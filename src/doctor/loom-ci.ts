/**
 * loom-ci.ts -- `alter doctor loom --ci`, a generic local check runner that
 * posts ONE GitHub commit status when it's done.
 *
 * The point: a required status check can go green off a run that happened
 * on the contributor's own machine, instead of spending hosted Actions
 * minutes on it. This module does three things and nothing else:
 *
 *   1. Read a repo-local declared check list (.alter/loom.json by default,
 *      see loom-ci-config.ts). No stack detection, no guessing - a
 *      repository that wants this says so itself, in its own file.
 *   2. Run each declared check as an ordinary local subprocess, once the
 *      user has approved that exact set of commands for that repository.
 *   3. Post one commit status (`gh api … statuses`) for the result, using
 *      the caller's own `gh` login. Never a check-run (that needs a GitHub
 *      App); a status needs only `repo:status` on an ordinary PAT.
 *
 * THE COMMANDS COME OUT OF THE REPOSITORY AND RUN AS THE USER. That is safe
 * in a repository they wrote and unsafe in one they have merely cloned, and
 * nothing about the command line distinguishes the two, so this runner holds
 * a declared check set to exactly the standard lib/repocheck already holds a
 * detected one to: default-deny until the user approves that set for that
 * repository (`--approve`), a re-ask whenever the set changes, a scrubbed
 * environment that withholds this CLI's own variables and anything named
 * like a credential, and a timeout that takes the whole process group rather
 * than the shell at the top of it.
 *
 * Everything about the target repository - owner/name, current SHA - is
 * resolved at runtime from the directory being checked. Nothing here names
 * a specific org or repo. There is no network call other than the user's
 * own `gh` talking to GitHub; no result, verdict, or telemetry reaches any
 * ALTER endpoint.
 *
 * Degrade path: if `gh` is missing, unauthenticated, or the directory has
 * no GitHub remote, the checks still run and the verdict still prints -
 * this module says plainly that no status was posted and why. It never
 * fails silently and never reports a status it did not actually send.
 */

import { spawnSync } from "node:child_process";
import {
  UNPRINTABLE_RANGES,
  DEFAULT_FIELD_CAP,
  visible,
  truncateField,
  safeField,
  charWidth,
  displayWidth,
  jsonVisible,
  wrappedRows,
} from "../lib/unprintable.js";
import * as fs from "node:fs";
import * as path from "node:path";

import { repoIdentity } from "../lib/repocheck/identity.js";
import { execute } from "../lib/repocheck/run.js";
import {
  approve,
  declarationDigest,
  isApproved,
  trustRootUnsafeReason,
} from "../lib/repocheck/trust.js";
import { which } from "../lib/which.js";
import {
  CONFIG_RELATIVE_PATH,
  DEFAULT_CHECK_TIMEOUT_MS,
  DEFAULT_CONTEXT,
  loadLoomCiConfig,
  noConfigHelp,
  type LoomCiCheck,
} from "./loom-ci-config.js";

const CI_USAGE =
  "Usage: alter doctor loom --ci [path] [--config <file>] [--json]\n" +
  "       alter doctor loom --ci [path] --approve\n\n" +
  "Run this repository's declared checks locally and post one GitHub\n" +
  "commit status for the result.\n\n" +
  "  path           directory to check (default: current directory)\n" +
  "  --config FILE  use FILE instead of <path>/.alter/loom.json\n" +
  "  --json         emit a machine-readable report instead of the summary\n" +
  "  --approve      print this repository's declared commands and approve\n" +
  "                 them, so a later run may execute them\n\n" +
  "The check list is declared by the repository itself in\n" +
  ".alter/loom.json - there is no auto-detected default. Run with no\n" +
  "config present to see the file's expected shape.\n\n" +
  "THESE COMMANDS COME FROM THE REPOSITORY AND RUN AS YOU. Nothing runs\n" +
  "until you have approved that exact set of commands for that folder,\n" +
  "and you are asked again the moment any of them changes. Approve a\n" +
  "repository you would run by hand; approval cannot cover the code those\n" +
  "commands then reach.\n";

