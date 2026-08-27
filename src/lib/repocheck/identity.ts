/**
 * repocheck/identity.ts -- content identity for a repository check.
 *
 * A check's verdict depends on the CONTENT it was judged against, never on the
 * commit that happened to carry that content. Two branches holding identical
 * bytes, a rebase that rewrites every commit id, or the same tree on a second
 * machine all produce the same identity here, so a verdict earned once is still
 * valid in all of them.
 *
 * The identity is built from git's own object ids for tracked content, which
 * git has already computed, plus a direct digest of anything on disk that git's
 * index does not yet describe. Nothing re-hashes content git has already hashed.
 */

import * as crypto from "crypto";
import { execFile, execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

import { digestPath } from "./safe-read.js";
import type { TreeMode } from "./types.js";

/** Upper bound on git plumbing output, generous enough for a large repository. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Configuration forced on every git call made here.
 *
 * `core.fsmonitor` names a program git runs, and it can be set by the
 * repository's own .git/config, so turning it off closes one way a repository
 * can choose what executes. It costs a little speed on a very large tree and
 * nothing else.
 *
 * IT CLOSES ONE WAY, NOT THE CLASS. `filter.<name>.clean`, named in the same
 * .git/config and bound to a path by a tracked .gitattributes, is a program git
 * runs during `git status`, and no command-line override switches it off: the
 * filter names are the repository's to choose, so there is no fixed key to set.
 * The same is true of anything else git will learn to run from its own config.
 *
 * What keeps that away from an unapproved repository is ORDER, not this list.
 * `contentKey` is the only function here that runs `status` or `ls-files`, and
 * its callers reach it only once the user's approval is settled (run.ts,
 * doctor/checks/repo.ts). `repoRootFrom` is the one call that necessarily comes
 * first, and `rev-parse --show-toplevel` reads config and prints a path.
 */
const GIT_SAFE_CONFIG = ["-c", "core.fsmonitor=false"];

/**
 * Resolve the repository root containing `startDir`.
 * Returns null when the directory is not inside a git working tree.
 */
export function repoRootFrom(startDir: string): string | null {
  try {
    const out = execFileSync(
      "git",
      [...GIT_SAFE_CONFIG, "rev-parse", "--show-toplevel"],
      {
        cwd: startDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: GIT_MAX_BUFFER,
      },
    );
    const root = out.trim();
    return root.length > 0 ? root : null;
  } catch {
    return null;
  }
}

/** Run a git command and return stdout, or null when git fails. */
function gitOut(repoRoot: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [...GIT_SAFE_CONFIG, ...args],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: GIT_MAX_BUFFER },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
}

/**
 * sha256 of a working-tree file's bytes, or a word saying why there are none.
 *
 * SHAPE-GUARDED, through the same primitive detection uses. This used to
 * `statSync` the path and then `readFileSync` it, and every path it is handed
 * came out of `git status` in a repository the user did not write. A FIFO among
 * them makes the read wait for a writer that need never arrive, and this
 * process has one thread, so the wait is the whole CLI: exactly the fault a
 * FIFO at `.cargo/config.toml` caused in detection, in a second reader that
 * never got the guard.
 *
 * That this sits after approval bounds who can reach it and does not make it
 * safe. Approval covers the commands a repository declares; it says nothing
 * about the shape of a file that appears afterwards, and an approved check is
 * itself free to leave one behind.
 */
function digestFile(absPath: string): Promise<string> {
  return Promise.resolve(digestPath(absPath));
}

/**
 * Parse `git ls-files -s -z` output into "path\0objectid" pairs.
 * Each record is "<mode> <oid> <stage>\t<path>".
 */
function parseLsFiles(raw: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const record of raw.split("\0")) {
    if (record.length === 0) continue;
    const tabAt = record.indexOf("\t");
    if (tabAt < 0) continue;
    const meta = record.slice(0, tabAt).split(" ");
    if (meta.length < 2) continue;
    entries.set(record.slice(tabAt + 1), meta[1]);
  }
  return entries;
}

/**
 * Paths whose on-disk content differs from the index, plus untracked paths.
 * Returned as porcelain-v1 records so the caller can tell a deletion from an
 * edit without a second git call.
 */
