/**
 * `alter excitations flush` - programmatic excitation spool flush.
 *
 * Hidden subcommand: NOT in `alter --help`, NOT in the interactive menu,
 * NOT in the README command table. Exists so the CC Stop hook
 * (cc-excitation-upload.sh) has a single auth-handling entry point that
 * doesn't need the session JWT in its shell environment.
 *
 * Transport contract (mirrors alter-runtime's TokenUsageClient):
 *   POST {session.api}/api/v1/iai-tap/excitations
 *   body: {"events": [<new spool rows>]}
 *   idempotent: the backend dedups on each row's UUID `id`, so a re-sent
 *   line never double-counts. The line-offset advances on 2xx only.
 *
 *   The spool is sent in BATCHES bounded by both backend limits (500 events,
 *   1 MiB body), and the offset advances after each 2xx rather than once at
 *   the end. Both halves matter: a spool bigger than one body is the normal
 *   steady state, and advancing only on a whole-spool success turns a single
 *   rejection into a ratchet - the un-drained spool grows every turn, so the
 *   body drifts further over the cap and every later flush fails too.
 *
 * Spool + offset paths default to the exact files the bash hook used, so
 * the cutover preserves offset continuity (no re-upload window):
 *   spool:  $ALTER_CONVERSATION_EXCITATION_PATH || $CONVERSATION_EXCITATION_JSONL
 *           || $XDG_DATA_HOME/alter-runtime/conversation-excitation.jsonl
 *   offset: $XDG_DATA_HOME/alter/cc-excitation-upload.offset
 *
 * Usage:
 *   alter excitations flush [--spool <path>] [--offset-file <path>] [--quiet]
 *
 * Output:
 *   stdout: one line of JSON `{"ok": true|false, "flushed": N, ...}`
 *   stderr: human-readable error on failure (also non-zero exit code)
 *
 * Exit codes match `alter ingest`: 1 usage, 2 no/expired session,
 * 3 transport error, 4 backend rejection. Missing spool or nothing new
 * is a clean 0 - the hook treats it as fire-and-forget.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { getSession, isExpired, httpCall } from "../auth.js";
import { emitSessionHeartbeat } from "../lib/active-sessions-emit.js";

export interface ExcitationsFlushArgs {
  action: "flush";
  spool?: string;
  offsetFile?: string;
  quiet: boolean;
}

export type ExcitationsParseResult = ExcitationsFlushArgs | { error: string };

const USAGE =
  "Usage: alter excitations flush\n" +
  "  --spool <path>        spool JSONL override (default: conversation-excitation spool)\n" +
  "  --offset-file <path>  line-offset file override\n" +
  "  --quiet, -q           suppress result line";

export function parseExcitationsArgs(argv: string[]): ExcitationsParseResult {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return { error: USAGE };
  }
  if (argv[0] !== "flush") {
    return { error: `unknown excitations action: ${argv[0]}\n${USAGE}` };
  }

  let spool: string | undefined;
  let offsetFile: string | undefined;
  let quiet = false;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--spool") {
      spool = argv[++i];
      if (!spool) return { error: "--spool requires a value" };
    } else if (arg === "--offset-file") {
      offsetFile = argv[++i];
      if (!offsetFile) return { error: "--offset-file requires a value" };
    } else if (arg === "--quiet" || arg === "-q") {
      quiet = true;
    } else {
      return { error: `unknown argument: ${arg}\n${USAGE}` };
    }
  }

  return { action: "flush", spool, offsetFile, quiet };
}

/** Wire row projected from a spool line - same field set the bash hook sent. */
export interface ExcitationEvent {
  id: unknown;
  ts?: unknown;
  session_id?: unknown;
  model?: unknown;
  t0?: unknown;
}

/**
 * Project raw spool lines into wire events. Mirrors the hook's jq filter:
 * keep objects only, project {id, ts, session_id, model, t0}, drop rows
 * without an `id`. Unparseable lines are silently dropped (the offset
 * still advances past them on success - same semantics as the hook).
 */
export function projectSpoolEvents(lines: string[]): ExcitationEvent[] {
  const events: ExcitationEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    if (r.id === null || r.id === undefined) continue;
    events.push({
      id: r.id,
      ts: r.ts,
      session_id: r.session_id,
      model: r.model,
      t0: r.t0,
    });
  }
  return events;
}