/** Exit code for a run refused because the repository is not approved. */
const EXIT_NOT_APPROVED = 3;

// ---------------------------------------------------------------------------
// Safe-to-print repository-supplied text
//
// Every string below - a check's id, its command line, its cwd, its output,
// the description built from failed ids - comes out of the repository being
// checked, printed to a real terminal for a human to read before they decide
// whether to approve or trust what ran. A POSIX filename or a JSON string may
// legally contain an ESC byte, and a real terminal executes one the instant
// it is written raw: it can move the cursor, clear the line the warning
// paragraph is on, or overwrite a FAIL with a PASS. Escaping alone is not
// enough either - 2,400 harmless `A` characters fill a normal screen and
// scroll the same warning out of view with no control byte in sight. Both
// treatments are applied everywhere this module writes repository-supplied
// text: bound the length first, then make whatever remains safe to print.
//
// Bounding each FIELD is not the same as bounding the SCREEN, and four gates in
// a row proved it at four different scales. Per-field caps multiplied by an
// unbounded check count are unbounded. A cap on LINES ignores that one line
// wraps to many rows. A row count taken from string length ignores that a CJK
// character is two columns. And a budget computed from `head + tail` ignores
// every line composed between them.
//
// The warning paragraph prints BEFORE the list and the approve instruction
// AFTER it, so every one of those overflows erased the disclosure and preserved
// the call to action. That asymmetry is why this is a security bound and not a
// formatting preference.
//
// So nothing here budgets a part. `composePrompt` builds the entire message,
// measures THAT in rows at the assumed width, and shrinks the list until the
// whole thing fits. A caller cannot forget to count a component, because no
// component is counted.
//
// The table, the escaping and the field caps live in lib/unprintable.ts, shared
// with loom-ci-config.ts. They were two tables until a gate found the narrower
// copy missing every ASCII control character.
// ---------------------------------------------------------------------------

/**
 * The width the prompt is measured against. Not the terminal's real width: the
 * smallest one an operator plausibly has, because a bound computed against a
 * wide terminal is no bound at all on a narrow one, and the narrow one is
 * where the warning paragraph is lost.
 */
const ASSUMED_COLUMNS = 80;

/**
 * The screen the whole prompt is measured against, in rows. Twenty-four is the
 * classic terminal height and the smallest an operator plausibly has.
 */
const ASSUMED_ROWS = 24;

/**
 * Rows a rendered line occupies at the assumed width.
 *
 * Measured in COLUMNS, not in code units, and WALKED rather than divided. Both
 * halves of that were a defeat in turn. `line.length` counts UTF-16 units, so a
 * line of CJK ideographs -- two columns each, one unit each -- reported half the
 * rows it takes. Fixing that left `ceil(width / 80)`, which is not a row count
 * either: a terminal will not split a two-column glyph across the right margin,
 * so a line can occupy one row more than the division predicts, and every line
 * can be made to do so at once. Nine checks aligned that way modelled 24 rows
 * and drew 30.
 *
 * `wrappedRows` walks the columns the way a terminal does. It is the only
 * measure used here; the budget below is computed from nothing else.
 */
function renderedRows(line: string): number {
  return wrappedRows(line, ASSUMED_COLUMNS);
}

/**
 * The one line that explains a doubled backslash, printed only when the block
 * actually contains one.
 *
 * `visible()` escapes the backslash first, which is what stops a repository
 * spelling out `\x1b` and forging the signal that says "this text contained
 * something that would have moved my cursor". The cost is that an ordinary
 * Windows path or regex in a declared command renders doubled, and the
 * operator is being asked to read this prompt and decide. So the cost is
 * stated where it lands, rather than left for them to trip over.
 */
