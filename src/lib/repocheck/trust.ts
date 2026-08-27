/**
 * repocheck/trust.ts -- per-repository approval for executing repository-supplied
 * commands.
 *
 * The runner executes command lines that come out of the repository it is
 * standing in, under the user's own privileges. That is safe in a repository the
 * user wrote and unsafe in one they have merely cloned, and nothing about the
 * command itself distinguishes the two. So the user approves the set once per
 * repository.
 *
 * Approval is keyed on the content of the check set, not on the repository, so
 * an edit that adds a command, changes one, renames a check, or rewrites the
 * script body behind an unchanged command line all read as a new set and ask
 * again. Default-deny: with no approval on file and no terminal to ask at,
 * nothing runs.
 *
 * WHAT THIS DOES NOT COVER, and cannot.
 *
 * The digest covers what the manifests declare: the command lines, and the
 * script bodies and tool configuration behind them. It does not cover the code
 * those commands then reach. A test run executes the repository's own test
 * files, a conftest.py, a build.rs, a dependency resolved at install time, and
 * none of that is a declaration anything could digest.
 *
 * Nor does it survive the first approval being misplaced. An approved check
 * runs as the user, with the user's HOME, so it can write this file. It can
 * append the digest of whatever it means to run next and be approved before it
 * is asked about, and it can file passing verdicts for checks that never ran.
 * Withholding environment does not close that: the path to this file is
 * `$HOME/.local/share`, and a check that cannot read HOME cannot run npm or
 * cargo either. Nothing short of a boundary the operating system enforces
 * between the user and their own child process would, and there is none.
 *
 * What is done instead is to make it visible, on two clocks.
 *
 * DURING A RUN. The runner fingerprints this file before it executes anything,
 * again after each check, and once more after the last one, and a change that
 * appears while a check was running is not an approval the user gave, so every
 * approval for that repository is withdrawn (see run.ts).
 *
 * BETWEEN RUNS. Sampling only during a run catches only a write made during
 * one. A check is free to leave something behind that writes this file later:
 * `setsid` puts a process in a session of its own, where the group sweep the
 * runner performs does not reach it, and a write two seconds after the report
 * says the run is over lands after the last sample. So this module keeps a seal
 * beside the file, holding the fingerprint of the file as `approve` last left
 * it, and refuses every approval in a file whose fingerprint no longer matches
 * its seal. A write that did not go through `approve` is therefore noticed at
 * the next read, whenever it happened.
 *
 * THE SEAL IS NOT A SIGNATURE and cannot be. It is a plain digest in a file the
 * same user can write, so a process that forges an approval and then rewrites
 * the seal to match is not detected by it; nothing keyed could be, because any
 * key would sit under the same HOME the forger already reads. What the seal
 * closes is the gap between "the runner happened to be looking" and "the runner
 * was not", which is where the late write lived. It raises the cost of the
 * forgery from one careless append to a consistent pair of writes. That is a
 * detection, and a partial one.
 *
 * THAT COST IS ONLY IMPOSED IF THE SEAL IS COMPUTED FROM THE BYTES THE WRITER
 * WROTE, and for four commits it was not: `approve` sealed a re-read of the
 * file, so a writer that replaced the file between the rename and the re-read
 * got its own bytes sealed by this process and needed no second write at all.
 * The paragraph above was true of the design and false of the code, which is
 * the worse way round, because the design is what a reader believes. It is
 * true now; `approve` says how.
 *
 * So: approving a repository's checks is trusting the repository, not trusting
 * one string, and it is trust that a later run cannot fully take back.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { canonicalRoot } from "./identity.js";
import type { RepoCheck } from "./types.js";

interface TrustFile {
  version: number;
  repoRoot: string;
  /** Digests of check sets the user has approved, most recent last. */
  approved: { digest: string; approvedAt: string }[];
}

/** Approvals retained per repository before the oldest are dropped. */
const MAX_APPROVALS = 20;

function dataHome(): string {
  return (
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share")
  );
}

/**
 * `realpathSync` of the deepest EXISTING ancestor of `p`, with whatever
 * suffix does not exist yet joined back on lexically.
 *
 * `XDG_DATA_HOME` need not exist before the first approval creates it, so a
 * plain `fs.realpathSync` on the whole path would throw on a directory this
 * module is about to make. Resolving what is there and trusting the rest
 * lexically is enough for a containment test: a symlink can only appear on a
 * path segment that already exists.
 */
