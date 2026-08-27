/**
 * Active-sessions emitter - alter-cli side for local session coordination.
 *
 * Writes `session_started` / `session_heartbeat` / `session_ended`
 * envelopes into the daemon-owned JSONL log at
 * `$XDG_DATA_HOME/alter-runtime/active-sessions.jsonl` (default
 * `~/.local/share/alter-runtime/active-sessions.jsonl`). The coordination
 * reader and this emitter resolve the same path so they never disagree.
 *
 * Schema:
 *   https://docs.truealter.com/schemas/active-sessions.schema.json
 *
 * Concurrency model - POSIX O_APPEND atomicity.
 *   Lines are well under PIPE_BUF (4096 bytes on every Linux/macOS we
 *   support), so `fs.appendFileSync(path, line + "\n", {flag:"a"})`
 *   issues a single `write(2)` against an O_APPEND fd. The kernel
 *   guarantees that write is atomic w.r.t. other appenders on the same
 *   file - no `flock`, no `proper-lockfile`, no `fs-ext` needed. This is
 *   the same contract the daemon writer + the local broadcast hook rely
 *   on (the hook wraps `flock` belt-and-braces but the underlying
 *   primitive is identical).
 *
 * Doctrine - no MCP fallback. If the handle is missing, if JSON.stringify
 * chokes, if the disk write fails: silent skip + a one-line JSON log
 * entry. Coordination is the daemon's job; the CLI MUST NOT block its
 * caller and MUST NOT throw.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";

import { deriveMachineId } from "../onboarding/progress.js";
import { readSession } from "../auth.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SessionEmitInput {
  /** Caller passes `String(process.pid)` (matches schema dedup contract). */
  sessionId: string;
  /** Free-text focus summary; omitted from envelope when absent. */
  workingOn?: string | null;
  /** Active git branch. `null`/`undefined` → auto-derive via `git -C cwd`. */
  branch?: string | null;
  /** Recently-touched paths; bounded to last 16; heartbeat-only. */
  filesTouched?: string[];
}

// B3 fix: emit() is synchronous (file append is cheap). The only previously
// blocking call was deriveBranch() via execFileSync. That is now replaced by
// probeBranchAsync() (execFile, non-blocking) + a module-level cache so
// importing this module and calling these wrappers never blocks the event
// loop. The void prefix here is kept for forward compatibility but is
// semantically a no-op since emit() is sync and never throws.
export function emitSessionStarted(input: SessionEmitInput): void {
  void emit("session_started", input);
}

export function emitSessionHeartbeat(input: SessionEmitInput): void {
  void emit("session_heartbeat", input);
}

export function emitSessionEnded(input: SessionEmitInput): void {
  void emit("session_ended", input);
}

// ---------------------------------------------------------------------------
// Path resolvers - mirror the coordination reader + the local broadcast hook
// ---------------------------------------------------------------------------

/** Resolve `<jsonl>` path. Matches the coordination reader exactly. */
export function activeSessionsJsonlPath(): string {
  const dataHome =
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "alter-runtime", "active-sessions.jsonl");
}

function versionSidecarPath(): string {
  return activeSessionsJsonlPath() + ".ver";
}

function sessionStartedSidecarPath(sessionId: string): string {
  const stateHome =
    process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  return path.join(
    stateHome,
    "alter-cli",
    "sessions",
    `${sanitiseSessionId(sessionId)}.started`,
  );
}

function logPath(): string {
  const dir =
    process.env.ALTER_LOG_DIR ??
    path.join(os.homedir(), ".local", "share", "alter");
  return path.join(dir, "active-sessions-emit.log");
}

/**
 * Strip anything that isn't a session-id-safe char so a malicious caller
 * can't traverse out of the sidecar directory. PIDs are decimal digits in
 * practice; we accept the broader UUID/digit/dash/underscore set.
 */
function sanitiseSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
}

// ---------------------------------------------------------------------------
// Session-config reader (handle + consent_tier)
// ---------------------------------------------------------------------------

interface SessionConfigSnapshot {
  handle: string | null;
  consentTier: 1 | 2 | 3 | 4;
}

/**
 * Read the session config for the handle and consent tier needed by the
 * active-sessions emitter. Routes through the canonical enc-store accessor
 * (readSession from auth.ts) which resolves enc-store first, then falls back
 * to the legacy plaintext session.json. Never reads the plaintext file directly
 * as primary.
 */
function readSessionConfig(): SessionConfigSnapshot {
  let session: ReturnType<typeof readSession>;
  try {
    session = readSession();
  } catch {
    return { handle: null, consentTier: 2 };
  }
  if (!session) {
    return { handle: null, consentTier: 2 };
  }
  const handle =
    typeof session.handle === "string" && session.handle.length > 0
      ? session.handle
      : null;
  const tierParsed =
    typeof session.consent_tier === "string"
      ? parseInt(session.consent_tier, 10)
      : typeof session.consent_tier === "number"
      ? session.consent_tier
      : NaN;
  const tier =
    tierParsed === 1 || tierParsed === 2 || tierParsed === 3 || tierParsed === 4
      ? (tierParsed as 1 | 2 | 3 | 4)
      : 2;
  return { handle, consentTier: tier };
}

