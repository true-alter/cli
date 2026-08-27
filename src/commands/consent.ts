/**
 * alter consent - show and manage what you have consented to.
 *
 * Read/write surface onto the backend consent ledgers. Wraps two
 * endpoints - they describe orthogonal authority surfaces and the
 * verb renders both:
 *   GET  /api/v1/members/me/consent         - declared member-level
 *                                             consent (assessment,
 *                                             matching, demographic)
 *   GET  /api/v1/members/me/stream-consent  - per-stream + per-purpose
 *                                             grants (OAuth pair,
 *                                             vault pair) - the
 *                                             stream-consent ledger
 *   POST /api/v1/members/me/consent         - grant or withdraw consent
 *
 * Subcommands:
 *   alter consent list                       pretty-print both ledgers
 *   alter consent list --preview             inline consequence per row
 *   alter consent list --json                emit the raw merged response
 *   alter consent revoke <type>              withdraw a grant (shows the
 *                                            server's live consequence first)
 *   alter consent revoke <type> --org <h>    scope withdrawal to one org
 *   alter consent revoke <type> --yes        skip confirmation prompt
 *   alter consent automated-decisions        read the Article 22 disclosure
 *                                            and your standing on it
 *   alter consent automated-decisions --acknowledge
 *                                            record the acknowledgement
 *   alter consent automated-decisions --withdraw
 *                                            take it back again
 *   alter consent --help                     usage
 *
 * The consequence shown before a revoke is the SERVER's value, fetched
 * live immediately before the control - never cached, never fabricated
 * client-side. It is served by the per-type revoke-preview
 * endpoint; see ``fetchConsequencePreview``.
 */

import { apiCall, failNotLoggedIn, getSession } from "../auth.js";
import { confirmYesNo } from "../ui/picker.js";
import { emitSessionHeartbeat } from "../lib/active-sessions-emit.js";
import { withLoadingCancel } from "../ui/biosMenu.js";
import { requireAuthedClient, extractPayload } from "./msg.js";

// ---------------------------------------------------------------------------
// Types mirroring the backend consent-status response
// ---------------------------------------------------------------------------

export interface ConsentRecord {
  id: string;
  consent_type: string;
  consent_status: string;
  granted_at: string | null;
  revoked_at: string | null;
  created_at: string;
  // Any forward-compatible fields are preserved in --json but ignored by
  // the pretty formatter.
  [key: string]: unknown;
}

export interface ConsentListResponse {
  consents: ConsentRecord[];
  [key: string]: unknown;
}

/**
 * One row from /api/v1/members/me/stream-consent - the latest active
 * grant per (stream, member). The backend filters revoked rows out.
 */
export interface StreamConsentRow {
  stream: string;
  provenance_class: string;
  purposes: string[];
  granted_at: string;
  vault_path_hash: string | null;
  [key: string]: unknown;
}

export interface StreamConsentListResponse {
  stream_consents: StreamConsentRow[];
  [key: string]: unknown;
}

export interface MergedConsentResponse {
  consents: ConsentRecord[];
  stream_consents: StreamConsentRow[];
}

// ---------------------------------------------------------------------------
// MCP grant ledger (messaging + alignment) - the third authority surface.
//
// The two HTTP ledgers above (/me/consent, /me/stream-consent) cover
// member-level and per-source consent only. They are SILENT on the MCP
// grant ledger - the messaging-send and alignment-query grants a member
// authors to (and receives from) peers via the `alter_consent` MCP tool.
// A member with live MCP grants but no paired data sources (e.g. several
// people granted messaging access, no OAuth/vault sources) used to see
// NOTHING here: a real perception gap where their actual consent posture
// was invisible. We read the same `mcp_grants_authored` /
// `mcp_grants_received` arrays the interactive dashboard reads and render
// them as a third section. Exactly what the MCP tool returns - no
// fabrication, no client-side synthesis.
// ---------------------------------------------------------------------------

interface McpGrant {
  target_tool?: string;
  scope?: string;
  grantor_handle?: string | null;
  grantee_handle?: string | null;
  status?: string;
  granted_at?: string | null;
  expires_at?: string | null;
}
interface McpConsentPosture {
  mcp_grants_authored?: McpGrant[];
  mcp_grants_received?: McpGrant[];
}

/** Human label for an MCP grant scope. */
function scopeLabel(scope: string | undefined): string {
  switch (scope) {
    case "messaging.send":
    case "messaging.consent":
    case "alter_message.send":
      return "message";
    case "alignment.query":
      return "query";
    default:
      return scope ?? "reach";
  }
}

/**
 * Best-effort read of the MCP grant ledger via the `alter_consent` MCP
 * tool. Reuses msg.ts's authed-client builder and payload extractor (no
 * new MCP plumbing). Returns null when the call cannot be made or fails -
 * the list surface then omits the MCP section rather than lying about it.
 */
async function fetchMcpGrants(): Promise<McpConsentPosture | null> {
  // Best-effort probe: it must NEVER change the command's exit status. The
  // two HTTP ledgers alone decide success; the MCP grant section is additive
  // and simply omitted when unavailable. requireAuthedClient sets
  // process.exitCode = 1 on a session with no member key or no signing kid,
  // which would otherwise make an already-successful `consent list` exit
  // non-zero for a signing-kid-less session. Snapshot and restore so this
  // probe stays side-effect-free on the exit code.
  const prevExit = process.exitCode;
  const authed = requireAuthedClient();
  if (!authed) {
    process.exitCode = prevExit;
    return null;
  }
  try {
    const result = await authed.client.mcp.callTool("alter_consent", {});
    return extractPayload<McpConsentPosture>(result);
  } catch {
    process.exitCode = prevExit;
    return null;
  }
}

/**
 * Render the MCP grant ledger as printable lines: who you let reach/query
 * you (authored) and who lets you reach/query them (received). Surfaces
 * exactly the grants the MCP tool returned.
 */
