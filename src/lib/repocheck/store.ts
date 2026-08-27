/**
 * repocheck/store.ts -- the verdict store.
 *
 * A check that has already passed against exactly this content, with exactly
 * this command, under exactly this runner, does not need to run again. The key
 * carries all three, so any change to any of them misses the store and the
 * check runs for real.
 *
 * Only passes are kept. A failure is always re-run, because a failing check
 * frequently depends on something outside the content it was keyed on, a tool
 * version or a service that has since come back, and telling somebody their
 * code is still broken when it is not is a worse error than running it twice.
 *
 * THIS FILE DECIDES WHETHER A CHECK RUNS AT ALL, so it is worth as much to a
 * hostile repository as the approval file is: a forged pass filed here is a
 * check that never executes and reports OK. An approved check runs as the user
 * and can write it, exactly as it can write the approvals, and for exactly the
 * same reason nothing here prevents that. So the same two answers are used.
 * The runner rewrites this file from the copy it read before anything ran,
 * unconditionally, which overwrites anything a check filed for itself mid-run;
 * and a seal beside the file holds the fingerprint of the file as `writeStore`
 * last left it, so a write that did not come through `writeStore`, including
 * one made after the run ended, is noticed at the next read and the store is
 * treated as cold.
 *
 * A cold store is a safe failure here in a way a cold approval file is not:
 * losing verdicts costs a re-run, and re-running is the honest answer. As with
 * the approval seal, this is a digest and not a signature, so a forger that
 * rewrites the seal to match is not caught by it.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { RepoCheck, StoredVerdict } from "./types.js";

/** Bumped whenever a change here could invalidate previously stored verdicts. */
export const RUNNER_EPOCH = "2";

/** Most verdicts retained per repository before the oldest are dropped. */
const MAX_VERDICTS = 500;

interface StoreFile {
  version: number;
  repoRoot: string;
  verdicts: Record<string, StoredVerdict>;
}

function dataHome(): string {
  return (
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share")
  );
}

/** Absolute path of the verdict file for one repository. */
export function storePath(repoIdentity: string): string {
  return path.join(dataHome(), "alter", "repocheck", `${repoIdentity}.json`);
}

/** Where the fingerprint of the verdict file as `writeStore` left it is kept. */
function sealPath(repoIdentity: string): string {
  return path.join(dataHome(), "alter", "repocheck", `${repoIdentity}.seal`);
}

/** A fingerprint of the verdict file exactly as it stands, "absent" when there is none. */
function storeFingerprint(repoIdentity: string): string {
  try {
    return crypto
      .createHash("sha256")
      .update(fs.readFileSync(storePath(repoIdentity)))
      .digest("hex");
  } catch {
    return "absent";
  }
}

/**
 * True when the verdict file is exactly as `writeStore` last left it.
 *
 * Written against the same four reachable states as the approval seal. NEITHER
 * PRESENT: nothing filed, intact. FILE PRESENT, SEAL ABSENT: not intact, which
 * is also what a store written by an older build looks like, so the first run
 * after an upgrade re-runs its checks once. SEAL PRESENT, FILE ABSENT: the
 * fingerprint reads "absent", does not match, not intact. BOTH PRESENT AND
 * MATCHING: intact, including the case of a forger that rewrote both.
 */
function sealIntact(repoIdentity: string): boolean {
  let recorded: string | null = null;
  try {
    const raw = fs.readFileSync(sealPath(repoIdentity), "utf8").trim();
    recorded = raw.length > 0 ? raw : null;
  } catch {
    recorded = null;
  }
  const current = storeFingerprint(repoIdentity);
  if (recorded === null) return current === "absent";
  return recorded === current;
}

/**
 * The key a verdict is filed under.
 *
 * Every input that could change the answer is in the key: the content the check
 * reads, the command it runs, the declaration behind that command, and the
 * runner that interprets it.
 *
 * WHY THE DECLARATION IS IN HERE and not left to the approval machinery, which
 * already re-asks when it changes. Re-asking governs whether a command may run;
 * it does not retire the verdicts earned before it changed, and the approval
 * file keeps every set the user has ever approved, so a repository that returns
 * to an approved declaration is approved again without asking.
 *
 * That leaves one case where a stale pass is recalled. In `worktree` mode the
 * content key covers untracked files, because `status --untracked-files=all`
 * reports them, so an edited `.npmrc` changes the content and misses the store.
 * In `index` mode, which is the basis at commit time, untracked content is not
 * in the key at all. An ignored `.npmrc` naming a different `script-shell` was
 * therefore a change to which program the check runs that the key could not
 * see. The payload does see it, because that file is one of the sidecars the
 * payload digests, so putting the payload here closes it in both modes.
 */
