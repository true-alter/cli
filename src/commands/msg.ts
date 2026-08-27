/**
 * alter msg - direct messenger command family.
 *
 * Wraps the shipped alter_message_* MCP tools via @truealter/sdk's
 * AlterClient. Implements identity trailers on every send, an 8 KiB
 * NFC-normalised body ceiling, the rate-limit surface, and handle
 * normalisation against the canonical regex.
 *
 * Subcommands:
 *   alter msg                          list unread inbox (shorthand)
 *   alter msg inbox [--all] [--limit]  list inbox (unread only by default)
 *   alter msg thread <handle>          bidirectional thread view
 *   alter msg send <handle> <body...>  send a message
 *   alter msg read <message-ids...>    mark inbound messages as read
 *   alter msg grant <handle>           grant a peer permission to message you
 *   alter msg revoke <handle>          revoke a peer's grant
 *
 * Auth flow - reads ~/.config/alter/session.json for the member API
 * key and signing kid/private-key pair. No hard-coded base URLs:
 * AlterClient defaults to discovery against DEFAULT_DOMAIN, which the
 * SDK owns. If the session predates member-key provisioning the
 * command explains how to recover.
 */

import chalk from "chalk";
import {
  AlterClient,
  AlterAuthError,
  AlterRateLimited,
  AlterToolError,
  type MCPCallToolResult,
  type MCPContentBlock,
} from "@truealter/sdk";

import { failNotLoggedIn, getSession, sessionRejectedMessage } from "../auth.js";
import { getMcpExtraHeaders } from "../lib/cf-access-headers.js";
import { getCliVersion } from "../lib/version.js";
import { resolveBoundSigningKey, SigningKeyMismatchError } from "../signing.js";
import { openMessenger } from "../messenger/index.js";
import { emitSessionHeartbeat } from "../lib/active-sessions-emit.js";
import { HANDLE_RE } from "../lib/handle-re.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Body ceiling - 8 KiB UTF-8 NFC. */
const BODY_CEILING_BYTES = 8 * 1024;


/** Running CLI version - read from package.json at load, never a literal (see lib/version.ts). */
const CLI_VERSION = getCliVersion();

/** Instrument handle emitted in the `drafted_with` identity trailer. */
const INSTRUMENT_HANDLE = `~alter-cli@${CLI_VERSION}`;

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

interface InboxEntry {
  message_id?: string;
  id?: string;
  from?: string;
  sender?: string;
  sent_at?: string;
  created_at?: string;
  read?: boolean;
  unread?: boolean;
  /** Backend read-state: ISO timestamp when read, null/absent when unread. */
  read_at?: string | null;
  body?: string;
  body_md?: string;
  preview?: string;
  direction?: string;
}

interface InboxPayload {
  messages?: InboxEntry[];
  items?: InboxEntry[];
}

interface SendPayload {
  event_id?: string;
  message_id?: string;
  id?: string;
  status?: string;
}

interface ReadPayload {
  marked?: number;
  count?: number;
}