export function formatMcpGrants(posture: McpConsentPosture): string {
  const authored = posture.mcp_grants_authored ?? [];
  const received = posture.mcp_grants_received ?? [];
  const lines: string[] = [];

  if (authored.length) {
    lines.push("  You granted:");
    for (const g of authored) {
      const who = g.grantee_handle ?? "(open / master grant)";
      const exp = g.expires_at ? `  expires ${formatTimestamp(g.expires_at)}` : "";
      lines.push(`    ${who}  can ${scopeLabel(g.scope)} you${exp}`);
    }
  }
  if (received.length) {
    if (authored.length) lines.push("");
    lines.push("  Granted to you:");
    for (const g of received) {
      const who = g.grantor_handle ?? "~peer";
      lines.push(`    ${who}  you can ${scopeLabel(g.scope)} them`);
    }
  }
  if (!authored.length && !received.length) {
    return "No messaging or alignment grants active.";
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Formatter helpers
// ---------------------------------------------------------------------------

const DEFAULT_TERMINAL_WIDTH = 100;

export function terminalWidth(): number {
  const cols = process.stdout.columns;
  if (typeof cols === "number" && cols > 40) return cols;
  return DEFAULT_TERMINAL_WIDTH;
}

function truncate(value: string, max: number): string {
  if (max <= 1) return value.slice(0, Math.max(max, 0));
  if (value.length <= max) return value;
  return value.slice(0, Math.max(max - 1, 1)) + "…";
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "-";
  // Humanise to YYYY-MM-DD HH:MM (matches pair-status convention) so the
  // column never overflows in an 80-col frame.
  try {
    return new Date(value).toISOString().slice(0, 16).replace("T", " ");
  } catch {
    return value.slice(0, 16);
  }
}

interface Column {
  header: string;
  pick: (row: ConsentRecord) => string;
  min: number;
  weight: number;
}

const COLUMNS: Column[] = [
  {
    header: "TYPE",
    pick: (r) => r.consent_type ?? "-",
    min: 10,
    weight: 2,
  },
  {
    header: "STATUS",
    pick: (r) => r.consent_status ?? "-",
    min: 8,
    weight: 1,
  },
  {
    header: "GRANTED_AT",
    pick: (r) => formatTimestamp(r.granted_at),
    min: 16,
    weight: 2,
  },
  {
    header: "REVOKED_AT",
    pick: (r) => formatTimestamp(r.revoked_at),
    min: 16,
    weight: 2,
  },
];

export function formatConsentsAsTable(
  consents: ConsentRecord[],
  width: number = terminalWidth(),
): string {
  if (consents.length === 0) {
    return "No consent grants active.";
  }

  // Size each column to fit its widest cell, then trim the widest
  // column(s) if the total exceeds the terminal width. We keep the
  // header row readable (at least `min` chars per column).
  const gap = 2;
  const totalGap = gap * (COLUMNS.length - 1);
  const minTotal = COLUMNS.reduce((s, c) => s + c.min, 0);
  const available = Math.max(width - totalGap, minTotal);

  const naturalWidths = COLUMNS.map((c) => {
    const headerLen = c.header.length;
    const dataLen = consents.reduce(
      (max, row) => Math.max(max, c.pick(row).length),
      0,
    );
    return Math.max(headerLen, dataLen, c.min);
  });

  const naturalTotal = naturalWidths.reduce((s, w) => s + w, 0);
  let finalWidths = naturalWidths;
  if (naturalTotal > available) {
    // Shrink columns proportional to their weight, never below `min`.
    const excess = naturalTotal - available;
    const totalWeight = COLUMNS.reduce((s, c) => s + c.weight, 0);
    let remaining = excess;
    finalWidths = naturalWidths.map((w, i) => {
      const share = Math.floor((excess * COLUMNS[i].weight) / totalWeight);
      const shrunk = Math.max(w - share, COLUMNS[i].min);
      remaining -= w - shrunk;
      return shrunk;
    });
    // Absorb any rounding leftover from the widest column (that still
    // has slack above its `min`).
    if (remaining > 0) {
      for (let i = 0; i < finalWidths.length && remaining > 0; i++) {
        const slack = finalWidths[i] - COLUMNS[i].min;
        const take = Math.min(slack, remaining);
        finalWidths[i] -= take;
        remaining -= take;
      }
    }
  }

  const padCell = (value: string, cellWidth: number): string => {
    const trimmed = truncate(value, cellWidth);
    return trimmed.padEnd(cellWidth, " ");
  };

  const headerRow = COLUMNS.map((c, i) => padCell(c.header, finalWidths[i]))
    .join(" ".repeat(gap))
    .trimEnd();
  const rule = finalWidths
    .map((w) => "-".repeat(w))
    .join(" ".repeat(gap))
    .trimEnd();

  const dataRows = consents.map((row) =>
    COLUMNS.map((c, i) => padCell(c.pick(row), finalWidths[i]))
      .join(" ".repeat(gap))
      .trimEnd(),
  );

  return [headerRow, rule, ...dataRows].join("\n");
}

// ---------------------------------------------------------------------------
// Stream-consent formatter
// ---------------------------------------------------------------------------

const STREAM_COLUMNS: { header: string; pick: (r: StreamConsentRow) => string; min: number; weight: number }[] = [
  { header: "STREAM",           pick: (r) => r.stream ?? "-",                      min: 12, weight: 2 },
  { header: "PROVENANCE",       pick: (r) => r.provenance_class ?? "-",            min: 12, weight: 2 },
  { header: "PURPOSES",         pick: (r) => (r.purposes ?? []).join(", ") || "-", min: 16, weight: 4 },
  { header: "GRANTED_AT",       pick: (r) => formatTimestamp(r.granted_at),        min: 16, weight: 2 },
];

export function formatStreamConsentsAsTable(
  rows: StreamConsentRow[],
  width: number = terminalWidth(),
): string {
  if (rows.length === 0) {
    return "No active data-sharing grants. Pair a source under Sources to begin.";
  }

  const gap = 2;
  const totalGap = gap * (STREAM_COLUMNS.length - 1);
  const minTotal = STREAM_COLUMNS.reduce((s, c) => s + c.min, 0);
  const available = Math.max(width - totalGap, minTotal);

  const naturalWidths = STREAM_COLUMNS.map((c) => {
    const headerLen = c.header.length;
    const dataLen = rows.reduce((max, row) => Math.max(max, c.pick(row).length), 0);
    return Math.max(headerLen, dataLen, c.min);
  });

  const naturalTotal = naturalWidths.reduce((s, w) => s + w, 0);
  let finalWidths = naturalWidths;
  if (naturalTotal > available) {
    const excess = naturalTotal - available;
    const totalWeight = STREAM_COLUMNS.reduce((s, c) => s + c.weight, 0);
    let remaining = excess;
    finalWidths = naturalWidths.map((w, i) => {
      const share = Math.floor((excess * STREAM_COLUMNS[i].weight) / totalWeight);
      const shrunk = Math.max(w - share, STREAM_COLUMNS[i].min);
      remaining -= w - shrunk;
      return shrunk;
    });
    if (remaining > 0) {
      for (let i = 0; i < finalWidths.length && remaining > 0; i++) {
        const slack = finalWidths[i] - STREAM_COLUMNS[i].min;
        const take = Math.min(slack, remaining);
        finalWidths[i] -= take;
        remaining -= take;
      }
    }
  }

  const padCell = (value: string, cellWidth: number): string => {
    const trimmed = truncate(value, cellWidth);
    return trimmed.padEnd(cellWidth, " ");
  };

  const headerRow = STREAM_COLUMNS.map((c, i) => padCell(c.header, finalWidths[i]))
    .join(" ".repeat(gap))
    .trimEnd();
  const rule = finalWidths.map((w) => "-".repeat(w)).join(" ".repeat(gap)).trimEnd();
  const dataRows = rows.map((row) =>
    STREAM_COLUMNS.map((c, i) => padCell(c.pick(row), finalWidths[i]))
      .join(" ".repeat(gap))
      .trimEnd(),
  );
  return [headerRow, rule, ...dataRows].join("\n");
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

const LEGACY_ENDPOINT = "/api/v1/members/me/consent";
const STREAM_ENDPOINT = "/api/v1/members/me/stream-consent";

async function fetchOrFail<T>(
  path: string,
  parse: (data: unknown) => T | null,
  signal?: AbortSignal,
): Promise<T> {
  // Throws Error instead of process.exit so callers dispatched from the
  // interactive menu can let the try/catch handle errors cleanly.
  // Standalone CLI callers bubble to main().catch which exits with 1.
  const resp = await apiCall(path, { signal });
  if (!resp) {
    throw new Error("alter: not logged in. Run 'alter login' first.");
  }
  if (resp.status === 401) {
    throw new Error("alter consent: session not authenticated. Run 'alter login' first.");
  }
  if (resp.status === 403) {
    const body = (await resp.json().catch(() => ({}))) as { detail?: string };
    throw new Error(`alter consent: ${body.detail ?? "access denied."}`);
  }
  if (resp.status >= 500) {
    throw new Error(
      `alter consent: server error (${resp.status} ${resp.statusText}). Try again in a moment.`,
    );
  }
  if (!resp.ok) {
    throw new Error(
      `alter consent: could not fetch ${path} (${resp.status} ${resp.statusText}).`,
    );
  }
  const data = await resp.json().catch(() => null);
  const parsed = parse(data);
  if (parsed === null) {
    throw new Error(`alter consent: malformed response from ${path}.`);
  }
  return parsed;
}

export async function fetchConsentList(
  signal?: AbortSignal,
): Promise<ConsentListResponse> {
  return fetchOrFail<ConsentListResponse>(LEGACY_ENDPOINT, (data) => {
    const d = data as ConsentListResponse | null;
    if (!d || !Array.isArray(d.consents)) return null;
    return d;
  }, signal);
}

export async function fetchStreamConsentList(
  signal?: AbortSignal,
): Promise<StreamConsentListResponse> {
  return fetchOrFail<StreamConsentListResponse>(STREAM_ENDPOINT, (data) => {
    const d = data as StreamConsentListResponse | null;
    if (!d || !Array.isArray(d.stream_consents)) return null;
    return d;
  }, signal);
}

export async function fetchMergedConsent(
  signal?: AbortSignal,
): Promise<MergedConsentResponse> {
  const [legacy, stream] = await Promise.all([
    fetchConsentList(signal),
    fetchStreamConsentList(signal),
  ]);
  return {
    consents: legacy.consents,
    stream_consents: stream.stream_consents,
  };
}

// ---------------------------------------------------------------------------
// Consequence preview - fetched LIVE from the backend, never fabricated
// ---------------------------------------------------------------------------
//
// Revocability is the moat: the cost of revoking must be shown
// before the control that performs it. The authoritative consequence text
// is computed SERVER-SIDE (it depends on the member's live trait state, the
// queries currently running against the grant, and the tier fall-back map)
// - the CLI must NOT invent it client-side.
//
// ────────────────────────────────────────────────────────────────────────
// The per-type revoke-preview endpoint exists and is what this verb
// calls:
//     GET /api/v1/members/me/consent/{consent_type}/revoke-preview
//       → 200 { "consent_type": "...", "consequence_if_revoked": "..." }
//       → 404 for an unknown consent type
// The consequence text is authored server-side; the CLI only renders it.
// On any non-ok response (404 / fetch failure) `fetchConsequencePreview`
// returns null and the revoke flow surfaces an explicit "preview
// unavailable" notice - it never substitutes fabricated copy for a
// missing server value.
//
// (The two ledger endpoints - `GET /me/consent`, `GET /me/stream-consent`
// - still return raw rows with no consequence field; carrying it per-row
// there is a separate, out-of-scope future change. `consent list
// --preview` therefore continues to show the honest "unavailable" notice
// via `rowConsequence` until that lands.)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build the per-type revoke-preview path for a consent type. The type is
 * a path segment, so it is URL-encoded to stay safe against slashes and
 * other reserved characters in arbitrary consent-type identifiers.
 */
function revokePreviewEndpoint(consentType: string): string {
  return `/api/v1/members/me/consent/${encodeURIComponent(consentType)}/revoke-preview`;
}

/**
 * Fetch the server-authored ``consequence_if_revoked`` for a consent
 * type, LIVE, immediately before showing the revoke control. Never
 * cached, never replayed, never fabricated.
 *
 * Calls the per-type revoke-preview endpoint and returns the
 * ``consequence_if_revoked`` string from its single-object response.
 * Returns null on any non-ok response (404 for an unknown type, a fetch
 * failure, or a malformed/empty body) so the verb degrades to an honest
 * "unavailable" notice rather than inventing the consequence client-side.
 */
export async function fetchConsequencePreview(
  consentType: string,
): Promise<string | null> {
  const previewWait = await withLoadingCancel(
    (signal) => apiCall(revokePreviewEndpoint(consentType), { signal }),
    "loading preview",
  );
  if (previewWait.cancelled) return null;
  const resp = previewWait.result;
  if (!resp || !resp.ok) {
    // 404 (unknown type) or any fetch failure must not be papered over
    // with fabricated copy.
    return null;
  }
  const data = (await resp.json().catch(() => null)) as
    | { consequence_if_revoked?: unknown }
    | null;
  const preview = data?.consequence_if_revoked;
  return typeof preview === "string" && preview.length > 0 ? preview : null;
}

/**
 * The line shown when the backend does not (yet) serve a live
 * consequence preview for this grant. Honest about the absence - it
 * states that the server-side preview is unavailable rather than
 * presenting client-fabricated text as if it were the real cost.
 */
const PREVIEW_UNAVAILABLE_NOTICE =
  "A live preview of what you'd lose is not yet available for this grant. " +
  "Withdrawal is append-only and reversible - you can re-grant at any time.";

/**
 * Read the server-authored ``consequence_if_revoked`` off a live ledger
 * row (already fetched - not a fresh call) for the `consent list
 * --preview` surface. Forward-compatible: the ledger endpoints do not
 * carry this field on their rows today, so this returns the honest
 * "unavailable" notice until they do. Never fabricates the consequence
 * from the row's other fields. (The `consent revoke` flow uses the
 * dedicated per-type endpoint instead - see fetchConsequencePreview.)
 */
function rowConsequence(row: Record<string, unknown>): string {
  const v = row.consequence_if_revoked;
  return typeof v === "string" && v.length > 0 ? v : PREVIEW_UNAVAILABLE_NOTICE;
}

// ---------------------------------------------------------------------------
// Revoke subcommand (Win 1)
// ---------------------------------------------------------------------------

const REVOKE_ENDPOINT = "/api/v1/members/me/consent";

/**
 * POST the revoke to /api/v1/members/me/consent with granted: false.
 * This is the same endpoint used by alter consent to write - the backend
 * is append-only; revoke is a new record with consent_status='revoked'.
 */
async function postRevoke(consentType: string): Promise<boolean> {
  const revokeWait = await withLoadingCancel(
    (signal) =>
      apiCall(REVOKE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          consent_type: consentType,
          granted: false,
          consent_version: "1.0",
        }),
        signal,
      }),
    "revoking consent",
  );
  if (revokeWait.cancelled) return false;
  const resp = revokeWait.result;
  if (!resp) {
    console.error("alter consent revoke: not logged in. Run 'alter login' first.");
    process.exitCode = 1;
    return false;
  }
  if (resp.status === 401) {
    console.error("alter consent revoke: session not authenticated. Run 'alter login' first.");
    process.exitCode = 1;
    return false;
  }
  if (resp.status === 403) {
    const body = (await resp.json().catch(() => ({}))) as { detail?: string };
    console.error(`alter consent revoke: ${body.detail ?? "access denied."}`);
    process.exitCode = 1;
    return false;
  }
  if (!resp.ok) {
    const body = (await resp.json().catch(() => ({}))) as { detail?: string };
    console.error(`alter consent revoke: ${body.detail ?? `server error (${resp.status})`}`);
    process.exitCode = 1;
    return false;
  }
  return true;
}