function realpathExistingPrefix(p: string): string {
  let cur = path.resolve(p);
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return suffix.length > 0 ? path.join(real, ...suffix.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p); // reached the filesystem root; give up cleanly
      suffix.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * True when this process's approval-store root resolves to somewhere inside
 * `repoRoot`.
 *
 * `dataHome()` trusts `XDG_DATA_HOME` unvalidated, which is fine for the store
 * location on its own - narrowing it to a fixed path would break every
 * legitimate override. What is checked here is narrower and cheap: the store
 * an approval for THIS repository would be read from or written to must not
 * live inside the repository itself. A repository that ships a `.envrc`
 * under direnv, a Makefile target, a devcontainer, or a wrapper script that
 * points `XDG_DATA_HOME` at itself would otherwise plant its own approval row
 * and have this module read it back as the user's, on the next run, with no
 * prompt ever answered.
 *
 * realpath'd on both sides, for the same reason the `cwd` containment check
 * in loom-ci.ts is: a lexical test does not see a symlink that lands inside
 * the repository from a path that reads as outside it.
 */
function trustRootResolvesInsideRepo(repoRoot: string): boolean {
  try {
    const realRepo = fs.realpathSync(repoRoot);
    const realHome = realpathExistingPrefix(dataHome());
    const rel = path.relative(realRepo, realHome);
    const outside = path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`);
    return !outside;
  } catch {
    return false;
  }
}

/**
 * A human-readable reason the approval store cannot be trusted for
 * `repoRoot`, or null when there is nothing wrong with it.
 *
 * Exported so `loom-ci.ts` can give the operator this SPECIFIC reason instead
 * of the generic "not writable" message `approve` returning false otherwise
 * produces - the two failures want different remedies, and only one of them
 * is the user's directory permissions.
 */
export function trustRootUnsafeReason(repoRoot: string): string | null {
  if (trustRootResolvesInsideRepo(repoRoot)) {
    return (
      "alter doctor loom --ci: the approval store (XDG_DATA_HOME) resolves " +
      `inside ${repoRoot}. Refusing to record or trust an approval this ` +
      "repository could plant for itself. Point XDG_DATA_HOME (or leave it " +
      "unset) somewhere outside the repository being checked.\n"
    );
  }
  return null;
}

function trustPath(repoIdentity: string): string {
  return path.join(dataHome(), "alter", "repocheck", `${repoIdentity}.trust.json`);
}

/** Where the fingerprint of the approval file as `approve` last left it is kept. */
function sealPath(repoIdentity: string): string {
  return path.join(dataHome(), "alter", "repocheck", `${repoIdentity}.trust.seal`);
}

/** sha256 of exactly these bytes, the same rendering `trustFingerprint` reads. */
function digestBytes(body: Buffer): string {
  return crypto.createHash("sha256").update(body).digest("hex");
}

function readSeal(repoIdentity: string): string | null {
  try {
    const raw = fs.readFileSync(sealPath(repoIdentity), "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * A temporary path beside `file` that nobody can guess and nobody can pre-make.
 *
 * The name used to be `<file>.<pid>.tmp`, which is predictable, and
 * `writeFileSync` FOLLOWS a symlink at its target, so anyone able to create a
 * file in this directory could plant a link and have this process write into
 * whatever it pointed at. Random bytes remove the prediction; the `wx` flag at
 * every call site refuses an existing path outright, which also disposes of a
 * stale temp left behind by a process that died mid-write.
 *
 * Duplicated in store.ts rather than shared, because the two modules do not
 * import each other and one write helper is not worth the coupling.
 */
function tmpPathFor(file: string): string {
  return `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
}

function writeSeal(repoIdentity: string, fingerprint: string): void {
  const file = sealPath(repoIdentity);
  try {
    const tmp = tmpPathFor(file);
    fs.writeFileSync(tmp, `${fingerprint}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
  } catch {
    // An unwritable data directory is handled by the caller's own write
    // failing; a missing seal reads as a broken one, which fails closed.
  }
}

/**
 * True when the approval file is exactly as `approve` last left it.
 *
 * Reachable states this is written against, rather than the one it was written
 * for. NEITHER FILE PRESENT: nothing has been approved, nothing can have moved,
 * intact. FILE PRESENT, SEAL ABSENT: fails closed, and it is worth saying that
 * this is also what an approval file written by an older build looks like, so
 * the first run after an upgrade asks again. SEAL PRESENT, FILE ABSENT: the
 * fingerprint reads "absent" and will not match, so the stale seal is treated
 * as broken rather than as permission. BOTH PRESENT AND MATCHING: intact, and
 * that includes the case where a forger rewrote both consistently, which this
 * cannot tell from the real thing.
 */
function sealIntact(repoIdentity: string): boolean {
  const recorded = readSeal(repoIdentity);
  const current = trustFingerprint(repoIdentity);
  if (recorded === null) return current === "absent";
  return recorded === current;
}

/**
 * The digest of what the repository declares would run.
 *
 * The resolved payload is in here alongside the command line, because the
 * command line is frequently only a name for it: `npm run test` is unchanged by
 * a rewrite of `scripts.test`, and it is the rewrite that decides what executes.
 * Sorted by id so a reordering of the same commands is the same set.
 *
 * Typed on the four fields it reads rather than the whole `RepoCheck`, so a
 * check set that was DECLARED by a repository rather than detected in one
 * (`.alter/loom.json`) is digested by this function and not by a second one.
 * Two derivations of the same thing is how they come to disagree.
 *
 * `source` folds in WHICH of those two callers produced this tuple set. Both
 * write into the one approval store, keyed the same way (`repoIdentity`,
 * digest), with nothing before this that told an approval recorded from one
 * apart from an approval asked about from the other. Today the two payload
 * shapes happen to differ enough that one cannot satisfy the other, but that
 * is an accident of the current shapes, not a property this module enforces,
 * so a set approved via one path is never allowed to authorise the other,
 * whatever their tuples come to look like later.
 */
export function declarationDigest(
  checks: readonly Pick<
    RepoCheck,
    "id" | "command" | "workdir" | "payload"
  >[],
  // Defaults to "detected": every caller in this package's own test suite,
  // and doctor/checks/repo.ts, is this module's native source. loom-ci.ts is
  // the one caller outside it and passes "declared" explicitly.
  source: "declared" | "detected" = "detected",
): string {
  const canonical = JSON.stringify({
    source,
    checks: checks
      .map((c) => [c.id, c.command, c.workdir, c.payload] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function readTrust(repoIdentity: string, repoRoot: string): TrustFile {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(trustPath(repoIdentity), "utf8"),
    ) as TrustFile;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.approved)
    ) {
      return { version: 1, repoRoot, approved: [] };
    }
    return parsed;
  } catch {
    return { version: 1, repoRoot, approved: [] };
  }
}

/**
 * True when the user has already approved exactly this set of commands.
 *
 * The seal is checked first, so an approval file that has moved since `approve`
 * last wrote it answers no, whatever it says inside, and is withdrawn on the
 * spot. Two functions in this module read an approval, this one and `approve`,
 * and both check the seal before believing what they read; nothing outside the
 * module can, because `readTrust` is private and this is the only exported way
 * to ask.
 *
 * Two more refusals before the digest is even consulted. The trust root
 * containment check answers no to a repository that pointed its own store at
 * itself, so nothing it planted there is ever read back as the user's word.
 * The stored `repoRoot` comparison is a narrower defence: `repoIdentity` is a
 * 64-bit truncation of a hash, so two different paths landing on the same 16
 * hex characters is astronomically unlikely today but not impossible as the
 * number of repositories a machine has ever approved grows, and it is cheap
 * to close outright rather than accept on faith. It does not, and cannot,
 * close the disclosed and separate exposure of a different repository later
 * occupying the SAME path with the SAME declared commands - `repoRoot` is
 * that path either way, so the comparison reads the same for both. That
 * exposure is why content, not path, is what a verdict is ultimately keyed
 * on elsewhere in this package; the approval layer stays path-identified,
 * as documented in CI_USAGE and README.md.
 */
export function isApproved(
  repoIdentity: string,
  repoRoot: string,
  digest: string,
): boolean {
  if (trustRootResolvesInsideRepo(repoRoot)) return false;
  if (!sealIntact(repoIdentity)) {
    revokeAll(repoIdentity);
    return false;
  }
  const trust = readTrust(repoIdentity, repoRoot);
  if (trust.repoRoot && canonicalRoot(trust.repoRoot) !== canonicalRoot(repoRoot)) {
    return false;
  }
  return trust.approved.some((a) => a.digest === digest);
}

/**
 * Record the user's approval of this set.
 * Returns false when the approval could not be persisted, so the caller can say
 * so rather than silently asking again on the next run.
 */
export function approve(
  repoIdentity: string,
  repoRoot: string,
  digest: string,
): boolean {
  if (trustRootResolvesInsideRepo(repoRoot)) return false;

  // A file that has already moved out from under its seal is not a file to add
  // an approval to: whatever is in it was not put there by anyone asking.
  const onDisk = sealIntact(repoIdentity) ? readTrust(repoIdentity, repoRoot) : null;
  // A stored repoRoot that does not match the one being approved (a hash
  // collision, or any future change to how repoIdentity is derived) is not a
  // file to append to either: starting fresh is the fail-closed direction,
  // and the repoRoot below is corrected to the current value either way.
  const trust: TrustFile =
    onDisk && (!onDisk.repoRoot || canonicalRoot(onDisk.repoRoot) === canonicalRoot(repoRoot))
      ? onDisk
      : { version: 1, repoRoot, approved: [] };
  trust.repoRoot = repoRoot;
  if (!trust.approved.some((a) => a.digest === digest)) {
    trust.approved.push({ digest, approvedAt: new Date().toISOString() });
  }
  if (trust.approved.length > MAX_APPROVALS) {
    trust.approved = trust.approved.slice(-MAX_APPROVALS);
  }

  const file = trustPath(repoIdentity);
  try {
    // 0700, NOT THE UMASK, and the reasoning is set out at the same site in
    // store.ts. A 0600 file inside a group-writable directory can be unlinked
    // and replaced by a group peer, and this directory holds BOTH the approval
    // file and the seal that would otherwise catch the swap. Section 1 of the
    // threat model excludes "a different operating-system user" because such a
    // user already owns HOME; a group peer does not, and reached this only
    // through the mode.
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const body = Buffer.from(`${JSON.stringify(trust, null, 2)}\n`, "utf8");
    const tmp = tmpPathFor(file);
    fs.writeFileSync(tmp, body, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
    // SEALED FROM THE BYTES THIS FUNCTION WROTE, never from a re-read of the
    // file after the rename, which is what this used to do and which inverted
    // the seal's whole purpose. Between the rename and a re-read there is a
    // window, and a writer that replaces the file inside it has its own bytes
    // fingerprinted and sealed by the legitimate process. The forgery then
    // validates, because it carries a seal written by the one party a reader
    // trusts. Measured before this change: 1986 of 3000 racing attempts won,
    // and every winner's approval was accepted afterwards.
    //
    // Sealing what was written removes the window rather than narrowing it.
    // A racing writer can still replace the file, and now the seal it left
    // behind does not match, so the approvals read as tampered and are
    // withdrawn. That is the fail-closed direction.
    writeSeal(repoIdentity, digestBytes(body));
    return true;
  } catch {
    return false;
  }
}

/**
 * A fingerprint of the approval file exactly as it stands.
 *
 * Read by the runner before and during a run, so that a write made by the very
 * commands the file authorises is noticed rather than inherited. "absent" is a
 * value like any other here: a file appearing where there was none is as much a
 * change as one being edited.
 */
export function trustFingerprint(repoIdentity: string): string {
  try {
    return crypto
      .createHash("sha256")
      .update(fs.readFileSync(trustPath(repoIdentity)))
      .digest("hex");
  } catch {
    return "absent";
  }
}

/** Withdraw every approval for a repository, seal and all. */
export function revokeAll(repoIdentity: string): void {
  try {
    fs.rmSync(trustPath(repoIdentity), { force: true });
  } catch {
    // Nothing to withdraw.
  }
  try {
    // Removed after the file, never before: a seal left behind a file that is
    // gone would read as a mismatch, which is harmless, while a file left
    // behind a seal that is gone reads the same way. Both orders fail closed;
    // this one leaves nothing behind on the ordinary path.
    fs.rmSync(sealPath(repoIdentity), { force: true });
  } catch {
    // Nothing to withdraw.
  }
}
