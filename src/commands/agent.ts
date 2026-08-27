/**
 * `alter agent` -- inter-agent communication substrate.
 *
 * Ships the full 7-verb `agent` namespace:
 *
 *   handover   Hand context to a future session.
 *   send       Emit any frame kind to a recipient or fan-out scope.
 *   broadcast  Broadcast a frame to a fan-out scope.
 *   listen     Subscribe to the agent-frame stream (kind/sender/tool filters).
 *   query      Ask a question to a scope and collect responses.
 *   lock       Emit an advisory lock-acquire or lock-release frame.
 *   roster     List online instruments visible to the session.
 *
 * Wire shape: the AgentFrame carries provenance fields, identity
 * trailers (acted_by + drafted_with), and a per-kind structured payload.
 *
 * Transport (handover, send, broadcast, query, lock): POSTs to the
 * messaging endpoint with `Content-Type: application/x-alter-agent`.
 * The DO branches on this content-type to route the frame into the
 * agent surface (existing `text/markdown` path untouched). Auth is
 * the session JWT (Bearer).
 *
 * Transport (listen): GET to the agent SSE stream endpoint, pipes the
 * event stream to stdout in newline-delimited JSON. Ctrl-C to stop.
 *
 * Transport (roster): GET to the agent roster endpoint, renders a
 * table of online instruments.
 *
 * Fallback: none of these verbs require a local runtime daemon. The
 * runtime cache is a performance optimisation; the daemon is not
 * required for correctness. The CLI POSTs/GETs directly against the
 * backend URL.
 *
 * Identity trailers:
 *   acted_by:      sender handle from session.json
 *   drafted_with:  `~alter-cli@<version>` -- the CLI IS the instrument.
 *
 * Locks are ADVISORY at the substrate layer. The `lock` verb emits a
 * signal; it does not enforce exclusive access. Local enforcement
 * (filesystem flock, .git/index.lock) is the caller's responsibility.
 *
 * For `lock` release: pass --release <lease-id> instead of <resource>.
 * A single `lock` verb surfaces both acquire and release through flag
 * disambiguation on the same verb.
 *
 * Usage:
 *   alter agent handover --to <handle> --previous-session-id <id> ...
 *   alter agent send <recipient> --kind <kind> --payload <json> [--quiet]
 *   alter agent broadcast <scope> --kind <kind> --payload <json> [--quiet]
 *   alter agent listen [--kind <kind>] [--sender <handle>] [--tool <t>]
 *   alter agent query <scope> "<question>" [--timeout <duration>]
 *   alter agent lock <resource> [--ttl <duration>] [--release <lease-id>] [--quiet]
 *   alter agent roster [--org <handle>] [--tool <tool>]
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";

import { getSession, isExpired, httpCall } from "../auth.js";
import { getCliVersion } from "../lib/version.js";
import { emitSessionHeartbeat } from "../lib/active-sessions-emit.js";
import { HANDLE_RE } from "../lib/handle-re.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Running CLI version -- read from package.json at module load. */
const CLI_VERSION = getCliVersion();

/**
 * `drafted_with` instrument handle. The CLI is its own authoring
 * surface; this stamp identifies the binary that drafted the frame.
 * The CLI is the instrument, not the human.
 */
export const INSTRUMENT_HANDLE = `~alter-cli@${CLI_VERSION}`;

/** AgentFrame envelope version. */
export const AGENT_FRAME_VERSION = "1.0";

/** Wire content-type discriminator. */
export const AGENT_CONTENT_TYPE = "application/x-alter-agent";

// HANDLE_RE imported from lib/handle-re.ts - canonical backend-aligned pattern.

/**
 * Valid `kind` values for the 12-kind catalogue.
 * The CLI enforces this set on --kind flags so the user gets a clear error
 * before the request hits the backend rather than a 400 from the DO.
 */
const VALID_KINDS = new Set([
  "agent_handover",
  "agent_advisory",
  "agent_broadcast",
  "agent_query",
  "agent_response",
  "agent_lock_request",
  "agent_lock_release",
  "agent_lease_extend",
  "agent_binding_moment",
  "agent_return_event",
  "peer_diagnostic_request",
  "peer_diagnostic_response",
]);

// ---------------------------------------------------------------------------
// Types -- AgentFrame envelope
// ---------------------------------------------------------------------------

export interface HandoverPayload {
  previous_session_id: string;
  next_session_id: string | null;
  handover_body: string;
  pointer_refs: string[];
}

export interface AgentFrame {
  envelope_version: string;
  kind: string;
  frame_id: string;
  sender_handle: string;
  recipient_handle: string;
  created_at: string;
  ledger_kind: "agent_frame";
  payload: unknown;

  // Provenance fields carried on every frame.
  iai_compute_location: "server-active";
  iai_provenance: string[];
  iai_return_event_ref: string | null;
  iai_prohibited_context_check: "passed";
  iai_stream_basis: string;

  // Identity trailers -- the server-active substrate carries the
  // `acted_by` handle plus the drafting `drafted_with` instrument.
  acted_by: string;
  drafted_with: string;
}

// ---------------------------------------------------------------------------
// Argument parsing -- pure functions, exposed for tests
// ---------------------------------------------------------------------------

export interface HandoverArgs {
  to: string | null;
  previous_session_id: string;
  next_session_id: string | null;
  body: string | null;
  file: string | null;
  pointer_refs: string[];
  quiet: boolean;
}

export type HandoverParseResult = HandoverArgs | { error: string };

const HANDOVER_USAGE =
  "Usage: alter agent handover --to <handle> --previous-session-id <id>\n" +
  "                            [--next-session-id <id>]\n" +
  "                            [--body <text> | --file <path> | <stdin>]\n" +
  "                            [--pointer <ref> ...]\n" +
  "                            [--quiet]\n";