/**
 * Read one line of stdin for a y/n confirmation.
 * Resolves true on 'y' / 'yes', false on anything else.
 */
async function askConfirm(question: string): Promise<boolean> {
  // Non-interactive (piped / CI) without --yes: cancel rather than hang on
  // stdin that never arrives. Callers gate this behind `if (!yes)`.
  if (!process.stdin.isTTY) {
    console.log(`${question} (no TTY - pass --yes to confirm) - cancelled.`);
    return false;
  }
  // Esc-aware confirm: a raw `stdin.once("data")` in cooked mode left Esc a
  // dead key from the menu (the prompt trapped the user at [y/N] until n+Enter
  // or Ctrl-C). confirmYesNo reads keys directly so Esc cancels.
  const answer = await confirmYesNo({ message: question, initialValue: false });
  return answer === true; // Esc→null and No both → false; Enter defaults No, matching [y/N]
}

/**
 * Parse `revoke` args into { consentType, org, yes }.
 *
 * Shape: `consent revoke <type> [--org <handle>] [--yes]`.
 * `--org` consumes the following token as its value (the org ~handle);
 * `--yes` / `-y` are booleans. The first non-flag, non-consumed token is
 * the consent type.
 */
export function parseRevokeArgs(args: string[]): {
  consentType: string | undefined;
  org: string | undefined;
  yes: boolean;
} {
  let yes = false;
  let org: string | undefined;
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--yes" || a === "-y") {
      yes = true;
    } else if (a === "--org") {
      // Consume the next token as the org handle, if present.
      org = args[i + 1];
      i++;
    } else if (a.startsWith("--org=")) {
      org = a.slice("--org=".length);
    } else if (!a.startsWith("-")) {
      positionals.push(a);
    }
    // Unknown flags are ignored - keeps forward-compat with new flags.
  }
  return { consentType: positionals[0], org, yes };
}

