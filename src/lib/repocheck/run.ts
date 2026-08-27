/**
 * repocheck/run.ts -- run the detected checks against the current content.
 *
 * For each check: work out what content it is judged against, look for a pass
 * already filed against exactly that content, and run it for real only when
 * there is none. A recalled pass costs a hash of content git had already
 * hashed; a real run costs whatever the check costs.
 *
 * Checks run one at a time. Two build tools in the same repository routinely
 * contend for the same target directory, and a lock fight reported as a failure
 * would be this runner's fault rather than the code's.
 */

import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import * as path from "path";

import { contentKey, repoIdentity } from "./identity.js";
import { readStore, recall, record, verdictKey, writeStore } from "./store.js";
import { revokeAll, trustFingerprint } from "./trust.js";
import type {
  CheckOutcome,
  CheckStatus,
  RepoCheck,
  RunReport,
  TreeMode,
} from "./types.js";

/** Default ceiling on a single check. Generous: a real test suite is slow. */
export const DEFAULT_CHECK_TIMEOUT_MS = 15 * 60 * 1000;

/** Output retained from a failing check, taken from the end where the error is. */
const OUTPUT_TAIL_CHARS = 4000;

/**
 * Grace given to the output pipes once the command itself has exited, so the
 * last few lines still arrive. Bounded, because a surviving grandchild can hold
 * those pipes open for as long as it likes.
 */
const STREAM_DRAIN_GRACE_MS = 200;

/**
 * Environment this CLI sets for itself, withheld from a repository's commands.
 * One of these carries an access credential, and the rest say how the CLI is
 * configured.
 *
 * WHAT THIS IS NOT. Withholding these does not put the CLI's configuration out
 * of a check's reach. `HOME` is passed through, because a check that cannot
 * find its own package cache is a check that fails for a reason nobody can
 * diagnose, and everything this CLI stores is under `HOME`. The filter narrows
 * what is handed over; it does not draw a boundary.
 */
const OWN_ENV = /^(ALTER_|CF_ACCESS_)/i;

/**
 * Environment whose name marks it as a credential, withheld for the same
 * reason. Matched on whole underscore-separated words, so `SSH_AUTH_SOCK` and
 * `GITHUB_TOKEN` are withheld while `KEYBOARD_LAYOUT` is not. A check that
 * genuinely needs a credential is a check that should be told so plainly rather
 * than handed the whole environment by default.
 *
 * This is a name-based test and names are not the thing. A credential carried
 * in a variable called `DATABASE_URL` reads as ordinary and is passed through.
 */
const CREDENTIAL_ENV =
  /(^|_)(TOKEN|TOKENS|SECRET|SECRETS|KEY|KEYS|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|CREDENTIALS|AUTH|BEARER|SESSION|COOKIE)(_|$)/i;

export interface RunOptions {
  repoRoot: string;
  mode: TreeMode;
  checks: RepoCheck[];
  /**
   * Whether the user has approved this set of commands for this repository.
   * When false nothing is executed, and the report says why.
   */
  approved: boolean;
  timeoutMs?: number;
  /** Called before a check runs for real, never for a recalled pass. */
  onCheckStart?: (check: RepoCheck) => void;
  /** Called once a check has an outcome, recalled or not. */
  onCheckEnd?: (outcome: CheckOutcome) => void;
}

function tail(text: string): string {
  const trimmed = text.trimEnd();
  return trimmed.length <= OUTPUT_TAIL_CHARS
    ? trimmed
    : `...\n${trimmed.slice(-OUTPUT_TAIL_CHARS)}`;
}

/**
 * The environment a repository-supplied command is given.
 *
 * Exported because it is the standard this package holds every
 * repository-declared command to, and a second runner that built its own
 * environment would be a second standard. There is one.
 */
export function checkEnv(): NodeJS.ProcessEnv {
  const allowed: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (OWN_ENV.test(name) || CREDENTIAL_ENV.test(name)) continue;
    allowed[name] = value;
  }
  return allowed;
}

/** How long a survivor of the group SIGTERM is given before it is killed. */
const KILL_ESCALATION_MS = 5000;