/**
 * Batch bounds. Both mirror a limit the backend enforces, and the flush must
 * respect the tighter of the two:
 *   - 500 events: `_MAX_EVENTS_PER_BATCH` on ExcitationBatchRequest (422 above).
 *   - 1 MiB body: the per-path request-size cap (413 above).
 * The byte budget sits under 1 MiB so the `{"events":[...]}` wrapper and any
 * multi-byte UTF-8 still fit.
 */
const MAX_EVENTS_PER_BATCH = 500;
const MAX_BATCH_BYTES = 900_000;

export interface SpoolChunk {
  events: ExcitationEvent[];
  /** Spool lines this chunk consumes, event-bearing or not. */
  lineCount: number;
  /** Events too large to ever ship, dropped so they cannot wedge the spool. */
  oversizedDropped: number;
}

/**
 * Split spool lines into batches that fit both backend bounds.
 *
 * Chunks carry a `lineCount` rather than an event count because the offset is
 * a LINE offset and the projection drops rows (unparseable, id-less). Advancing
 * by events would desynchronise the offset from the spool and re-send or skip
 * rows. Lines that project to nothing still belong to a chunk, so the offset
 * advances past them.
 *
 * A single event larger than the byte budget can never be sent. It is dropped
 * and its line consumed: leaving it in place would refuse forever and block
 * every row behind it, which is the failure this whole chunker exists to end.
 */
export function chunkSpoolLines(
  lines: string[],
  maxEvents: number = MAX_EVENTS_PER_BATCH,
  maxBytes: number = MAX_BATCH_BYTES,
): SpoolChunk[] {
  const chunks: SpoolChunk[] = [];
  let events: ExcitationEvent[] = [];
  let lineCount = 0;
  let bytes = 0;

  const emit = (): void => {
    if (lineCount === 0) return;
    chunks.push({ events, lineCount, oversizedDropped: 0 });
    events = [];
    lineCount = 0;
    bytes = 0;
  };

  for (const line of lines) {
    const [event] = projectSpoolEvents([line]);
    if (!event) {
      lineCount += 1;
      continue;
    }
    // +1 for the separating comma in the serialised array.
    const size = Buffer.byteLength(JSON.stringify(event), "utf8") + 1;
    if (size > maxBytes) {
      emit();
      chunks.push({ events: [], lineCount: 1, oversizedDropped: 1 });
      continue;
    }
    if (events.length >= maxEvents || bytes + size > maxBytes) emit();
    events.push(event);
    lineCount += 1;
    bytes += size;
  }
  emit();
  return chunks;
}

function xdgDataHome(): string {
  return process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
}

function defaultSpoolPath(): string {
  return (
    process.env.ALTER_CONVERSATION_EXCITATION_PATH ??
    process.env.CONVERSATION_EXCITATION_JSONL ??
    path.join(xdgDataHome(), "alter-runtime", "conversation-excitation.jsonl")
  );
}

function defaultOffsetPath(): string {
  return path.join(xdgDataHome(), "alter", "cc-excitation-upload.offset");
}