interface ErrorContext {
  peer?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise and validate a ~handle. Accepts with or without the tilde
 * prefix, lowercases the body, and enforces the canonical regex. Throws
 * a user-facing Error on malformed input.
 */
function normaliseHandle(raw: string | undefined, fieldName = "handle"): string {
  if (!raw || typeof raw !== "string") {
    throw new Error(`${fieldName} is required`);
  }
  const trimmed = raw.trim();
  const withTilde = trimmed.startsWith("~") ? trimmed : `~${trimmed}`;
  const lowered = "~" + withTilde.slice(1).toLowerCase();
  if (!HANDLE_RE.test(lowered)) {
    throw new Error(
      `malformed ${fieldName} "${raw}" - must match ~[a-z0-9][a-z0-9-]{1,31}`,
    );
  }
  return lowered;
}

/**
 * Require an authenticated session carrying both a member API key and
 * a signing kid/private key. Returns the fully-provisioned client,
 * or null after printing a clear remediation message and setting
 * exit code 1 (soft exit - a hard process.exit() races libuv handle
 * teardown on Windows). Callers MUST return immediately on null.
 */
export function requireAuthedClient(): { client: AlterClient; handle: string } | null {
  const session = getSession();
  if (!session) {
    failNotLoggedIn();
    return null;
  }
  if (!session.member_api_key) {
    console.error(
      chalk.red("No member API key on this session. Run `alter key member rotate`."),
    );
    process.exitCode = 1;
    return null;
  }
  if (!session.signing_kid) {
    console.error(
      chalk.red(
        "No signing kid on this session. Run `alter login` again to provision one.",
      ),
    );
    process.exitCode = 1;
    return null;
  }
  // Bound resolution: throws when the resolved key does not match the
  // session's kid. Refuse to sign on mismatch, never use another key.
  let privateKeyPem: string | null;
  try {
    privateKeyPem = resolveBoundSigningKey(session);
  } catch (err) {
    if (err instanceof SigningKeyMismatchError) {
      console.error(chalk.red(err.message));
      process.exitCode = 1;
      return null;
    }
    throw err;
  }
  if (!privateKeyPem) {
    console.error(
      chalk.red("Signing key missing from the credential store. Re-run `alter login`."),
    );
    process.exitCode = 1;
    return null;
  }
  const extraHeaders = getMcpExtraHeaders(CLI_VERSION);
  const client = new AlterClient({
    apiKey: session.member_api_key,
    clientInfo: { name: "alter-cli", version: CLI_VERSION },
    signing: {
      kid: session.signing_kid,
      privateKey: privateKeyPem,
      handle: session.handle,
    },
    extraHeaders,
  });
  return { client, handle: session.handle };
}

/**
 * Extract a structured JSON payload from a tool result. Most messenger
 * tools return their payload as a JSON-stringified text block or a
 * parsed `data` field; accept both.
 */
export function extractPayload<T = unknown>(result: MCPCallToolResult): T | null {
  if (result.data !== undefined && result.data !== null) {
    return result.data as T;
  }
  const text = result.content?.find((c: MCPContentBlock) => c.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Translate SDK errors into the canonical user-facing copy the task
 * brief mandates. Sets process.exitCode on every failure path.
 */
function renderErrorAndExit(err: unknown, context: ErrorContext): void {
  if (err instanceof AlterAuthError) {
    // A 401/403 here is the server rejecting the session's member key /
    // signing key - NOT a missing login. Say so, and point at the only
    // fix that actually works (`alter login` alone short-circuits).
    console.error(chalk.red(sessionRejectedMessage()));
    process.exitCode = 1;
    return;
  }
  if (err instanceof AlterRateLimited) {
    // Rate-limit surface - show the retryAfter seconds the server returned.
    console.error(
      chalk.yellow(
        `Rate limited: retry after ${err.retryAfter}s. ` +
          "Limits: 60 sends/minute, 600 sends/day, 4 KiB/s/peer sustained.",
      ),
    );
    process.exitCode = 1;
    return;
  }
  if (err instanceof AlterToolError) {
    const msg = err.message.toLowerCase();
    // `contact_not_established` is the cold-start variant: the peer has
    // never granted nor revoked, so there's no record at all. Same
    // remediation as the explicit-no-grant case - the peer needs to run
    // `alter msg grant`. Bundle them.
    if (
      msg.includes("no grant") ||
      msg.includes("not granted") ||
      msg.includes("forbidden") ||
      msg.includes("contact_not_established") ||
      err.rpcCode === 403
    ) {
      const peerStr = context.peer ?? "~peer";
      // Substitute the active session's ~handle so the remediation line
      // is copy-pasteable. Falls back to the placeholder only if the
      // session is somehow absent at render time.
      const yourHandle = getSession()?.handle ?? "~yourhandle";
      console.error(
        chalk.red(
          `No grant from ${peerStr}. Ask them to run \`alter msg grant ${yourHandle}\`.`,
        ),
      );
      process.exitCode = 1;
      return;
    }
    console.error(chalk.red(`alter msg: ${err.message}`));
    process.exitCode = 1;
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(chalk.red(`alter msg: ${message}`));
  process.exitCode = 1;
}

/** Humanise a UTC timestamp into a short "Nm ago" / "Nh ago" / "Nd ago". */
function formatAge(iso: string | undefined): string {
  if (!iso) return "-";
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "-";
  const diffMs = Date.now() - when.getTime();
  const sec = Math.max(0, Math.floor(diffMs / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/**
 * Strip the `<untrusted-message-body nonce="...">...</untrusted-message-body-...>`
 * envelope from a raw body string. Safe to call on already-stripped text.
 */
function stripEnvelope(body: string): string {
  return body.replace(
    /^<untrusted-message-body nonce="([^"]+)"[^>]*>([\s\S]*?)<\/untrusted-message-body-\1>\s*$/,
    "$2",
  );
}

/** Truncate a body to a short preview suitable for inbox listing. */
function bodyPreview(body: string | undefined, max = 72): string {
  if (!body) return "";
  const unwrapped = stripEnvelope(body);
  const noMd = stripMarkdownEmphasis(unwrapped);
  const flat = noMd.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1) + "…";
}

/** Strip ANSI escape codes from a string (for --plain output). */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Strip basic markdown emphasis markers (**bold** and *italic*) so they
 * render as plain text rather than literal asterisks in the terminal.
 * Does not attempt full markdown rendering - only the `*` / `**` forms
 * that the messaging backend commonly emits.
 */
function stripMarkdownEmphasis(s: string): string {
  // Bold: **text** → text  (must come before single-star pass)
  return s.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1");
}

// ---------------------------------------------------------------------------
// Arg parsers
// ---------------------------------------------------------------------------

interface InboxArgs {
  all: boolean;
  limit: number | null;
  plain: boolean;
}

function parseInboxArgs(argv: string[]): InboxArgs {
  let all = false;
  let limit: number | null = null;
  let plain = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") all = true;
    else if (a === "--plain") plain = true;
    else if (a === "--limit") {
      const v = argv[++i];
      const n = Number.parseInt(v ?? "", 10);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error("--limit requires a positive integer");
      }
      limit = n;
    } else {
      throw new Error(`Unknown flag: ${a}`);
    }
  }
  return { all, limit, plain };
}

interface ThreadArgs {
  peer: string;
  limit: number | null;
  plain: boolean;
}

function parseThreadArgs(argv: string[]): ThreadArgs {
  if (argv.length === 0) {
    throw new Error("Usage: alter msg thread <handle> [--limit N] [--plain]");
  }
  const peer = normaliseHandle(argv[0], "peer");
  let limit: number | null = null;
  let plain = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") {
      const v = argv[++i];
      const n = Number.parseInt(v ?? "", 10);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error("--limit requires a positive integer");
      }
      limit = n;
    } else if (a === "--plain") {
      plain = true;
    } else {
      throw new Error(`Unknown flag: ${a}`);
    }
  }
  return { peer, limit, plain };
}

