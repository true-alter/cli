/**
 * alter doctor loom - run the folder-native change/verdict validator (the
 * "loom") against a plain directory, no version control required.
 *
 *   alter doctor loom <path> [--json] [--no-write]
 *
 * The loom answers "what changed in this folder since last time" for any
 * directory - a notes vault, a client handoff, an export - and stores a set
 * of per-file verdicts (encoding, secret/card-shape scan, template residue,
 * internal link integrity, byte-identical duplicates, truncation) alongside
 * a machine-local baseline used to detect change and reuse work between
 * runs. Nothing it does reaches the network.
 *
 * Delivery mechanism: this thin wrapper shells out to a bundled, stdlib-only
 * Python 3 script (`dist/assets/loom/folder_loom.py`, copied from
 * `src/assets/loom/` at build time - the same pattern `alter hooks install`
 * and `alter skills install` use for their own bundled assets). The
 * validator's actual logic stays in one implementation rather than being
 * ported and kept in sync across two languages; this command's job is only
 * to find a Python 3 interpreter, hand it the target path and flags, and
 * relay its stdout/stderr/exit code unchanged.
 *
 * Flags:
 *   --json        machine-readable report (passed straight through)
 *   --no-write    do not update the local baseline (dry run)
 *
 * End-of-flags marker: if <path> itself begins with `-` (a common notes-vault
 * convention, e.g. `-Inbox`, `-Templates`), put `--` before it so this
 * wrapper's own flag parser (and the bundled validator's) stop treating it
 * as a flag: `alter doctor loom -- -Inbox`. Flags, if any, still come before
 * the `--`.
 *
 * A second, unrelated mode lives on this same verb:
 *
 *   alter doctor loom --ci [path] [--config <file>] [--json]
 *
 * runs a repository's own declared checks (see loom-ci.ts / loom-ci-config.ts)
 * and posts one GitHub commit status for the result - a generic local CI
 * runner, not the folder validator above. `--ci` is recognised before any of
 * the folder-validator flag parsing below and dispatches straight to it.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { runLoomCi } from "./loom-ci.js";

const USAGE =
  "Usage: alter doctor loom <path> [--json] [--no-write]\n" +
  "       alter doctor loom [--json] [--no-write] -- <path>\n" +
  "       alter doctor loom --ci [path] [--config <file>] [--json]\n\n" +
  "Point this at any folder of files - a teacher's student records, a\n" +
  "family's eldercare paperwork, a project folder you share with someone\n" +
  "else, anything - and it checks each file for the everyday things that\n" +
  "quietly damage a body of records, corrupted text, unfilled\n" +
  "placeholders left behind, links that point at nothing, something that\n" +
  "looks like a password or card number sitting in plain text, a file\n" +
  "that's suddenly lost most of its content, and duplicate copies wasting\n" +
  "space. It also tells you what's changed since the last time you ran\n" +
  "it.\n\n" +
  "  --json        emit the raw JSON report instead of the human summary\n" +
  "  --no-write    do not update the local baseline for this run\n\n" +
  "If <path> itself starts with `-` (e.g. `-Inbox`), mark the end of flags\n" +
  "with `--` so it isn't mistaken for one: alter doctor loom -- -Inbox\n\n" +
  "`--ci` is a separate mode: run this repository's own declared checks\n" +
  "and post one GitHub commit status for the result. Run\n" +
  "`alter doctor loom --ci --help` for its own usage.\n";

const KNOWN_FLAGS = new Set(["--json", "--no-write"]);

// Asset resolution - dist/doctor/loom.js -> ../assets/loom (mirrors the
// hooks/skills assetsDir() pattern: resolve relative to this module, not cwd).
function assetsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "assets", "loom");
}

// Bounded so a candidate that never returns (observed: a Windows "Python App
// Execution Alias" shim, which can hang `--version` indefinitely instead of
// erroring) cannot hang this command forever - a timed-out candidate is
// simply treated as unusable and probing moves on to the next one.
// Overridable for tests that need a short, deterministic bound.
const PYTHON_PROBE_TIMEOUT_MS =
  Number(process.env.ALTER_LOOM_PYTHON_PROBE_TIMEOUT_MS) || 5000;

function findPython(): string | null {
  for (const candidate of ["python3", "python"]) {
    const probe = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      timeout: PYTHON_PROBE_TIMEOUT_MS,
    });
    // `error` covers both "candidate not found" and a timed-out probe
    // (Node reports ETIMEDOUT via `error` and kills the process); either
    // way this candidate is not usable, try the next one.
    if (probe.error || probe.status !== 0) continue;
    // Python 2 prints "Python 2.x.y" to stderr; Python 3.4+ prints to
    // stdout. Read both so either interpreter's actual version is seen
    // instead of assuming anything that answered is good enough.
    const versionText = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
    const match = versionText.match(/Python\s+(\d+)\./);
    if (!match || Number(match[1]) < 3) continue;
    return candidate;
  }
  return null;
}

/**
 * Split the command's own args into (flags, target), honouring a `--`
 * end-of-flags marker: `alter doctor loom [--json] [--no-write] -- <path>`.
 * Without `--`, the target is args[0] and everything after it must be a
 * known flag (the original, still-supported shape: `<path> [--json]
 * [--no-write]`).
 *
 * Returns an `error` string (already `\n`-terminated) instead of a result
 * when the args don't resolve to exactly one target.
 */