/**
 * Terminate the whole tree a check started, not just the shell at the top of it.
 *
 * A signal to the shell alone leaves its children running, and those children
 * hold the output pipes open, which is how a timeout that fires still leaves the
 * caller waiting.
 *
 * ON THE SAFETY OF CALLING THIS AFTER THE SHELL HAS EXITED, which `done` now
 * does on every completion including a clean one, and which is exactly when a
 * pid becomes available for reuse. On POSIX the negative-pid form addresses a
 * process group, a group id is the pid of its leader, and the kernel will not
 * reuse that pid while the group still has members, so either the group is
 * still there and this reaches it or it is empty and the call fails with ESRCH.
 * That argument is POSIX's and holds only on the POSIX branch.
 *
 * ON WINDOWS IT DOES NOT APPLY. There is no process group, the branch above
 * hands a bare pid to `taskkill /t`, and Windows offers no equivalent guarantee
 * that the pid of an exited process is not already somebody else's by the time
 * the call lands. The window is small and this is not a defect anyone has
 * observed; it is stated because the sentence that used to sit here claimed the
 * guarantee for both branches and it belongs to one.
 *
 * NEITHER BRANCH REACHES A PROCESS THAT LEFT THE GROUP DELIBERATELY. `setsid`
 * puts a child in a session of its own, and no signal sent here finds it. That
 * is a hole in this sweep, not an oversight in the comment; closing it would
 * take a cgroup or a job object, which is a boundary this process does not have.
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;

  if (process.platform === "win32") {
    // Windows has no process groups, and terminating a wrapping cmd.exe is
    // documented to leave its children behind. taskkill /t walks the tree.
    //
    // `sweep()` now calls this on every completion, not only a timeout,
    // which is what made a failure here reachable on an ordinary passing
    // check. `spawn` resolves `taskkill` by searching `PATH`, and a failure
    // to find it - PATH scrubbed down for some other reason, a minimal
    // container, a restricted shell - surfaces asynchronously as an `error`
    // event on the returned ChildProcess, not as a synchronous throw. The
    // try/catch below does not see that: it only ever catches. An
    // unlistened `error` event is fatal to the whole process (Node's
    // documented behaviour), which crashed a run that had already finished
    // cleanly. The listener is what actually closes it; the try/catch is
    // kept for whatever spawn setup failure genuinely is synchronous.
    try {
      const tk = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
      tk.on("error", () => {
        // Nothing further to try: the process this was meant to clean up
        // has already finished or been signalled, and taskkill was best
        // effort on top of that.
      });
    } catch {
      // Nothing further to try.
    }
    return;
  }

  try {
    // A negative pid addresses the whole group, which `detached` gave the child.
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

export interface Executed {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

/**
 * Execute one command line in the repository, capturing everything it says.
 *
 * Exported for the same reason `checkEnv` is: the scrubbed environment, the
 * process group and the escalating sweep are one behaviour, and every caller
 * that runs a repository-declared command line gets all three or none.
 */
export function execute(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<Executed> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: checkEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group on POSIX, so a timeout can take the whole tree
      // rather than the one shell sitting at the top of it.
      detached: process.platform !== "win32",
    });

    let output = "";
    let timedOut = false;
    let settled = false;
    let exitCode: number | null = null;
    let escalation: NodeJS.Timeout | undefined;
    let drain: NodeJS.Timeout | undefined;

    const capture = (chunk: Buffer): void => {
      output += chunk.toString();
      // Bound memory on a runaway check without losing the ending, which is
      // the part that says what went wrong.
      if (output.length > OUTPUT_TAIL_CHARS * 4) {
        output = output.slice(-OUTPUT_TAIL_CHARS * 2);
      }
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    /**
     * Ask the group to go, then make sure it does.
     *
     * The escalation is never cleared and is unref'd, so it costs the run no
     * wall-clock time and still fires if this process is alive when it comes
     * due. Cancelling it once the shell exits, which is what used to happen,
     * left the one case it exists for, a survivor that had already left the
     * group, with nothing behind the polite request.
     */
    const sweep = (): void => {
      killTree(child, "SIGTERM");
      if (escalation !== undefined) return;
      escalation = setTimeout(() => killTree(child, "SIGKILL"), KILL_ESCALATION_MS);
      escalation.unref?.();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      sweep();
    }, timeoutMs);

    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (drain !== undefined) clearTimeout(drain);
      // Whatever the check started goes with it, whether it passed, failed or
      // timed out. A check that exits 0 having left a process behind has left
      // something running as the user, outside the run that was approved and
      // after the report says the run is over; that it exited cleanly is no
      // reason to leave it there. The child leads its own group, so this
      // reaches what the check started and nothing else.
      sweep();
      // A surviving grandchild can hold these pipes open long after the command
      // itself has gone, so let them go rather than wait on them.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref?.();
      resolve({ exitCode, output, timedOut });
    };

    child.on("error", (err) => {
      output = `${output}${String(err)}`;
      done();
    });

    // `exit` fires when the command itself has gone; `close` waits for every
    // pipe to close as well, and an orphan can hold one open indefinitely. So
    // `exit` bounds the wait and `close` only shortens it.
    child.on("exit", (code) => {
      exitCode = code;
      drain = setTimeout(done, STREAM_DRAIN_GRACE_MS);
    });
    child.on("close", (code) => {
      exitCode = code ?? exitCode;
      done();
    });
  });
}