interface SendArgs {
  to: string;
  body: string;
}

function parseSendArgs(argv: string[]): SendArgs {
  if (argv.length === 0) {
    throw new Error('Usage: alter msg send <handle> <body...>  |  --body "..."');
  }
  const to = normaliseHandle(argv[0], "recipient");
  let body: string | null = null;
  const positional: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--body") {
      const v = argv[++i];
      if (!v) throw new Error("--body requires a value");
      body = v;
    } else {
      positional.push(a);
    }
  }
  if (body === null) {
    if (positional.length === 0) {
      throw new Error('send requires a body (positional or --body "...")');
    }
    body = positional.join(" ");
  }
  // NFC-normalise, then enforce the 8 KiB byte ceiling.
  const nfc = body.normalize("NFC");
  const byteLen = Buffer.byteLength(nfc, "utf-8");
  if (byteLen === 0) {
    throw new Error("body is empty after normalisation");
  }
  if (byteLen > BODY_CEILING_BYTES) {
    throw new Error(
      `body exceeds ceiling: ${byteLen} bytes > ${BODY_CEILING_BYTES} bytes (8 KiB UTF-8 NFC)`,
    );
  }
  return { to, body: nfc };
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function inboxEntries(payload: InboxPayload | null): InboxEntry[] {
  if (!payload) return [];
  return payload.messages ?? payload.items ?? [];
}