// ---------------------------------------------------------------------------
// Context proposal
// ---------------------------------------------------------------------------

/**
 * The context proposal this emitter attaches to every envelope.
 *
 * OBSERVATION PROPOSES, ADMISSION CONSTITUTES. Everything here is
 * an observation about where the session is running. None of it grants
 * anything: the runtime resolves `org` against the member's SERVER-ISSUED
 * memberships and seals whatever does not match, and the egress boundary
 * re-derives that verdict rather than trusting the record. So this emitter
 * cannot bind its own session however it fills this in, which is the point.
 */
interface ContextProposal {
  /** Working location. LOCAL-ONLY, stripped at the boundary; never published. */
  local_name: string;
  /** The organisation the member maps this location to, if any. */
  org?: string;
  /** Retention for this context; the runtime defaults it when absent. */
  decay_class?: string;
}

interface ContextMapEntry {
  path: string;
  org?: string;
  decay_class?: string;
}

/**
 * Where the member's location-to-organisation assignments live. This is the
 * local half of the Contexts panel, the surface a non-technical person
 * manages this from, so it is a plain file the panel writes rather than
 * anything a person is expected to hand-edit or a new command to learn.
 */
export function contextsConfigPath(): string {
  const configHome =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(configHome, "alter", "contexts.json");
}

function readContextMap(): ContextMapEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(contextsConfigPath(), "utf8");
  } catch {
    // No assignments yet. Every session then proposes no organisation and
    // seals, which is the correct resting state, not a degraded one.
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const list = (parsed as { contexts?: unknown })?.contexts;
    if (!Array.isArray(list)) return [];
    return list.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const e = entry as Record<string, unknown>;
      if (typeof e.path !== "string" || e.path.length === 0) return [];
      return [
        {
          path: e.path,
          ...(typeof e.org === "string" && e.org.length > 0
            ? { org: e.org }
            : {}),
          ...(typeof e.decay_class === "string" && e.decay_class.length > 0
            ? { decay_class: e.decay_class }
            : {}),
        },
      ];
    });
  } catch {
    return [];
  }
}

/**
 * Resolve the working location against the member's assignments.
 *
 * LONGEST PREFIX WINS, so a narrower assignment inside a broader one takes
 * precedence: a client directory nested under a general code directory belongs
 * to the client, which is the case the freelancer scenario in the plain-language
 * Explainer is built on. Matching is on path SEGMENTS, so `/code/acme-old`
 * never matches an assignment for `/code/acme`.
 */
function resolveContext(cwd: string): ContextProposal {
  const here = path.resolve(cwd);
  const proposal: ContextProposal = { local_name: here };

  let best: ContextMapEntry | null = null;
  for (const entry of readContextMap()) {
    const base = path.resolve(entry.path);
    if (here !== base && !here.startsWith(base + path.sep)) continue;
    if (best === null || base.length > path.resolve(best.path).length) {
      best = entry;
    }
  }
  if (best?.org) proposal.org = best.org;
  if (best?.decay_class) proposal.decay_class = best.decay_class;
  return proposal;
}

// ---------------------------------------------------------------------------
// Version sidecar - monotonic per session_id, atomic rename
// ---------------------------------------------------------------------------

function nextVersion(sessionId: string): number {
  const p = versionSidecarPath();
  let state: Record<string, number> = {};
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
          state[k] = Math.floor(v);
        }
      }
    }
  } catch {
    // Missing file or malformed JSON → reset to empty per brief.
    state = {};
  }
  const current = state[sessionId];
  const next = typeof current === "number" ? current + 1 : 0;
  state[sessionId] = next;
  try {
    ensureDir(path.dirname(p));
    const tmp = `${p}.tmp.${process.pid}.${crypto.randomUUID()}`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, p);
  } catch {
    // Best-effort - version may regress on disk failure; not fatal.
  }
  return next;
}

// ---------------------------------------------------------------------------
// started_at sidecar - first-emit cache so heartbeats share the anchor
// ---------------------------------------------------------------------------

function resolveStartedAt(sessionId: string, kind: EmitKind): string {
  const p = sessionStartedSidecarPath(sessionId);
  if (kind === "session_started") {
    try {
      return fs.readFileSync(p, "utf8").trim() || persistStartedAt(p);
    } catch {
      return persistStartedAt(p);
    }
  }
  // Heartbeat / ended - defensive: never throw, fall back to "now".
  try {
    const onDisk = fs.readFileSync(p, "utf8").trim();
    if (onDisk) return onDisk;
  } catch {
    /* no-op */
  }
  return new Date().toISOString();
}