export async function consentRevoke(args: string[]): Promise<void> {
  const { consentType, org, yes } = parseRevokeArgs(args);

  if (!consentType) {
    console.error(
      "alter consent revoke: consent type required.\n" +
        "Usage: alter consent revoke <type> [--yes]\n" +
        "\n" +
        "Examples:\n" +
        "  alter consent revoke assessment\n" +
        "  alter consent revoke matching --yes\n",
    );
    process.exitCode = 1;
    return;
  }

  // Per-org scoping is not wired from the CLI yet: the backend's per-org
  // revoke is a distinct endpoint keyed on an org UUID, which the CLI cannot
  // resolve from a ~handle today. Rather than silently withdraw the grant
  // GLOBALLY while the prompt claims an org scope (an authority surface that
  // lies), reject --org honestly and withdraw nothing. Tracked for proper
  // wiring post-launch.
  if (org) {
    console.error(
      "alter consent revoke: per-org scoping is not available from the CLI yet.\n" +
        "  `alter consent revoke <type>` withdraws the grant across ALL organisations.\n" +
        "  Per-organisation withdrawal will land in a later release; nothing was changed.",
    );
    process.exitCode = 1;
    return;
  }

  // Show the consequence BEFORE the destructive action.
  // The consequence is the SERVER's value, fetched live right now from the
  // per-type revoke-preview endpoint - never replayed from cache, never
  // fabricated client-side. If that endpoint returns nothing usable (404 /
  // fetch failure - see fetchConsequencePreview), we show an honest
  // "unavailable" notice rather than inventing the cost.
  const consequence = await fetchConsequencePreview(consentType);

  console.log("");
  const subject = consentType;
  console.log(`  Withdraw consent: ${subject}`);
  console.log(`  ${"─".repeat(40)}`);
  console.log("");
  console.log("  What changes if you withdraw:");
  console.log(`    ${consequence ?? PREVIEW_UNAVAILABLE_NOTICE}`);
  console.log("");

  if (!yes) {
    const confirmed = await askConfirm("  Confirm withdrawal?");
    if (!confirmed) {
      console.log("  Cancelled.");
      console.log("");
      return;
    }
  }

  const ok = await postRevoke(consentType);
  if (!ok) return;
  console.log(`  Grant withdrawn: ${subject}`);
  console.log("  The record is append-only. Run 'alter consent list' to confirm.");
  console.log("");
}