/**
 * Normalise + validate a ~handle. Accepts with or without the tilde
 * prefix, lowercases the body, and enforces the canonical regex.
 */
export function normaliseHandle(raw: string | undefined, fieldName: string): string {
  if (!raw || typeof raw !== "string") {
    throw new Error(`${fieldName} is required`);
  }
  const trimmed = raw.trim();
  const withTilde = trimmed.startsWith("~") ? trimmed : `~${trimmed}`;
  const lowered = "~" + withTilde.slice(1).toLowerCase();
  if (!HANDLE_RE.test(lowered)) {
    throw new Error(
      `malformed ${fieldName} "${raw}" -- must match ~[a-z0-9][a-z0-9-]{1,31}`,
    );
  }
  return lowered;
}

/**
 * Parse a duration string like "5m", "30s", "1h" into milliseconds.
 * Accepts bare integers as seconds.
 */
export function parseDurationMs(raw: string): number | null {
  const trimmed = raw.trim();
  const match = /^(\d+)(ms|s|m|h)?$/.exec(trimmed);
  if (!match) return null;
  const n = parseInt(match[1]!, 10);
  switch (match[2] ?? "s") {
    case "ms": return n;
    case "s":  return n * 1000;
    case "m":  return n * 60 * 1000;
    case "h":  return n * 60 * 60 * 1000;
    default:   return null;
  }
}

/**
 * Parse argv for `alter agent handover`. Pure function for testability --
 * never reads stdin, never touches the filesystem; the caller is
 * responsible for resolving --file / stdin contents.
 */
export function parseHandoverArgs(argv: string[]): HandoverParseResult {
  if (argv[0] === "--help" || argv[0] === "-h") {
    return { error: HANDOVER_USAGE };
  }

  let to: string | null = null;
  let previous_session_id: string | null = null;
  let next_session_id: string | null = null;
  let body: string | null = null;
  let file: string | null = null;
  const pointer_refs: string[] = [];
  let quiet = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--to") {
      const v = argv[++i];
      if (!v) return { error: "--to requires a value" };
      to = v;
    } else if (arg === "--previous-session-id") {
      const v = argv[++i];
      if (!v) return { error: "--previous-session-id requires a value" };
      previous_session_id = v;
    } else if (arg === "--next-session-id") {
      const v = argv[++i];
      if (!v) return { error: "--next-session-id requires a value" };
      next_session_id = v;
    } else if (arg === "--body") {
      const v = argv[++i];
      if (v === undefined) return { error: "--body requires a value" };
      body = v;
    } else if (arg === "--file") {
      const v = argv[++i];
      if (!v) return { error: "--file requires a value" };
      file = v;
    } else if (arg === "--pointer") {
      const v = argv[++i];
      if (!v) return { error: "--pointer requires a value" };
      pointer_refs.push(v);
    } else if (arg === "--quiet" || arg === "-q") {
      quiet = true;
    } else {
      return { error: `unknown flag: ${arg}` };
    }
  }

  if (!previous_session_id) {
    return { error: "--previous-session-id is required" };
  }

  // Normalise --to when supplied. Defaulting to the sender's own
  // ~handle for self-fan-out happens at command-runtime (parseArgs has
  // no session context), so leaving `to` null here is fine.
  if (to !== null) {
    try {
      to = normaliseHandle(to, "--to");
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  return {
    to,
    previous_session_id,
    next_session_id,
    body,
    file,
    pointer_refs,
    quiet,
  };
}

// ---------------------------------------------------------------------------
// Send / broadcast arg parsers
// ---------------------------------------------------------------------------

export interface SendArgs {
  recipient: string;
  kind: string;
  payload: unknown;
  quiet: boolean;
}

export type SendParseResult = SendArgs | { error: string };

const SEND_USAGE =
  "Usage: alter agent send <recipient> --kind <kind> --payload <json> [--quiet]\n" +
  "\n" +
  "  <recipient>   Fan-out scope or ~handle (e.g. ~yourhandle/cc-* or ~example)\n" +
  "  --kind        One of the 12 frame kinds (e.g. agent_advisory)\n" +
  "  --payload     JSON-encoded payload object for the chosen kind\n";

export function parseSendArgs(argv: string[]): SendParseResult {
  if (argv[0] === "--help" || argv[0] === "-h") {
    return { error: SEND_USAGE };
  }
  if (!argv[0] || argv[0].startsWith("--")) {
    return { error: "send requires a <recipient> as the first argument\n" + SEND_USAGE };
  }

  const recipient = argv[0];
  let kind: string | null = null;
  let payloadRaw: string | null = null;
  let quiet = false;

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--kind") {
      const v = argv[++i];
      if (!v) return { error: "--kind requires a value" };
      kind = v;
    } else if (a === "--payload") {
      const v = argv[++i];
      if (v === undefined) return { error: "--payload requires a value" };
      payloadRaw = v;
    } else if (a === "--quiet" || a === "-q") {
      quiet = true;
    } else {
      return { error: `unknown flag: ${a}` };
    }
  }

  if (!kind) return { error: "--kind is required" };
  if (!VALID_KINDS.has(kind)) {
    return { error: `unknown kind "${kind}" -- valid kinds: ${[...VALID_KINDS].join(", ")}` };
  }
  if (payloadRaw === null) return { error: "--payload is required" };

  let payload: unknown;
  try {
    payload = JSON.parse(payloadRaw);
  } catch {
    return { error: `--payload is not valid JSON: ${payloadRaw}` };
  }

  return { recipient, kind, payload, quiet };
}

export interface BroadcastArgs {
  scope: string;
  kind: string;
  payload: unknown;
  quiet: boolean;
}

export type BroadcastParseResult = BroadcastArgs | { error: string };