function backslashLegend(block: string): string {
  return block.includes("\\\\") ? "  (`\\\\` above is one literal backslash)\n" : "";
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface ParsedCiArgs {
  path?: string;
  config?: string;
  json: boolean;
  help: boolean;
  approve: boolean;
}

function parseCiArgs(args: string[]): ParsedCiArgs | { error: string } {
  let target: string | undefined;
  let config: string | undefined;
  let json = false;
  let help = false;
  let approveSet = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") {
      help = true;
      continue;
    }
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a === "--approve") {
      approveSet = true;
      continue;
    }
    if (a === "--config") {
      const value = args[i + 1];
      if (value === undefined) {
        return { error: "alter doctor loom --ci: --config requires a value" };
      }
      config = value;
      i++;
      continue;
    }
    // ARGV IS REPOSITORY-INFLUENCED, and the fix that missed this scoped its
    // sweep to "values the repository supplied" and filed argv under the
    // operator's own typing. A repository names the directories it ships, git
    // imposes no restriction on an ESC byte in a path component, and a shell
    // glob or a tab-completion drops that name straight into argv. A directory
    // called `--web` + a clear-screen + a forged "SAFE: no checks declared"
    // line reached a real terminal through the branch below, at exit 2, with
    // the cursor left hidden afterwards. So it is escaped and capped like every
    // other string this module prints, not trusted for having come off a
    // command line.
    if (a.startsWith("--")) {
      return { error: `alter doctor loom --ci: unknown flag: ${safeField(a, 200)}` };
    }
    if (target !== undefined) {
      return {
        error: `alter doctor loom --ci: unexpected extra argument: ${safeField(a, 200)}`,
      };
    }
    target = a;
  }

  return { path: target, config, json, help, approve: approveSet };
}

// ---------------------------------------------------------------------------
// Running declared checks
// ---------------------------------------------------------------------------

interface CheckResult {
  id: string;
  command: string;
  cwd: string;
  status: "success" | "failure";
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
}

/**
 * The declared check set, rendered as the fields the approval digest is taken
 * over: what it is called, what it runs, where, and under what bound.
 *
 * `payload` is where a detected check carries the manifest behind its command
 * line. A declared check has no manifest behind it - the file IS the
 * declaration - so what goes in is the rest of what the repository said,
 * which keeps a timeout change inside the digest rather than outside it, and
 * now the effective `context` too: it used to sit outside the digest
 * entirely, so a repository approved once for a command set could afterwards
 * change only which GitHub commit status it posted under, unnoticed, without
 * being asked again.
 */
function trustDeclaration(
  checks: LoomCiCheck[],
  effectiveContext: string,
): { id: string; command: string; workdir: string; payload: string }[] {
  return checks.map((c) => ({
    id: c.id,
    command: c.command,
    workdir: c.cwd ?? "",
    payload: JSON.stringify({ timeoutMs: c.timeoutMs ?? null, context: effectiveContext }),
  }));
}

/** One declared check, rendered as the operator is asked to read it. */
function describeCheck(c: LoomCiCheck, repoRoot: string): string {
  const id = safeField(c.id, 80);
  const command = safeField(c.command, 300);
  if (!c.cwd) return `  ${id}: ${command}`;
  // Show the RESOLVED directory, not the declared string: a declared
  // `cwd` of `sub` that is a symlink to somewhere else reads as `sub`
  // here and runs somewhere else entirely, which is the deception
  // resolveCheckCwd exists to close. When it cannot be resolved at all
  // (missing, or a symlink escaping the repository), say so plainly
  // rather than showing the operator a path that will never be used.
  const resolved = resolveCheckCwd(c, repoRoot);
  const where =
    resolved === null
      ? `${safeField(c.cwd, 200)} -- cannot be resolved inside the repository; this check would be refused`
      : safeField(resolved, 200);
  return `  ${id}: ${command}   (in ${where})`;
}

/**
 * The declared commands, one per line, as the user is asked to read them.
 *
 * Bounded in the unit the harm is measured in: SCREEN ROWS. Each field is
 * capped in rendered characters, AND the block is capped in the rows those
 * lines occupy at the assumed width, with the remainder stated. Bounding the
 * COUNT instead is what let a repository hide a hostile command behind a
 * handful of plausible ones and scroll the warning paragraph away -- six
 * checks, all inside every field cap, no control character anywhere.
 */
