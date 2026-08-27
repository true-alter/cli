/**
 * legal-documents - the served Terms section 14 acceptance ledger, read
 * and write.
 *
 * Wraps the three endpoints the backend contract exposes:
 *
 *   GET  /api/v1/legal-documents/{document}   current text + version + digest
 *   GET  /api/v1/me/legal-acceptance          what this member has accepted
 *   POST /api/v1/me/legal-acceptance          record an acceptance
 *
 * The client NEVER computes a digest. `buildAcceptanceRequestBody` only
 * ever copies `version` and `text_sha256` off a `LegalDocument` this module
 * itself fetched from the server - the backend independently recomputes
 * and rejects a mismatch, an unknown version, or a malformed digest, so a
 * client-side hash would be redundant at best and a source of drift at
 * worst.
 *
 * Acceptance is append-only server-side: a member cannot un-accept a
 * version they were bound by, and re-accepting writes a new row. This
 * module has no concept of "un-accept" for the same reason.
 *
 * Failure model matches session-notices.ts: every fetch degrades to
 * `null` rather than throwing past its own boundary. A document or
 * acceptance-status fetch that fails just means the command can't show
 * that piece this run - it never blocks the invoking command.
 */

import { apiCall, getSession } from "../auth.js";
import { shortDate } from "./format-date.js";

export type LegalDocumentName = "terms" | "privacy";

export interface LegalDocument {
  document: LegalDocumentName;
  version: string;
  text: string;
  text_sha256: string;
}

export interface LegalAcceptanceRecord {
  version: string;
  accepted_at: string;
  text_sha256: string;
}

export interface LegalAcceptanceStatus {
  terms: LegalAcceptanceRecord | null;
  privacy: LegalAcceptanceRecord | null;
}

export type AcceptLegalDocumentResult =
  | { ok: true }
  | { ok: false; status: number; body: string };

function parseAcceptanceRecord(v: unknown): LegalAcceptanceRecord | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (
    typeof r.version !== "string" ||
    typeof r.accepted_at !== "string" ||
    typeof r.text_sha256 !== "string"
  ) {
    return null;
  }
  return {
    version: r.version,
    accepted_at: r.accepted_at,
    text_sha256: r.text_sha256,
  };
}

/** Exported for tests. Parses the `GET /api/v1/me/legal-acceptance` body. */
export function parseLegalAcceptanceStatus(
  data: unknown,
): LegalAcceptanceStatus | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  return {
    terms: parseAcceptanceRecord(d.terms),
    privacy: parseAcceptanceRecord(d.privacy),
  };
}

/** Exported for tests. Parses a `GET /api/v1/legal-documents/{doc}` body. */
export function parseLegalDocument(data: unknown): LegalDocument | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (
    (d.document !== "terms" && d.document !== "privacy") ||
    typeof d.version !== "string" ||
    typeof d.text !== "string" ||
    typeof d.text_sha256 !== "string"
  ) {
    return null;
  }
  return {
    document: d.document,
    version: d.version,
    text: d.text,
    text_sha256: d.text_sha256,
  };
}

/**
 * Whether `record` needs a fresh accept against `currentVersion`: never
 * accepted, or accepted a version other than the one the server is
 * currently serving. Returns false when `currentVersion` is unknown (the
 * document fetch failed) - never prompt a member to accept a document we
 * couldn't actually fetch to show them.
 */
export function needsAcceptance(
  record: LegalAcceptanceRecord | null,
  currentVersion: string | undefined,
): boolean {
  if (!currentVersion) return false;
  if (!record) return true;
  return record.version !== currentVersion;
}

/**
 * One status line for a document: never accepted, accepted and current,
 * or accepted a version other than the one now in effect. `currentVersion`
 * may be absent (the document fetch failed) - the line still renders,
 * just without the up-to-date/outdated comparison.
 *
 * The mismatch line does NOT claim the served version is NEWER. Version
 * strings are document versions, not ordered values this module can
 * compare, so calling the difference "newer" would be an assertion about
 * ordering nothing here has checked. What the member needs is which
 * version binds now, and that is what the line says.
 */
export function formatAcceptanceLine(
  label: string,
  record: LegalAcceptanceRecord | null,
  currentVersion: string | undefined,
): string {
  if (!record) {
    return currentVersion
      ? `${label}: not yet accepted. Current version is v${currentVersion}.`
      : `${label}: not yet accepted.`;
  }
  const when = shortDate(record.accepted_at);
  if (!currentVersion) {
    return `${label}: v${record.version} accepted ${when}.`;
  }
  if (record.version === currentVersion) {
    return `${label}: v${record.version} accepted ${when} - up to date.`;
  }
  return `${label}: v${record.version} accepted ${when} - v${currentVersion} is now in effect.`;
}

/**
 * Build the POST body for an acceptance. Copies `document`, `version`
 * and `text_sha256` straight off the fetched `LegalDocument` - see the
 * module doc-comment above for why this never derives a digest itself.
 */
export function buildAcceptanceRequestBody(doc: LegalDocument): {
  document: LegalDocumentName;
  version: string;
  text_sha256: string;
} {
  return {
    document: doc.document,
    version: doc.version,
    text_sha256: doc.text_sha256,
  };
}

/**
 * Fetch the current text + version + digest for one document. No auth is
 * required server-side (a person must be able to read the Terms before
 * they have an account), but this rides the same authenticated `apiCall`
 * client as everything else in the CLI for consistency. Never throws -
 * any failure (network, non-2xx, unparsable body) degrades to `null`.
 */
export async function fetchLegalDocument(
  document: LegalDocumentName,
): Promise<LegalDocument | null> {
  try {
    const res = await apiCall(`/api/v1/legal-documents/${document}`, {
      timeoutMs: 8000,
    });
    if (!res || !res.ok) return null;
    return parseLegalDocument(await res.json());
  } catch {
    return null;
  }
}

/**
 * Fetch what the signed-in member has accepted for both documents. Never
 * throws - no session, network failure, non-2xx, or an unparsable body
 * all degrade to `null`.
 */
export async function fetchLegalAcceptanceStatus(): Promise<LegalAcceptanceStatus | null> {
  if (!getSession()) return null;
  try {
    const res = await apiCall("/api/v1/me/legal-acceptance", {
      timeoutMs: 8000,
    });
    if (!res || !res.ok) return null;
    return parseLegalAcceptanceStatus(await res.json());
  } catch {
    return null;
  }
}

/**
 * POST the acceptance receipt for one document. Returns `null` only when
 * the session itself is gone (apiCall's own refresh-failed signal) -
 * every other outcome, success or a non-2xx rejection, comes back as a
 * result the caller can render a message for.
 */
export async function acceptLegalDocument(
  doc: LegalDocument,
): Promise<AcceptLegalDocumentResult | null> {
  try {
    const res = await apiCall("/api/v1/me/legal-acceptance", {
      method: "POST",
      body: buildAcceptanceRequestBody(doc),
      timeoutMs: 8000,
    });
    if (!res) return null;
    if (res.ok) return { ok: true };
    const body = await res.text();
    return { ok: false, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: "" };
  }
}