const BROADCAST_USAGE =
  "Usage: alter agent broadcast <scope> --kind <kind> --payload <json> [--quiet]\n" +
  "\n" +
  "  <scope>     Fan-out scope, e.g. ~yourhandle/* or org:<org>/members/*\n" +
  "  --kind      Frame kind (e.g. agent_broadcast, agent_advisory)\n" +
  "  --payload   JSON-encoded payload\n";

export function parseBroadcastArgs(argv: string[]): BroadcastParseResult {
  if (argv[0] === "--help" || argv[0] === "-h") {
    return { error: BROADCAST_USAGE };
  }
  if (!argv[0] || argv[0].startsWith("--")) {
    return { error: "broadcast requires a <scope> as the first argument\n" + BROADCAST_USAGE };
  }

  const scope = argv[0];
  let kind: string | null = null;
  let payloadRaw: string | null = null;
  let quiet = false;

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--kind") {
      const v = argv[++i];
      if (!v) return { error: "--kind requires a value" };
      kind = v;
    } else if (a === "--payload") {
      const v = argv[++i];
      if (v === undefined) return { error: "--payload requires a value" };
      payloadRaw = v;
    } else if (a === "--quiet" || a === "-q") {
      quiet = true;
    } else {
      return { error: `unknown flag: ${a}` };
    }
  }

  if (!kind) return { error: "--kind is required" };
  if (!VALID_KINDS.has(kind)) {
    return { error: `unknown kind "${kind}" -- valid kinds: ${[...VALID_KINDS].join(", ")}` };
  }
  if (payloadRaw === null) return { error: "--payload is required" };

  let payload: unknown;
  try {
    payload = JSON.parse(payloadRaw);
  } catch {
    return { error: `--payload is not valid JSON: ${payloadRaw}` };
  }

  return { scope, kind, payload, quiet };
}

// ---------------------------------------------------------------------------
// Listen arg parser
// ---------------------------------------------------------------------------

export interface ListenArgs {
  kind: string | null;
  sender: string | null;
  tool: string | null;
  since_event_id: string | null;
}

export type ListenParseResult = ListenArgs | { error: string };

const LISTEN_USAGE =
  "Usage: alter agent listen [--kind <kind>] [--sender <handle>]\n" +
  "                          [--tool <cc|codex|cursor|runtime>]\n" +
  "                          [--since <event-id>]\n" +
  "\n" +
  "Streams agent frames matching the filter to stdout (newline-delimited JSON).\n" +
  "Ctrl-C to stop.\n";

export function parseListenArgs(argv: string[]): ListenParseResult {
  if (argv[0] === "--help" || argv[0] === "-h") {
    return { error: LISTEN_USAGE };
  }

  let kind: string | null = null;
  let sender: string | null = null;
  let tool: string | null = null;
  let since_event_id: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--kind") {
      const v = argv[++i];
      if (!v) return { error: "--kind requires a value" };
      if (!VALID_KINDS.has(v)) {
        return { error: `unknown kind "${v}" -- valid kinds: ${[...VALID_KINDS].join(", ")}` };
      }
      kind = v;
    } else if (a === "--sender") {
      const v = argv[++i];
      if (!v) return { error: "--sender requires a value" };
      try {
        sender = normaliseHandle(v, "--sender");
      } catch (err) {
        return { error: (err as Error).message };
      }
    } else if (a === "--tool") {
      const v = argv[++i];
      if (!v) return { error: "--tool requires a value" };
      const VALID_TOOLS = ["cc", "codex", "cursor", "runtime"];
      if (!VALID_TOOLS.includes(v)) {
        return { error: `--tool must be one of: ${VALID_TOOLS.join(", ")}` };
      }
      tool = v;
    } else if (a === "--since") {
      const v = argv[++i];
      if (!v) return { error: "--since requires a value" };
      since_event_id = v;
    } else {
      return { error: `unknown flag: ${a}` };
    }
  }

  return { kind, sender, tool, since_event_id };
}

// ---------------------------------------------------------------------------
// Query arg parser
// ---------------------------------------------------------------------------

export interface QueryArgs {
  scope: string;
  question: string;
  timeout_ms: number;
}

export type QueryParseResult = QueryArgs | { error: string };

const QUERY_USAGE =
  'Usage: alter agent query <scope> "<question>" [--timeout <duration>]\n' +
  "\n" +
  "  <scope>       Fan-out scope or ~handle\n" +
  '  "<question>"  The question text (second positional argument)\n' +
  "  --timeout     Response collection window (default 5s; e.g. 30s, 1m)\n" +
  "\n" +
  "Emits the query frame and prints the query_id. Observe responses via\n" +
  "`alter agent listen --kind agent_response`.\n";

export function parseQueryArgs(argv: string[]): QueryParseResult {
  if (argv[0] === "--help" || argv[0] === "-h") {
    return { error: QUERY_USAGE };
  }
  if (!argv[0] || argv[0].startsWith("--")) {
    return { error: "query requires a <scope> as the first argument\n" + QUERY_USAGE };
  }
  if (!argv[1] || argv[1].startsWith("--")) {
    return { error: 'query requires a "<question>" as the second argument\n' + QUERY_USAGE };
  }

  const scope = argv[0];
  const question = argv[1];
  let timeout_ms = 5000; // default 5s

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--timeout") {
      const v = argv[++i];
      if (!v) return { error: "--timeout requires a value (e.g. 5s, 30s, 1m)" };
      const ms = parseDurationMs(v);
      if (ms === null) return { error: `--timeout value "${v}" is not a valid duration` };
      timeout_ms = ms;
    } else {
      return { error: `unknown flag: ${a}` };
    }
  }

  return { scope, question, timeout_ms };
}

// ---------------------------------------------------------------------------
// Lock arg parser
// ---------------------------------------------------------------------------

export interface LockArgs {
  resource: string | null;
  ttl_ms: number;
  release_lease_id: string | null;
  quiet: boolean;
}