// ---------------------------------------------------------------------------
// Article 22 automated-decision acknowledgement
// ---------------------------------------------------------------------------
//
// GDPR Article 22 gives a person the right not to be subject to a decision
// based solely on automated processing. Matching is exactly that, so a
// member must be told how it works and acknowledge that disclosure before
// it runs for them. Without the acknowledgement, matching does not compute.
//
// This surface exists so that gate is clearable from the terminal. It was
// previously reachable only over MCP, which left a member with no AI client
// unable to unblock their own matching on a surface they use.
//
// The ORDER is the whole point, and it is not a stylistic preference:
//
//   1. GET the disclosure.
//   2. PRINT it.
//   3. PUT the acknowledgement, carrying the version that was printed.
//
// Article 7(1) requires the controller be able to DEMONSTRATE that consent
// was given. A record attesting to text nobody displayed demonstrates
// nothing. So there is deliberately no flag that writes without printing:
// `--yes` skips the confirmation prompt, never the disclosure. Article 7(3)
// requires withdrawal be as easy as granting, which is why `--withdraw` is
// the same word, the same length and the same one step as `--acknowledge`.

const AUTOMATED_DECISION_ENDPOINT =
  "/api/v1/members/me/automated-decision-acknowledgement";

/** The shape both the GET and the PUT return. */
export interface AutomatedDecisionStatus {
  acknowledged: boolean;
  consent_version: string;
  disclosure_text: string;
  consent_text_hash: string;
  /** Present on the PUT response only; mirrors `acknowledged`. */
  automated_decision_acknowledgement?: boolean;
  [key: string]: unknown;
}

/**
 * Greedy word-wrap for the disclosure body. Local rather than imported from
 * the onboarding renderer so this command does not pull the prompt stack in
 * as a side effect. The disclosure is plain server text with no ANSI in it,
 * so the width maths needs no escape handling.
 */
export function wrapPlain(text: string, width: number): string[] {
  const budget = Math.max(width, 20);
  const out: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    if (paragraph.trim().length === 0) {
      out.push("");
      continue;
    }
    let cur = "";
    for (const word of paragraph.split(/\s+/)) {
      if (word.length === 0) continue;
      if (cur.length === 0) {
        cur = word;
      } else if (cur.length + 1 + word.length <= budget) {
        cur += " " + word;
      } else {
        out.push(cur);
        cur = word;
      }
      // A single word longer than the budget is hard-wrapped rather than
      // allowed to blow the right margin out.
      while (cur.length > budget) {
        out.push(cur.slice(0, budget));
        cur = cur.slice(budget);
      }
    }
    if (cur.length > 0) out.push(cur);
  }
  return out;
}

