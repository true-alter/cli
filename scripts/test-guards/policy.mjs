/**
 * The policy half of the no-live-host test gate: which invocations mutate the
 * live host's service manager, and the refusal they earn.
 *
 * Kept apart from the shim so the rule can be tested directly, without a
 * loader registration in the way.
 */

/** Binary -> the verbs that change live host state. */
export const MUTATORS = {
  systemctl: [
    "start",
    "stop",
    "restart",
    "try-restart",
    "reload",
    "reload-or-restart",
    "kill",
    "enable",
    "disable",
    "mask",
    "unmask",
    "reset-failed",
    "daemon-reload",
  ],
  launchctl: ["load", "unload", "start", "stop", "kickstart", "bootstrap", "bootout"],
  schtasks: ["/run", "/end", "/create", "/delete", "/change"],
};

/** Strip path and .exe so a fully-qualified binary is matched like a bare one. */
export function basename(cmd) {
  return String(cmd ?? "")
    .split(/[/\\]/)
    .pop()
    .replace(/\.exe$/i, "")
    .toLowerCase();
}

/**
 * The offending verb when this invocation mutates live host state, else null.
 *
 * Read-only queries (is-active, show, status, list) are deliberately allowed:
 * tests legitimately probe host state, and a gate that blocked reads would be
 * routed around rather than obeyed.
 */
export function offendingVerb(cmd, args) {
  const verbs = MUTATORS[basename(cmd)];
  if (!verbs) return null;
  const argv = (args ?? []).map((a) => String(a).toLowerCase());
  return verbs.find((v) => argv.includes(v)) ?? null;
}

/** The error a refused invocation throws. Never thrown from here. */
export function refusal(cmd, verb) {
  const err = new Error(
    `no-live-host: a test tried to run \`${basename(cmd)} ${verb}\`, which mutates ` +
      `live host state on the machine running the suite.\n` +
      `A unit test must not start, stop, or restart a real service. Inject the ` +
      `spawn boundary and assert the call was made, or guard the code path under ` +
      `test the way bounceDaemon() does.\n` +
      `If this suite genuinely owns the host (an e2e run against a throwaway box), ` +
      `it belongs under tests/e2e/, which is excluded from this gate.`,
  );
  err.code = "ERR_NO_LIVE_HOST";
  return err;
}
