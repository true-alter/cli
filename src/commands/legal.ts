/**
 * alter legal - the served Terms section 14 acceptance ledger, read and
 * act.
 *
 * Menu-only entry under the Account zone (mirrors notices.ts's
 * convention: not registered as a top-level CLI verb, the verb surface
 * stays frozen). Where notices.ts is the channel for one-off account and
 * legal NOTICES, this is the record of which version of the Terms of
 * Service and Privacy Policy a member has actually accepted, and the
 * place to read the current text and accept it.
 *
 * Reading is the primary job: show what's on record for both documents,
 * plainly, whether that's "not yet accepted" or a version and date - and
 * say plainly when an accepted version is older than the one now served.
 * Only documents that need a fresh accept (never accepted, or accepted
 * an older version) get offered the read-then-accept flow.
 *
 * Neither the version number nor the effective date shown here is ever
 * invented client-side - both come straight off the server's response to
 * `GET /api/v1/legal-documents/{document}` and `GET
 * /api/v1/me/legal-acceptance`. See src/lib/legal-documents.ts for the
 * digest-echo contract on accept.
 */

import { confirmYesNo } from "../ui/picker.js";
import { failNotLoggedIn, getSession } from "../auth.js";
import { withLoadingCancel } from "../ui/biosMenu.js";
import { apiErrorMessage } from "../lib/api-error.js";
import {
  acceptLegalDocument,
  fetchLegalAcceptanceStatus,
  fetchLegalDocument,
  formatAcceptanceLine,
  needsAcceptance,
  type LegalAcceptanceStatus,
  type LegalDocument,
  type LegalDocumentName,
} from "../lib/legal-documents.js";

const DOCS: { name: LegalDocumentName; label: string }[] = [
  { name: "terms", label: "Terms of Service" },
  { name: "privacy", label: "Privacy Policy" },
];

export async function legal(): Promise<void> {
  const session = getSession();
  if (!session) {
    failNotLoggedIn();
    return;
  }

  const fetchWait = await withLoadingCancel(
    async () => {
      const [acceptance, terms, privacy] = await Promise.all([
        fetchLegalAcceptanceStatus(),
        fetchLegalDocument("terms"),
        fetchLegalDocument("privacy"),
      ]);
      return { acceptance, terms, privacy };
    },
    "checking your Terms and Privacy record",
  );
  if (fetchWait.cancelled) {
    console.log("Cancelled.");
    return;
  }
  const fetched = fetchWait.result;
  const acceptance: LegalAcceptanceStatus | null = fetched?.acceptance ?? null;

  console.log("");
  if (acceptance === null) {
    console.log(
      "  Couldn't reach the server to check your Terms and Privacy record.",
    );
    console.log("  Try again shortly.");
    console.log("");
    return;
  }

  const docsByName: Record<LegalDocumentName, LegalDocument | null> = {
    terms: fetched?.terms ?? null,
    privacy: fetched?.privacy ?? null,
  };

  console.log("  Terms of Service and Privacy Policy.");
  console.log("");
  for (const { name, label } of DOCS) {
    console.log(
      `  ${formatAcceptanceLine(label, acceptance[name], docsByName[name]?.version)}`,
    );
  }
  console.log("");

  const pending = DOCS.filter(({ name }) =>
    needsAcceptance(acceptance[name], docsByName[name]?.version),
  );

  if (pending.length === 0) {
    console.log("  Nothing to accept - you're up to date.");
    console.log("");
    return;
  }

  for (const { name, label } of pending) {
    const doc = docsByName[name];
    if (!doc) continue; // needsAcceptance already guards this, belt and braces

    const read = await confirmYesNo({
      message: `Read and accept the current ${label} (v${doc.version})?`,
      initialValue: true,
    });
    if (read === null) {
      // Member quit the confirm-exit modal - stop working through the
      // list rather than force the remaining document past them.
      return;
    }
    if (!read) {
      console.log(
        `  Left unaccepted - ${label} will show as outstanding next time.`,
      );
      console.log("");
      continue;
    }

    console.log("");
    console.log(`  ${label} - v${doc.version}`);
    console.log("");
    for (const line of doc.text.split("\n")) {
      console.log(`  ${line}`);
    }
    console.log("");

    const accept = await confirmYesNo({
      message: `Accept ${label} v${doc.version}?`,
      initialValue: true,
    });
    if (accept === null) {
      return;
    }
    if (!accept) {
      console.log(
        `  Not accepted - ${label} will show as outstanding next time.`,
      );
      console.log("");
      continue;
    }

    const acceptWait = await withLoadingCancel(
      () => acceptLegalDocument(doc),
      "recording your acceptance",
    );
    if (acceptWait.cancelled) {
      console.log("  Cancelled - not recorded.");
      console.log("");
      continue;
    }
    const result = acceptWait.result;
    if (!result) {
      console.error("  Session expired. Run `alter login` again.");
      console.log("");
      continue;
    }
    if (result.ok) {
      console.log(`  Accepted. ${label} v${doc.version} is now on record.`);
    } else {
      console.error(
        `  ${apiErrorMessage(`accept the ${label}`, result.status, result.body)}`,
      );
    }
    console.log("");
  }
}
