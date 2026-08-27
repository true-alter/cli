/**
 * repocheck/types.ts -- the shared contract for the repository check runner.
 *
 * The runner is foreground and per-run: it starts when the user acts, does its
 * work on the tree the user is standing in, and exits. It is never a daemon and
 * never a background process.
 *
 * Australian English in comments; US English in identifiers.
 */

/** Verdict for one check. Mirrors the CLI's shared status vocabulary. */
export type CheckStatus = "OK" | "FAIL" | "WARN";

/**
 * The ecosystems detection has an arm for.
 *
 * CLOSED ON PURPOSE, and it is a guard rather than a tidiness. What a check
 * DECLARES about the program it runs is digested per ecosystem, from a list of
 * sidecar files kept in detect.ts, and an arm added without such a list folds
 * nothing, so its payload is a constant and a repository can swap what executes
 * behind an unchanged command line. That defect is invisible to a test, which
 * can only walk the arms that exist. Naming the set here makes
 * `DECLARATION_FILES` a `Record` over it, so the missing arm is a compile error
 * at the declaration instead.
 */
export type Ecosystem = "node" | "python" | "rust" | "go";

/**
 * The python tools the python arm offers a check for.
 *
 * CLOSED for the reason `Ecosystem` is closed, one level down, and it was still
 * open after that level was shut. The python arm builds a payload PER TOOL, not
 * per ecosystem, so the unit that can quietly fold nothing is the tool. A tool
 * added without a configuration-file list would put its own configuration
 * outside the approval digest while both existing guards stayed green, because
 * the ecosystem's list is the union of the others and is never empty.
 */
export type PythonTool = "ruff" | "mypy" | "pytest";

/**
 * Which snapshot of the tree a check is judged against.
 *
 *   "index"    -- what is staged. The correct basis at commit time, because
 *                 that is exactly the content about to be recorded.
 *   "worktree" -- what is on disk, staged or not. The correct basis for an
 *                 on-demand run, because that is what the user can see.
 */
export type TreeMode = "index" | "worktree";

/**
 * One check the runner can execute.
 *
 * `command` is a command line resolved from the repository the user is in.
 * It is repository-supplied data, never a value this package chose, which is
 * why executing it requires the user's per-repository approval (see trust.ts).
 */
export interface RepoCheck {
  /** Stable dotted id, e.g. "node.test" or "rust.clippy". */
  id: string;
  /** One-line human label. */
  label: string;
  /** Ecosystem this was detected from. Closed set: see `Ecosystem`. */
  ecosystem: Ecosystem;
  /** The command line to run, executed through the user's shell. */
  command: string;
  /**
   * Directory the command runs in, relative to the repository root. Empty for
   * the root itself. A repository holding several projects gets one set of
   * checks per project, each run where its own manifest lives.
   */
  workdir: string;
  /**
   * Paths whose content this check's verdict depends on, relative to the
   * repository root. An empty list means the whole tracked tree, which is the
   * safe default: too wide only costs a re-run, too narrow returns a stale
   * pass on changed code.
   */
  basis: string[];
  /**
   * Everything the repository declares about what this command executes, folded
   * into one rendering. Two halves, and every ecosystem has both: what a
   * manifest says, parsed, and a digest of the bytes of every sidecar file that
   * decides which program runs or what it loads. For node that is the whole
   * `scripts` map plus `config` and `packageManager`, because one `npm run test`
   * reaches its pre- and post-scripts and anything those name, alongside
   * `.npmrc` and its siblings, which name the shell those bodies run in; for
   * python the tool's `[tool.<name>]` block alongside every other file that tool
   * reads its configuration from; for rust and go the files that name a wrapper,
   * a runner, an alias or a toolchain. The version-manager files are folded into
   * all four. The lists live in detect.ts and are exported as
   * `DECLARATION_FILES` so the property can be checked rather than recited.
   *
   * This is in the approval digest (see trust.ts), so a repository that swaps
   * what runs behind an unchanged command line has to be approved again. It is
   * a declaration, not a closure: code the command reaches at runtime, a
   * conftest.py, a build.rs, a dependency, is not in it and cannot be.
   */
  payload: string;
}

/** The outcome of running (or recalling) one check. */
export interface CheckOutcome {
  check: RepoCheck;
  status: CheckStatus;
  /** Process exit code, or null when the check never started. */
  exitCode: number | null;
  /** Combined stdout and stderr, trimmed to a readable tail on failure. */
  output: string;
  /** Wall-clock milliseconds this check took, 0 when the verdict was recalled. */
  durationMs: number;
  /** True when the verdict came from the store rather than a fresh run. */
  recalled: boolean;
  /**
   * The key this verdict is filed under. Empty when nothing was keyed, which is
   * the case for a check withheld pending approval: computing the key reads the
   * repository with git, and that happens only once approval is settled.
   */
  key: string;
}

/** A verdict as it is stored between runs. */
export interface StoredVerdict {
  key: string;
  checkId: string;
  status: CheckStatus;
  exitCode: number | null;
  /** ISO-8601 UTC timestamp of the run that produced this verdict. */
  recordedAt: string;
  /** Milliseconds the original run took, kept so recall can report the saving. */
  originalDurationMs: number;
}

/** What one full pass produced. */
export interface RunReport {
  repoRoot: string;
  mode: TreeMode;
  outcomes: CheckOutcome[];
  /** True when checks were detected but withheld pending the user's approval. */
  blockedOnTrust: boolean;
  /**
   * True when the approval file changed while a check was running. Nothing the
   * user did produces that, so the approvals for this repository are withdrawn
   * and the rest of the run is withheld.
   */
  trustTampered: boolean;
  /** Sum of originalDurationMs across recalled verdicts. */
  recalledMs: number;
}