export type LockParseResult = LockArgs | { error: string };

const LOCK_USAGE =
  "Usage: alter agent lock <resource> [--ttl <duration>] [--quiet]\n" +
  "       alter agent lock --release <lease-id>           [--quiet]\n" +
  "\n" +
  "  <resource>       Resource to claim advisory lock on (e.g. src/auth.ts)\n" +
  "  --ttl            Lock duration (default 5m; max 60m)\n" +
  "  --release        Release an existing lease by ID (emits lock_release frame)\n" +
  "\n" +
  "Locks are ADVISORY at the substrate layer. This verb\n" +
  "emits a signal; it does not enforce exclusive access. Local enforcement\n" +
  "(filesystem flock, .git/index.lock) is the caller's responsibility.\n";

export function parseLockArgs(argv: string[]): LockParseResult {
  if (argv[0] === "--help" || argv[0] === "-h") {
    return { error: LOCK_USAGE };
  }

  let resource: string | null = null;
  let ttl_ms = 5 * 60 * 1000; // default 5 min
  let release_lease_id: string | null = null;
  let quiet = false;

  // First positional -- resource (unless --release is the first token)
  let i = 0;
  if (argv[0] && !argv[0].startsWith("--")) {
    resource = argv[0];
    i = 1;
  }

  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ttl") {
      const v = argv[++i];
      if (!v) return { error: "--ttl requires a value (e.g. 5m, 30s)" };
      const ms = parseDurationMs(v);
      if (ms === null) return { error: `--ttl value "${v}" is not a valid duration` };
      const MAX_TTL_MS = 60 * 60 * 1000; // 60 min payload constraint
      if (ms > MAX_TTL_MS) return { error: "--ttl exceeds maximum of 60m" };
      ttl_ms = ms;
    } else if (a === "--release") {
      const v = argv[++i];
      if (!v) return { error: "--release requires a lease-id value" };
      release_lease_id = v;
    } else if (a === "--quiet" || a === "-q") {
      quiet = true;
    } else {
      return { error: `unknown flag: ${a}` };
    }
  }

  // Either resource or --release must be supplied; not both.
  if (release_lease_id !== null && resource !== null) {
    return { error: "--release and <resource> are mutually exclusive; use one at a time" };
  }
  if (release_lease_id === null && resource === null) {
    return { error: "lock requires a <resource> argument or --release <lease-id>\n" + LOCK_USAGE };
  }

  return { resource, ttl_ms, release_lease_id, quiet };
}

// ---------------------------------------------------------------------------
// Roster arg parser
// ---------------------------------------------------------------------------

export interface RosterArgs {
  org: string | null;
  tool: string | null;
}

export type RosterParseResult = RosterArgs | { error: string };

const ROSTER_USAGE =
  "Usage: alter agent roster [--org <handle>] [--tool <cc|codex|cursor|runtime>]\n" +
  "\n" +
  "Lists online instruments visible to the current session. Without filters,\n" +
  "shows all instruments for the current ~handle.\n";

export function parseRosterArgs(argv: string[]): RosterParseResult {
  if (argv[0] === "--help" || argv[0] === "-h") {
    return { error: ROSTER_USAGE };
  }

  let org: string | null = null;
  let tool: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--org") {
      const v = argv[++i];
      if (!v) return { error: "--org requires a value" };
      try {
        org = normaliseHandle(v, "--org");
      } catch (err) {
        return { error: (err as Error).message };
      }
    } else if (a === "--tool") {
      const v = argv[++i];
      if (!v) return { error: "--tool requires a value" };
      const VALID_TOOLS = ["cc", "codex", "cursor", "runtime"];
      if (!VALID_TOOLS.includes(v)) {
        return { error: `--tool must be one of: ${VALID_TOOLS.join(", ")}` };
      }
      tool = v;
    } else {
      return { error: `unknown flag: ${a}` };
    }
  }

  return { org, tool };
}

// ---------------------------------------------------------------------------
// Envelope construction -- pure functions, exposed for tests
// ---------------------------------------------------------------------------

export interface BuildEnvelopeInput {
  sender_handle: string;
  recipient_handle: string;
  previous_session_id: string;
  next_session_id: string | null;
  handover_body: string;
  pointer_refs: string[];
  /** Override the UUID generator -- tests pin a deterministic id. */
  frame_id?: string;
  /** Override the timestamp -- tests pin a deterministic ISO string. */
  created_at?: string;
}

/**
 * Build an `agent_handover` AgentFrame.
 * Pure function -- no I/O, no clock reads unless caller omits
 * `created_at`. Tests pin both `frame_id` and `created_at` for
 * deterministic shape assertions.
 */
export function buildHandoverEnvelope(input: BuildEnvelopeInput): AgentFrame {
  const frame_id = input.frame_id ?? crypto.randomUUID();
  const created_at = input.created_at ?? new Date().toISOString();

  return {
    envelope_version: AGENT_FRAME_VERSION,
    kind: "agent_handover",
    frame_id,
    sender_handle: input.sender_handle,
    recipient_handle: input.recipient_handle,
    created_at,
    ledger_kind: "agent_frame",
    payload: {
      previous_session_id: input.previous_session_id,
      next_session_id: input.next_session_id,
      handover_body: input.handover_body,
      pointer_refs: input.pointer_refs,
    } satisfies HandoverPayload,

    // Provenance fields carried on every frame. `server-active` matches
    // the alter-cli direct-POST path (compute happens at the backend,
    // against the active session). The `prohibited_context_check` is
    // `passed` because handover is a same-handle / cross-tool
    // coordination surface, never workforce-inference, education-
    // inference, or affect-inference.
    iai_compute_location: "server-active",
    iai_provenance: ["alter-cli.agent.handover"],
    iai_return_event_ref: null,
    iai_prohibited_context_check: "passed",
    iai_stream_basis: "agent_handover.cli",

    // Identity trailers. `acted_by` carries the sender handle;
    // `drafted_with` carries the CLI instrument stamp.
    acted_by: input.sender_handle,
    drafted_with: INSTRUMENT_HANDLE,
  };
}