function splitFlagsAndTarget(
  args: string[],
): { flags: string[]; target: string } | { error: string } {
  const dashDashIndex = args.indexOf("--");
  if (dashDashIndex !== -1) {
    const flags = args.slice(0, dashDashIndex);
    const positional = args.slice(dashDashIndex + 1);
    if (positional.length === 0) {
      return { error: "alter doctor loom: expected a path after `--`\n" };
    }
    if (positional.length > 1) {
      return {
        error:
          `alter doctor loom: unexpected extra argument(s) after the path: ` +
          `${positional.slice(1).join(", ")}\n`,
      };
    }
    return { flags, target: positional[0] };
  }

  const target = args[0];
  if (target.startsWith("-")) {
    return {
      error:
        `alter doctor loom: \`${target}\` looks like a flag, not a path. ` +
        "If it's really a folder name, mark the end of flags with `--`:\n" +
        `  alter doctor loom -- ${target}\n`,
    };
  }
  return { flags: args.slice(1), target };
}

export async function doctorLoom(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(USAGE);
    process.exitCode = args.length === 0 ? 2 : 0;
    return;
  }

  // `--ci` is a distinct mode (declared-check local CI runner + commit
  // status) - dispatch before any of the folder-validator flag parsing
  // below ever sees these args, same pattern `doctor.ts` uses to dispatch
  // `loom` itself before its own environment-diagnostic flag parser.
  if (args[0] === "--ci") {
    await runLoomCi(args.slice(1));
    return;
  }

  const split = splitFlagsAndTarget(args);
  if ("error" in split) {
    process.stderr.write(`${split.error}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const { flags, target } = split;
  const unknown = flags.filter((a) => !KNOWN_FLAGS.has(a));
  if (unknown.length > 0) {
    process.stderr.write(
      `alter doctor loom: unknown flag(s): ${unknown.join(", ")}\n\n${USAGE}`,
    );
    process.exitCode = 2;
    return;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    process.stderr.write(`alter doctor loom: not found: ${target}\n`);
    process.exitCode = 2;
    return;
  }
  if (!stat.isDirectory()) {
    process.stderr.write(`alter doctor loom: not a directory: ${target}\n`);
    process.exitCode = 2;
    return;
  }

  const script = path.join(assetsDir(), "folder_loom.py");
  if (!fs.existsSync(script)) {
    process.stderr.write(
      `alter doctor loom: bundled validator not found at ${script}. ` +
        "The package build did not copy src/assets/loom into dist.\n",
    );
    process.exitCode = 2;
    return;
  }

  const python = findPython();
  if (!python) {
    process.stderr.write(
      "alter doctor loom: no Python 3 interpreter found on PATH (tried `python3`, `python`).\n" +
        "Install Python 3.9 or later, then either re-run this command or invoke the\n" +
        "validator directly:\n" +
        `  python3 ${script} <path>\n`,
    );
    process.exitCode = 2;
    return;
  }

  // Always relay a `--` immediately before the target, regardless of how the
  // caller wrote it - this is what lets the bundled validator's own argparse
  // (which honours the same POSIX convention) accept a target beginning with
  // `-` instead of mistaking it for one of its own flags.
  const result = spawnSync(python, [script, ...flags, "--", target], {
    stdio: "inherit",
  });
  if (result.error) {
    process.stderr.write(
      `alter doctor loom: could not launch ${python}: ${result.error.message}\n`,
    );
    process.exitCode = 2;
    return;
  }
  process.exitCode = result.status ?? 1;
}