/**
 * Render the disclosure the member must read, with the version and text
 * hash that the acknowledgement will attest to. This is the screen the
 * whole verb exists to put in front of someone.
 */
export function formatAutomatedDecisionDisclosure(
  status: AutomatedDecisionStatus,
  width: number = terminalWidth(),
): string {
  const body = Math.max(Math.min(width, 100) - 4, 30);
  const lines: string[] = [];
  lines.push("  Automated decisions about you");
  lines.push("  " + "─".repeat(29));
  lines.push("");
  for (const line of wrapPlain(status.disclosure_text ?? "", body)) {
    lines.push(line.length ? "  " + line : "");
  }
  lines.push("");
  lines.push(`  Version:    ${status.consent_version ?? "-"}`);
  lines.push(`  Text hash:  ${status.consent_text_hash ?? "-"}`);
  return lines.join("\n");
}

/**
 * The member's current standing plus the one thing they can type next.
 * Kept separate from the disclosure so `consent list` can show the standing
 * without reprinting the full text.
 */
export function formatAutomatedDecisionStanding(
  status: AutomatedDecisionStatus,
): string {
  if (status.acknowledged) {
    return (
      "  You have acknowledged this, so matching runs for you.\n" +
      "  To take it back:  alter consent automated-decisions --withdraw"
    );
  }
  return (
    "  You have not acknowledged this, so matching does not run for you.\n" +
    "  To acknowledge:   alter consent automated-decisions --acknowledge"
  );
}

/**
 * Map a failed response to copy the member can act on. Never mentions
 * tokens, keys or credentials: the only session remedies a member has are
 * signing in again and asking their administrator.
 */
export function describeAutomatedDecisionFailure(
  action: "read" | "write",
  status: number,
  detail?: string,
): string {
  switch (status) {
    case 400:
      return (
        "the disclosure version you were shown is not one the field accepts. " +
        "Nothing was recorded. Run 'alter consent automated-decisions' again " +
        "to read the current text."
      );
    case 401:
      return "your session is not authenticated. Run 'alter login' to sign in again.";
    case 403:
      return (
        detail ??
        "this is a member surface, and the signed-in identity is not a member record."
      );
    case 404:
      return (
        detail ??
        "no member record was found for this session. Run 'alter status' to see " +
          "what the field holds for you, or ask your administrator to check the record."
      );
    case 422:
      return (
        "the field rejected the acknowledgement as incomplete. Nothing was " +
        "recorded. Run 'alter consent automated-decisions' again."
      );
    default:
      if (status >= 500) {
        return `the field returned a server error (${status}). Nothing was ${
          action === "write" ? "recorded" : "read"
        }. Try again in a moment.`;
      }
      return detail ?? `the field refused the request (${status}).`;
  }
}

/**
 * Read a GET/PUT response into the status object, or print the failure and
 * return null. Sets a non-zero exit code on every failure path so scripts
 * can tell a refusal from a grant.
 */
async function readAutomatedDecisionResponse(
  resp: Response | null,
  action: "read" | "write",
): Promise<AutomatedDecisionStatus | null> {
  if (!resp) {
    console.error(
      "alter consent automated-decisions: not logged in. Run 'alter login' first.",
    );
    process.exitCode = 1;
    return null;
  }
  if (!resp.ok) {
    const body = (await resp.json().catch(() => ({}))) as { detail?: unknown };
    const detail = typeof body.detail === "string" ? body.detail : undefined;
    console.error(
      "alter consent automated-decisions: " +
        describeAutomatedDecisionFailure(action, resp.status, detail),
    );
    process.exitCode = 1;
    return null;
  }
  const data = (await resp.json().catch(() => null)) as AutomatedDecisionStatus | null;
  if (
    !data ||
    typeof data.disclosure_text !== "string" ||
    typeof data.consent_version !== "string"
  ) {
    console.error(
      "alter consent automated-decisions: the field returned a disclosure it " +
        "could not read. Nothing was changed.",
    );
    process.exitCode = 1;
    return null;
  }
  // The PUT mirrors the flag under a longer name; normalise so callers read
  // one field.
  if (typeof data.acknowledged !== "boolean") {
    data.acknowledged = data.automated_decision_acknowledgement === true;
  }
  return data;
}

/**
 * Silent read of the same endpoint for `consent list`. Prints nothing and
 * never touches the exit code: a member reading their ledgers must not have
 * that read fail because this one extra section could not be fetched. The
 * section is omitted or marked unavailable instead. Same rule as
 * `fetchMcpGrants` above.
 */
async function probeAutomatedDecisionStatus(): Promise<AutomatedDecisionStatus | null> {
  try {
    const resp = await apiCall(AUTOMATED_DECISION_ENDPOINT, {});
    if (!resp || !resp.ok) return null;
    const data = (await resp.json().catch(() => null)) as AutomatedDecisionStatus | null;
    if (!data || typeof data.consent_version !== "string") return null;
    if (typeof data.acknowledged !== "boolean") {
      data.acknowledged = data.automated_decision_acknowledgement === true;
    }
    return data;
  } catch {
    return null;
  }
}

/** GET the disclosure and the member's standing on it. */
export async function fetchAutomatedDecisionStatus(
  signal?: AbortSignal,
): Promise<AutomatedDecisionStatus | null> {
  const resp = await apiCall(AUTOMATED_DECISION_ENDPOINT, { signal });
  return readAutomatedDecisionResponse(resp, "read");
}

/**
 * PUT the acknowledgement, carrying the version the member was shown. The
 * version is a required argument rather than an internal default: the point
 * of the record is that it attests to a specific text, and passing anything
 * other than what was printed would make the attestation false.
 */