function renderInbox(entries: InboxEntry[], unreadOnly: boolean, plain = false): void {
  const out = (s: string) => process.stdout.write((plain ? stripAnsi(s) : s) + "\n");
  if (entries.length === 0) {
    out(unreadOnly ? "No unread messages." : "Inbox empty.");
    return;
  }
  for (const m of entries) {
    const id = m.message_id ?? m.id ?? "?";
    const from = m.from ?? m.sender ?? "~unknown";
    const when = m.sent_at ?? m.created_at;
    const age = formatAge(when);
    // Server read-state wins. The messaging backend tracks read-state via a
    // `read_at` timestamp (null/absent = unread) - honour it first, since that
    // is the field the backend actually returns. Fall back to the legacy
    // `read`/`unread` booleans. Treat all-absent as unread to avoid a false
    // READ render.
    const read =
      m.read_at != null ||
      m.read === true ||
      (m.read === undefined && m.unread === false);
    const flag = read ? chalk.dim("READ") : chalk.cyan("UNREAD");
    const preview = bodyPreview(m.body ?? m.body_md ?? m.preview ?? "");
    out(`  ${flag} ${chalk.bold(from)} ${chalk.dim(`(${age})`)} - ${preview}`);
    out(`    ${chalk.dim(id)}`);
  }
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

async function cmdInbox(argv: string[]): Promise<void> {
  let opts: InboxArgs;
  try {
    opts = parseInboxArgs(argv);
  } catch (err) {
    console.error(chalk.red(`alter msg inbox: ${(err as Error).message}`));
    process.exitCode = 1;
    return;
  }
  const authed = requireAuthedClient();
  if (!authed) return;
  const { client } = authed;
  try {
    const result = await client.mcp.callTool("alter_message_inbox", {
      unread_only: !opts.all,
      ...(opts.limit ? { limit: opts.limit } : {}),
    });
    const payload = extractPayload<InboxPayload>(result);
    renderInbox(inboxEntries(payload), !opts.all, opts.plain);
  } catch (err) {
    renderErrorAndExit(err, {});
  }
}

async function cmdThread(argv: string[]): Promise<void> {
  let opts: ThreadArgs;
  try {
    opts = parseThreadArgs(argv);
  } catch (err) {
    console.error(chalk.red(`alter msg thread: ${(err as Error).message}`));
    process.exitCode = 1;
    return;
  }
  const authed = requireAuthedClient();
  if (!authed) return;
  const { client, handle: me } = authed;
  try {
    const result = await client.mcp.callTool("alter_message_thread", {
      with: opts.peer,
      ...(opts.limit ? { limit: opts.limit } : {}),
    });
    const payload = extractPayload<InboxPayload>(result);
    const entries = payload?.messages ?? payload?.items ?? [];
    const out = (s: string) => process.stdout.write((opts.plain ? stripAnsi(s) : s) + "\n");
    if (entries.length === 0) {
      out(`No messages with ${opts.peer} yet.`);
      return;
    }
    out(
      chalk.bold(`Thread: ${me} ⇄ ${opts.peer}`) +
        chalk.dim(`  (${entries.length} messages)`),
    );
    for (const m of entries) {
      const when = m.sent_at ?? m.created_at;
      const age = formatAge(when);
      const from = m.from ?? m.sender ?? "~unknown";
      const outbound = from === me || m.direction === "outbound";
      const arrow = outbound ? chalk.green("→") : chalk.cyan("←");
      const who = outbound ? `${me} → ${opts.peer}` : `${from} → ${me}`;
      const body = stripMarkdownEmphasis(stripEnvelope(m.body ?? m.body_md ?? m.preview ?? "")).trim();
      out(`  ${arrow} ${chalk.dim(age)}  ${chalk.bold(who)}`);
      out(`    ${body}`);
    }
  } catch (err) {
    renderErrorAndExit(err, { peer: opts.peer });
  }
}

async function cmdSend(argv: string[]): Promise<void> {
  let opts: SendArgs;
  try {
    opts = parseSendArgs(argv);
  } catch (err) {
    console.error(chalk.red(`alter msg send: ${(err as Error).message}`));
    process.exitCode = 1;
    return;
  }
  const authed = requireAuthedClient();
  if (!authed) return;
  const { client, handle: me } = authed;
  try {
    // Every outbound message carries the caller's
    // Sovereign handle plus the drafting instrument. The CLI is its own
    // authoring surface, so `drafted_with` is this binary's stamp.
    const result = await client.mcp.callTool("alter_message_send", {
      to: opts.to,
      body: opts.body,
      meta: {
        identity_trailers: {
          acted_by: me,
          drafted_with: [INSTRUMENT_HANDLE],
        },
      },
    });
    const payload = extractPayload<SendPayload>(result);
    const id = payload?.event_id ?? payload?.message_id ?? payload?.id ?? "(no id returned)";
    // Only an explicit delivery-success status earns the green SENT line. A
    // 200 carrying status `rejected` / `queued` / `failed` is NOT a delivered
    // message; printing it green is a false success on the messaging channel.
    // An absent status (older field shape) is treated as success.
    const rawStatus = String(payload?.status ?? "sent").toLowerCase();
    const SUCCESS_STATES = new Set(["sent", "delivered", "accepted", "ok", "success"]);
    const label = rawStatus.toUpperCase();
    if (SUCCESS_STATES.has(rawStatus)) {
      console.log(`${chalk.green(label)}  ${me} → ${opts.to}  ${chalk.dim(id)}`);
    } else {
      console.error(
        `${chalk.yellow(label)}  ${me} → ${opts.to}  ${chalk.dim(id)}  ${chalk.yellow("(not delivered)")}`,
      );
      process.exitCode = 1;
    }
  } catch (err) {
    renderErrorAndExit(err, { peer: opts.to });
  }
}

async function cmdRead(argv: string[]): Promise<void> {
  if (argv.length === 0) {
    console.error(chalk.red("Usage: alter msg read <message-id> [<id>...]"));
    process.exitCode = 1;
    return;
  }
  const ids = argv.filter((a) => !a.startsWith("--"));
  if (ids.length === 0) {
    console.error(chalk.red("alter msg read: at least one message id required"));
    process.exitCode = 1;
    return;
  }
  const authed = requireAuthedClient();
  if (!authed) return;
  const { client } = authed;
  try {
    const result = await client.mcp.callTool("alter_message_mark_read", {
      message_ids: ids,
    });
    const payload = extractPayload<ReadPayload>(result);
    // Report the count the SERVER actually marked, never a fallback to the
    // requested count: mark-read is recipient-scoped and silently skips ids
    // you don't own, so `ids.length` can overstate what happened.
    const marked = payload?.marked ?? payload?.count;
    if (typeof marked === "number") {
      const colour = marked > 0 ? chalk.green : chalk.yellow;
      console.log(`${colour("READ")}  marked ${marked} of ${ids.length} message(s)`);
    } else {
      console.log(
        `${chalk.green("READ")}  mark-read request sent for ${ids.length} message(s)`,
      );
    }
  } catch (err) {
    renderErrorAndExit(err, {});
  }
}

async function cmdGrant(argv: string[]): Promise<void> {
  if (argv.length === 0) {
    console.error(chalk.red("Usage: alter msg grant <handle>"));
    process.exitCode = 1;
    return;
  }
  let peer: string;
  try {
    peer = normaliseHandle(argv[0], "peer");
  } catch (err) {
    console.error(chalk.red(`alter msg grant: ${(err as Error).message}`));
    process.exitCode = 1;
    return;
  }
  const authed = requireAuthedClient();
  if (!authed) return;
  const { client } = authed;
  try {
    await client.mcp.callTool("alter_message_grant", { peer });
    console.log(`${chalk.green("GRANTED")}  ${peer} can now message you`);
  } catch (err) {
    renderErrorAndExit(err, { peer });
  }
}

async function cmdRevoke(argv: string[]): Promise<void> {
  if (argv.length === 0) {
    console.error(chalk.red("Usage: alter msg revoke <handle>"));
    process.exitCode = 1;
    return;
  }
  let peer: string;
  try {
    peer = normaliseHandle(argv[0], "peer");
  } catch (err) {
    console.error(chalk.red(`alter msg revoke: ${(err as Error).message}`));
    process.exitCode = 1;
    return;
  }
  const authed = requireAuthedClient();
  if (!authed) return;
  const { client } = authed;
  try {
    await client.mcp.callTool("alter_message_revoke", { peer });
    console.log(`${chalk.yellow("REVOKED")}  ${peer} can no longer send new messages`);
  } catch (err) {
    renderErrorAndExit(err, { peer });
  }
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

function printMsgHelp(): void {
  console.log(`
alter msg - direct messaging between ~handles on Alter.

Interactive:
  alter msg                              Open the messenger (interactive TUI)
  alter msg <handle>                     Open the messenger focused on <handle>

Line-oriented (pipe-friendly):
  alter msg inbox [--all] [--limit N]    List inbox (unread by default)
  alter msg thread <handle> [--limit N]  Show bidirectional thread with peer
  alter msg send <handle> <body...>      Send a message (body joined from args)
  alter msg send <handle> --body "..."   Send a message (explicit body flag)
  alter msg read <message-id>...         Mark inbound messages as read
  alter msg grant <handle>               Grant a peer permission to message you
  alter msg revoke <handle>              Revoke a peer's grant

Inside the interactive messenger:
  ↑↓        nav conversations / scroll thread
  ↵         drop into thread / compose / send
  Ctrl-E    open \$EDITOR for multiline composition
  Ctrl-K    fuzzy-jump between conversations
  /         search inside the current thread
  n, g      new conversation / manage grants
  R         mark whole conversation read · u toggle read on last message
  c, x      copy last body / redact last message you received
  p         presence pane (room view) · m back to messages
  q, Esc    back to where you opened the messenger from

Notes:
  - Bodies are capped at 8 KiB UTF-8 NFC.
  - Sends carry a signed identity trailer (who sent it, what tool sent it).
  - Rate limits surface on error with retry-after hints.
  - Messages in view ≥1.5 s are auto-marked read. CC /msg + hooks are unaffected.
  - Realtime: SSE direct → alter-runtime daemon tail → poll. Whichever works.
  - Under pipes / CI, \`alter msg\` falls back to printing the unread inbox.
`);
}

export async function msg(argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub !== "help" && sub !== "--help" && sub !== "-h") {
    try {
      emitSessionHeartbeat({
        sessionId: String(process.pid),
        workingOn: "alter msg",
      });
    } catch { /* silent - must not block command */ }
  }
  switch (sub) {
    case undefined:
      // Bare `alter msg`. Interactive when stdin+stdout are a TTY -
      // the headline messenger surface (full-screen, realtime). Falls
      // back to the line-oriented unread-inbox listing under pipes /
      // CI so scripts that depended on the old behaviour keep working.
      if (process.stdout.isTTY && process.stdin.isTTY) {
        await openMessenger();
      } else {
        await cmdInbox([]);
      }
      return;
    case "help":
    case "--help":
    case "-h":
      printMsgHelp();
      return;
    case "inbox":
      await cmdInbox(rest);
      return;
    case "thread":
      await cmdThread(rest);
      return;
    case "send":
      await cmdSend(rest);
      return;
    case "read":
      await cmdRead(rest);
      return;
    case "grant":
      await cmdGrant(rest);
      return;
    case "revoke":
      await cmdRevoke(rest);
      return;
    default:
      // `alter msg ~peer` - interactive messenger focused on that peer.
      // Anything else starting with a ~ is treated the same way; the
      // messenger surfaces a "they haven't granted you" hint inline if
      // the peer hasn't completed the grant handshake.
      if (sub.startsWith("~") || (sub.length > 0 && /^[a-z0-9]/.test(sub))) {
        if (process.stdout.isTTY && process.stdin.isTTY) {
          let peer: string;
          try {
            peer = normaliseHandle(sub, "peer");
          } catch (err) {
            console.error(chalk.red(`alter msg: ${(err as Error).message}`));
            process.exitCode = 1;
            return;
          }
          await openMessenger({ initialPeer: peer });
          return;
        }
        // Non-TTY shorthand - drop into the thread listing for the
        // peer, which is the closest pipe-friendly read of "show me
        // ~peer".
        await cmdThread([sub, ...rest]);
        return;
      }
      console.error(chalk.red(`Unknown subcommand: alter msg ${sub}`));
      console.error("Run `alter msg help` for usage.");
      process.exitCode = 1;
      return;
  }
}