async function dirtyPaths(
  repoRoot: string,
  pathspec: string[],
): Promise<{ modified: string[]; deleted: string[] } | null> {
  const args = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];
  if (pathspec.length > 0) args.push("--", ...pathspec);
  const raw = await gitOut(repoRoot, args);
  const modified: string[] = [];
  const deleted: string[] = [];
  // NULL IS "NO ANSWER", NEVER "NOTHING IS DIRTY". This used to return an empty
  // pair, which reads downstream as a pristine tree and is the exact inversion
  // that made a failed `git status` look like a clean one.
  if (raw === null) return null;

  // Porcelain v1 with -z: "XY <path>\0", and a rename carries a second
  // \0-terminated field holding the original path.
  const fields = raw.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i];
    if (record.length < 4) continue;
    const x = record[0];
    const y = record[1];
    const target = record.slice(3);
    if (x === "R" || x === "C") {
      // Consume the origin-path field that follows a rename or copy.
      i++;
    }
    if (x === "D" || y === "D") {
      deleted.push(target);
      continue;
    }
    modified.push(target);
  }
  return { modified, deleted };
}

/**
 * Compute the content identity for `basis` under `mode`.
 *
 * An empty `basis` means the whole tracked tree, which is the safe default: a
 * basis wider than the truth costs one needless re-run, while a basis narrower
 * than the truth returns a pass on content nobody checked.
 */
export async function contentKey(
  repoRoot: string,
  basis: string[],
  mode: TreeMode,
): Promise<string | null> {
  const pathspec = basis.filter((p) => p.length > 0);

  const lsArgs = ["ls-files", "-s", "-z"];
  if (pathspec.length > 0) lsArgs.push("--", ...pathspec);
  const rawIndex = await gitOut(repoRoot, lsArgs);
  // NULL RATHER THAN A KEY OVER NOTHING, and this is the fail-open the module
  // was carrying. A failed git call used to yield an empty entry set, which
  // hashes to a FIXED CONSTANT: the same key for every repository, forever.
  // One benign pass banked under it is then recalled on every later run while
  // the checks never execute again, which is a check reporting OK without
  // running, the worst outcome this store can produce. A repository can force
  // it deliberately, by shipping enough tracked paths that `git status`
  // overruns the output buffer, and a locked index or a concurrent `gc` does it
  // by accident. Callers treat null as never-recall and never-record, so the
  // cost of no answer is a real run rather than a false pass.
  if (rawIndex === null) return null;
  const entries = parseLsFiles(rawIndex);

  if (mode === "worktree") {
    const dirty = await dirtyPaths(repoRoot, pathspec);
    if (dirty === null) return null;
    const { modified, deleted } = dirty;
    for (const rel of deleted) entries.delete(rel);
    for (const rel of modified) {
      entries.set(rel, await digestFile(path.join(repoRoot, rel)));
    }
  }

  // Sort by path so the identity is independent of listing order.
  const lines = [...entries.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([rel, oid]) => `${oid} ${rel}`);

  return crypto
    .createHash("sha256")
    .update(`v1\n${mode}\n${lines.join("\n")}`)
    .digest("hex");
}

/**
 * One rendering of a path, so that two spellings of the same directory are the
 * same directory.
 *
 * Windows and macOS both compare filenames without regard to case by default,
 * and on Windows git reports a root with forward slashes while the platform
 * writes backslashes. Left alone, `C:/Users/x/repo` and `c:\Users\x\repo` are
 * two identities for one working tree, which silently halves the recall this
 * whole module exists for. Linux is case-sensitive and is left exactly as it is.
 */
export function canonicalRoot(repoRoot: string): string {
  const resolved = path.resolve(repoRoot);
  if (process.platform === "win32") {
    return resolved.replace(/\\/g, "/").toLowerCase();
  }
  if (process.platform === "darwin") return resolved.toLowerCase();
  return resolved;
}

/**
 * A stable identifier for this repository, used to scope stored verdicts.
 * Derived from the root path so two clones of the same project keep separate
 * verdicts: they are separate working trees and can hold different content.
 */
export function repoIdentity(repoRoot: string): string {
  return crypto
    .createHash("sha256")
    .update(canonicalRoot(repoRoot))
    .digest("hex")
    .slice(0, 16);
}
