/**
 * TPM2-held device-key countersignature: helper resolution and invocation.
 *
 * The ES256 device countersignature at `alter login` time is produced by
 * shelling out to a one-shot local helper. The first cut of that mechanism
 * resolved the helper through an environment variable or a `$PATH` search,
 * which is same-uid-writable by construction, so ANY process running as the
 * same user as `alter login` (a compromised dependency, a malicious editor
 * plugin, a subverted agent session) could point the resolution at a forged,
 * non-TPM-backed signer. That defeats the whole reason to choose TPM2 over a
 * private-key file, which is that the key cannot be exfiltrated, and it does
 * so without ever touching the chip.
 *
 * The repair is implemented here exactly:
 *   - The helper is NEVER discovered. There is one hardcoded absolute path
 *     compiled into the CLI. No environment variable is read, no `$PATH`
 *     search occurs (execFile takes an absolute path and never consults
 *     $PATH), no config file is consulted, no relative resolution happens
 *     anywhere in this module.
 *   - Before every exec: lstat the path, refuse unless it is owned by
 *     uid 0 and carries no group/other write bit. If it is a symlink,
 *     resolve the real path and re-run the same checks against the
 *     resolved target - every hop is re-checked, never trusted blind.
 *     Every parent directory component up to `/` gets the identical
 *     owner/write-bit check (a root-owned leaf file behind a
 *     group-writable parent directory is exactly as substitutable as an
 *     unowned file).
 *   - Any failure of any check - absent helper, wrong owner, writable
 *     directory anywhere in the chain, non-zero exit, timeout,
 *     unparseable stdout, wrong JSON shape - degrades to `null`
 *     (unattested), exactly as an absent helper does today. This module
 *     NEVER throws out of `invokeDeviceSignHelper` and NEVER hard-fails
 *     `alter login`.
 *
 * Platform note, left as a comment rather than a relaxation of the check:
 * this hardcoded path assumes a Linux-style install where
 * `/usr/local` (and everything above it) is root-owned by default. On a
 * Homebrew-managed macOS prefix (owned by the installing user, not root,
 * by deliberate Homebrew design) the uid-0 check will always fail and
 * every login on that machine degrades to unattested permanently - the
 * SAFE failure direction. Do NOT "fix" that by relaxing the check to
 * accept the logged-in user's uid instead of root: the logged-in user's
 * uid IS the same-uid attacker's uid this module exists to exclude, and
 * relaxing the check reopens exactly the hole described above. Today's pinned
 * desktop is Linux; this module is Linux-only in practice and unverified
 * on Windows/WSL path-ownership semantics.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The ONE hardcoded absolute path to the device-sign helper. Deliberately
 * not overridable by environment variable, config file, or `$PATH` search
 * anywhere in production code - see the module docstring. Provisioning
 * this file (root-owned, mode 0755, e.g.
 * `sudo install -o root -g root -m 0755 device-sign /usr/local/libexec/alter/device-sign`)
 * is a separate, out-of-scope admin action (sibling TPM-provisioning
 * unit); this module only ever reads and verifies whatever is already at
 * this path.
 */
export const DEVICE_SIGN_HELPER_PATH = "/usr/local/libexec/alter/device-sign";

/** Bounded wait for the one-shot helper subprocess. `alter login` is a
 * human-paced, once-per-login event, so a generous but finite timeout
 * costs nothing real and prevents a hung or malicious helper from
 * stalling login indefinitely. */
const DEFAULT_TIMEOUT_MS = 5000;

/** Refuse a resolved file/directory that is writable by anyone but its
 * owner. `0o022` covers group-write and other-write; owner-write is
 * expected and fine for a root-owned file. */
const UNSAFE_WRITE_BITS = 0o022;

/** Hard ceiling on symlink hops, defends against a symlink loop being
 * used to hang or crash the resolver. No real install chains this deep. */
const MAX_SYMLINK_HOPS = 32;

/**
 * Verify that `candidatePath` resolves - through any number of symlink
 * hops - to a file owned by uid 0 with no group/other write bit, AND that
 * every parent directory of every hop (the symlink's own location as well
 * as the final resolved target's location) is likewise root-owned with no
 * group/other write bit, all the way up to `/`.
 *
 * Never throws. Any lstat/readlink failure, missing path, wrong owner, or
 * writable directory anywhere in the chain returns `false`.
 */