/**
 * Run every check, recalling any that has already passed against this content.
 *
 * Nothing is executed unless `approved` is true, and nothing reads the
 * repository either, so an unapproved repository produces a report of what
 * would run rather than the effects of running it.
 */
export async function runChecks(opts: RunOptions): Promise<RunReport> {
  const { repoRoot, mode, checks, approved } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const identity = repoIdentity(repoRoot);
  const store = readStore(identity, repoRoot);

  const outcomes: CheckOutcome[] = [];
  let recalledMs = 0;
  let trustTampered = false;
  /** Keys filed during this run, so a tampered run can take them all back. */
  const recordedThisRun: string[] = [];

  // The approval file as the user left it. Compared after every check, because
  // the commands this file authorises run as the user and can write it.
  const trustAtStart = trustFingerprint(identity);

  // The basis is shared across checks today, so the content is keyed once
  // rather than once per check. The basis is serialised rather than joined on a
  // separator, because no separator is safe against a path that contains it.
  //
  // NULL MEANS GIT COULD NOT ANSWER, and it is cached like any other answer,
  // because asking again in the same run gets the same silence. `has` rather
  // than an undefined check, so a cached null is a hit and not a miss.
  const keyCache = new Map<string, string | null>();
  const keyFor = async (check: RepoCheck): Promise<string | null> => {
    const basisId = JSON.stringify(check.basis);
    if (keyCache.has(basisId)) return keyCache.get(basisId) ?? null;
    const computed = await contentKey(repoRoot, check.basis, mode);
    keyCache.set(basisId, computed);
    return computed;
  };

  for (const check of checks) {
    // Approval is settled before anything else happens, and nothing above this
    // line touches the repository. Keying the content runs `git status` in the
    // user's directory, and `git status` runs whatever the repository named in
    // `filter.<name>.clean`, so keying an unapproved repository would hand it
    // the execution the approval exists to withhold. It also settles before the
    // store is consulted, so a repository whose approval has been withdrawn
    // stops reporting the passes it earned while it was trusted.
    if (!approved || trustTampered) {
      const outcome: CheckOutcome = {
        check,
        status: "WARN",
        exitCode: null,
        output: "",
        durationMs: 0,
        recalled: false,
        key: "",
      };
      outcomes.push(outcome);
      opts.onCheckEnd?.(outcome);
      continue;
    }

    // A check whose content could not be keyed is RUN, and its pass is not
    // banked. Both halves matter: recalling under a key we could not compute
    // would report a pass on content nobody read, and recording under one would
    // leave that pass to be recalled later.
    const content = await keyFor(check);
    const key = content === null ? null : verdictKey(check, content);

    const hit = key === null ? null : recall(store, key);
    if (hit && key !== null) {
      recalledMs += hit.originalDurationMs;
      const outcome: CheckOutcome = {
        check,
        status: "OK",
        exitCode: hit.exitCode,
        output: "",
        durationMs: 0,
        recalled: true,
        key,
      };
      outcomes.push(outcome);
      opts.onCheckEnd?.(outcome);
      continue;
    }

    opts.onCheckStart?.(check);
    const startedAt = Date.now();
    const cwd = check.workdir ? path.join(repoRoot, check.workdir) : repoRoot;
    const result = await execute(check.command, cwd, timeoutMs);
    const durationMs = Date.now() - startedAt;

    // The user does not edit their approvals while their tests are running, so
    // a file that has moved since this run started moved because something the
    // run executed moved it. Withdraw the lot: an approval nobody gave is worse
    // than no approval, and being asked again is the whole cost of being wrong
    // here. Two runs approving different sets of the same repository at the
    // same moment would also trip this, and would also be answered by asking.
    if (trustFingerprint(identity) !== trustAtStart) {
      trustTampered = true;
      revokeAll(identity);
    }

    const status: CheckStatus = result.exitCode === 0 ? "OK" : "FAIL";
    if (status === "OK" && key !== null) {
      record(store, key, check, result.exitCode, durationMs);
      recordedThisRun.push(key);
    }

    const outcome: CheckOutcome = {
      check,
      status,
      exitCode: result.exitCode,
      output:
        status === "OK"
          ? ""
          : result.timedOut
            ? `${tail(result.output)}\n[timed out after ${Math.round(timeoutMs / 1000)}s]`
            : tail(result.output),
      durationMs,
      recalled: false,
      // The empty key already means "nothing was banked for this", which is
      // what an unkeyable run leaves behind.
      key: key ?? "",
    };
    outcomes.push(outcome);
    opts.onCheckEnd?.(outcome);
  }

  // One last look at the approval file, after the last check has finished.
  //
  // WHAT IT ADDS, precisely, because the per-check sample already fires after
  // the last check that RAN: the sample above sits on the execution path, and
  // a recalled verdict does not take it. A run whose checks are all recalled
  // therefore used to take exactly one sample, at the start, and a survivor of
  // an EARLIER run writing during this one went unseen for the whole of it.
  // This line is that run's second sample.
  //
  // WHAT THIS SAMPLE DOES NOT SEE, and it is the interesting half: a check can
  // leave something running that writes the file later still. `execute` sweeps
  // the process group on the way out, but `setsid` leaves the group, and a
  // write that arrives after this line is after every line. That case is
  // answered where it can be, at the next read: the approval file carries a
  // seal, and a write that did not go through `approve` no longer matches it
  // unless whatever made it rewrote the seal to match, which it can (trust.ts
  // says why nothing here can stop that). So this closes the tail of the run,
  // and the seal narrows the interval after it rather than closing it.
  if (approved && !trustTampered && trustFingerprint(identity) !== trustAtStart) {
    trustTampered = true;
    revokeAll(identity);
  }

  // Written unconditionally from the copy read before anything ran, whenever
  // the repository was approved at all. Gating this on "at least one check
  // passed", which is what it used to do, left the file exactly as a failing
  // check had left it: a check that forged a pass for itself into the store and
  // then exited non-zero wrote a verdict nobody earned, and nothing overwrote
  // it, so the next run recalled it and executed nothing.
  //
  // This covers a write made WHILE the run was in progress, which is the case
  // that was proven. It does not cover one made after this line; that is what
  // the store's own seal is for, and like the approval seal it is a digest in a
  // file the same user can rewrite.
  //
  // NOTHING THIS RUN EARNED IS KEPT WHEN THE RUN WAS TAMPERED WITH. An approval
  // nobody gave appeared while these checks were executing, and there is no way
  // to tell from here which of them ran before it and which after, so every
  // verdict filed during the run goes back. The pre-run copy is still written,
  // deliberately: it is what overwrites anything a check filed for itself
  // mid-run, and dropping the write to be safe would leave that forgery in
  // place. The store is put back to what it held before the run, no more.
  if (trustTampered) {
    for (const key of recordedThisRun) delete store.verdicts[key];
  }
  if (approved) writeStore(identity, store);

  return {
    repoRoot,
    mode,
    outcomes,
    blockedOnTrust: (!approved || trustTampered) && checks.length > 0,
    trustTampered,
    recalledMs,
  };
}