function describeChecks(checks: LoomCiCheck[], repoRoot: string, shown: number): string {
  const rendered = checks.slice(0, Math.max(1, shown)).map((c) => describeCheck(c, repoRoot));
  const hidden = checks.length - rendered.length;
  const lines = rendered.join("\n");
  if (hidden <= 0) return lines;
  // Naming the file is the part that matters. "+N more not shown" alone tells
  // the operator they are approving something they cannot see and then invites
  // them to approve it anyway, which sanctions the very blindness the cap is
  // meant to remove. Approval covers all N checks by digest, so the remainder
  // has to be readable somewhere, and the config file is where it is.
  //
  // The config path is repository-influenced too -- a directory NAME can carry
  // an escape sequence, survive clone, and erase this prompt from a terminal
  // exactly as a command field would -- so it is escaped like every other
  // field rather than trusted for being ours.
  return (
    `${lines}\n` +
    `  ...[+${hidden} more check${hidden === 1 ? "" : "s"} not shown; ${checks.length} declared in total]\n` +
    `  Approving covers all ${checks.length}. Read them first: ` +
    `${safeField(path.join(repoRoot, CONFIG_RELATIVE_PATH), 200)}`
  );
}

/** Rows the whole message occupies at the assumed width. */
function messageRows(message: string): number {
  return message.split("\n").reduce((n, line) => n + renderedRows(line), 0);
}

/**
 * The complete prompt, shrunk until the WHOLE of it fits one screen -- and,
 * since the screen arithmetic has now been wrong six times, built so that
 * getting the arithmetic wrong no longer costs the operator the disclosure.
 *
 * THE STRUCTURAL PROPERTY, and it is the one that matters.
 *
 * `tail` carries BOTH halves of the decision: the sentence that says these
 * commands came from the repository and will run as you, AND the instruction
 * that approves them. They are adjacent, in that order, at the END of the
 * message. A terminal that overflows scrolls off the TOP, so the last thing
 * written is the last thing lost. The disclosure and the call to action now
 * leave the screen together or not at all.
 *
 * That is a change of kind, not of degree. Every one of the six defeats was the
 * same shape: the warning printed BEFORE the list and the approve instruction
 * AFTER it, so any overflow -- from any miscounted unit -- erased the
 * disclosure and preserved the call to action. The asymmetry was structural, and
 * five fixes in a row treated it as an arithmetic problem. The sixth gate
 * measured the point directly: the same payload overflowed the `--approve`
 * confirmation path by eight rows too, and `These run as you` survived there for
 * one reason only, which is that it sat in that path's tail.
 *
 * So the row budget below is no longer the thing holding this together. It stays
 * because it is still correct and still worth having: it keeps the list
 * readable, and it is the difference between a prompt an operator reads and a
 * prompt an operator scrolls. It is defence in depth now, not the depth.
 *
 * THE ROW BUDGET, unchanged in method. Nothing is budgeted by part. Each earlier
 * version budgeted a SUBSET and was defeated by whatever it left out: a cap on
 * characters per field ignored the number of fields; a cap on lines ignored how
 * many rows a line wraps to; a budget from `head + tail` ignored the trailer
 * lines `describeChecks` appends. So the whole message is composed, measured
 * with the no-straddle column walk, and the check list shrunk by one until the
 * total fits, or until only one check is left. A caller cannot forget to count a
 * part, because no part is counted: the finished string is.
 *
 * `tail` is never shrunk and never truncated -- it is the guarantee, so it is
 * the last thing that could be sacrificed to make room. Its own fields are
 * bounded (`safeField`) and the assertion in tests/test_doctor_loom_ci.ts holds
 * it inside one screen across a matrix of hostile repository paths.
 */