// ---------------------------------------------------------------------------
// Shared session helpers
// ---------------------------------------------------------------------------

interface ResolvedSession {
  handle: string;
  jwt: string;
  apiBase: string;
}

/**
 * Resolve and validate the active session. Returns null (after writing to
 * stderr and setting exitCode) if the session is missing or expired.
 * Callers MUST return immediately on null.
 */
function requireSession(): ResolvedSession | null {
  if (isExpired()) {
    process.stderr.write(
      "alter: session expired -- run `alter login` and retry\n",
    );
    process.exitCode = 2;
    return null;
  }
  const session = getSession();
  if (!session) {
    process.stderr.write(
      "alter: not logged in -- run `alter login` and retry\n",
    );
    process.exitCode = 2;
    return null;
  }
  const apiBase = (session.api ?? "").replace(/\/+$/, "");
  if (!apiBase) {
    process.stderr.write("alter: session is missing api base\n");
    process.exitCode = 2;
    return null;
  }
  return { handle: session.handle, jwt: session.jwt as string, apiBase };
}

/**
 * Build the common provenance + identity fields for a generic outbound frame.
 * Each verb supplies a distinct `iai_stream_basis` that identifies
 * the verb path in the provenance chain.
 */
function buildBaseFrame(
  senderHandle: string,
  recipientHandle: string,
  kind: string,
  payload: unknown,
  streamBasis: string,
  overrides?: { frame_id?: string; created_at?: string },
): AgentFrame {
  return {
    envelope_version: AGENT_FRAME_VERSION,
    kind,
    frame_id: overrides?.frame_id ?? crypto.randomUUID(),
    sender_handle: senderHandle,
    recipient_handle: recipientHandle,
    created_at: overrides?.created_at ?? new Date().toISOString(),
    ledger_kind: "agent_frame",
    payload,
    iai_compute_location: "server-active",
    iai_provenance: [`alter-cli.agent.${kind}`],
    iai_return_event_ref: null,
    iai_prohibited_context_check: "passed",
    iai_stream_basis: streamBasis,
    acted_by: senderHandle,
    drafted_with: INSTRUMENT_HANDLE,
  };
}

/**
 * POST an AgentFrame to the backend messaging endpoint.
 * Returns the HTTP response object; caller handles non-2xx.
 */
async function postFrame(
  apiBase: string,
  jwt: string,
  envelope: AgentFrame,
): Promise<Response> {
  return httpCall(apiBase + "/api/v1/messaging/agent", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": AGENT_CONTENT_TYPE,
      Accept: "application/json",
    },
    body: JSON.stringify(envelope),
  });
}

// ---------------------------------------------------------------------------
// Runtime entry -- `alter agent handover`
// ---------------------------------------------------------------------------

