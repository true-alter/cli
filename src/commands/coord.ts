/**
 * alter coord - concurrent-session deconfliction view.
 *
 * Org Alter coordinates concurrent agent sessions by default. The
 * alter-runtime daemon owns the
 * `active-sessions.jsonl` log; this verb is a local-first read of
 * that surface. NO MCP fallback - coordination is the daemon's
 * job. If the daemon hasn't seeded the file we say so plainly
 * rather than silently flipping to a different transport.
 *
 * Subcommands:
 *   alter coord status   list active sessions across tools/machines
 *
 * Dedup contract (matches the schema description):
 *   key = (tool, session_id); keep the row with the newest
 *   last_activity. status=complete is the tombstone - drop entries
 *   tombstoned by a later row OR with status === "complete".
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { getSession } from "../auth.js";
import { brand } from "../ui/biosMenu.js";
import { emitSessionHeartbeat } from "../lib/active-sessions-emit.js";

// ---------------------------------------------------------------------------
// Paths - XDG-compliant, matches the daemon writer in alter-runtime
// ---------------------------------------------------------------------------

const ALTER_RUNTIME_DATA_DIR = path.join(
  process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
  "alter-runtime",
);
const ACTIVE_SESSIONS_FILE = path.join(
  ALTER_RUNTIME_DATA_DIR,
  "active-sessions.jsonl",
);

// ---------------------------------------------------------------------------
// Types - mirror docs/schemas/active-sessions.schema.json
// ---------------------------------------------------------------------------

interface SessionRecord {
  id?: string;
  version?: number;
  kind?: "session_started" | "session_heartbeat" | "session_ended";
  handle?: string;
  tool?: string;
  session_id?: string;
  machine_id?: string;
  started_at?: string;
  last_activity?: string;
  working_on?: string | null;
  files_touched?: string[];
  status?: "active" | "idle" | "complete";
  // tolerate the rest
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// JSONL reading + dedup
// ---------------------------------------------------------------------------

function readActiveSessions(): SessionRecord[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(ACTIVE_SESSIONS_FILE, "utf8");
  } catch {
    return null;
  }
  const out: SessionRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as SessionRecord;
      if (parsed && typeof parsed === "object") {
        out.push(parsed);
      }
    } catch {
      // skip malformed line
    }
  }
  return out;
}

// A session is reaped from the active view if it hasn't emitted inside this
// window. One-shot CLI commands emit a single `session_heartbeat` and exit
// without ever writing a `session_ended` tombstone, and a killed long-lived
// session never tombstones either - so without a TTL the view accreted every
// session ever emitted (the "319 sessions, 6h-old still showing active"
// symptom). Active tools (cc, the daemon) re-emit well inside this window.
// Override with ALTER_COORD_TTL_MIN for diagnostics.
function activeSessionTtlMs(): number {
  const raw = process.env.ALTER_COORD_TTL_MIN;
  const mins = raw ? Number.parseInt(raw, 10) : NaN;
  return (Number.isFinite(mins) && mins > 0 ? mins : 15) * 60_000;
}

/**
 * Dedup on `(tool, session_id)` keeping the row with the newest
 * `last_activity`. Drop tombstones (`status === "complete"`) and any
 * session that has gone stale past the TTL (the reaper).
 */
function dedupSessions(rows: SessionRecord[]): SessionRecord[] {
  const newest = new Map<string, SessionRecord>();
  for (const row of rows) {
    if (!row.tool || !row.session_id) continue;
    const key = `${row.tool}::${row.session_id}`;
    const existing = newest.get(key);
    const rowTime = row.last_activity
      ? Date.parse(row.last_activity)
      : 0;
    const existingTime = existing?.last_activity
      ? Date.parse(existing.last_activity)
      : 0;
    if (!existing || rowTime >= existingTime) {
      newest.set(key, row);
    }
  }
  const ttl = activeSessionTtlMs();
  const now = Date.now();
  return Array.from(newest.values()).filter((r) => {
    // Drop tombstones - they exist in the log but shouldn't render.
    if (r.status === "complete") return false;
    // Reaper: a row with no parseable timestamp can't be shown to be live,
    // and one older than the TTL is a dead session that never tombstoned.
    const last = r.last_activity ? Date.parse(r.last_activity) : NaN;
    if (Number.isNaN(last)) return false;
    return now - last <= ttl;
  });
}

// ---------------------------------------------------------------------------
// Render helpers
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

function shortMachine(machineId: string | undefined): string {
  if (!machineId) return "-";
  // First 8 chars of the hash is enough to disambiguate hosts visually
  // without bloating the column.
  return machineId.length <= 8 ? machineId : machineId.slice(0, 8);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)) + "…";
}