async function putAutomatedDecisionAcknowledgement(
  acknowledged: boolean,
  consentVersion: string,
): Promise<AutomatedDecisionStatus | null> {
  const wait = await withLoadingCancel(
    (signal) =>
      apiCall(AUTOMATED_DECISION_ENDPOINT, {
        method: "PUT",
        body: { acknowledged, consent_version: consentVersion },
        signal,
      }),
    acknowledged ? "recording acknowledgement" : "withdrawing acknowledgement",
  );
  if (wait.cancelled) return null;
  return readAutomatedDecisionResponse(wait.result, "write");
}

/**
 * Parse `automated-decisions` args.
 *
 * Shape: `consent automated-decisions [--acknowledge | --withdraw] [--yes] [--json]`.
 * With neither write flag the verb is read-only: it prints the disclosure
 * and the standing and writes nothing.
 */
export function parseAutomatedDecisionArgs(args: string[]): {
  mode: "show" | "acknowledge" | "withdraw";
  yes: boolean;
  json: boolean;
  help: boolean;
  conflict: boolean;
} {
  let acknowledge = false;
  let withdraw = false;
  let yes = false;
  let json = false;
  let help = false;
  for (const a of args) {
    if (a === "--acknowledge" || a === "--accept") acknowledge = true;
    else if (a === "--withdraw" || a === "--revoke") withdraw = true;
    else if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--json") json = true;
    else if (a === "--help" || a === "-h") help = true;
    // Unknown flags are ignored, matching parseRevokeArgs - forward-compat
    // with flags a newer field surface may add.
  }
  return {
    mode: acknowledge && !withdraw ? "acknowledge" : withdraw && !acknowledge ? "withdraw" : "show",
    yes,
    json,
    help,
    conflict: acknowledge && withdraw,
  };
}

function printAutomatedDecisionHelp(): void {
  console.log(
    "Usage: alter consent automated-decisions [--acknowledge | --withdraw]\n" +
      "                                         [--yes] [--json]\n" +
      "\n" +
      "Matching is an automated decision about you. Under Article 22 of the\n" +
      "GDPR you have to be told how it works, and acknowledge that you have\n" +
      "been told, before it runs. Until you do, matching does not compute\n" +
      "for you.\n" +
      "\n" +
      "With no flags this reads. It prints the disclosure and tells you where\n" +
      "you stand. Nothing is recorded.\n" +
      "\n" +
      "Options:\n" +
      "  --acknowledge  Record that you have read the disclosure printed above\n" +
      "                 the prompt. Matching runs from then on.\n" +
      "  --withdraw     Take the acknowledgement back. Matching stops.\n" +
      "  --yes          Skip the confirmation prompt. The disclosure is still\n" +
      "                 printed first - there is no way to record an\n" +
      "                 acknowledgement for text you were not shown.\n" +
      "  --json         Emit the field's own response for scripting.\n" +
      "  --help         Show this message.\n",
  );
}

export async function consentAutomatedDecisions(args: string[]): Promise<void> {
  const { mode, yes, json, help, conflict } = parseAutomatedDecisionArgs(args);

  if (help) {
    printAutomatedDecisionHelp();
    return;
  }
  if (conflict) {
    console.error(
      "alter consent automated-decisions: --acknowledge and --withdraw are\n" +
        "  opposites; pass one or the other. Nothing was changed.",
    );
    process.exitCode = 1;
    return;
  }

  const statusWait = await withLoadingCancel(
    (signal) => fetchAutomatedDecisionStatus(signal),
    "loading disclosure",
  );
  if (statusWait.cancelled) return;
  const status = statusWait.result;
  if (!status) return;

  if (json && mode === "show") {
    process.stdout.write(JSON.stringify(status, null, 2) + "\n");
    return;
  }

  // The disclosure is printed before anything else happens, on every path
  // that can write. This is the Article 7(1) obligation, not decoration.
  console.log("");
  console.log(formatAutomatedDecisionDisclosure(status));
  console.log("");

  if (mode === "show") {
    console.log(formatAutomatedDecisionStanding(status));
    console.log("");
    return;
  }

  const wanted = mode === "acknowledge";
  if (wanted === status.acknowledged) {
    console.log(
      wanted
        ? `  You already acknowledged this at version ${status.consent_version}. Nothing was changed.`
        : `  You have not acknowledged this at version ${status.consent_version}. Nothing was changed.`,
    );
    console.log("");
    return;
  }

  if (!yes) {
    const question = wanted
      ? "  You have read the above. Record your acknowledgement?"
      : "  Withdraw your acknowledgement, and stop matching?";
    const confirmed = await askConfirm(question);
    if (!confirmed) {
      console.log("  Cancelled. Nothing was changed.");
      console.log("");
      return;
    }
  }

  const updated = await putAutomatedDecisionAcknowledgement(
    wanted,
    status.consent_version,
  );
  if (!updated) return;

  if (json) {
    process.stdout.write(JSON.stringify(updated, null, 2) + "\n");
    return;
  }

  console.log(
    updated.acknowledged
      ? `  Acknowledged, at version ${updated.consent_version}. Matching runs for you from now on.`
      : `  Withdrawn. Matching no longer runs for you.`,
  );
  console.log(formatAutomatedDecisionStanding(updated));
  console.log("");
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(
    "Usage: alter consent list [--preview] [--json]\n" +
      "       alter consent revoke <type> [--yes]\n" +
      "       alter consent automated-decisions [--acknowledge | --withdraw]\n" +
      "                                         [--yes] [--json]\n" +
      "\n" +
      "Show your consent grants across both authority surfaces:\n" +
      "  • Member-level consent  (assessment, matching, demographic)\n" +
      "  • Stream-level consent  (per OAuth pair / vault pair, with\n" +
      "                          per-purpose grants)\n" +
      "\n" +
      "Both ledgers are append-only - list shows only the active state\n" +
      "(latest event per row).\n" +
      "\n" +
      "Subcommands:\n" +
      "  list                 Show active consent grants.\n" +
      "  revoke               withdraw a grant - shows what changes before you\n" +
      "                       confirm.\n" +
      "  automated-decisions  Read the Article 22 disclosure on matching, and\n" +
      "                       acknowledge or withdraw. Until you acknowledge,\n" +
      "                       matching does not run for you.\n" +
      "\n" +
      "Options (list):\n" +
      "  --preview  Inline what would change if each grant were withdrawn.\n" +
      "  --json     Emit the merged response as JSON for scripting.\n" +
      "\n" +
      "Options (revoke):\n" +
      "  --yes           Skip confirmation prompt.\n" +
      "\n" +
      "Options (automated-decisions):\n" +
      "  --acknowledge   Record that you have read the disclosure just printed.\n" +
      "  --withdraw      Take that acknowledgement back.\n" +
      "  --yes           Skip the confirmation prompt. The disclosure is still\n" +
      "                  printed first, always.\n" +
      "  --json          Emit the field's own response for scripting.\n" +
      "\n" +
      "  --help     Show this message.\n",
  );
}

