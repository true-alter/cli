/**
 * alter signals - tail recent activity signals.
 *
 * Local-first: the alter-runtime daemon writes
 * an append-only `signals.jsonl` cache at
 * `~/.local/share/alter-runtime/signals.jsonl`. We read that file
 * primarily and only fall back to the `alter_signals_tail` MCP tool
 * when the daemon cache is absent or empty (fresh install, daemon
 * not yet running, or running on a host that doesn't pair with the
 * daemon at all).
 *
 * Subcommands:
 *   alter signals tail [--limit N] [--since ISO]   most-recent signals
 *
 * Both transports return the same shape - `{ signals: [{...}, ...] }`
 * - so the renderer can be ignorant of the source.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import {
  AlterClient,
  AlterAuthError,
  AlterRateLimited,
  AlterToolError,
  type MCPCallToolResult,
  type MCPContentBlock,
} from "@truealter/sdk";

import { getSession, sessionRejectedMessage } from "../auth.js";
import { resolveBoundSigningKey, SigningKeyMismatchError } from "../signing.js";
import { getMcpExtraHeaders } from "../lib/cf-access-headers.js";
import { getCliVersion } from "../lib/version.js";
import { brand } from "../ui/biosMenu.js";
import { emitSessionHeartbeat } from "../lib/active-sessions-emit.js";

const CLI_VERSION = getCliVersion();

// ---------------------------------------------------------------------------
// Paths - XDG-compliant, matches the daemon writer in alter-runtime
// ---------------------------------------------------------------------------

const ALTER_RUNTIME_DATA_DIR = path.join(
  process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
  "alter-runtime",
);
const SIGNALS_FILE = path.join(ALTER_RUNTIME_DATA_DIR, "signals.jsonl");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SignalEntry {
  id?: string;
  kind?: string;
  type?: string;
  source?: string;
  handle?: string;
  recorded_at?: string;
  created_at?: string;
  occurred_at?: string;
  summary?: string;
  body?: string;
  body_md?: string;
  // Loose escape hatch - the daemon may emit additional fields we
  // don't render today; ignore them rather than reject the row.
  [key: string]: unknown;
}

interface TailOptions {
  limit: number;
  since: string | null;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseTailArgs(argv: string[]): TailOptions {
  let limit = 20;
  let since: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") {
      const v = argv[++i];
      const n = Number.parseInt(v ?? "", 10);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error("--limit requires a positive integer");
      }
      limit = n;
    } else if (a === "--since") {
      const v = argv[++i];
      if (!v) throw new Error("--since requires an ISO8601 timestamp");
      const t = Date.parse(v);
      if (Number.isNaN(t)) {
        throw new Error(`--since: not a valid ISO8601 timestamp: ${v}`);
      }
      since = v;
    } else if (a === "--help" || a === "-h") {
      throw new Error("__help__");
    } else {
      throw new Error(`Unknown flag: ${a}`);
    }
  }
  return { limit, since };
}

// ---------------------------------------------------------------------------
// Local-first read
// ---------------------------------------------------------------------------

/**
 * Read the daemon-owned signals.jsonl. Returns null when the file
 * doesn't exist or is unreadable - the caller falls back to the MCP
 * tool in that case. Returns an empty array when the file exists but
 * has no parseable rows; that's a legitimate "daemon is running but
 * has nothing for you yet" state, NOT a trigger for MCP fallback.
 */
function readLocalSignals(): SignalEntry[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(SIGNALS_FILE, "utf8");
  } catch {
    return null;
  }
  const out: SignalEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as SignalEntry;
      if (parsed && typeof parsed === "object") {
        out.push(parsed);
      }
    } catch {
      // skip malformed line
    }
  }
  return out;
}

