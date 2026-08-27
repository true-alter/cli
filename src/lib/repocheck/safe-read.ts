/**
 * repocheck/safe-read.ts -- reading a path a stranger chose.
 *
 * Every path this module reads comes out of a repository, so its SHAPE is the
 * repository's to choose as much as its contents are. A named pipe standing
 * where a configuration file was makes an ordinary read wait for a writer that
 * need never arrive, and this process has one thread, so the wait is the whole
 * CLI. That is not hypothetical: a FIFO at `.cargo/config.toml` wedged detection
 * indefinitely before this guard existed.
 *
 * This file exists as its own module because the guard was written once, in
 * detection, and the working-tree digest in identity.ts read paths the same
 * repository chose with `readFileSync` and no guard at all. One shared primitive
 * is the answer to that, rather than a second copy that can drift from the first.
 *
 * WHAT THE GUARD IS. `O_NONBLOCK` is what makes the open itself safe: on POSIX,
 * opening a FIFO for reading with it set returns at once instead of waiting, and
 * the same holds for a device that would otherwise block on open. The descriptor
 * is then fstat'd rather than the path stat'd, because a path checked and then
 * opened is a path that can be swapped between the two.
 *
 * WHAT IT DOES NOT COVER. Windows has no `O_NONBLOCK` (the constant is undefined
 * there and this falls back to 0), so on Windows the fstat is the only guard and
 * an open that blocks would still block. Windows named pipes do not live in the
 * filesystem namespace these relative paths resolve in, which makes that a
 * narrower hole there rather than none at all. A regular file on a network mount
 * that stops responding also still blocks: this rejects a shape, not a slow disk.
 */

import * as crypto from "crypto";
import * as fs from "fs";

/** Largest file this module will hold in memory whole in order to parse it. */
export const MAX_PARSE_BYTES = 8 * 1024 * 1024;

/**
 * Read size used when pulling bytes off a descriptor. In `digestOpen` it means
 * file size decides time and not memory; `readTextFile` still has to hold what
 * it parses, which is what MAX_PARSE_BYTES bounds.
 */
const DIGEST_CHUNK_BYTES = 256 * 1024;

/**
 * Open a repository-supplied path for reading, or null when it is not a plain
 * file this process can safely read to the end.
 */
export function openRegular(abs: string): number | null {
  const nonblock = (fs.constants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0;
  let fd: number;
  try {
    fd = fs.openSync(abs, fs.constants.O_RDONLY | nonblock);
  } catch {
    return null;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) {
      fs.closeSync(fd);
      return null;
    }
  } catch {
    try {
      fs.closeSync(fd);
    } catch {
      // Already gone.
    }
    return null;
  }
  return fd;
}

/** Hash an open descriptor in bounded chunks, so a huge file costs time only. */
export function digestOpen(fd: number): string {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(DIGEST_CHUNK_BYTES);
  for (;;) {
    const read = fs.readSync(fd, buffer, 0, buffer.length, null);
    if (read <= 0) break;
    hash.update(buffer.subarray(0, read));
  }
  return hash.digest("hex");
}

/**
 * sha256 of one path's bytes, or a word saying why there are none.
 *
 * Absence is a value like any other, because whether a file exists is itself
 * part of what a tool will do. "irregular" is kept distinct from "absent" for
 * the same reason: a directory or a pipe standing where a configuration file was
 * is a change to what the tool reading it will do, and folding it into "absent"
 * would hide that change.
 */
export function digestPath(abs: string): string {
  const fd = openRegular(abs);
  if (fd === null) {
    // lstat resolves nothing and opens nothing, so it is safe on exactly the
    // paths the open above refused.
    try {
      fs.lstatSync(abs);
      return "irregular";
    } catch {
      return "absent";
    }
  }
  try {
    return digestOpen(fd);
  } catch {
    return "unreadable";
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Already gone.
    }
  }
}

/**
 * A repository-supplied file's text, or null when it cannot safely be read.
 *
 * Bounded by reading rather than by asking: a size taken from fstat and then
 * trusted is a size that can be wrong by the time the read happens, and a
 * manifest that grows while it is being read is one more thing a repository
 * gets to choose. Reading one byte past the ceiling and refusing on that is the
 * same test made from what actually arrived.
 */
export function readTextFile(file: string): string | null {
  const fd = openRegular(file);
  if (fd === null) return null;
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    const buffer = Buffer.allocUnsafe(DIGEST_CHUNK_BYTES);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      total += read;
      if (total > MAX_PARSE_BYTES) return null;
      chunks.push(Buffer.from(buffer.subarray(0, read)));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Already gone.
    }
  }
}