function composePrompt(
  head: string,
  checks: LoomCiCheck[],
  repoRoot: string,
  tail: string,
): string {
  for (let shown = checks.length; shown >= 1; shown--) {
    const block = describeChecks(checks, repoRoot, shown);
    const message = `${head}${block}\n${backslashLegend(block)}${tail}`;
    if (messageRows(message) <= ASSUMED_ROWS || shown === 1) return message;
  }
  // No checks at all: still emit the surround, so the operator is told why.
  return `${head}${tail}`;
}

/**
 * The directory a check runs in, or null when the declaration points outside
 * the repository that made it, or cannot be verified to exist.
 *
 * The config validator already refuses an absolute or `..`-climbing `cwd`
 * LEXICALLY, which `path.resolve` alone can also produce: it never touches
 * the filesystem, so a declared `cwd` naming an ordinary-looking
 * subdirectory that is actually a symlink pointing outside the repository
 * passes the lexical test and runs there. `fs.realpathSync`, on both the
 * repository root and the resolved target, is the only form that resolves
 * every symlink component before the containment check runs - and it is what
 * is now shown to the operator, not the declared string, so the prompt and
 * the `--json` report say where the check actually ran.
 *
 * A `cwd` that does not exist yet cannot be realpath'd; that fails closed
 * (refused) rather than falling back to the unresolved lexical path.
 */
function resolveCheckCwd(check: LoomCiCheck, repoRoot: string): string | null {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(repoRoot);
  } catch {
    return null;
  }
  if (!check.cwd) return realRoot;
  const lexical = path.resolve(repoRoot, check.cwd);
  let resolved: string;
  try {
    resolved = fs.realpathSync(lexical);
  } catch {
    return null;
  }
  const rel = path.relative(realRoot, resolved);
  if (rel === "") return resolved;
  if (path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`)) {
    return null;
  }
  return resolved;
}

async function runCheck(
  check: LoomCiCheck,
  repoRoot: string,
): Promise<CheckResult> {
  const timeoutMs = check.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const cwd = resolveCheckCwd(check, repoRoot);
  if (cwd === null) {
    const lexical = path.resolve(repoRoot, check.cwd ?? "");
    // Best-effort, for the message only: report where a symlink actually
    // points when that is knowable, rather than just the declared path -
    // the same "show the resolved path, not the declared one" the approval
    // prompt applies. A `cwd` that does not exist at all has nothing to
    // resolve, and that is said plainly instead.
    let real: string | null;
    try {
      real = fs.realpathSync(lexical);
    } catch {
      real = null;
    }
    return {
      id: check.id,
      command: check.command,
      cwd: lexical,
      status: "failure",
      exitCode: null,
      timedOut: false,
      durationMs: 0,
      output:
        real === null
          ? `refused: \`cwd\` does not exist: ${lexical}`
          : `refused: \`cwd\` resolves to ${real}, outside ${repoRoot}`,
    };
  }

  const start = Date.now();
  // Run through the same executor lib/repocheck uses for a detected check:
  // a shell (so "npm run lint" means what the repository's README says it
  // means), with this CLI's own and credential-named variables withheld, in
  // its own process group so a timeout takes everything the check started
  // rather than reporting a kill it did not perform.
  const result = await execute(check.command, cwd, timeoutMs);
  const durationMs = Date.now() - start;
  const status: "success" | "failure" =
    !result.timedOut && result.exitCode === 0 ? "success" : "failure";

  return {
    id: check.id,
    command: check.command,
    cwd,
    status,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs,
    output: result.output,
  };
}

