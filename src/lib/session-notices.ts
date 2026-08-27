/**
 * session-notices - the served Terms section 14 "notice within the Service"
 * channel.
 *
 * ALTER's Terms require material changes be notified "by notice within the
 * Service". There was no in-Service notice channel before this - this is
 * it. At CLI session start, for a signed-in member, fetch active
 * undismissed notices and render a one-shot stderr line naming them (the
 * same idiom as `noticeSecretFault` in secure-store.ts and the self-update
 * "newer version" notice in index.ts: state what's there, name where to
 * act, stop). The member reads and dismisses through the Account > Notices
 * menu leaf (src/commands/notices.ts) - there is no top-level verb.
 *
 * Dismissal is a server round-trip on purpose. The POST
 * `/api/v1/me/notices/{id}/dismiss` call IS the section 14 notification
 * receipt; a client-only "mark as seen" file would let a member's CLI
 * silently swallow the notice with no record anywhere that they were ever
 * told, so that shape is never built here. This module keeps only a
 * throttle cache (when did we last ASK), never a dismissal cache (what did
 * we decide NOT to show again).
 *
 * Throttle: at most one network check per hour, persisted at
 * `~/.cache/alter/session-notices-check.json`, mirroring self-update.ts's
 * self-update-check.json exactly (same cache root, same shape, same
 * reasoning: an un-throttled check would hit the backend on every
 * keystroke-fast command).
 *
 * Failure model: every step is best-effort and NEVER throws past its own
 * boundary. Not logged in, offline, a slow endpoint, a non-2xx response,
 * an unparsable body - all degrade to an empty notice list. A legal notice
 * that broke the CLI would be worse than a legal notice that is late.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join as pathJoin, resolve as pathResolve } from "path";
import * as os from "os";

import { apiCall, getSession } from "../auth.js";

export interface SessionNotice {
  id: string;
  kind: string;
  title: string;
  body: string;
  document_version: string;
  published_at: string;
}

const THROTTLE_MS = 60 * 60 * 1000; // 1 hour - matches self-update's cadence

interface ThrottleState {
  last_check_ms: number;
}

export interface SessionNoticeDeps {
  now: () => number;
  readFile: (path: string) => string | null;
  writeFile: (path: string, data: string) => void;
  homedir: () => string;
  env: NodeJS.ProcessEnv;
}

function defaultReadFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function defaultWriteFile(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, data, { mode: 0o600 });
}

function withDefaults(deps?: Partial<SessionNoticeDeps>): SessionNoticeDeps {
  return {
    now: deps?.now ?? (() => Date.now()),
    readFile: deps?.readFile ?? defaultReadFile,
    writeFile: deps?.writeFile ?? defaultWriteFile,
    homedir: deps?.homedir ?? (() => os.homedir()),
    env: deps?.env ?? process.env,
  };
}

function throttleStatePath(deps: SessionNoticeDeps): string {
  const cacheRoot =
    deps.env.XDG_CACHE_HOME ?? pathResolve(deps.homedir(), ".cache");
  return pathJoin(cacheRoot, "alter", "session-notices-check.json");
}

/** Exported for tests only - not part of the public contract. */
export function _isThrottled(deps?: Partial<SessionNoticeDeps>): boolean {
  const d = withDefaults(deps);
  const raw = d.readFile(throttleStatePath(d));
  if (!raw) return false;
  let parsed: ThrottleState;
  try {
    parsed = JSON.parse(raw) as ThrottleState;
  } catch {
    return false;
  }
  if (typeof parsed.last_check_ms !== "number") return false;
  return d.now() - parsed.last_check_ms < THROTTLE_MS;
}

function writeThrottleState(deps: SessionNoticeDeps): void {
  try {
    deps.writeFile(
      throttleStatePath(deps),
      JSON.stringify({ last_check_ms: deps.now() } satisfies ThrottleState),
    );
  } catch {
    // Throttle is best-effort; a failed write just means the next
    // invocation checks again, which is safe, only extra network I/O.
  }
}

/**
 * Fetch active undismissed notices for the signed-in member.
 *
 * Never throws. Returns `[]` for: no session, throttled (unless `force`),
 * network failure, non-2xx, or an unparsable body. `force: true` bypasses
 * the throttle - the Account > Notices menu leaf uses this so an explicit
 * member action always reads live state.
 */
export async function fetchActiveNotices(
  opts: { force?: boolean } = {},
  deps?: Partial<SessionNoticeDeps>,
): Promise<SessionNotice[]> {
  if (!getSession()) return [];
  const d = withDefaults(deps);
  if (!opts.force && _isThrottled(d)) return [];
  writeThrottleState(d);
  try {
    const res = await apiCall("/api/v1/me/notices", { timeoutMs: 4000 });
    if (!res || !res.ok) return [];
    const data = (await res.json()) as { notices?: unknown };
    if (!Array.isArray(data.notices)) return [];
    return data.notices.filter(
      (n): n is SessionNotice =>
        !!n &&
        typeof n === "object" &&
        typeof (n as SessionNotice).id === "string" &&
        typeof (n as SessionNotice).title === "string",
    );
  } catch {
    return [];
  }
}

/**
 * POST the dismiss receipt for one notice. Idempotent server-side on
 * repeat, so a caller can retry freely. Returns false (never throws) on
 * any failure - the Notices leaf surfaces that to the member itself.
 */
export async function dismissNotice(noticeId: string): Promise<boolean> {
  try {
    const res = await apiCall(
      `/api/v1/me/notices/${encodeURIComponent(noticeId)}/dismiss`,
      { method: "POST", timeoutMs: 8000 },
    );
    return !!res && (res.status === 204 || res.ok);
  } catch {
    return false;
  }
}

/**
 * One stderr render per session-start check. Mirrors noticeSecretFault's
 * one-shot idiom and the self-update "newer version" line: states WHAT is
 * there, names where to act, stops - the dismiss ceremony itself lives in
 * the Notices menu leaf, not here.
 */
export function renderSessionNotices(notices: SessionNotice[]): void {
  if (notices.length === 0) return;
  const n = notices.length;
  const lines = [
    "",
    `alter: ${n} notice${n === 1 ? "" : "s"} about your ~Alter account ${
      n === 1 ? "needs" : "need"
    } your attention.`,
    ...notices.slice(0, 5).map((notice) => `  - ${notice.title}`),
    ...(notices.length > 5 ? [`  - and ${notices.length - 5} more`] : []),
    "  Read and dismiss: run `alter`, then Account > Notices.",
    "",
  ];
  process.stderr.write(lines.join("\n") + "\n");
}

/**
 * Best-effort session-start check for non-interactive-menu command
 * dispatch: fetch, render, never throw, never affect the invoked command's
 * own exit code or output. Callers fire this off with `void` (see
 * index.ts) exactly like `runSelfUpdateCheck`.
 *
 * Deliberately NOT called on the interactive-menu path (`alter` with no
 * args) - that surface is a long-lived alt-screen and a stderr write here
 * would be wiped by `enterAlt()`'s screen-clear and never seen, same
 * reasoning `runSelfUpdateCheck` already documents for its own notice. The
 * menu instead carries a static, always-present Account > Notices row that
 * fetches live on open.
 */
export async function runSessionNoticeCheck(): Promise<void> {
  try {
    const notices = await fetchActiveNotices();
    renderSessionNotices(notices);
  } catch {
    // Never let the notice check affect the invoked command.
  }
}