function readOffset(offsetPath: string): number {
  try {
    const raw = fs.readFileSync(offsetPath, "utf8").replace(/[^0-9]/g, "");
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeOffset(offsetPath: string, value: number): void {
  fs.mkdirSync(path.dirname(offsetPath), { recursive: true });
  const tmp = `${offsetPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${value}\n`, "utf8");
  fs.renameSync(tmp, offsetPath);
}

/**
 * Persist the offset without letting a write failure abort a flush that has
 * already delivered rows. The rows are already folded and the backend dedups
 * on each row's UUID, so a re-send after a failed write is safe.
 */
function saveOffset(offsetPath: string, value: number): void {
  try {
    writeOffset(offsetPath, value);
  } catch (err) {
    process.stderr.write(
      `alter: offset write failed (rows uploaded, will re-send next flush; backend dedups): ${
        (err as Error).message
      }\n`,
    );
  }
}

function emitResult(quiet: boolean, result: Record<string, unknown>): void {
  if (!quiet) process.stdout.write(JSON.stringify(result) + "\n");
}

export async function excitations(argv: string[]): Promise<void> {
  const parsed = parseExcitationsArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(parsed.error + "\n");
    process.exitCode = 1;
    return;
  }
  try {
    emitSessionHeartbeat({
      sessionId: String(process.pid),
      workingOn: "alter excitations flush",
    });
  } catch { /* silent - must not block command */ }

  const spoolPath = parsed.spool ?? defaultSpoolPath();
  const offsetPath = parsed.offsetFile ?? defaultOffsetPath();

  // No spool == nothing to flush. Clean exit so the hook stays fail-open.
  if (!fs.existsSync(spoolPath)) {
    emitResult(parsed.quiet, { ok: true, flushed: 0, reason: "no_spool" });
    return;
  }

  if (isExpired()) {
    process.stderr.write(
      "alter: session expired - run `alter login` and retry\n",
    );
    process.exitCode = 2;
    return;
  }
  const session = getSession();
  if (!session) {
    process.stderr.write(
      "alter: no active session - run `alter login` and retry\n",
    );
    process.exitCode = 2;
    return;
  }

  const apiBase = (session.api ?? "").replace(/\/+$/, "");
  if (!apiBase) {
    process.stderr.write("alter: session is missing api base\n");
    process.exitCode = 2;
    return;
  }

  let spoolRaw: string;
  try {
    spoolRaw = fs.readFileSync(spoolPath, "utf8");
  } catch (err) {
    process.stderr.write(
      `alter: spool unreadable: ${(err as Error).message}\n`,
    );
    process.exitCode = 3;
    return;
  }

  // Trailing newline yields one empty trailing element - drop it so the
  // line count matches `wc -l` (the offset the bash hook left behind).
  const lines = spoolRaw.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const totalLines = lines.length;

  let sent = readOffset(offsetPath);
  // Spool rotated/truncated below our offset - reset (hook parity).
  if (sent > totalLines) sent = 0;

  if (totalLines <= sent) {
    emitResult(parsed.quiet, { ok: true, flushed: 0, reason: "up_to_date" });
    return;
  }

  const chunks = chunkSpoolLines(lines.slice(sent));
  if (chunks.length === 0) {
    // All-new-lines unparseable or id-less: advance past them (hook parity).
    saveOffset(offsetPath, totalLines);
    emitResult(parsed.quiet, { ok: true, flushed: 0, reason: "no_events" });
    return;
  }

  // The offset advances per SUCCESSFUL chunk, not once at the end. A spool
  // larger than one permitted body must still drain: advancing only on a
  // whole-spool success means one rejection re-sends everything next turn,
  // and since the spool grows every turn the body only gets further over the
  // cap. That is a ratchet, not a retry - it never recovers on its own.
  let flushed = 0;
  let oversizedDropped = 0;
  let offset = sent;

  for (const chunk of chunks) {
    if (chunk.events.length > 0) {
      let response: Response;
      try {
        response = await httpCall(`${apiBase}/api/v1/iai-tap/excitations`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.jwt}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ events: chunk.events }),
          timeoutMs: 15_000,
        });
      } catch (err) {
        // Keep the progress already made; the rest retries next flush.
        saveOffset(offsetPath, offset);
        process.stderr.write(
          `alter: excitations transport error after ${flushed} row(s): ${
            (err as Error).message
          }\n`,
        );
        process.exitCode = 3;
        return;
      }

      if (!response.ok) {
        let bodyText = "";
        try {
          bodyText = await response.text();
        } catch { /* keep empty */ }
        saveOffset(offsetPath, offset);
        process.stderr.write(
          `alter: excitations rejected (HTTP ${response.status}) after ${flushed} row(s): ${
            bodyText || "(no body)"
          }\n`,
        );
        process.exitCode = 4;
        return;
      }
      flushed += chunk.events.length;
    }
    offset += chunk.lineCount;
    oversizedDropped += chunk.oversizedDropped;
    saveOffset(offsetPath, offset);
  }

  emitResult(parsed.quiet, {
    ok: true,
    flushed,
    offset,
    ...(oversizedDropped > 0 ? { oversized_dropped: oversizedDropped } : {}),
  });
}