function buildDescription(results: CheckResult[]): string {
  const total = results.length;
  const failed = results.filter((r) => r.status === "failure");
  // Ids are repository-supplied and this string is printed to the terminal
  // (as well as posted to GitHub), so it goes through the same treatment as
  // every other repository-supplied field before the 140-character GitHub
  // cap is applied.
  let description =
    failed.length === 0
      ? `${total}/${total} checks passed`
      : `${failed.length}/${total} checks failed: ${failed.map((f) => safeField(f.id, 60)).join(", ")}`;
  // TWO ceilings, because this string is read on two surfaces with different
  // units. GitHub's commit-status `description` field is capped at 140
  // CHARACTERS; the terminal it is also printed to counts COLUMNS, and a CJK
  // check id costs two of those per code unit. Bounding by `.length` alone let
  // a 140-unit description occupy 280 columns -- three and a half rows of an
  // eighty-column screen from a field the call site reads as one line. Whichever
  // ceiling binds first stops the copy, the same discipline `truncateField`
  // already applies to every other repository-supplied field.
  if (displayWidth(description) > 140 || description.length > 140) {
    let out = "";
    let width = 0;
    let units = 0;
    for (const ch of description) {
      const w = charWidth(ch.codePointAt(0) ?? 0);
      if (width + w > 137 || units + ch.length > 137) break;
      out += ch;
      width += w;
      units += ch.length;
    }
    description = `${out}...`;
  }
  return description;
}

// ---------------------------------------------------------------------------
// Commit status posting
// ---------------------------------------------------------------------------

interface PostResult {
  posted: boolean;
  reason?: string;
  repo?: string;
  sha?: string;
}

const GH_PROBE_TIMEOUT_MS =
  Number(process.env.ALTER_LOOM_CI_GH_TIMEOUT_MS) || 10_000;

function firstLine(s: string | undefined): string {
  return (s ?? "").trim().split("\n")[0] || "no detail";
}

/**
 * Resolve the target's owner/repo and current commit, then post one commit
 * status. Every piece of this is derived at runtime - never a hardcoded org
 * or repo literal.
 */