function signalTime(s: SignalEntry): number {
  const iso = s.recorded_at ?? s.created_at ?? s.occurred_at;
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

function applyFilters(
  signals: SignalEntry[],
  opts: TailOptions,
): SignalEntry[] {
  let filtered = signals;
  if (opts.since) {
    const cutoff = Date.parse(opts.since);
    filtered = filtered.filter((s) => signalTime(s) >= cutoff);
  }
  // Newest first.
  filtered = [...filtered].sort((a, b) => signalTime(b) - signalTime(a));
  return filtered.slice(0, opts.limit);
}

// ---------------------------------------------------------------------------
// MCP fallback
// ---------------------------------------------------------------------------

function tryBuildClient(): { client: AlterClient } | { error: string } {
  const session = getSession();
  if (!session) return { error: "not signed in. run `alter login` first." };
  if (!session.member_api_key) {
    return {
      error: "no member API key on this session. run `alter key member rotate`.",
    };
  }
  if (!session.signing_kid) {
    return { error: "no signing kid. re-run `alter login`." };
  }
  // Bound resolution: refuses on kid/key mismatch, never another key.
  let privateKeyPem: string | null;
  try {
    privateKeyPem = resolveBoundSigningKey(session);
  } catch (err) {
    if (err instanceof SigningKeyMismatchError) return { error: err.message };
    throw err;
  }
  if (!privateKeyPem) {
    return { error: "signing key missing - re-run `alter login`." };
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
  return { client };
}

function extractMcpPayload<T = unknown>(result: MCPCallToolResult): T | null {
  if (result.data !== undefined && result.data !== null) {
    return result.data as T;
  }
  const text = result.content?.find((c: MCPContentBlock) => c.type === "text")
    ?.text;
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function fetchRemoteSignals(opts: TailOptions): Promise<SignalEntry[]> {
  const built = tryBuildClient();
  if ("error" in built) {
    throw new Error(built.error);
  }
  const args: Record<string, unknown> = { limit: opts.limit };
  if (opts.since) args.since = opts.since;
  try {
    const result = await built.client.mcp.callTool("alter_signals_tail", args);
    interface Payload {
      signals?: SignalEntry[];
      items?: SignalEntry[];
      data?: SignalEntry[];
    }
    const payload = extractMcpPayload<Payload>(result);
    return payload?.signals ?? payload?.items ?? payload?.data ?? [];
  } catch (err) {
    if (err instanceof AlterAuthError) {
      throw new Error(sessionRejectedMessage());
    }
    if (err instanceof AlterRateLimited) {
      throw new Error(`rate limited - retry after ${err.retryAfter}s`);
    }
    if (err instanceof AlterToolError) {
      throw new Error(`alter_signals_tail: ${err.message}`);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Rendering - mirrors the msg.ts table style with brand colours
// ---------------------------------------------------------------------------

function formatRelative(iso: string | undefined): string {
  if (!iso) return "-";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "-";
  const diff = Date.now() - then;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function summaryOf(s: SignalEntry, max = 64): string {
  const raw = s.summary ?? s.body ?? s.body_md ?? "";
  if (!raw) return "";
  const flat = String(raw).replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1) + "…";
}

function renderSignals(signals: SignalEntry[], source: "local" | "mcp"): void {
  if (signals.length === 0) {
    process.stdout.write(
      brand.dim("no signals to show.") +
        " " +
        brand.faint(`(source: ${source})`) +
        "\n",
    );
    return;
  }

  const sourceLabel = source === "local" ? "daemon cache" : "MCP fallback";
  process.stdout.write(
    brand.titleDim("signals") +
      brand.dim("  ·  ") +
      brand.faint(`${signals.length} entr${signals.length === 1 ? "y" : "ies"} · ${sourceLabel}`) +
      "\n\n",
  );

  for (const s of signals) {
    const kind = s.kind ?? s.type ?? "signal";
    const who = s.source ?? s.handle ?? "-";
    const when = formatRelative(s.recorded_at ?? s.created_at ?? s.occurred_at);
    const preview = summaryOf(s);
    process.stdout.write(
      "  " +
        brand.accent(kind.padEnd(20)) +
        "  " +
        brand.muted(who.padEnd(18)) +
        "  " +
        brand.dim(when.padEnd(10)) +
        "  " +
        brand.text(preview) +
        "\n",
    );
  }
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

function printHelp(): void {
  process.stdout.write(
    [
      "alter signals tail [--limit N] [--since ISO]",
      "",
      "Show recent activity signals. Reads the local daemon cache first;",
      "falls back to the live signal feed when the cache is absent.",
      "",
      "Options:",
      "  --limit N      maximum rows to show (default 20)",
      "  --since ISO    only signals at or after ISO8601 timestamp",
      "",
    ].join("\n"),
  );
}

async function cmdTail(argv: string[]): Promise<void> {
  let opts: TailOptions;
  try {
    opts = parseTailArgs(argv);
  } catch (err) {
    const message = (err as Error).message;
    if (message === "__help__") {
      printHelp();
      return;
    }
    process.stderr.write(brand.text(`alter signals tail: ${message}\n`));
    process.exitCode = 1;
    return;
  }

  // Auth check - every alter verb requires a bound session, even the
  // pure-local-read ones. This catches "user typed `alter signals` on a
  // fresh box" before we silently report an empty cache.
  const session = getSession();
  if (!session) {
    process.stderr.write(
      brand.text("not signed in. run `alter login` first.\n"),
    );
    // Soft exit: a hard process.exit() races libuv teardown on Windows.
    process.exitCode = 1;
    return;
  }

  // Local-first.
  const local = readLocalSignals();
  if (local && local.length > 0) {
    renderSignals(applyFilters(local, opts), "local");
    return;
  }

  // Cache absent or empty - fall back to MCP.
  let remote: SignalEntry[];
  try {
    remote = await fetchRemoteSignals(opts);
  } catch (err) {
    process.stderr.write(
      brand.text(`alter signals tail: ${(err as Error).message}\n`),
    );
    process.exitCode = 1;
    return;
  }
  renderSignals(applyFilters(remote, opts), "mcp");
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export async function signals(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (sub !== "help" && sub !== "--help" && sub !== "-h") {
    try {
      emitSessionHeartbeat({
        sessionId: String(process.pid),
        workingOn: "alter signals",
      });
    } catch { /* silent - must not block command */ }
  }
  switch (sub) {
    case undefined:
    case "tail":
      await cmdTail(argv[0] === undefined ? argv : argv.slice(1));
      return;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      process.stderr.write(`Unknown subcommand: alter signals ${sub}\n`);
      process.stderr.write("Run `alter signals --help` for usage.\n");
      process.exitCode = 1;
      return;
  }
}