export function isHelperPathTrusted(candidatePath: string): boolean {
  const dirsToCheck = new Set<string>();
  let current = path.resolve(candidatePath);
  let hops = 0;

  for (;;) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(current);
    } catch {
      return false; // does not exist (or unreadable parent) - refuse.
    }

    if (st.isSymbolicLink()) {
      // The symlink entry itself lives in a directory; that directory's
      // trust is checked below via dirsToCheck. Never trust the hop
      // itself - resolve and re-run the full check against the target.
      dirsToCheck.add(path.dirname(current));
      if (++hops > MAX_SYMLINK_HOPS) return false;
      let link: string;
      try {
        link = fs.readlinkSync(current);
      } catch {
        return false;
      }
      current = path.isAbsolute(link)
        ? path.resolve(link)
        : path.resolve(path.dirname(current), link);
      continue;
    }

    // Terminal (non-symlink) target: must be a regular file, root-owned,
    // no group/other write bit.
    if (!st.isFile()) return false;
    if (st.uid !== 0) return false;
    if ((st.mode & UNSAFE_WRITE_BITS) !== 0) return false;
    dirsToCheck.add(path.dirname(current));
    break;
  }

  // Walk every parent directory of every hop (every symlink's own
  // directory plus the final target's directory) up to `/`, applying the
  // identical root-owned / no-group-or-other-write check to each
  // component. A root-owned leaf behind even one writable ancestor
  // directory is substitutable (the attacker replaces the entry, not the
  // file), so this closes that route too.
  for (const startDir of dirsToCheck) {
    let dir = startDir;
    for (;;) {
      let st: fs.Stats;
      try {
        st = fs.lstatSync(dir);
      } catch {
        return false;
      }
      if (st.uid !== 0) return false;
      if ((st.mode & UNSAFE_WRITE_BITS) !== 0) return false;
      const parent = path.dirname(dir);
      if (parent === dir) break; // reached '/'
      dir = parent;
    }
  }

  return true;
}

/** What the helper must return on stdout for a countersignature to be
 * attached to the registration request. */
export interface DeviceCountersignatureResult {
  devicePublicKeyPem: string;
  deviceCountersignature: string;
}

interface DeviceSignInvokeOptions {
  /** Test-only override of the helper path. Production callers must never
   * pass this - the whole point of the fix is that the path is not
   * externally configurable. */
  helperPath?: string;
  /** Test-only override of the subprocess timeout. */
  timeoutMs?: number;
}

/**
 * Invoke the device-sign helper for the freshly-generated (or reused)
 * session signing key's public half, identified by `newKeySha256` (the
 * SHA-256 hex digest of that key's PEM, matching the server's own
 * `hashlib.sha256(new_key_pem.encode("utf-8")).hexdigest()` in
 * `_verify_device_countersignature`).
 *
 * Protocol mirrors `scripts/loom_landing_record.py`'s `LandingRecordSeam`:
 * narrow JSON over stdin/stdout, `{"new_key_sha256": "<hex>"}` in,
 * `{"device_countersignature": "<compact JWS>", "device_public_key_pem":
 * "<PEM>"}` out on stdout.
 *
 * Returns `null` - never throws - when: the helper path fails the
 * ownership/mode/parent-directory trust check (including simply not
 * existing, the common case on a machine with no TPM provisioned); the
 * subprocess exits non-zero; it times out; stdout is not parseable JSON;
 * or the parsed shape is missing either expected string field. Every one
 * of these degrades identically to "no countersignature attached" -
 * `alter login` proceeds and the session key registers un-attested,
 * exactly as it does today with no device-sign mechanism at all.
 */
/**
 * @internal Spawn the helper process at an ALREADY-TRUSTED path and parse
 * its stdout. Split out of {@link invokeDeviceSignHelper} purely so tests
 * can exercise the stdin/stdout protocol (timeout, non-zero exit,
 * malformed JSON, wrong shape) against a same-uid fixture script without
 * needing root to satisfy `isHelperPathTrusted`. NEVER call this directly
 * from production wiring - `invokeDeviceSignHelper` is the only sanctioned
 * entry point, and it is the one that runs the trust check first. This
 * function does not itself resolve, search, or trust anything; it only
 * execs the exact path it is handed.
 */
export async function execDeviceSignHelperProcess(
  helperPath: string,
  newKeySha256: string,
  timeoutMs: number,
): Promise<DeviceCountersignatureResult | null> {
  let stdout: string;
  try {
    stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        helperPath,
        [], // no argv passed through - the digest travels on stdin only.
        {
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: 1 << 20,
          // Fixed cwd: nothing in this module resolves anything relative
          // to the invoking process's working directory, and the helper
          // should not inherit a CWD an attacker could have steered.
          cwd: path.parse(process.cwd()).root,
        },
        (err, stdoutResult) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(stdoutResult);
        },
      );
      child.stdin?.end(JSON.stringify({ new_key_sha256: newKeySha256 }));
    });
  } catch {
    return null; // absent, non-zero exit, timeout, or spawn failure.
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null; // unparseable stdout.
  }

  if (
    parsed !== null &&
    typeof parsed === "object" &&
    typeof (parsed as Record<string, unknown>).device_countersignature ===
      "string" &&
    typeof (parsed as Record<string, unknown>).device_public_key_pem ===
      "string"
  ) {
    const record = parsed as Record<string, string>;
    return {
      deviceCountersignature: record.device_countersignature,
      devicePublicKeyPem: record.device_public_key_pem,
    };
  }
  return null; // wrong shape.
}

export async function invokeDeviceSignHelper(
  newKeySha256: string,
  opts: DeviceSignInvokeOptions = {},
): Promise<DeviceCountersignatureResult | null> {
  const helperPath = opts.helperPath ?? DEVICE_SIGN_HELPER_PATH;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!isHelperPathTrusted(helperPath)) {
    return null;
  }

  return execDeviceSignHelperProcess(helperPath, newKeySha256, timeoutMs);
}