function attemptPostStatus(opts: {
  repoRoot: string;
  context: string;
  state: "success" | "failure";
  description: string;
}): PostResult {
  if (!which("gh")) {
    return {
      posted: false,
      reason: "`gh` is not installed or not on PATH",
    };
  }

  const shaResult = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: opts.repoRoot,
    encoding: "utf8",
    timeout: GH_PROBE_TIMEOUT_MS,
  });
  if (shaResult.error || shaResult.status !== 0) {
    return {
      posted: false,
      reason:
        `could not resolve the current commit under ${opts.repoRoot} ` +
        "(not a git repository, or it has no commits yet)",
    };
  }
  const sha = shaResult.stdout.trim();

  const repoResult = spawnSync(
    "gh",
    ["repo", "view", "--json", "nameWithOwner"],
    { cwd: opts.repoRoot, encoding: "utf8", timeout: GH_PROBE_TIMEOUT_MS },
  );
  if (repoResult.error || repoResult.status !== 0) {
    return {
      posted: false,
      reason:
        "`gh repo view` failed - gh may not be logged in, or this directory " +
        `has no GitHub remote (${firstLine(repoResult.stderr ?? repoResult.error?.message)})`,
    };
  }

  let nameWithOwner: string;
  try {
    const parsedRepo = JSON.parse(repoResult.stdout) as { nameWithOwner?: string };
    if (!parsedRepo.nameWithOwner) throw new Error("response had no nameWithOwner");
    nameWithOwner = parsedRepo.nameWithOwner;
  } catch (err) {
    return {
      posted: false,
      reason: `could not parse \`gh repo view\` output: ${(err as Error).message}`,
    };
  }

  const postResult = spawnSync(
    "gh",
    [
      "api",
      "-X",
      "POST",
      `repos/${nameWithOwner}/statuses/${sha}`,
      "-f",
      `state=${opts.state}`,
      "-f",
      `context=${opts.context}`,
      "-f",
      `description=${opts.description}`,
    ],
    { cwd: opts.repoRoot, encoding: "utf8", timeout: GH_PROBE_TIMEOUT_MS },
  );
  if (postResult.error || postResult.status !== 0) {
    return {
      posted: false,
      repo: nameWithOwner,
      sha,
      reason: `gh api statuses POST failed (${firstLine(postResult.stderr ?? postResult.error?.message)})`,
    };
  }

  return { posted: true, repo: nameWithOwner, sha };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runLoomCi(args: string[]): Promise<void> {
  const parsed = parseCiArgs(args);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n\n${CI_USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (parsed.help) {
    process.stdout.write(CI_USAGE);
    return;
  }

  const repoRoot = path.resolve(parsed.path ?? process.cwd());
  let stat: fs.Stats;
  try {
    stat = fs.statSync(repoRoot);
  } catch {
    process.stderr.write(`alter doctor loom --ci: not found: ${safeField(repoRoot, 200)}\n`);
    process.exitCode = 2;
    return;
  }
  if (!stat.isDirectory()) {
    process.stderr.write(`alter doctor loom --ci: not a directory: ${safeField(repoRoot, 200)}\n`);
    process.exitCode = 2;
    return;
  }

  const loaded = loadLoomCiConfig(repoRoot, parsed.config);
  if (loaded.kind === "error") {
    process.stderr.write(`alter doctor loom --ci: ${safeField(loaded.message, 400)}\n`);
    process.exitCode = 2;
    return;
  }
  if (loaded.kind === "absent") {
    process.stdout.write(noConfigHelp(repoRoot));
    process.exitCode = 0;
    return;
  }

  const { config } = loaded;
  if (config.checks.length === 0) {
    process.stdout.write(
      `alter doctor loom --ci: ${safeField(loaded.path, 200)} declares zero checks. Nothing to run, nothing posted.\n`,
    );
    process.exitCode = 0;
    return;
  }

  // ---------------------------------------------------------------------
  // Approval, settled before anything from the repository is executed.
  // ---------------------------------------------------------------------
  // Computed here, once, and reused for both the digest and the eventual
  // post: the SAME effective value in both places, so a repository cannot
  // change what it posts under without also changing what was approved.
  const context = config.context?.trim() || DEFAULT_CONTEXT;
  const identity = repoIdentity(repoRoot);
  const digest = declarationDigest(trustDeclaration(config.checks, context), "declared");

  if (parsed.approve) {
    const stored = approve(identity, repoRoot, digest);
    if (!stored) {
      process.stderr.write(
        trustRootUnsafeReason(repoRoot) ??
          "alter doctor loom --ci: could not record the approval (the data " +
            "directory is not writable). Nothing was approved and nothing ran.\n",
      );
      process.exitCode = 2;
      return;
    }
    // Same tail discipline as the unapproved prompt, and this path is where the
    // property was measured: the sixth gate overflowed this confirmation by
    // eight rows with the identical payload, and the disclosure survived for
    // one reason only, which is that it was already in the tail here.
    process.stdout.write(
      composePrompt(
        `approved for ${safeField(repoRoot, 200)}, from ${safeField(loaded.path, 200)}:\n`,
        config.checks,
        repoRoot,
        "These commands come from the repository and would run as you, with " +
          "your files and your logins in reach.\n" +
          "They run as you on the next `alter doctor loom --ci` here. You " +
          "will be asked again if any of them changes.\n",
      ),
    );
    process.exitCode = 0;
    return;
  }

  if (!isApproved(identity, repoRoot, digest)) {
    if (parsed.json) {
      // `JSON.stringify` escapes below U+0020 and stops. A bidi override in a
      // path survives it raw, and `--json` output lands on a terminal at least
      // as often as it lands in a parser. `jsonVisible` writes those codepoints
      // as JSON's own `\uXXXX`, so the document still parses to the identical
      // string and nothing reorders a screen on the way past.
      process.stdout.write(
        `${jsonVisible(JSON.stringify(
          {
            repoRoot,
            configPath: loaded.path,
            approved: false,
            ran: false,
            checks: [],
            overall: "not-approved",
            description: "not approved: no commands were run",
            status: {
              posted: false,
              reason: "the declared commands are not approved for this folder",
            },
          },
          null,
          2,
        ))}\n`,
      );
      process.exitCode = EXIT_NOT_APPROVED;
      return;
    }
    // Every repository-influenced string in this block is escaped, including
    // the two paths. A repository controls the names of the directories it
    // ships, git imposes no restriction on an ESC byte in a path component,
    // and a name that erases this warning does it from a path exactly as well
    // as from a command. A backslash reads doubled as a result: the legend
    // below says so, because the prompt exists to be read accurately.
    //
    // The surround is composed FIRST and measured, so the check block is given
    // the rows actually left on a 24-row screen rather than a constant that
    // knows nothing about how far this repository's path wraps.
    //
    // The run-as-you disclosure is in the TAIL, immediately above the approve
    // instruction, and that placement is the security property rather than a
    // matter of reading order. It used to sit in the head, above the list; six
    // gates in a row overflowed the list and erased it while leaving the
    // hostile command and the approve instruction on screen. A terminal drops
    // the top, so the disclosure now goes last and cannot be separated from the
    // action it qualifies.
    process.stderr.write(
      composePrompt(
        `alter doctor loom --ci: ${safeField(loaded.path, 200)} declares commands that have ` +
          "not been approved for this folder, so nothing was run and no " +
          "commit status was posted. Read them:\n",
        config.checks,
        repoRoot,
        "These commands come from the repository and would run as you, with " +
          "your files and your logins in reach. Nothing has run yet.\n" +
          "If you would run them by hand, approve them:\n" +
          `  alter doctor loom --ci ${safeField(repoRoot, 200)} --approve\n`,
      ),
    );
    process.exitCode = EXIT_NOT_APPROVED;
    return;
  }

  const results: CheckResult[] = [];
  for (const check of config.checks) {
    results.push(await runCheck(check, repoRoot));
  }
  const overall: "success" | "failure" = results.every((r) => r.status === "success")
    ? "success"
    : "failure";
  const description = buildDescription(results);

  const posting = attemptPostStatus({ repoRoot, context, state: overall, description });

  if (parsed.json) {
    // Same treatment as the not-approved report above: bidi overrides and
    // zero-width characters written as JSON's own escapes, never raw.
    process.stdout.write(
      `${jsonVisible(JSON.stringify(
        {
          repoRoot,
          configPath: loaded.path,
          context,
          checks: results.map(({ id, command, cwd, status, exitCode, timedOut, durationMs }) => ({
            id,
            command,
            cwd,
            status,
            exitCode,
            timedOut,
            durationMs,
          })),
          overall,
          description,
          status: posting,
        },
        null,
        2,
      ))}\n`,
    );
  } else {
    for (const r of results) {
      const label =
        r.status === "success"
          ? "PASS"
          : r.timedOut
            ? "FAIL (timed out)"
            : `FAIL (exit ${r.exitCode ?? "?"})`;
      process.stdout.write(`  ${label}  ${safeField(r.id, 80)}  (${r.durationMs}ms)\n`);
      if (r.status === "failure") {
        // Repository-supplied subprocess output: the id above was the
        // "second instance, same class" the pentest re-gate found - a
        // control character in a check's declared id overwrote this exact
        // PASS/FAIL summary line. Each line of the tail gets the same
        // treatment, not the block as a whole, so one 2,400-character line
        // cannot fill the screen and scroll the rest out of view either.
        const tail = r.output
          .trim()
          .split("\n")
          .slice(-20)
          .map((line) => safeField(line, 300))
          .join("\n");
        if (tail) process.stdout.write(`${tail}\n`);
      }
    }
    process.stdout.write(
      `\n${overall === "success" ? "PASS" : "FAIL"}: ${safeField(description, 300)}\n`,
    );
    if (posting.posted) {
      process.stdout.write(
        `commit status posted: ${safeField(posting.repo ?? "", 200)}@${safeField(posting.sha ?? "", 60)} -> "${safeField(context, 100)}" = ${overall}\n`,
      );
    } else {
      process.stdout.write(`no commit status posted (${safeField(posting.reason ?? "", 400)})\n`);
    }
  }

  process.exitCode = overall === "success" ? 0 : 1;
}