export async function consent(args: string[]): Promise<void> {
  const sub = args[0];

  // --help short-circuits before the session check so users can inspect
  // the command without being forced through `alter login` first.
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    printHelp();
    return;
  }
  try {
    emitSessionHeartbeat({
      sessionId: String(process.pid),
      workingOn: "alter consent",
    });
  } catch { /* silent - must not block command */ }

  if (!getSession()) {
    failNotLoggedIn();
    return;
  }

  if (sub === "revoke") {
    await consentRevoke(args.slice(1));
    return;
  }

  if (
    sub === "automated-decisions" ||
    sub === "automated-decision" ||
    sub === "article-22"
  ) {
    await consentAutomatedDecisions(args.slice(1));
    return;
  }

  if (sub !== "list") {
    console.error(`alter consent: unknown subcommand '${sub}'.`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  const listArgs = args.slice(1);
  const json = listArgs.includes("--json");
  const preview = listArgs.includes("--preview");
  const wantsHelp =
    listArgs.includes("--help") || listArgs.includes("-h");

  if (wantsHelp) {
    printHelp();
    return;
  }

  const mergedWait = await withLoadingCancel(
    (signal) => fetchMergedConsent(signal),
    "loading consents",
  );
  if (mergedWait.cancelled) return;
  const merged = mergedWait.result!;

  // Best-effort: pull the MCP grant ledger (messaging + alignment) so a
  // member with live peer grants but no paired data sources still sees
  // their real consent posture. A failure here must not block the two
  // HTTP ledgers above; the section is simply omitted on null.
  const mcpPosture = await fetchMcpGrants();

  // Fourth authority surface, and the only one that gates a capability
  // outright: the Article 22 acknowledgement. A member whose matching is
  // blocked has to be able to find that out from the ledger they already
  // know how to read, rather than needing to know a word first.
  const automated = await probeAutomatedDecisionStatus();

  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          ...merged,
          mcp_grants_authored: mcpPosture?.mcp_grants_authored ?? [],
          mcp_grants_received: mcpPosture?.mcp_grants_received ?? [],
          automated_decision_acknowledgement: automated
            ? {
                acknowledged: automated.acknowledged,
                consent_version: automated.consent_version,
                consent_text_hash: automated.consent_text_hash,
              }
            : null,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  console.log("");
  console.log("What you've agreed to share");
  console.log("---------------------------");
  console.log(formatConsentsAsTable(merged.consents));

  // --preview inlines the SERVER's consequence per active grant, read
  // straight off the live row just fetched. The ledger endpoints do not
  // carry `consequence_if_revoked` on these rows today (the per-type
  // revoke-preview endpoint is the only surface that serves it - and
  // `consent revoke` is the only caller of it); when the ledgers do carry
  // it, `rowConsequence` renders it with no CLI change. Until then it
  // shows the honest "unavailable" notice rather than fabricating the
  // cost client-side.
  if (preview && merged.consents.length > 0) {
    console.log("");
    console.log("  Consequences if withdrawn:");
    for (const c of merged.consents) {
      if (c.consent_status !== "granted") continue;
      const consequence = rowConsequence(c);
      console.log(`    ${c.consent_type}:`);
      console.log(`      ${consequence}`);
    }
  }

  // Standing only, never the disclosure body: `list` records nothing, so it
  // has no business printing text an acknowledgement could be read as
  // attesting to. The full disclosure lives behind the verb that writes.
  console.log("");
  console.log("Automated decisions (matching)");
  console.log("------------------------------");
  if (automated) {
    console.log(formatAutomatedDecisionStanding(automated));
    console.log(
      `  Read the disclosure:  alter consent automated-decisions`,
    );
  } else {
    console.log(
      "  Couldn't read where you stand on automated decisions right now. " +
        "Your session is fine; run 'alter consent automated-decisions' to check.",
    );
  }

  console.log("");
  console.log("Per-source data grants");
  console.log("----------------------");
  console.log(formatStreamConsentsAsTable(merged.stream_consents));

  if (preview && merged.stream_consents.length > 0) {
    console.log("");
    console.log("  Consequences if withdrawn:");
    for (const row of merged.stream_consents) {
      const consequence = rowConsequence(row);
      console.log(`    ${row.stream}:`);
      console.log(`      ${consequence}`);
    }
  }

  // Third authority surface: the MCP grant ledger (messaging + alignment).
  // Always shown when the ledger could be read - including when both HTTP
  // ledgers are empty - so live peer grants are never invisible.
  console.log("");
  console.log("Messaging & alignment grants");
  console.log("----------------------------");
  if (mcpPosture) {
    console.log(formatMcpGrants(mcpPosture));
  } else {
    console.log(
      "Couldn't read your messaging/alignment grants right now. " +
        "Your session is fine; try again in a moment.",
    );
  }

  console.log("");
}
