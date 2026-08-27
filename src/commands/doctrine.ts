/**
 * `alter doctrine` - pull-mode doctrine projection sync.
 *
 * Subcommands:
 *   alter doctrine sync [--if-stale] [--quiet]
 *
 * The projection is a local materialisation of the member's doctrine
 * entries served by the `alter_doctrine` MCP tool. It is read by CC
 * hooks for context injection and written here. No local backend
 * required - purely MCP-over-member-key.
 *
 * Wire contract (pinned, must match the backend implementation):
 *   alter_doctrine action="summary" → {scope, max_created_at, count, etag}
 *   alter_doctrine action="list" since=<ISO> → entries newer than since
 *   etag is deterministic over (max_created_at, count); cached == fresh → skip
 *
 * Atomic write: tmp + rename (same pattern as auth.ts:atomicWriteFileSync).
 * Merge-by-slug: newest created_at wins; superseded entries are dropped.
 *
 * Collective scope serves no data for now: DEFAULT-CLOSED until the
 * consent-gated projection exists. A member reads only consent-gated
 * joint projections, never individual traces, so even once gated,
 * uncoupled members get nothing. Default is personal.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

import {
  AlterClient,
  AlterAuthError,
  AlterRateLimited,
  AlterToolError,
  type MCPCallToolResult,
  type MCPContentBlock,
} from "@truealter/sdk";

import {
  getSession,
  backfillMemberId,
  sessionRejectedMessage,
} from "../auth.js";
import { resolveBoundSigningKey, SigningKeyMismatchError } from "../signing.js";
import { getMcpExtraHeaders } from "../lib/cf-access-headers.js";
import { getCliVersion } from "../lib/version.js";
import {
  mergeEntries as _mergeEntries,
  type DoctrineEntry,
} from "../lib/doctrine-merge.js";

// Re-export for consumers that import DoctrineEntry / mergeEntries from here.
export { mergeEntries, type DoctrineEntry } from "../lib/doctrine-merge.js";

// ---------------------------------------------------------------------------
// XDG-compliant paths
// ---------------------------------------------------------------------------

const XDG_DATA =
  process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");

export const DOCTRINE_DIR = path.join(XDG_DATA, "alter", "doctrine");
export const DOCTRINE_FILE = path.join(DOCTRINE_DIR, "personal.jsonl");
export const ETAG_FILE = path.join(DOCTRINE_DIR, "personal.etag.json");
export const REFRESH_LOG = path.join(DOCTRINE_DIR, "refresh.log");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Summary response from alter_doctrine action="summary" */
export interface DoctrineSummary {
  scope: string;
  max_created_at: string | null;
  count: number;
  etag: string;
}

// Use the imported mergeEntries function (extracted for testability).
const mergeEntries = _mergeEntries;

