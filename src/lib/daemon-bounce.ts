/**
 * Bounce the alter-runtime systemd user unit so a freshly-written session
 * (after `alter login` or a proactive token rotation) is picked up by the
 * currently-running daemon process.
 *
 * Problem: the SessionRefresher subscriber holds a reference to the shared
 * SessionRef populated at startup.  When the daemon was started BEFORE a
 * session write (e.g. pre-#102 binary, or a re-login that replaced the
 * session file), the in-memory ref is stale and the refresher never fires,
 * or fires against the old expiry.  A restart reloads config from disk.
 *
 * Safety contract:
 *   - Only attempts a restart on Linux where `systemctl --user` is available.
 *   - No-ops silently on macOS / Windows (those platforms use a different
 *     daemon install path and must not see an error here).
 *   - No-ops when the unit is not active (not installed, disabled, stopped).
 *   - No-ops under a test run. The unit this bounces is the developer's OWN
 *     running daemon, so a suite that reaches this function restarts it for
 *     real; concurrent runs stack restarts until systemd's start limiter
 *     latches the unit off, and it stays dead with nothing to say so.
 *   - Never throws: daemon management is best-effort and must not prevent a
 *     successful login or token rotation from completing.
 *   - Uses `child_process.spawnSync` (sync) so the caller blocks for the
 *     ~150 ms systemctl round-trip before printing "Welcome". The user
 *     never notices, and the bounce is not fire-and-forget (a forgotten
 *     spawn can race a concurrent session write).
 *
 * Platform gating:
 *   - `systemctl` is checked via PATH lookup (spawnSync with shell:false);
 *     the GNU-only path issue does not apply because systemctl is a first-
 *     class systemd binary, not a coreutils alias.
 *   - macOS: launchd manages the runtime; a launchctl bounce can be added
 *     here later.  For now: no-op.
 *   - Windows: the runtime is either a Task Scheduler job or a manually-
 *     started process; no standard restart surface.  For now: no-op.
 */

import { spawnSync } from "node:child_process";

const UNIT = "alter-runtime";

/**
 * True when this process is a test run, so a live-host mutation must not fire.
 *
 * Two signals, either sufficient. `ALTER_NO_DAEMON_BOUNCE` is pinned by
 * scripts/run-tests.mjs alongside the secure-store backend pin, and is the
 * signal a caller can set deliberately. `NODE_TEST_CONTEXT` is set by
 * `node --test` in every test process and is the backstop for a suite invoked
 * some other way, so forgetting the pin does not re-open the path.
 */
function isTestRun(): boolean {
  return Boolean(
    process.env.ALTER_NO_DAEMON_BOUNCE || process.env.NODE_TEST_CONTEXT,
  );
}

/**
 * Restart the alter-runtime user unit if it is currently active.
 * Returns a short log string describing what happened (for DEBUG output).
 * Never throws.
 */
export function bounceDaemon(): string {
  if (isTestRun()) {
    return "daemon-bounce: skipped (test run)";
  }

  if (process.platform !== "linux") {
    return `daemon-bounce: skipped (platform=${process.platform})`;
  }

  // Check whether systemctl is on PATH.
  const which = spawnSync("which", ["systemctl"], { encoding: "utf8" });
  if (which.status !== 0) {
    return "daemon-bounce: systemctl not found, skipping";
  }

  // Check whether the unit is active before restarting; avoids a spurious
  // "Failed to restart alter-runtime.service: Unit not found" error message
  // leaking into CLI output for users who do not have the daemon installed.
  const isActive = spawnSync(
    "systemctl",
    ["--user", "is-active", "--quiet", UNIT],
    { encoding: "utf8" },
  );
  if (isActive.status !== 0) {
    // Unit absent, inactive, or failed — nothing to bounce.
    return `daemon-bounce: unit ${UNIT} not active, skipping`;
  }

  // Unit is running: restart it.
  const restart = spawnSync("systemctl", ["--user", "restart", UNIT], {
    encoding: "utf8",
  });
  if (restart.status === 0) {
    return `daemon-bounce: restarted ${UNIT} successfully`;
  }
  return `daemon-bounce: restart exited ${restart.status}: ${(restart.stderr ?? "").trim()}`;
}
