/**
 * alter whoami - show current identity and inference surface.
 *
 * Prints handle, consent tier, org binding, email, and a terse
 * "Inferred from" block listing which streams currently contribute to
 * the member's trait vector. Numeric scores are never shown (tier
 * labels only). The inference block renders gracefully
 * when the backend field is absent (older backend or cold start).
 *
 * --json mode: emits a single JSON object of non-secret identity fields
 * sourced from the local enc-store session only (no network call). The
 * enc-store migration removed plaintext session.json so CC hooks can no
 * longer read fields directly - `alter whoami --json` is the safe
 * replacement surface. Secrets (jwt, access_token, token,
 * refresh_token) are deliberately excluded from the JSON output.
 */

import { apiCall, failNotLoggedIn, getSessionInfo, isExpired } from "../auth.js";
import { resolveEffectiveOrgs } from "../lib/memberships.js";

// Shape of the alter_whoami MCP response (member-self mode).
// The `contributing_streams` field is populated by the backend when
// at least one substrate has been paired. Absent on cold start or
// older backends - render the placeholder line in that case.
interface WhoamiPayload {
  user_id?: string;
  handle?: string | null;
  member_id?: string;
  scopes?: string[];
  tier?: string;
  authenticated?: boolean;
  contributing_streams?: string[];
  trait_categories_populated?: string[];
}

function displayEmail(email: string | undefined | null): string {
  // Mirror status.ts displayEmail: an unbound email gets an actionable CTA
  // rather than a bare "not set" that reads as a bug. Kept verbatim so both
  // surfaces show identical copy.
  if (!email || email.trim().length === 0) {
    return "not set - add one in Account > Login email";
  }
  return email;
}

/**
 * The OAuth token is minted without an email claim by design, so the session
 * often carries no email and whoami would show "not set" even for a member
 * who has one. Fall back to the backend profile (GET /me returns the
 * decrypted account email). Best-effort: any failure leaves the session value
 * untouched so the display degrades gracefully to "not set". Mirrors the
 * resolver in status.ts.
 */
async function resolveAccountEmail(
  sessionEmail: string | undefined | null,
): Promise<string | undefined | null> {
  if (sessionEmail && sessionEmail.trim().length > 0) return sessionEmail;
  try {
    const resp = await apiCall("/api/v1/members/me");
    if (resp && resp.ok) {
      const body = (await resp.json().catch(() => null)) as { email?: string } | null;
      if (body?.email) return body.email;
    }
  } catch {
    // network blip - fall through to the session value
  }
  return sessionEmail;
}

/**
 * Contract type for `alter whoami --json` output.
 *
 * Exactly 10 keys - no more, no less. Every field sourced from the
 * local enc-store session (getSessionInfo). No network call is made.
 *
 * DELIBERATELY EXCLUDED: jwt, access_token, token, refresh_token, and
 * any bearer/secret fields. The enc-store migration removed plaintext
 * session.json; hooks consume this output and must never receive secrets.
 */
export interface WhoamiJsonOutput {
  handle: string;
  tier: string;
  org: string;
  trust: string;
  domain: string;
  email: string;
  member_id: string;
  session_id: string;
  authenticated: boolean;
  expired: boolean;
}

function printHelp(): void {
  console.log(
    "Usage: alter whoami [--json]\n" +
      "\n" +
      "Print ~handle, consent tier, org binding, email, and the inference\n" +
      "surface - which streams currently contribute to your trait vector.\n" +
      "Exits 1 if not logged in or the session has expired.\n" +
      "\n" +
      "  --json    Emit a single JSON object of non-secret identity fields\n" +
      "            (handle, tier, org, trust, domain, email, member_id,\n" +
      "            session_id, authenticated, expired). No network call.\n" +
      "            Suitable for CC hooks and shell scripts. Secrets\n" +
      "            (jwt, tokens) are never included.\n",
  );
}

/** Wrap text to a given column width with a leading indent. */
function wrapLine(text: string, width = 72, indent = "  "): string {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = indent;
  for (const word of words) {
    if (current.length + word.length + 1 > width && current.trim().length > 0) {
      lines.push(current);
      current = indent + word;
    } else {
      current = current.length === indent.length ? indent + word : `${current} ${word}`;
    }
  }
  if (current.trim().length > 0) lines.push(current);
  return lines.join("\n");
}

/**
 * Fetch the inference surface from /api/v1/members/me/whoami.
 * Returns null on any network error - the caller falls back to the
 * placeholder line so the rest of whoami output is unaffected.
 */
async function fetchInferenceSurface(): Promise<WhoamiPayload | null> {
  try {
    const resp = await apiCall("/api/v1/members/me/whoami");
    if (!resp || !resp.ok) return null;
    return (await resp.json()) as WhoamiPayload;
  } catch {
    return null;
  }
}

export async function whoami(args: string[] = []): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  // --json: emit non-secret identity fields as a single JSON object.
  // No network call - all fields sourced from the local enc-store session.
  // Secrets (jwt, access_token, token, refresh_token) are never included;
  // the enc-store migration removed plaintext session.json so hooks consume
  // this output and must never receive bearer credentials.
  if (args.includes("--json")) {
    const session = getSessionInfo();
    const expired = isExpired();
    // Merge the daemon-refreshed org cache over the login-time seed so the
    // badge reflects current couplings without a re-login. Local read only.
    const org = session ? resolveEffectiveOrgs(session.orgs)[0] : undefined;
    const output: WhoamiJsonOutput = {
      handle: session?.handle ?? "",
      tier: session?.consent_tier ?? "",
      org: org?.domain ?? "",
      trust: org?.tier ?? "",
      domain: org?.domain ?? "",
      email: session?.email ?? "",
      member_id: session?.user_id ?? "",
      session_id: "",
      authenticated: session !== null && !expired,
      expired,
    };
    process.stdout.write(JSON.stringify(output) + "\n");
    return;
  }

  const session = getSessionInfo();

  if (!session) {
    failNotLoggedIn();
    return;
  }

  const expired = isExpired();
  const org = resolveEffectiveOrgs(session.orgs)[0];
  const orgStr = org ? `${org.domain} (${org.tier}/${org.role})` : "none";
  const email = displayEmail(await resolveAccountEmail(session.email));

  if (expired) {
    console.log(
      `${session.handle} (${email}) - SESSION EXPIRED. Run 'alter login'.`
    );
    process.exitCode = 1;
    return;
  }

  // Primary identity line - unchanged from prior shape.
  console.log(
    `${session.handle} | ${session.consent_tier} | ${orgStr} | ${email}`
  );

  // Inference surface - which streams currently contribute to the
  // trait vector. Best-effort: never block on a network blip.
  // Numeric scores are not printed - tier labels only.
  const payload = await fetchInferenceSurface();

  const streams = payload?.contributing_streams;
  const categories = payload?.trait_categories_populated;

  if (streams && streams.length > 0) {
    const streamList = streams.join(", ");
    console.log(
      wrapLine(`Inferred from: ${streamList}`, 72, "  ")
    );
    if (categories && categories.length > 0) {
      console.log(
        wrapLine(`Categories active: ${categories.join(", ")}`, 72, "  ")
      );
    }
  } else {
    // Backend field absent or no streams paired yet - active-voice
    // placeholder that guides the member without implying passivity.
    console.log(
      "  Pair sources to grow your identity vector."
    );
    console.log(
      "  Run 'alter pair' to add identity sources."
    );
  }
}