export function verdictKey(check: RepoCheck, contentKey: string): string {
  const canonical = JSON.stringify({
    e: RUNNER_EPOCH,
    i: check.id,
    c: check.command,
    d: check.workdir,
    p: check.payload,
    k: contentKey,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function emptyStore(repoRoot: string): StoreFile {
  return { version: 1, repoRoot, verdicts: {} };
}

/**
 * Read the store, returning an empty one on any absence, corruption, or a file
 * that has moved since this module last wrote it.
 */
export function readStore(repoIdentity: string, repoRoot: string): StoreFile {
  const file = storePath(repoIdentity);
  if (!sealIntact(repoIdentity)) return emptyStore(repoRoot);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as StoreFile;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      parsed.version !== 1 ||
      typeof parsed.verdicts !== "object" ||
      parsed.verdicts === null
    ) {
      return emptyStore(repoRoot);
    }
    return parsed;
  } catch {
    return emptyStore(repoRoot);
  }
}

/**
 * Write the store atomically, pruning to the most recent MAX_VERDICTS.
 * A write failure is swallowed: an unwritable data directory costs the saving,
 * never the run.
 */
/**
 * A temporary path beside `file` that nobody can guess and nobody can pre-make.
 *
 * The name used to be `<file>.<pid>.tmp`, which is predictable, and
 * `writeFileSync` FOLLOWS a symlink at its target. Anyone able to create a file
 * in this directory could therefore plant a link there and have this process
 * write JSON into whatever the link pointed at. Random bytes remove the
 * prediction; the callers' `wx` flag refuses to open an existing path at all,
 * which closes it even against a lucky guess and against a stale temp file left
 * by a process that died mid-write.
 *
 * Duplicated in trust.ts rather than shared, because the two modules do not
 * import each other and one write helper is not worth the coupling.
 */
function tmpPathFor(file: string): string {
  return `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
}

export function writeStore(repoIdentity: string, store: StoreFile): void {
  const entries = Object.entries(store.verdicts);
  if (entries.length > MAX_VERDICTS) {
    entries.sort((a, b) => (a[1].recordedAt < b[1].recordedAt ? 1 : -1));
    store.verdicts = Object.fromEntries(entries.slice(0, MAX_VERDICTS));
  }

  const file = storePath(repoIdentity);
  try {
    // 0700, NOT THE UMASK. The files are written 0600, which is worth nothing
    // if the directory holding them is group-writable: write permission on a
    // directory is permission to unlink and replace what is in it, and a peer
    // sharing the user's primary group could therefore rewrite the store AND
    // its seal consistently, which is precisely the forgery a seal cannot
    // catch. The threat model excludes "a different operating-system user" on
    // the reasoning that such a user already owns HOME. That reasoning does not
    // reach a group peer, who gains this only from the directory's mode.
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const body = Buffer.from(`${JSON.stringify(store, null, 2)}\n`, "utf8");
    const tmp = tmpPathFor(file);
    fs.writeFileSync(tmp, body, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
    // Sealed from the bytes just written, never from a re-read of the file.
    // Re-reading leaves a window between the rename and the read in which a
    // racing writer's bytes get sealed as authentic by this process, which is
    // the forgery signed by its own victim. Measured at 2231 of 3000 attempts
    // before this change, with the forged verdict recalled afterwards. The
    // reasoning is set out at the same site in trust.ts.
    const sealFile = sealPath(repoIdentity);
    const sealTmp = tmpPathFor(sealFile);
    const digest = crypto.createHash("sha256").update(body).digest("hex");
    fs.writeFileSync(sealTmp, `${digest}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(sealTmp, sealFile);
  } catch {
    // Deliberately silent: losing the saving is not worth failing the run. A
    // store left without a matching seal reads as cold next time, which costs
    // a re-run and never a wrong pass.
  }
}

/** Recall a stored pass, or null when this content has not passed before. */
export function recall(store: StoreFile, key: string): StoredVerdict | null {
  const hit = store.verdicts[key];
  return hit && hit.status === "OK" ? hit : null;
}

/** File a pass. Anything other than a pass is deliberately not stored. */
export function record(
  store: StoreFile,
  key: string,
  check: RepoCheck,
  exitCode: number | null,
  durationMs: number,
): void {
  store.verdicts[key] = {
    key,
    checkId: check.id,
    status: "OK",
    exitCode,
    recordedAt: new Date().toISOString(),
    originalDurationMs: durationMs,
  };
}