// ---------------------------------------------------------------------------
// Renderer - tabular, brand palette, matches msg.ts style
// ---------------------------------------------------------------------------

function renderSessions(rows: SessionRecord[]): void {
  if (rows.length === 0) {
    process.stdout.write(
      brand.dim("no active sessions - daemon log present but no live rows.\n"),
    );
    return;
  }

  // Newest first so the freshest session sits at the top.
  const sorted = [...rows].sort((a, b) => {
    const ta = a.last_activity ? Date.parse(a.last_activity) : 0;
    const tb = b.last_activity ? Date.parse(b.last_activity) : 0;
    return tb - ta;
  });

  process.stdout.write(
    brand.titleDim("active sessions") +
      brand.dim("  ·  ") +
      brand.faint(
        `${sorted.length} session${sorted.length === 1 ? "" : "s"} · daemon cache`,
      ) +
      "\n\n",
  );

  process.stdout.write(
    "  " +
      brand.muted("tool".padEnd(10)) +
      "  " +
      brand.muted("machine".padEnd(10)) +
      "  " +
      brand.muted("started".padEnd(10)) +
      "  " +
      brand.muted("status".padEnd(8)) +
      "  " +
      brand.muted("working on".padEnd(28)) +
      "  " +
      brand.muted("files") +
      "\n",
  );
  process.stdout.write("  " + brand.borderDim("─".repeat(80)) + "\n");

  for (const row of sorted) {
    const tool = (row.tool ?? "-").padEnd(10);
    const machine = shortMachine(row.machine_id).padEnd(10);
    const started = formatRelative(row.started_at).padEnd(10);
    const status = (row.status ?? "-").padEnd(8);
    const workingOn = truncate(row.working_on ?? "-", 28).padEnd(28);
    const files = String((row.files_touched ?? []).length);
    const statusColour =
      row.status === "active"
        ? brand.accent
        : row.status === "idle"
          ? brand.dim
          : brand.faint;
    process.stdout.write(
      "  " +
        brand.accent(tool) +
        "  " +
        brand.text(machine) +
        "  " +
        brand.dim(started) +
        "  " +
        statusColour(status) +
        "  " +
        brand.text(workingOn) +
        "  " +
        brand.muted(files) +
        "\n",
    );
  }
}

// ---------------------------------------------------------------------------
// Subcommand
// ---------------------------------------------------------------------------

function printHelp(): void {
  process.stdout.write(
    [
      "alter coord status",
      "",
      "List active sessions coordinated by the alter-runtime daemon",
      "across tools (cc, codex, cursor, alter-cli, android, widget,",
      "obsidian) and machines. Reads",
      "~/.local/share/alter-runtime/active-sessions.jsonl directly -",
      "no MCP fallback. If the file is absent, the daemon hasn't",
      "started yet.",
      "",
    ].join("\n"),
  );
}

async function cmdStatus(argv: string[]): Promise<void> {
  for (const a of argv) {
    if (a === "--help" || a === "-h") {
      printHelp();
      return;
    }
    process.stderr.write(`Unknown flag: ${a}\n`);
    process.exitCode = 1;
    return;
  }

  // Auth check - coordination is identity-scoped, even on a local read.
  const session = getSession();
  if (!session) {
    process.stderr.write(
      brand.text("not signed in. run `alter login` first.\n"),
    );
    // Soft exit: a hard process.exit() races libuv teardown on Windows.
    process.exitCode = 1;
    return;
  }

  const rows = readActiveSessions();
  if (rows === null) {
    process.stdout.write(
      [
        brand.dim("no active-sessions.jsonl - daemon hasn't started yet."),
        brand.faint(
          `  expected at: ${ACTIVE_SESSIONS_FILE}`,
        ),
        "",
      ].join("\n") + "\n",
    );
    return;
  }

  const deduped = dedupSessions(rows);
  renderSessions(deduped);
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export async function coord(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (sub !== "help" && sub !== "--help" && sub !== "-h") {
    try {
      emitSessionHeartbeat({
        sessionId: String(process.pid),
        workingOn: "alter coord",
      });
    } catch { /* silent - must not block command */ }
  }
  switch (sub) {
    case undefined:
    case "status":
      await cmdStatus(argv[0] === undefined ? argv : argv.slice(1));
      return;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      process.stderr.write(`Unknown subcommand: alter coord ${sub}\n`);
      process.stderr.write("Run `alter coord --help` for usage.\n");
      process.exitCode = 1;
      return;
  }
}