function readStdin(): string {
  if (process.stdin.isTTY) return "";
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * Resolve the handover body from one of three sources, in order:
 *   1. --body flag (literal text)
 *   2. --file flag (read from disk)
 *   3. stdin (non-TTY only)
 *
 * Returns null when no source supplies a non-empty body.
 */
function resolveBody(args: HandoverArgs): string | { error: string } | null {
  if (args.body !== null) {
    if (!args.body.trim()) {
      return { error: "--body must be non-empty" };
    }
    return args.body;
  }
  if (args.file !== null) {
    try {
      const contents = fs.readFileSync(args.file, "utf8");
      if (!contents.trim()) {
        return { error: `--file ${args.file} is empty` };
      }
      return contents;
    } catch (err) {
      return { error: `--file ${args.file} unreadable: ${(err as Error).message}` };
    }
  }
  const stdin = readStdin();
  if (stdin.trim()) return stdin;
  return null;
}

/**
 * Implementation of `alter agent handover`. Resolves session, builds
 * the AgentFrame, POSTs against the messaging endpoint with the
 * `application/x-alter-agent` Content-Type header.
 */
async function cmdHandover(argv: string[]): Promise<void> {
  const parsed = parseHandoverArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(parsed.error + "\n");
    process.exitCode = 1;
    return;
  }

  try {
    emitSessionHeartbeat({
      sessionId: String(process.pid),
      workingOn: "alter agent handover",
    });
  } catch {
    /* silent -- must not block command */
  }

  const session = requireSession();
  if (!session) return;
  const { handle, jwt, apiBase } = session;

  // Default recipient to sender's own handle for self-fan-out.
  // Same-handle is implicit; no grant required.
  const recipient = parsed.to ?? handle;

  const bodyOrErr = resolveBody(parsed);
  if (bodyOrErr === null) {
    process.stderr.write(
      "alter: handover body is empty -- supply via --body, --file, or stdin\n",
    );
    process.exitCode = 1;
    return;
  }
  if (typeof bodyOrErr === "object" && "error" in bodyOrErr) {
    process.stderr.write(`alter: ${bodyOrErr.error}\n`);
    process.exitCode = 1;
    return;
  }

  const envelope = buildHandoverEnvelope({
    sender_handle: handle,
    recipient_handle: recipient,
    previous_session_id: parsed.previous_session_id,
    next_session_id: parsed.next_session_id,
    handover_body: bodyOrErr,
    pointer_refs: parsed.pointer_refs,
  });

  // Direct POST to the messaging endpoint (runtime cache is a
  // performance optimisation, not correctness).
  let response: Response;
  try {
    response = await postFrame(apiBase, jwt, envelope);
  } catch (err) {
    process.stderr.write(
      `alter: agent handover transport error: ${(err as Error).message}\n`,
    );
    process.exitCode = 3;
    return;
  }

  if (!response.ok) {
    let detail: string;
    try {
      detail = await response.text();
    } catch {
      detail = "(no body)";
    }
    process.stderr.write(
      `alter: handover rejected (HTTP ${response.status}): ${detail}\n`,
    );
    process.exitCode = 4;
    return;
  }

  if (!parsed.quiet) {
    process.stdout.write(
      `handover sent → ${recipient} frame=${envelope.frame_id}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Runtime entry -- `alter agent send`
// ---------------------------------------------------------------------------

/**
 * `alter agent send <recipient> --kind <kind> --payload <json>`
 *
 * Emits any frame kind to a recipient scope. This is the generic dispatch
 * path wrapping `alter_agent_send`.
 */
async function cmdSend(argv: string[]): Promise<void> {
  const parsed = parseSendArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(parsed.error + "\n");
    process.exitCode = 1;
    return;
  }

  try {
    emitSessionHeartbeat({
      sessionId: String(process.pid),
      workingOn: "alter agent send",
    });
  } catch {
    /* silent */
  }

  const session = requireSession();
  if (!session) return;
  const { handle, jwt, apiBase } = session;

  const envelope = buildBaseFrame(
    handle,
    parsed.recipient,
    parsed.kind,
    parsed.payload,
    `agent.send.${parsed.kind}.cli`,
  );

  let response: Response;
  try {
    response = await postFrame(apiBase, jwt, envelope);
  } catch (err) {
    process.stderr.write(
      `alter: agent send transport error: ${(err as Error).message}\n`,
    );
    process.exitCode = 3;
    return;
  }

  if (!response.ok) {
    let detail: string;
    try {
      detail = await response.text();
    } catch {
      detail = "(no body)";
    }
    process.stderr.write(
      `alter: send rejected (HTTP ${response.status}): ${detail}\n`,
    );
    process.exitCode = 4;
    return;
  }

  if (!parsed.quiet) {
    process.stdout.write(
      `sent ${parsed.kind} -> ${parsed.recipient} frame=${envelope.frame_id}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Runtime entry -- `alter agent broadcast`
// ---------------------------------------------------------------------------

/**
 * `alter agent broadcast <scope> --kind <kind> --payload <json>`
 *
 * Broadcasts a frame to a fan-out scope, wrapping `alter_agent_broadcast`.
 * The backend enforces scope grant rules; cross-organisation delivery
 * requires explicit grant and is x402-priced.
 */
async function cmdBroadcast(argv: string[]): Promise<void> {
  const parsed = parseBroadcastArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(parsed.error + "\n");
    process.exitCode = 1;
    return;
  }

  try {
    emitSessionHeartbeat({
      sessionId: String(process.pid),
      workingOn: "alter agent broadcast",
    });
  } catch {
    /* silent */
  }

  const session = requireSession();
  if (!session) return;
  const { handle, jwt, apiBase } = session;

  const envelope = buildBaseFrame(
    handle,
    parsed.scope,
    parsed.kind,
    parsed.payload,
    `agent.broadcast.${parsed.kind}.cli`,
  );

  let response: Response;
  try {
    response = await postFrame(apiBase, jwt, envelope);
  } catch (err) {
    process.stderr.write(
      `alter: agent broadcast transport error: ${(err as Error).message}\n`,
    );
    process.exitCode = 3;
    return;
  }

  if (!response.ok) {
    let detail: string;
    try {
      detail = await response.text();
    } catch {
      detail = "(no body)";
    }
    process.stderr.write(
      `alter: broadcast rejected (HTTP ${response.status}): ${detail}\n`,
    );
    process.exitCode = 4;
    return;
  }

  if (!parsed.quiet) {
    // The backend returns recipient_count in the response body when available.
    let recipientCount: number | null = null;
    try {
      const body = JSON.parse(await response.text()) as { recipient_count?: number };
      recipientCount = body.recipient_count ?? null;
    } catch {
      // Non-JSON or already-consumed body -- skip count rendering.
    }
    const countStr = recipientCount !== null ? ` (${recipientCount} recipients)` : "";
    process.stdout.write(
      `broadcast ${parsed.kind} -> ${parsed.scope}${countStr} frame=${envelope.frame_id}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Runtime entry -- `alter agent listen`
// ---------------------------------------------------------------------------

/**
 * `alter agent listen [--kind <k>] [--sender <h>] [--tool <t>]`
 *
 * Subscribes to the per-~handle agent-frame SSE stream. Frames matching
 * the filter are written to stdout as newline-delimited JSON. The stream
 * continues until Ctrl-C; no timeout by design (use shell pipes to limit).
 *
 * Wraps the `alter_agent_subscribe` MCP verb and its DO-side subscription
 * filtering. Filter expressions are forwarded as query params to the
 * backend SSE endpoint.
 */
async function cmdListen(argv: string[]): Promise<void> {
  const parsed = parseListenArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(parsed.error + "\n");
    process.exitCode = 1;
    return;
  }

  try {
    emitSessionHeartbeat({
      sessionId: String(process.pid),
      workingOn: "alter agent listen",
    });
  } catch {
    /* silent */
  }

  const listenSession = requireSession();
  if (!listenSession) return;
  const { jwt, apiBase } = listenSession;

  // Build the filter query string forwarded to the backend SSE endpoint.
  const params = new URLSearchParams();
  if (parsed.kind) params.set("kind", parsed.kind);
  if (parsed.sender) params.set("sender_handle", parsed.sender);
  if (parsed.tool) params.set("tool", parsed.tool);
  if (parsed.since_event_id) params.set("since_event_id", parsed.since_event_id);

  const qs = params.toString();
  const url = `${apiBase}/api/v1/messaging/agent/stream${qs ? `?${qs}` : ""}`;

  let response: Response;
  try {
    response = await httpCall(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "text/event-stream",
      },
    });
  } catch (err) {
    process.stderr.write(
      `alter: agent listen transport error: ${(err as Error).message}\n`,
    );
    process.exitCode = 3;
    return;
  }

  if (!response.ok) {
    let detail: string;
    try {
      detail = await response.text();
    } catch {
      detail = "(no body)";
    }
    process.stderr.write(
      `alter: listen rejected (HTTP ${response.status}): ${detail}\n`,
    );
    process.exitCode = 4;
    return;
  }

  if (!response.body) {
    process.stderr.write("alter: agent listen: no response body (stream unavailable)\n");
    process.exitCode = 4;
    return;
  }

  // Stream SSE events to stdout as newline-delimited JSON.
  // Each SSE `data:` line is emitted as-is; the consumer (script, jq, etc.)
  // handles parsing. `id:` and `event:` fields are silently stripped.
  process.stderr.write(
    `alter: listening for agent frames (Ctrl-C to stop)...\n`,
  );

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (data && data !== "[DONE]") {
            process.stdout.write(data + "\n");
          }
        }
      }
    }
  } catch {
    // Stream closed (Ctrl-C or connection drop) -- exit cleanly.
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Runtime entry -- `alter agent query`
// ---------------------------------------------------------------------------

/**
 * `alter agent query <scope> "<question>" [--timeout <duration>]`
 *
 * Emits the `agent_query` frame and prints the query_id. Full server-side
 * response collection (block + gather) ships in a later phase.
 *
 * Wraps `alter_agent_query`. The `query_id` returned from the backend
 * correlates with eventual `agent_response` frames the caller can observe
 * via `alter agent listen --kind agent_response`.
 */
async function cmdQuery(argv: string[]): Promise<void> {
  const parsed = parseQueryArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(parsed.error + "\n");
    process.exitCode = 1;
    return;
  }

  try {
    emitSessionHeartbeat({
      sessionId: String(process.pid),
      workingOn: "alter agent query",
    });
  } catch {
    /* silent */
  }

  const querySession = requireSession();
  if (!querySession) return;
  const { handle, jwt, apiBase } = querySession;

  const query_id = crypto.randomUUID();

  const envelope = buildBaseFrame(
    handle,
    parsed.scope,
    "agent_query",
    {
      query_text: parsed.question,
      query_id,
      response_scope: parsed.scope,
      timeout_ms: parsed.timeout_ms,
    },
    "agent.query.cli",
  );

  let response: Response;
  try {
    response = await postFrame(apiBase, jwt, envelope);
  } catch (err) {
    process.stderr.write(
      `alter: agent query transport error: ${(err as Error).message}\n`,
    );
    process.exitCode = 3;
    return;
  }

  if (!response.ok) {
    let detail: string;
    try {
      detail = await response.text();
    } catch {
      detail = "(no body)";
    }
    process.stderr.write(
      `alter: query rejected (HTTP ${response.status}): ${detail}\n`,
    );
    process.exitCode = 4;
    return;
  }

  // Print the query_id so the caller can correlate responses observed
  // via `alter agent listen --kind agent_response`.
  process.stdout.write(
    `query emitted -> ${parsed.scope} query_id=${query_id} timeout=${parsed.timeout_ms}ms\n` +
    `  (observe responses via \`alter agent listen --kind agent_response\`)\n`,
  );
}

// ---------------------------------------------------------------------------
// Runtime entry -- `alter agent lock`
// ---------------------------------------------------------------------------

/**
 * `alter agent lock <resource> [--ttl <duration>] [--quiet]`
 * `alter agent lock --release <lease-id>           [--quiet]`
 *
 * Emits an advisory `agent_lock_request` or `agent_lock_release` frame.
 * The lock is ADVISORY at the substrate layer; sibling sessions observing
 * the frame SHOULD defer to the lease but the substrate cannot compel them.
 *
 * Wraps `alter_agent_lock_acquire` and `alter_agent_lock_release`.
 *
 * A single `lock` verb surfaces both acquire and release: release goes
 * through `--release <lease-id>` on the same verb so the namespace stays
 * flat and the advisory pair is co-located in the same command.
 */
async function cmdLock(argv: string[]): Promise<void> {
  const parsed = parseLockArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(parsed.error + "\n");
    process.exitCode = 1;
    return;
  }

  try {
    emitSessionHeartbeat({
      sessionId: String(process.pid),
      workingOn: "alter agent lock",
    });
  } catch {
    /* silent */
  }

  const lockSession = requireSession();
  if (!lockSession) return;
  const { handle, jwt, apiBase } = lockSession;

  let envelope: AgentFrame;
  let confirmLine: string;

  if (parsed.release_lease_id !== null) {
    // Lock release -- wraps alter_agent_lock_release.
    // The resource field is required in the lock_release payload;
    // the release payload carries lease_id + resource, and resource
    // is set to the empty string here as the CLI caller may not know it.
    envelope = buildBaseFrame(
      handle,
      `~${handle.slice(1)}/*`, // self fan-out -- advisory release broadcast
      "agent_lock_release",
      {
        lease_id: parsed.release_lease_id,
        resource: "",
      },
      "agent.lock_release.cli",
    );
    confirmLine = `lock released lease=${parsed.release_lease_id} frame=${envelope.frame_id}\n`;
  } else {
    // Lock acquire -- wraps alter_agent_lock_acquire.
    const lease_id = crypto.randomUUID();
    envelope = buildBaseFrame(
      handle,
      `~${handle.slice(1)}/*`, // self fan-out -- advisory acquire broadcast
      "agent_lock_request",
      {
        resource: parsed.resource!,
        lease_id,
        ttl_ms: parsed.ttl_ms,
        intent: null,
      },
      "agent.lock_request.cli",
    );
    confirmLine = `lock acquired resource="${parsed.resource}" lease=${lease_id} ttl=${parsed.ttl_ms}ms frame=${envelope.frame_id}\n`;
  }

  let response: Response;
  try {
    response = await postFrame(apiBase, jwt, envelope);
  } catch (err) {
    process.stderr.write(
      `alter: agent lock transport error: ${(err as Error).message}\n`,
    );
    process.exitCode = 3;
    return;
  }

  if (!response.ok) {
    let detail: string;
    try {
      detail = await response.text();
    } catch {
      detail = "(no body)";
    }
    process.stderr.write(
      `alter: lock rejected (HTTP ${response.status}): ${detail}\n`,
    );
    process.exitCode = 4;
    return;
  }

  if (!parsed.quiet) {
    process.stdout.write(confirmLine);
  }
}

// ---------------------------------------------------------------------------
// Runtime entry -- `alter agent roster`
// ---------------------------------------------------------------------------

interface RosterEntry {
  handle?: string;
  instrument?: string;
  tool?: string;
  session_id?: string;
  started_at?: string;
  last_heartbeat?: string;
}

/**
 * `alter agent roster [--org <handle>] [--tool <tool>]`
 *
 * Lists online instruments visible to the current session, wrapping
 * `alter_agent_roster`. Returns a table of active agents with handle,
 * instrument, tool, session_id, and timing.
 *
 * The backend GETs the roster from the DO's active-sessions view
 * filtered to the agent channel. The `--org` flag narrows to a specific
 * Org Alter; `--tool` narrows to a specific tool surface.
 */
async function cmdRoster(argv: string[]): Promise<void> {
  const parsed = parseRosterArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(parsed.error + "\n");
    process.exitCode = 1;
    return;
  }

  try {
    emitSessionHeartbeat({
      sessionId: String(process.pid),
      workingOn: "alter agent roster",
    });
  } catch {
    /* silent */
  }

  const rosterSession = requireSession();
  if (!rosterSession) return;
  const { jwt, apiBase } = rosterSession;

  const params = new URLSearchParams();
  if (parsed.org) params.set("org", parsed.org);
  if (parsed.tool) params.set("tool", parsed.tool);

  const qs = params.toString();
  const url = `${apiBase}/api/v1/messaging/agent/roster${qs ? `?${qs}` : ""}`;

  let response: Response;
  try {
    response = await httpCall(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/json",
      },
    });
  } catch (err) {
    process.stderr.write(
      `alter: agent roster transport error: ${(err as Error).message}\n`,
    );
    process.exitCode = 3;
    return;
  }

  if (!response.ok) {
    let detail: string;
    try {
      detail = await response.text();
    } catch {
      detail = "(no body)";
    }
    process.stderr.write(
      `alter: roster rejected (HTTP ${response.status}): ${detail}\n`,
    );
    process.exitCode = 4;
    return;
  }

  let entries: RosterEntry[];
  try {
    const body = await response.json() as { instruments?: RosterEntry[]; roster?: RosterEntry[] };
    entries = body.instruments ?? body.roster ?? [];
  } catch {
    process.stderr.write("alter: roster response was not valid JSON\n");
    process.exitCode = 4;
    return;
  }

  if (entries.length === 0) {
    process.stdout.write("No online instruments found.\n");
    return;
  }

  // Render as a simple aligned table -- no chalk dependency required.
  const COL = { handle: 20, instrument: 24, tool: 10, session_id: 38 };
  const header =
    "HANDLE".padEnd(COL.handle) +
    "INSTRUMENT".padEnd(COL.instrument) +
    "TOOL".padEnd(COL.tool) +
    "SESSION\n";
  const divider = "-".repeat(COL.handle + COL.instrument + COL.tool + COL.session_id) + "\n";
  process.stdout.write(header + divider);

  for (const e of entries) {
    const row =
      (e.handle ?? "-").padEnd(COL.handle) +
      (e.instrument ?? "-").padEnd(COL.instrument) +
      (e.tool ?? "-").padEnd(COL.tool) +
      (e.session_id ?? "-") +
      "\n";
    process.stdout.write(row);
  }
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

function printAgentHelp(): void {
  process.stdout.write(
    "alter agent -- Coordinate between your concurrent ~Alter sessions.\n" +
      "\n" +
      "Subcommands:\n" +
      "  handover    Hand context off to a future session.\n" +
      "  send        Emit any frame kind to a recipient or fan-out scope.\n" +
      "  broadcast   Broadcast a frame kind to a fan-out scope.\n" +
      "  listen      Subscribe to the agent-frame stream (kind/sender/tool filters).\n" +
      "  query       Ask a question to a scope (emits + returns query_id).\n" +
      "  lock        Emit an advisory lock-acquire or lock-release frame.\n" +
      "  roster      List online instruments visible to the current session.\n" +
      "\n" +
      "Run `alter agent <subcommand> --help` for per-subcommand usage.\n" +
      "\n" +
      "Locks are ADVISORY at the substrate layer.\n" +
      "Listen streams until Ctrl-C; use shell pipes to limit output.\n",
  );
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export async function agent(argv: string[]): Promise<void> {
  const sub = argv[0];
  switch (sub) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printAgentHelp();
      return;
    case "handover":
      await cmdHandover(argv.slice(1));
      return;
    case "send":
      await cmdSend(argv.slice(1));
      return;
    case "broadcast":
      await cmdBroadcast(argv.slice(1));
      return;
    case "listen":
      await cmdListen(argv.slice(1));
      return;
    case "query":
      await cmdQuery(argv.slice(1));
      return;
    case "lock":
      await cmdLock(argv.slice(1));
      return;
    case "roster":
      await cmdRoster(argv.slice(1));
      return;
    default:
      process.stderr.write(`alter agent: unknown subcommand "${sub}"\n`);
      process.stderr.write("Run `alter agent help` for usage.\n");
      process.exitCode = 1;
      return;
  }
}