function persistStartedAt(p: string): string {
  const iso = new Date().toISOString();
  try {
    ensureDir(path.dirname(p));
    fs.writeFileSync(p, iso, { mode: 0o600 });
  } catch {
    /* best-effort */
  }
  return iso;
}

// Branch derivation is now handled via probeBranchAsync() + _cachedBranch
// inside the core emit block below. No synchronous execFileSync call remains.

// ---------------------------------------------------------------------------
// Skip log - one-line JSON, never throws
// ---------------------------------------------------------------------------

function logSkip(reason: string, kind: EmitKind, sessionId: string): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event: "skip",
    reason,
    kind,
    session: sessionId,
  });
  try {
    const p = logPath();
    ensureDir(path.dirname(p));
    fs.appendFileSync(p, line + "\n", { flag: "a", mode: 0o600 });
  } catch {
    /* swallow - logger of last resort cannot itself error */
  }
}

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") {
      // Re-throw only when truly unknown; mkdir(recursive) returns
      // success on EEXIST today but be explicit.
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Core emit
// ---------------------------------------------------------------------------

type EmitKind = "session_started" | "session_heartbeat" | "session_ended";

// B3 fix: emit remains synchronous (the file append is cheap). Branch
// derivation via git is deferred: when the caller does not supply a branch,
// we use null in this envelope and fire the git probe asynchronously so
// future calls (heartbeat, ended) can use the cached result. This eliminates
// the execFileSync cold-start cost (0-500ms per command) while keeping the
// JSONL write synchronous, which the tests rely on.
let _cachedBranch: string | null | undefined = undefined; // undefined = not yet probed

function probeBranchAsync(): void {
  // Fire the probe only once; subsequent calls see the cache.
  if (_cachedBranch !== undefined) return;
  execFile(
    "git",
    ["-C", process.cwd(), "branch", "--show-current"],
    { timeout: 500, encoding: "utf8" },
    (_err, stdout) => {
      try {
        const out = (stdout ?? "").trim();
        _cachedBranch = out.length > 0 ? out : null;
      } catch {
        _cachedBranch = null;
      }
    },
  );
}

function emit(kind: EmitKind, input: SessionEmitInput): void {
  const sessionId = input.sessionId;
  const cfg = readSessionConfig();
  if (!cfg.handle) {
    logSkip("no_handle", kind, sessionId);
    return;
  }

  let branch: string | null;
  if (input.branch !== undefined && input.branch !== null) {
    branch = input.branch;
  } else if (_cachedBranch !== undefined) {
    branch = _cachedBranch;
  } else {
    // Probe not yet resolved: use null for this envelope, kick off async probe
    // so the next emit (heartbeat or ended) will have a cached value.
    branch = null;
    probeBranchAsync();
  }

  const startedAt = resolveStartedAt(sessionId, kind);
  const version = nextVersion(sessionId);
  const status: "active" | "complete" =
    kind === "session_ended" ? "complete" : "active";

  // Envelope assembly - only emit optional fields when meaningful so the
  // disk shape stays compact and matches the local broadcast hook's
  // conditional jq branches.
  const envelope: Record<string, unknown> = {
    id: crypto.randomUUID(),
    version,
    kind,
    handle: cfg.handle,
    tool: "alter-cli",
    session_id: sessionId,
    machine_id: deriveMachineId(),
    started_at: startedAt,
    last_activity: new Date().toISOString(),
    status,
    provenance_class: "active_composition",
    consent_tier: cfg.consentTier,
    // Every envelope carries a context proposal, so no consumer meets an
    // absent one or inherits another session's. What it resolves
    // to - bound or sealed - is not this emitter's to decide.
    context: resolveContext(process.cwd()),
  };

  if (typeof input.workingOn === "string" && input.workingOn.length > 0) {
    envelope.working_on = input.workingOn;
  }

  // branch is `string | null` in schema - emit null explicitly for
  // detached HEAD / non-git cwd so dedupers and the worktree gate see
  // the absence of a branch rather than missing the key.
  envelope.branch = branch;

  if (kind === "session_heartbeat") {
    const files = input.filesTouched;
    if (Array.isArray(files) && files.length > 0) {
      envelope.files_touched = files.slice(-16);
    }
  }

  let line: string;
  try {
    line = JSON.stringify(envelope);
  } catch {
    logSkip("json_build_failed", kind, sessionId);
    return;
  }

  const jsonlPath = activeSessionsJsonlPath();
  try {
    ensureDir(path.dirname(jsonlPath));
    fs.appendFileSync(jsonlPath, line + "\n", { flag: "a", mode: 0o600 });
  } catch {
    logSkip("append_failed", kind, sessionId);
    return;
  }
}