/** Cached etag sidecar on disk */
interface EtagSidecar {
  etag: string;
  max_created_at: string | null;
  synced_at: string;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface SyncOptions {
  ifStale: boolean;
  quiet: boolean;
}

function parseSyncArgs(argv: string[]): SyncOptions {
  let ifStale = false;
  let quiet = false;
  for (const a of argv) {
    if (a === "--if-stale") ifStale = true;
    else if (a === "--quiet") quiet = true;
    else if (a === "--help" || a === "-h") throw new Error("__help__");
    else throw new Error(`Unknown flag: ${a}`);
  }
  return { ifStale, quiet };
}

// ---------------------------------------------------------------------------
// Disk I/O helpers
// ---------------------------------------------------------------------------

function atomicWrite(file: string, data: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp.${process.pid}.${crypto
    .randomBytes(6)
    .toString("hex")}`;
  try {
    fs.writeFileSync(tmp, data, { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
    throw err;
  }
}

function readEtagSidecar(): EtagSidecar | null {
  try {
    const raw = fs.readFileSync(ETAG_FILE, "utf-8");
    return JSON.parse(raw) as EtagSidecar;
  } catch {
    return null;
  }
}

function writeEtagSidecar(etag: string, max_created_at: string | null): void {
  const sidecar: EtagSidecar = {
    etag,
    max_created_at,
    synced_at: new Date().toISOString(),
  };
  atomicWrite(ETAG_FILE, JSON.stringify(sidecar, null, 2) + "\n");
}

function appendRefreshLog(line: string): void {
  fs.mkdirSync(DOCTRINE_DIR, { recursive: true, mode: 0o700 });
  fs.appendFileSync(REFRESH_LOG, line + "\n", { encoding: "utf-8", mode: 0o600 });
}

/**
 * Read the current personal.jsonl as a map keyed by slug.
 * Newest created_at wins when duplicates exist (defensive: should not occur
 * in a well-formed file, but merge-by-slug requires this invariant).
 */
function readExistingEntries(): Map<string, DoctrineEntry> {
  const map = new Map<string, DoctrineEntry>();
  try {
    const raw = fs.readFileSync(DOCTRINE_FILE, "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as DoctrineEntry;
        if (!entry.slug) continue;
        const existing = map.get(entry.slug);
        if (!existing || (entry.created_at > existing.created_at)) {
          map.set(entry.slug, entry);
        }
      } catch { /* skip malformed line */ }
    }
  } catch {
    // File doesn't exist yet - fine.
  }
  return map;
}

function entriesToJsonl(entries: Map<string, DoctrineEntry>): string {
  return [...entries.values()].map((e) => JSON.stringify(e)).join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// MCP client helpers (same pattern as signals.ts / room.ts)
// ---------------------------------------------------------------------------

function tryBuildClient(): { client: AlterClient } | { error: string } {
  const session = getSession();
  if (!session) return { error: "not signed in. run `alter login` first." };
  if (!session.member_api_key) {
    return { error: "no member API key. run `alter key member rotate`." };
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
  const cli_version = getCliVersion();
  const client = new AlterClient({
    apiKey: session.member_api_key,
    clientInfo: { name: "alter-cli", version: cli_version },
    signing: {
      kid: session.signing_kid,
      privateKey: privateKeyPem,
      handle: session.handle,
    },
    extraHeaders: getMcpExtraHeaders(cli_version),
  });
  return { client };
}

function extractMcpPayload<T = unknown>(result: MCPCallToolResult): T | null {
  if ((result as any).data !== undefined && (result as any).data !== null) {
    return (result as any).data as T;
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

// ---------------------------------------------------------------------------
// Core sync logic
// ---------------------------------------------------------------------------

async function callDoctrineSummary(
  client: AlterClient,
  scope: string,
): Promise<DoctrineSummary | null> {
  try {
    const result = await client.mcp.callTool("alter_doctrine", {
      action: "summary",
      scope,
    });
    return extractMcpPayload<DoctrineSummary>(result);
  } catch (err: unknown) {
    if (err instanceof AlterAuthError) throw new Error(sessionRejectedMessage());
    if (err instanceof AlterRateLimited)
      throw new Error(`rate limited - retry after ${(err as AlterRateLimited).retryAfter}s`);
    if (err instanceof AlterToolError)
      throw new Error(`alter_doctrine summary: ${(err as AlterToolError).message}`);
    throw err;
  }
}

async function callDoctrineList(
  client: AlterClient,
  scope: string,
  since: string | null,
): Promise<DoctrineEntry[]> {
  const args: Record<string, unknown> = { action: "list", scope };
  if (since) args.since = since;
  try {
    const result = await client.mcp.callTool("alter_doctrine", args);
    interface ListPayload {
      entries?: DoctrineEntry[];
      items?: DoctrineEntry[];
      data?: DoctrineEntry[];
    }
    const payload = extractMcpPayload<ListPayload>(result);
    return payload?.entries ?? payload?.items ?? payload?.data ?? [];
  } catch (err: unknown) {
    if (err instanceof AlterAuthError) throw new Error(sessionRejectedMessage());
    if (err instanceof AlterRateLimited)
      throw new Error(`rate limited - retry after ${(err as AlterRateLimited).retryAfter}s`);
    if (err instanceof AlterToolError)
      throw new Error(`alter_doctrine list: ${(err as AlterToolError).message}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Subcommand: sync
// ---------------------------------------------------------------------------

async function cmdSync(argv: string[]): Promise<void> {
  let opts: SyncOptions;
  try {
    opts = parseSyncArgs(argv);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === "__help__") {
      printSyncHelp();
      return;
    }
    process.stderr.write(`alter doctrine sync: ${msg}\n`);
    process.exitCode = 1;
    return;
  }

  // Guard: require member_id; attempt one-time backfill if absent.
  const session = getSession();
  if (!session) {
    process.stderr.write("alter doctrine sync: not signed in. run `alter login` first.\n");
    // Soft exit: a hard process.exit() races libuv teardown on Windows.
    process.exitCode = 1;
    return;
  }

  if (!("member_id" in session) || session.member_id === undefined) {
    if (!opts.quiet) {
      process.stderr.write("alter doctrine sync: backfilling member_id via alter_whoami...\n");
    }
    const memberId = await backfillMemberId();
    if (memberId === undefined) {
      process.stderr.write(
        "alter doctrine sync: could not resolve member_id. Re-run `alter login` or check your member API key.\n",
      );
      process.exitCode = 1;
      return;
    }
    // null is valid (admin key) - fall through to the no-data path below.
    if (memberId === null) {
      if (!opts.quiet) {
        process.stderr.write("alter doctrine sync: admin key has no member_id - no personal doctrine to sync.\n");
      }
      return;
    }
  } else if (session.member_id === null) {
    if (!opts.quiet) {
      process.stderr.write("alter doctrine sync: admin key has no member_id - no personal doctrine to sync.\n");
    }
    return;
  }

  // Build MCP client.
  const built = tryBuildClient();
  if ("error" in built) {
    process.stderr.write(`alter doctrine sync: ${built.error}\n`);
    process.exitCode = 1;
    return;
  }
  const { client } = built;

  // Step 1: cheapness check via summary.
  let summary: DoctrineSummary | null;
  try {
    summary = await callDoctrineSummary(client, "personal");
  } catch (err) {
    process.stderr.write(`alter doctrine sync: ${(err as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  if (!summary) {
    process.stderr.write("alter doctrine sync: empty response from alter_doctrine summary.\n");
    process.exitCode = 1;
    return;
  }

  // --if-stale short-circuit: if cached etag == server etag, no-op.
  if (opts.ifStale) {
    const cached = readEtagSidecar();
    if (cached && cached.etag === summary.etag) {
      if (!opts.quiet) {
        process.stdout.write("alter doctrine sync: cache is fresh - nothing to do.\n");
      }
      appendRefreshLog(
        JSON.stringify({
          at: new Date().toISOString(),
          result: "fresh",
          etag: summary.etag,
        }),
      );
      return;
    }
  }

  // Step 2: delta pull via list with since=<cached max_created_at>.
  const cached = readEtagSidecar();
  const since = cached?.max_created_at ?? null;

  let incoming: DoctrineEntry[];
  try {
    incoming = await callDoctrineList(client, "personal", since);
  } catch (err) {
    process.stderr.write(`alter doctrine sync: ${(err as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  // Step 3: merge-by-slug (newest created_at wins, drop superseded).
  const existing = readExistingEntries();
  const merged = mergeEntries(existing, incoming);

  // Step 4: atomic write personal.jsonl + etag sidecar.
  atomicWrite(DOCTRINE_FILE, entriesToJsonl(merged));
  writeEtagSidecar(summary.etag, summary.max_created_at);

  // Step 5: append to refresh.log.
  appendRefreshLog(
    JSON.stringify({
      at: new Date().toISOString(),
      result: "synced",
      incoming: incoming.length,
      total: merged.size,
      etag: summary.etag,
      since: since ?? "full",
    }),
  );

  if (!opts.quiet) {
    process.stdout.write(
      `alter doctrine sync: ${incoming.length} new/updated, ${merged.size} total entries.\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printSyncHelp(): void {
  process.stdout.write(
    [
      "alter doctrine sync [--if-stale] [--quiet]",
      "",
      "Pull doctrine entries from your Alter and materialise them locally.",
      "Uses the member_id from session.json - never falls back to user_id.",
      "",
      "Options:",
      "  --if-stale   skip the network round-trip when local cache is fresh",
      "  --quiet      suppress informational output (errors still go to stderr)",
      "",
    ].join("\n"),
  );
}

function printHelp(): void {
  process.stdout.write(
    [
      "alter doctrine <subcommand>",
      "",
      "Subcommands:",
      "  sync [--if-stale] [--quiet]   pull latest doctrine entries",
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export async function doctrine(argv: string[]): Promise<void> {
  const sub = argv[0];
  switch (sub) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    case "sync":
      await cmdSync(argv.slice(1));
      return;
    default:
      process.stderr.write(`Unknown subcommand: alter doctrine ${sub}\n`);
      process.stderr.write("Run `alter doctrine --help` for usage.\n");
      process.exitCode = 1;
      return;
  }
}
