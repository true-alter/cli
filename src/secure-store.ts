/**
 * OS-native secure credential store for the ALTER CLI.
 *
 * Provides a SYNCHRONOUS set/get/delete abstraction over OS credential stores.
 * Synchronous execution is required because all existing call sites in
 * signing.ts, auth.ts, and x25519.ts are synchronous - making them async
 * would cascade through the entire menu/command dispatch path.
 *
 * Shell-out via child_process.execFileSync is used throughout. Zero new
 * native/npm dependencies: only node:child_process, node:crypto, node:fs,
 * node:os, node:path.
 *
 * Backend selection (in priority order at module load):
 *   win32   → DPAPI (PowerShell ProtectedData, CurrentUser scope)
 *   darwin  → macOS Keychain (security(1) CLI, device-local)
 *   linux   → libsecret (secret-tool(1))
 *   any     → encrypted-file fallback (AES-256-GCM, node:crypto only)
 *
 * The fallback activates when the OS tool is absent (e.g. headless Linux
 * without a GNOME session) OR when ALTER_SECURE_STORE_BACKEND=file is set
 * (primarily for the test suite - tests MUST NOT write to the real OS store).
 *
 * Shell-injection prevention: all account names and values are passed via
 * execFileSync argument arrays or stdin - never string-interpolated into a
 * shell command line.
 *
 * Argv exposure: no secret is ever passed as a command-line argument. DPAPI
 * and libsecret take the value on stdin. security(1) on macOS has no stdin
 * path for a password at all, so that backend passes a rotatable wrapping key
 * on the command line instead and keeps the secret itself encrypted under it
 * in a 0600 file (see the darwin section).
 *
 * Path isolation:
 *   This module deliberately does NOT import from auth.ts. Both import each
 *   other in the final wiring (auth.ts imports secure-store.ts, signing.ts
 *   imports both), creating a circular dependency where static module-load
 *   order is undefined. Instead, all paths are derived at call-time by
 *   reading process.env.XDG_CONFIG_HOME, mirroring auth.ts:activeSessionFile()
 *   and ensuring test isolation when tests redirect XDG_CONFIG_HOME after
 *   module load.
 */

import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Path helpers - call-time, not module-load-time
// ---------------------------------------------------------------------------

/**
 * Resolve the ALTER config dir at call-time.
 * Tests redirect XDG_CONFIG_HOME after module load; this must re-read
 * the env var each call. Mirrors auth.ts:activeConfigDir().
 */
function activeAlterConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdg, "alter");
}

function activeDpapiDir(): string {
  return path.join(activeAlterConfigDir(), "dpapi");
}

function activeEncDir(): string {
  return path.join(activeAlterConfigDir(), "enc");
}

function activeKeyfile(): string {
  return path.join(activeAlterConfigDir(), "enc-keyfile");
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface SecureStore {
  setSecret(account: string, value: string): void;
  getSecret(account: string): string | null;
  deleteSecret(account: string): void;
  backendName(): string;
}

// ---------------------------------------------------------------------------
// Helpers shared across backends
// ---------------------------------------------------------------------------

/**
 * Crash-safe file write: temp + fsync + atomic rename.
 * Mirrors the pattern in auth.ts:atomicWriteFileSync - do NOT import that
 * private function directly; keep this module self-contained.
 */
function atomicWriteFile(file: string, data: Buffer | string): void {
  const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
  const tmp = `${file}.tmp.${process.pid}.${crypto
    .randomBytes(6)
    .toString("hex")}`;
  try {
    fs.writeFileSync(tmp, buf, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    const fd = fs.openSync(tmp, "r+");
    try {
      fs.fsyncSync(fd);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (
        process.platform === "win32" &&
        (code === "EPERM" || code === "EACCES")
      ) {
        // Windows FlushFileBuffers may be blocked by AV/AppLocker;
        // the atomic rename still provides consistency.
      } else {
        throw err;
      }
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // orphan .tmp is harmless
    }
    throw err;
  }
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Securely remove a plaintext secret file: best-effort zero-overwrite of the
 * current contents, fsync, then unlink. Used by the legacy-plaintext
 * migration and residue-sweep paths so a removed
 * private key is not trivially recoverable from the file's old blocks.
 *
 * LIMITATION: on copy-on-write filesystems (btrfs, ZFS, APFS), journaling
 * filesystems, and SSDs with wear-levelling, the overwrite lands on NEW
 * blocks while the original ciphertext-free plaintext may persist in old
 * blocks, snapshots, or the journal. The overwrite is best-effort hygiene,
 * not a guarantee; the real control is that the secret now lives encrypted
 * in the OS store. Throws only when the final unlink fails - overwrite
 * failures are swallowed so removal still proceeds.
 */
export function secureUnlinkSync(filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    if (stat.isFile() && stat.size > 0) {
      const fd = fs.openSync(filePath, "r+");
      try {
        fs.writeSync(fd, Buffer.alloc(stat.size), 0, stat.size, 0);
        try {
          fs.fsyncSync(fd);
        } catch {
          // Windows FlushFileBuffers may be blocked by AV/AppLocker;
          // proceed to unlink regardless.
        }
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    // Overwrite is best-effort: a read-only file or race still gets unlinked.
  }
  fs.unlinkSync(filePath);
}

// ---------------------------------------------------------------------------
// Backend: DPAPI (win32)
// ---------------------------------------------------------------------------
//
// ProtectedData.Protect with CurrentUser scope ties the ciphertext to both
// the Windows user account AND the device (the DPAPI master key is derived
// from the user's login credential + machine secret). A stolen ciphertext
// blob cannot be decrypted on a different machine.
//
// Secrets are never passed as argv (argv is visible in `ps` / Task Manager).
// The plaintext is written to PowerShell's stdin pipe; the Base64 ciphertext
// is collected from stdout.

function dpapiFilePath(account: string): string {
  // Sanitise account to a safe filename component - no shell injection.
  const safe = account.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(activeDpapiDir(), `${safe}.enc`);
}

function dpapiSet(account: string, value: string): void {
  ensureDir(activeDpapiDir());
  // Pass plaintext via stdin so the value is never visible in the process
  // argument list. Read it with [Console]::In.ReadToEnd(), NOT $input:
  // $input enumerates stdin line-by-line and PowerShell's binder joins the
  // lines with spaces when coercing to string, corrupting multi-line blobs
  // (and $input is single-use). Add-Type is required on Windows PowerShell
  // 5.1 (.NET Framework) where ProtectedData does not auto-load; without it
  // every write fails with TypeNotFound (found live on Win11, 2026-06-07).
  const ps = `
Add-Type -AssemblyName System.Security
$raw = [Console]::In.ReadToEnd()
$bytes = [System.Text.Encoding]::UTF8.GetBytes($raw)
$enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($enc)
`.trim();
  let result: string;
  try {
    result = childProcess.execFileSync(
      "powershell",
      ["-NonInteractive", "-NoProfile", "-Command", ps],
      { input: value, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 10000 },
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") {
      throw new Error("dpapi write timed out (keychain may be locked or PowerShell frozen)");
    }
    throw new Error("dpapi write failed (code " + ((err as NodeJS.ErrnoException & { status?: number }).status ?? "unknown") + ")");
  }
  atomicWriteFile(dpapiFilePath(account), result.trim());
}

function dpapiGet(account: string): string | null {
  const file = dpapiFilePath(account);
  if (!fs.existsSync(file)) return null;
  const b64 = fs.readFileSync(file, "utf-8").trim();
  // The decrypted plaintext leaves PowerShell base64-encoded: Write-Output
  // appends a newline of its own, so emitting the raw string makes a
  // blob-final "\n" indistinguishable from the shell's - and trimEnd()
  // would eat both, breaking the migration's exact-match confirm. Base64
  // sidesteps newline and console-codepage ambiguity entirely.
  const ps = `
Add-Type -AssemblyName System.Security
$b64 = [Console]::In.ReadToEnd().Trim()
$enc = [Convert]::FromBase64String($b64)
$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($dec)
`.trim();
  try {
    const result = childProcess.execFileSync(
      "powershell",
      ["-NonInteractive", "-NoProfile", "-Command", ps],
      { input: b64, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 10000 },
    );
    // Decode the base64 the script emitted - trim only strips the shell's
    // trailing newline around the base64 token, never plaintext bytes.
    return Buffer.from(result.trim(), "base64").toString("utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") {
      throw new Error("dpapi read timed out (keychain may be locked or PowerShell frozen)");
    }
    throw new Error("dpapi read failed (code " + ((err as NodeJS.ErrnoException & { status?: number }).status ?? "unknown") + ")");
  }
}

function dpapiDelete(account: string): void {
  const file = dpapiFilePath(account);
  try {
    fs.unlinkSync(file);
  } catch {
    // not present - noop
  }
}
// Note: dpapiDelete has no OS shell-out; it only touches the local .enc file,
// so no timeout is needed here.

// The DPAPI backend is guarded on the same terms as the two true keyrings, even
// though it is the least exposed of the three: it encrypts to a file UNDER the
// config dir, so a runner that redirects XDG_CONFIG_HOME already contains it,
// where libsecret (a D-Bus service) and the macOS Keychain (a system store)
// escape any such sandbox. Guarding it anyway costs nothing and closes the case
// of a runner that sandboxes nothing at all. Note for the record: on Windows
// this CLI does NOT use the Credential Manager; DPAPI-to-file is the Windows
// backend, so there is no Windows credential-store write to refuse.
const dpapiBackend: SecureStore = {
  setSecret: (account, value) => {
    guardKeyringOp("write", "dpapi-file");
    dpapiSet(account, value);
  },
  getSecret: (account) => {
    guardKeyringOp("read", "dpapi-file");
    return dpapiGet(account);
  },
  deleteSecret: (account) => {
    guardKeyringOp("delete", "dpapi-file");
    dpapiDelete(account);
  },
  backendName: () => "dpapi-file",
};

// ---------------------------------------------------------------------------
// Backend: macOS Keychain (darwin)
// ---------------------------------------------------------------------------
//
// Uses /usr/bin/security (bundled with macOS). Keychain items are stored in
// the user's default (login) keychain, which is device-local and NOT synced
// to iCloud by default.
//
// WHAT REACHES THE COMMAND LINE, AND WHY IT IS NOT THE SECRET.
//
// `security add-generic-password` takes the password as `-w <value>` and
// offers no stdin path for it. Whatever is handed to it is therefore visible
// in the process argument list for the duration of the call, to every process
// running as the same user, with no prompt of any kind. Reading the keychain
// ITEM raises a user-visible consent prompt; reading the process table does
// not, so the two are not equivalent exposures and cannot be traded for one
// another.
//
// So the secret does not go there. Every write mints a fresh 32-byte wrapping
// key from the CSPRNG, stores THAT key in the keychain, and writes the secret
// encrypted under it (AES-256-GCM, fresh 12-byte nonce per write) into a 0600
// file in the config dir. Only the wrapping key transits argv, and a wrapping
// key is reissuable: the most an argv observer gains is a key the next write
// replaces, and which decrypts nothing on its own without also reading a file
// that only the owning user can open. Material that cannot be reissued by
// anyone, a seed no server holds and no flow can mint again, never reaches the
// argument list at all.
//
// The keychain still supplies exactly what it is good at: at-rest encryption,
// device binding, and the consent prompt on access. It now protects a
// rotatable key rather than the irreplaceable material itself.
//
// The `-U` flag (update-or-create) keeps each keychain write idempotent.

/** Service name under which every keychain item this CLI owns is filed. */
const KEYCHAIN_SERVICE = "alter-cli";

/**
 * The one call shape this backend needs from execFileSync. Narrow on purpose:
 * the unit tests supply their own, so the argv a real `security` invocation
 * would receive can be asserted on without spawning anything.
 */
export type SecurityExecFn = (
  file: string,
  args: readonly string[],
  options: childProcess.ExecFileSyncOptions,
) => Buffer | string;

const defaultSecurityExec: SecurityExecFn = childProcess.execFileSync;

/** Wrapped-secret file header: magic, key id, nonce, auth tag, then ciphertext. */
const WRAP_MAGIC = Buffer.from("AWK1", "ascii");
const WRAP_KEY_ID_BYTES = 8;
const WRAP_IV_BYTES = 12;
const WRAP_TAG_BYTES = 16;
const WRAP_KEY_BYTES = 32;
const WRAP_HEADER_BYTES =
  WRAP_MAGIC.length + WRAP_KEY_ID_BYTES + WRAP_IV_BYTES + WRAP_TAG_BYTES;

function activeWrappedDir(): string {
  return path.join(activeAlterConfigDir(), "wrapped");
}

function wrappedFilePath(account: string): string {
  // Sanitise account to a safe filename component - no shell injection.
  const safe = account.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(activeWrappedDir(), `${safe}.bin`);
}

/**
 * Keychain account name holding the wrapping key for one generation of one
 * secret. The key id is part of the name so a write can install the NEW key
 * before retiring the old one, instead of overwriting a key the file on disk
 * still depends on.
 */
function wrapKeyAccount(account: string, keyId: string): string {
  return `${account}.wrap.${keyId}`;
}

/** Key id (hex) of the wrapped file currently on disk, or null when there is none. */
function currentWrapKeyId(account: string): string | null {
  let blob: Buffer;
  try {
    blob = fs.readFileSync(wrappedFilePath(account));
  } catch {
    return null;
  }
  if (blob.length < WRAP_HEADER_BYTES) return null;
  if (!blob.subarray(0, WRAP_MAGIC.length).equals(WRAP_MAGIC)) return null;
  return blob
    .subarray(WRAP_MAGIC.length, WRAP_MAGIC.length + WRAP_KEY_ID_BYTES)
    .toString("hex");
}

/** Store one value in the keychain under `account`. Only ever a wrapping key. */
function keychainPut(account: string, value: string, exec: SecurityExecFn): void {
  try {
    exec(
      "/usr/bin/security",
      [
        "add-generic-password",
        "-U",                    // update if already present (idempotent)
        "-s", KEYCHAIN_SERVICE,  // service name
        "-a", account,           // account name (arg array - no shell interpolation)
        "-w", value,             // wrapping key, never the secret it wraps
      ],
      { stdio: ["ignore", "ignore", "pipe"], timeout: 10000 },
    );
  } catch (err) {
    // Rethrow WITHOUT propagating the raw error: the wrapping key is in argv
    // for this call and the raw error may echo the command line in .message
    // or stderr. Emit a generic message carrying only the exit code.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") {
      throw new Error("keychain write timed out (keychain may be locked or dialog waiting)");
    }
    throw new Error("keychain write failed (code " + ((err as NodeJS.ErrnoException & { status?: number }).status ?? "unknown") + ")");
  }
}

/** Read one keychain value, or null when the item is absent. */
function keychainFetch(account: string, exec: SecurityExecFn): string | null {
  try {
    const result = exec(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-s", KEYCHAIN_SERVICE,
        "-a", account,
        "-w",  // output only the password
      ],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 },
    );
    const text = typeof result === "string" ? result : result.toString("utf-8");
    return text.trimEnd();
  } catch (err) {
    // Item not found (exit code 44) or any other error → null. Callers treat
    // null as "not present" and fall through to the encrypted-file backend.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") {
      throw new Error("keychain read timed out (keychain may be locked or dialog waiting)");
    }
    return null;
  }
}

/** Remove one keychain item. Best-effort: absence is the desired end state. */
function keychainDrop(account: string, exec: SecurityExecFn): void {
  try {
    exec(
      "/usr/bin/security",
      [
        "delete-generic-password",
        "-s", KEYCHAIN_SERVICE,
        "-a", account,
      ],
      { stdio: ["ignore", "ignore", "pipe"], timeout: 10000 },
    );
  } catch {
    // Not present or timed out - noop (delete is best-effort)
  }
}

function keychainSet(
  account: string,
  value: string,
  exec: SecurityExecFn = defaultSecurityExec,
): void {
  const previousKeyId = currentWrapKeyId(account);
  const keyId = crypto.randomBytes(WRAP_KEY_ID_BYTES);
  const key = crypto.randomBytes(WRAP_KEY_BYTES);
  const iv = crypto.randomBytes(WRAP_IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([
    cipher.update(Buffer.from(value, "utf-8")),
    cipher.final(),
  ]);
  const blob = Buffer.concat([WRAP_MAGIC, keyId, iv, cipher.getAuthTag(), ct]);

  // Order matters, and it is what makes a crash here non-destructive. The new
  // wrapping key is filed under its OWN key id, so the file already on disk
  // keeps decrypting under the old key right up until the atomic rename
  // replaces it. Every intermediate state holds one complete pair, never a
  // file whose key has already been overwritten.
  ensureDir(activeWrappedDir());
  keychainPut(wrapKeyAccount(account, keyId.toString("hex")), key.toString("base64"), exec);
  atomicWriteFile(wrappedFilePath(account), blob);

  // The superseded wrapping key now protects nothing, and dropping it is what
  // makes this a rotation rather than a growing pile of live keys.
  if (previousKeyId !== null) {
    keychainDrop(wrapKeyAccount(account, previousKeyId), exec);
  }
  // An install that predates wrapping stored the secret itself under `account`.
  // The wrapped copy is durable by this point, so that copy goes. Unconditional
  // rather than first-write-only: a version downgrade and re-upgrade can put a
  // direct copy back, and one extra call on a path that runs at login or key
  // rotation costs nothing measurable.
  keychainDrop(account, exec);
}

function keychainGet(
  account: string,
  exec: SecurityExecFn = defaultSecurityExec,
): string | null {
  let blob: Buffer;
  try {
    blob = fs.readFileSync(wrappedFilePath(account));
  } catch {
    // No wrapped file. An install that predates wrapping stored the secret
    // directly in the keychain, so read it there, re-wrap it, and let
    // keychainSet drop the direct copy. An upgrade must never look to the
    // member like a lost credential.
    const legacy = keychainFetch(account, exec);
    if (legacy === null) return null;
    try {
      keychainSet(account, legacy, exec);
    } catch {
      // The value is returned either way; a locked keychain or an unwritable
      // config dir defers the migration to the next read or write.
    }
    return legacy;
  }

  if (blob.length < WRAP_HEADER_BYTES) return null;
  if (!blob.subarray(0, WRAP_MAGIC.length).equals(WRAP_MAGIC)) return null;

  let offset = WRAP_MAGIC.length;
  const keyId = blob.subarray(offset, offset + WRAP_KEY_ID_BYTES).toString("hex");
  offset += WRAP_KEY_ID_BYTES;
  const iv = blob.subarray(offset, offset + WRAP_IV_BYTES);
  offset += WRAP_IV_BYTES;
  const tag = blob.subarray(offset, offset + WRAP_TAG_BYTES);
  offset += WRAP_TAG_BYTES;
  const ct = blob.subarray(offset);

  const keyB64 = keychainFetch(wrapKeyAccount(account, keyId), exec);
  if (keyB64 === null) return null;
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== WRAP_KEY_BYTES) return null;

  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf-8");
  } catch {
    // Corrupt ciphertext, a failed auth-tag check, or a key that no longer
    // matches the blob it encrypted.
    return null;
  }
}

function keychainDelete(
  account: string,
  exec: SecurityExecFn = defaultSecurityExec,
): void {
  // The wrapping key goes FIRST. Once it is gone the file on disk is no longer
  // a secret at all, so a failure to remove the file leaves ciphertext nobody
  // can open rather than a recoverable remnant.
  const keyId = currentWrapKeyId(account);
  if (keyId !== null) keychainDrop(wrapKeyAccount(account, keyId), exec);
  // An install that predates wrapping stored the secret itself under `account`.
  keychainDrop(account, exec);
  try {
    secureUnlinkSync(wrappedFilePath(account));
  } catch {
    // Already absent, or unremovable. Either way the key is destroyed and
    // delete is best-effort, matching the other backends.
  }
}

const keychainBackend: SecureStore = {
  setSecret: (account, value) => {
    guardKeyringOp("write", "macos-keychain");
    keychainSet(account, value);
  },
  getSecret: (account) => {
    guardKeyringOp("read", "macos-keychain");
    return keychainGet(account);
  },
  deleteSecret: (account) => {
    guardKeyringOp("delete", "macos-keychain");
    keychainDelete(account);
  },
  backendName: () => "macos-keychain",
};

// ---------------------------------------------------------------------------
// Backend: libsecret / secret-tool (linux)
// ---------------------------------------------------------------------------
//
// `secret-tool store` reads the secret value from STDIN - no argv exposure.
// The item is keyed by two attributes: service=alter-cli, account=<account>.

function secretToolSet(account: string, value: string): void {
  // stdin is the secret value - no argv exposure.
  try {
    childProcess.execFileSync(
      "secret-tool",
      [
        "store",
        "--label=alter-cli",
        "service", "alter-cli",
        "account", account,
      ],
      { input: value, encoding: "utf-8", stdio: ["pipe", "ignore", "pipe"], timeout: 10000 },
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") {
      throw new Error("secret-tool write timed out (GNOME keyring may be locked or D-Bus frozen)");
    }
    throw new Error("secret-tool write failed (code " + ((err as NodeJS.ErrnoException & { status?: number }).status ?? "unknown") + ")");
  }
}

function secretToolGet(account: string): string | null {
  try {
    const result = childProcess.execFileSync(
      "secret-tool",
      [
        "lookup",
        "service", "alter-cli",
        "account", account,
      ],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 },
    );
    return result.trimEnd();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") {
      throw new Error("secret-tool read timed out (GNOME keyring may be locked or D-Bus frozen)");
    }
    return null;
  }
}

function secretToolDelete(account: string): void {
  try {
    childProcess.execFileSync(
      "secret-tool",
      [
        "clear",
        "service", "alter-cli",
        "account", account,
      ],
      { stdio: ["ignore", "ignore", "pipe"], timeout: 10000 },
    );
  } catch {
    // Not present or timed out - noop (delete is best-effort)
  }
}

const secretToolBackend: SecureStore = {
  setSecret: (account, value) => {
    guardKeyringOp("write", "libsecret");
    secretToolSet(account, value);
  },
  getSecret: (account) => {
    guardKeyringOp("read", "libsecret");
    return secretToolGet(account);
  },
  deleteSecret: (account) => {
    guardKeyringOp("delete", "libsecret");
    secretToolDelete(account);
  },
  backendName: () => "libsecret",
};

// ---------------------------------------------------------------------------
// Backend: encrypted-file fallback (any platform, tool absent / test mode)
// ---------------------------------------------------------------------------
//
// Threat model:
//   Encryption: AES-256-GCM with a per-install random 32-byte key stored in
//   a separate keyfile (activeKeyfile(), mode 0o600). Both the ciphertext and
//   the keyfile live under the config dir; an attacker who reads EITHER in
//   isolation cannot decrypt. Unlike the OS native stores, there is no device
//   binding - a backup that includes both the keyfile and the enc/ directory
//   exposes all secrets. This fallback is weaker than OS native stores but
//   strictly stronger than bare plaintext. It is used only when no OS-native
//   tool is available.
//
//   Each secret is stored as: [12-byte IV][16-byte auth-tag][ciphertext].
//   All in a binary file under activeEncDir()/<account>.bin.

function encFilePath(account: string): string {
  const safe = account.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(activeEncDir(), `${safe}.bin`);
}

/**
 * Cheap, spawn-free on-disk signature of a secret, for in-process read
 * memoisation. Stats the encrypted-file mirror, which `setSecretWriteThrough`
 * writes on every persist even when the OS-native store (DPAPI / Keychain /
 * libsecret) is the primary backend - so a fresh login, a token rotation (this
 * or a sibling process), or a logout all change it. The path is part of the
 * signature, so a config-dir swap (`XDG_CONFIG_HOME` redirection in tests)
 * also changes it. Statting is microseconds and never spawns PowerShell, so a
 * caller can guard a memo with this and skip the expensive store decrypt while
 * the on-disk state is unchanged. Returns a sentinel when the mirror is absent.
 */
export function secretFreshnessSig(account: string): string {
  const p = encFilePath(account);
  try {
    const st = fs.statSync(p);
    return `${p}:${st.mtimeMs}:${st.size}`;
  } catch {
    return `${p}:absent`;
  }
}

function loadOrCreateEncKey(): Buffer {
  const keyfile = activeKeyfile();
  try {
    const existing = fs.readFileSync(keyfile);
    if (existing.length === 32) return existing;
  } catch {
    // First use
  }
  ensureDir(activeAlterConfigDir());
  const key = crypto.randomBytes(32);
  atomicWriteFile(keyfile, key);
  return key;
}

function encSet(account: string, value: string): void {
  ensureDir(activeEncDir());
  const key = loadOrCreateEncKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([
    cipher.update(Buffer.from(value, "utf-8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag(); // 16 bytes
  const blob = Buffer.concat([iv, tag, ct]); // [12][16][...]
  atomicWriteFile(encFilePath(account), blob);
}

/**
 * Why an encrypted-file read returned no secret, when the reason was NOT a
 * plain absence.
 *
 * A `null` from getSecret() has always meant two very different things: nothing
 * is stored (the ordinary logged-out case), or something IS stored and could
 * not be read back. Those states have different remedies and collapsing them is
 * what made a corrupted credential indistinguishable from never having logged
 * in - including at `doctor`, which then asserted "no session in the secure
 * store" about a store that demonstrably held one.
 *
 * This channel records the second case so a caller that cares (the session
 * layer, and through it `doctor`) can tell the two apart. A read that finds
 * nothing records no fault, because absence is not a fault.
 */
export type SecretReadFault = {
  account: string;
  reason: "unreadable" | "truncated" | "undecryptable";
  detail: string;
};

let _lastSecretFault: SecretReadFault | null = null;

/**
 * The fault recorded by the most recent encrypted-file read, or null when that
 * read found nothing on disk (a genuine absence). Every read clears this first,
 * so it can never report a stale fault from an earlier read of another account.
 */
export function lastSecretReadFault(): SecretReadFault | null {
  return _lastSecretFault;
}

/**
 * One stderr notice per distinct fault. An unreadable credential is worth
 * saying out loud once - the silence was the defect - but getSecret() is called
 * repeatedly within a command, so an unguarded write would bury the message in
 * its own repetitions. Mirrors noticeKeyringDowngrade's one-shot idiom.
 *
 * The notice states WHAT is wrong and stops there; the remedy belongs to the
 * layer that knows what the account is for (a session is re-established by
 * `alter login`, a signing key is not).
 */
const _faultNoticed = new Set<string>();
function noticeSecretFault(fault: SecretReadFault): void {
  const key = `${fault.account}:${fault.reason}`;
  if (_faultNoticed.has(key)) return;
  _faultNoticed.add(key);
  process.stderr.write(
    `alter: WARNING: the stored '${fault.account}' credential is present but unreadable: ${fault.detail}.\n`,
  );
}

function encGet(account: string): string | null {
  _lastSecretFault = null;
  const file = encFilePath(account);
  let blob: Buffer;
  try {
    blob = fs.readFileSync(file);
  } catch (err) {
    // ENOENT is a true absence: nothing was ever written, or logout removed it.
    // Any other errno (EACCES, EISDIR, EIO) means a credential may well be
    // sitting there and we simply cannot see it. Reporting that as "not logged
    // in" sends the user to the wrong remedy, so it records a fault instead.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      _lastSecretFault = {
        account,
        reason: "unreadable",
        detail: `${file} could not be read (${code ?? "unknown error"})`,
      };
      noticeSecretFault(_lastSecretFault);
    }
    return null;
  }
  if (blob.length < 28) {
    // 12 IV + 16 tag minimum. A blob shorter than its own header is truncated
    // (a partial write, or a file clobbered by something else), never valid.
    _lastSecretFault = {
      account,
      reason: "truncated",
      detail: `${file} holds ${blob.length} bytes, short of the 28-byte minimum header`,
    };
    noticeSecretFault(_lastSecretFault);
    return null;
  }
  const key = loadOrCreateEncKey();
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString("utf-8");
  } catch {
    // Decryption failure: corrupt ciphertext, a failed auth-tag check, or a
    // keyfile that no longer matches the blob it encrypted.
    _lastSecretFault = {
      account,
      reason: "undecryptable",
      detail: `${file} did not decrypt (corrupt ciphertext, or it was written with a different key)`,
    };
    noticeSecretFault(_lastSecretFault);
    return null;
  }
}

function encDelete(account: string): void {
  try {
    fs.unlinkSync(encFilePath(account));
  } catch (err) {
    // ENOENT = already absent, which IS the desired end-state - treat as
    // success. Any other error (EACCES/EPERM/EBUSY/EROFS) means the file may
    // SURVIVE on disk; for a logout wipe a surviving credential copy is a real
    // failure, so propagate it instead of swallowing. The write-through
    // verifier turns this into a loud, non-zero logout.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

const encFileBackend: SecureStore = {
  setSecret: encSet,
  getSecret: encGet,
  deleteSecret: encDelete,
  backendName: () => "encrypted-file",
};

// ---------------------------------------------------------------------------
// Availability probes
// ---------------------------------------------------------------------------

function probeWin32(): boolean {
  if (process.platform !== "win32") return false;
  // B2 fix: no-spawn probe. Check well-known PowerShell locations via
  // fs.existsSync instead of execFileSync so this runs at zero cost.
  // PowerShell 5.1 (Windows built-in) lives at a fixed system32 path;
  // PowerShell 7+ at Program Files. Either is sufficient for the DPAPI
  // backend. If neither exists fall back to encrypted-file.
  const psSystemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const ps51 = `${psSystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const ps7 = `${process.env.ProgramFiles ?? "C:\\Program Files"}\\PowerShell\\7\\pwsh.exe`;
  return fs.existsSync(ps51) || fs.existsSync(ps7);
}

function probeDarwin(): boolean {
  if (process.platform !== "darwin") return false;
  return fs.existsSync("/usr/bin/security");
}

function probeLinux(): boolean {
  // Two-step probe for headless/CI/SSH/WSL safety:
  //
  // Step 1: Fast check that a D-Bus session bus is declared. Without a session
  // bus, libsecret falls back to the system bus or errors - this catches
  // containers, CI, and SSH sessions that have secret-tool on PATH but no
  // running keyring.
  if (!process.env.DBUS_SESSION_BUS_ADDRESS) return false;

  // Step 2: Confirm the keyring is actually reachable. A "not found" (non-zero
  // exit) from `secret-tool lookup` on a probe key means the D-Bus session is
  // live and the keyring daemon is responding - we just got a clean miss.
  // An error/timeout means D-Bus is present but broken (e.g. no keyring daemon
  // running, permissions failure, unlocked session not available) - fall back.
  //
  // Using lookup (not store) so we never write a persistent probe entry.
  try {
    childProcess.execFileSync(
      "secret-tool",
      ["lookup", "service", "alter-cli-probe", "account", "__probe__"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 3000 },
    );
    // Exit 0 means a stale probe entry exists - keyring is reachable.
    return true;
  } catch (err) {
    // Exit non-zero (ENOENT/"not found") means keyring is reachable but the key
    // doesn't exist - this is the expected success path on a clean machine.
    // ETIMEDOUT or a spawn error means the keyring is broken - fall back.
    const e = err as NodeJS.ErrnoException & { status?: number };
    if (e.code === "ETIMEDOUT") return false;
    // secret-tool exits 1 when the lookup key is not found - that's fine.
    if (typeof e.status === "number" && e.status !== 0 && e.code !== "ETIMEDOUT") return true;
    return false;
  }
}

// ---------------------------------------------------------------------------
// Backend selection (lazy, first-use)
//
// B2 fix: selectBackend() used to run at module load, which caused
// probeWin32() to spawn PowerShell synchronously on every command invocation
// on Windows (0.5-3s cold-start penalty). Backend selection is now deferred
// to the first actual get/set/delete call so importing this module is
// spawn-free. The probeWin32 no-spawn path checks a known PowerShell
// location via fs.existsSync instead of execFileSync.
// ---------------------------------------------------------------------------

let _resolvedBackend: SecureStore | null = null;

/**
 * Has a real end-user entrypoint affirmed this process?
 *
 * See {@link keyringPermitted}. `affirmKeyringRuntime()` is called by the CLI
 * bin (src/index.ts) once it knows it IS the process entrypoint, i.e. the user
 * literally ran `alter`. Nothing else calls it, so nothing else gets the OS
 * keyring by default.
 */
let _keyringRuntimeAffirmed = false;

/**
 * Affirm that this process is a real `alter` CLI run and may therefore use the
 * OS keyring. Called from the CLI bin's entrypoint guard, before any command
 * dispatch and therefore before any secure-store operation.
 *
 * This is the ONLY in-process way to open the keyring path. It is deliberately
 * not exported from the package's public surface for library consumers: an
 * embedder that genuinely wants the keyring sets
 * ALTER_SECURE_STORE_ALLOW_KEYRING=1, which is visible in the environment and
 * therefore auditable.
 */
export function affirmKeyringRuntime(): void {
  _keyringRuntimeAffirmed = true;
}

/**
 * Every environment variable that says "a test runner is driving this process".
 *
 * Returns the NAME of the signal that fired (for the refusal message), or null.
 *
 * This list is a courtesy, not the guard. The guard is {@link keyringPermitted},
 * which is default-CLOSED: a runner absent from this list still cannot reach
 * the keyring, because it will not have affirmed the runtime either. That
 * ordering matters. The previous guard enumerated the runners it knew
 * (NODE_TEST_CONTEXT, i.e. `node --test`) and was then defeated by vitest,
 * which nobody had added to the list. Enumeration is what failed; enumeration
 * is therefore no longer what protects us.
 */
function testEnvSignal(): string | null {
  const env = process.env;
  if (env.NODE_TEST_CONTEXT) return "NODE_TEST_CONTEXT";
  if (env.VITEST) return "VITEST";
  if (env.VITEST_POOL_ID) return "VITEST_POOL_ID";
  if (env.VITEST_WORKER_ID) return "VITEST_WORKER_ID";
  if (env.JEST_WORKER_ID) return "JEST_WORKER_ID";
  if (env.BUN_TEST) return "BUN_TEST";
  if (env.TAP) return "TAP";
  if (env.NODE_ENV === "test") return "NODE_ENV=test";
  const lifecycle = env.npm_lifecycle_event ?? "";
  if (lifecycle === "test" || lifecycle.startsWith("test:")) {
    return "npm_lifecycle_event=" + lifecycle;
  }
  return null;
}

/**
 * Test-runner globals injected into the module scope by the runner itself.
 * Catches a runner that sets no environment variable we know about but does
 * inject the usual BDD surface (vitest with globals:true, jest, mocha, jasmine,
 * bun test).
 */
function testGlobalSignal(): string | null {
  const g = globalThis as Record<string, unknown>;
  if (g.__vitest_worker__ !== undefined) return "globalThis.__vitest_worker__";
  if (g.jest !== undefined) return "globalThis.jest";
  if (g.__coverage__ !== undefined) return "globalThis.__coverage__";
  if (typeof g.describe === "function" && typeof g.it === "function") {
    return "globalThis.describe/it";
  }
  if (typeof g.expect === "function" && typeof g.beforeEach === "function") {
    return "globalThis.expect/beforeEach";
  }
  return null;
}

/**
 * Was this process STARTED by a test runner? `node --test` puts `--test` in
 * execArgv; every other runner is its own bin, so its name lands in argv[1].
 */
function testArgvSignal(): string | null {
  if (process.execArgv.some((a) => a === "--test" || a.startsWith("--test-"))) {
    return "node --test (execArgv)";
  }
  const entry = (process.argv[1] ?? "").replace(/\\/g, "/").toLowerCase();
  const base = entry.slice(entry.lastIndexOf("/") + 1).replace(/\.(c|m)?js$/, "");
  if (
    base === "vitest" ||
    base === "jest" ||
    base === "mocha" ||
    base === "ava" ||
    base === "tap" ||
    base === "jasmine" ||
    base === "karma" ||
    base === "cypress" ||
    base === "playwright"
  ) {
    return "test-runner entrypoint (" + base + ")";
  }
  return null;
}

/** First test signal that fires across env, injected globals, and argv. */
function testSignal(): string | null {
  return testEnvSignal() ?? testGlobalSignal() ?? testArgvSignal();
}

/**
 * May this process touch the OS keyring at all?
 *
 * DEFAULT-CLOSED. The keyring is opt-IN, and the ONLY things that opt in are:
 *
 *   1. ALTER_SECURE_STORE_INTEGRATION=1 - the explicitly-gated integration
 *      tests, which exist precisely to exercise the real OS store. This is the
 *      one sanctioned way a test may reach it, and it must be set deliberately.
 *   2. The `alter` CLI bin, which calls affirmKeyringRuntime() once it knows a
 *      human ran it (src/index.ts, isProcessEntrypoint()).
 *   3. ALTER_SECURE_STORE_ALLOW_KEYRING=1 - the escape hatch for a legitimate
 *      embedder that imports this package as a library and wants the keyring.
 *
 * EVERYTHING ELSE GETS THE ENCRYPTED-FILE BACKEND. That is the whole point.
 *
 * The previous guard asked "am I under test?" and reached for the keyring when
 * the answer was no. That is open-by-default, so every runner it failed to
 * recognise (vitest) walked straight through and overwrote the developer's live
 * session; the incident log in ~/.config/alter/quarantine-residue/ records
 * three separate clobbers on that design. This guard asks the opposite
 * question: "has anything affirmed that a human is running the CLI?" An unknown
 * future test runner does not affirm, because only the CLI bin affirms, so it
 * is refused WITHOUT ever having to be recognised. Detection (testSignal) is
 * now belt-and-braces: it sharpens the refusal message and it fails closed on
 * its own, but the safety no longer depends on it.
 *
 * The trade is deliberate and the costs are wildly asymmetric. A false positive
 * (refusing the keyring to a real user) sends them to the encrypted-file
 * backend, which is AES-256-GCM, fully supported, and never weaker than the
 * keyring, and it announces itself on stderr with the variable that reopens the
 * keyring. A false negative destroys the credential, including the long-lived
 * member_api_key the backend mints exactly once and never re-issues.
 *
 * Returns null when the keyring is permitted, or the reason it is refused.
 */
function keyringRefusalReason(): string | null {
  const env = process.env;

  // (1) The sanctioned integration-test opt-in. Deliberate, explicit, and the
  // only path by which a test is allowed to touch the live OS store.
  if (env.ALTER_SECURE_STORE_INTEGRATION === "1") return null;

  // (2) Any test signal we DO recognise. Redundant with the default-closed
  // posture below (a test runner never affirms), but it produces a precise
  // message and it holds even if a future entrypoint affirms too eagerly.
  const signal = testSignal();
  if (signal !== null) {
    return "a test runner is driving this process (" + signal + ")";
  }

  // (3) The embedder escape hatch.
  if (env.ALTER_SECURE_STORE_ALLOW_KEYRING === "1") return null;

  // (4) The affirmed CLI bin.
  if (_keyringRuntimeAffirmed) return null;

  // (5) DEFAULT: CLOSED.
  return (
    "no entrypoint affirmed this process as a real `alter` run, so the OS " +
    "keyring is closed to it (set ALTER_SECURE_STORE_ALLOW_KEYRING=1 to open " +
    "it for an embedder)"
  );
}

/**
 * Thrown when something reaches an OS-native keyring operation that is not
 * permitted to touch it. Loud on purpose: a test that somehow arrives at the
 * keyring write path must ERROR, never silently succeed against the real
 * credential.
 */
export class KeyringRefusedError extends Error {
  constructor(op: string, backend: string, reason: string) {
    super(
      "refusing to " + op + " the OS keyring (" + backend + "): " + reason +
        ". The encrypted-file backend is the safe path here; reaching this " +
        "error means the keyring backend was obtained directly, bypassing " +
        "selectBackend().",
    );
    this.name = "KeyringRefusedError";
  }
}

/**
 * Fail-closed backstop on the OS-native backends themselves.
 *
 * selectBackend() already routes an unaffirmed process to the encrypted-file
 * backend, so in the normal flow this never fires. It exists for the paths that
 * hold an OS backend DIRECTLY and never asked selectBackend(): _resolveOsBackend(),
 * a test that imports a backend object, a future refactor that reintroduces the
 * old module-load resolution. Guarding the backend and not only the selector is
 * what makes this a property of the store rather than a property of one
 * function that a later change can quietly route around.
 */
function guardKeyringOp(op: string, backend: string): void {
  const reason = keyringRefusalReason();
  if (reason !== null) throw new KeyringRefusedError(op, backend, reason);
}

/** One-shot stderr notice when a real (non-test) run is denied the keyring. */
let _refusalNoticeEmitted = false;
function noticeKeyringDowngrade(reason: string): void {
  if (_refusalNoticeEmitted) return;
  _refusalNoticeEmitted = true;
  // Silent under test: the suite denies itself the keyring by design and does
  // not need telling. Loud everywhere else, because a real user losing the
  // keyring is exactly the false positive this guard trades for, and it must be
  // visible and recoverable rather than silent.
  if (testSignal() !== null) return;
  process.stderr.write(
    "alter: using the encrypted-file credential store, not the OS keyring: " +
      reason +
      ".\n",
  );
}

function selectBackend(): SecureStore {
  if (_resolvedBackend !== null) return _resolvedBackend;

  // Explicit pin. run-tests.mjs sets this for the whole suite; users may too.
  if (process.env.ALTER_SECURE_STORE_BACKEND === "file") {
    _resolvedBackend = encFileBackend;
    return _resolvedBackend;
  }

  // Default-closed keyring posture (see keyringRefusalReason). An unaffirmed
  // process, which is every test runner including the ones nobody has invented
  // yet, gets the encrypted-file backend and never sees the keyring.
  const refusal = keyringRefusalReason();
  if (refusal !== null) {
    noticeKeyringDowngrade(refusal);
    _resolvedBackend = encFileBackend;
    return _resolvedBackend;
  }

  if (probeWin32()) _resolvedBackend = dpapiBackend;
  else if (probeDarwin()) _resolvedBackend = keychainBackend;
  else if (probeLinux()) _resolvedBackend = secretToolBackend;
  else {
    // No OS-native tool available - use encrypted-file fallback.
    // This is strictly stronger than plaintext and operates silently;
    // a warning is not emitted here because the fallback is fully functional.
    _resolvedBackend = encFileBackend;
  }

  return _resolvedBackend;
}

// secureStore proxies every operation through selectBackend() so the first
// call triggers backend resolution (and any probe spawns) while all
// subsequent calls hit the cached _resolvedBackend at near-zero cost.
// Importing this module never spawns anything.
export const secureStore: SecureStore = {
  setSecret: (...args) => selectBackend().setSecret(...args),
  getSecret: (...args) => selectBackend().getSecret(...args),
  deleteSecret: (...args) => selectBackend().deleteSecret(...args),
  backendName: () => selectBackend().backendName(),
};

// ---------------------------------------------------------------------------
// Session write-through (split-brain prevention)
// ---------------------------------------------------------------------------
//
// Backend selection runs once at module load and is environment-sensitive:
// the same machine can select the OS keyring in one process (desktop session,
// live D-Bus) and the encrypted-file fallback in another (SSH, CC hook,
// daemon with no session bus). A secret written to ONLY the selected backend
// then split-brains: the keyring copy rotates while
// ~/.config/alter/enc/<account>.bin keeps the pre-rotation value, and the
// next keyring-less process reads and presents the stale, already-revoked
// token. Confirmed live with the session blob (keyring-fresh / enc-stale).
//
// These helpers write the secret through to BOTH the selected backend and
// the encrypted-file fallback so a later fallback read can never serve a
// stale copy, AND so a primary-backend write failure can never strand a
// login with no persisted credential. When the selected backend IS the
// encrypted-file fallback there is nothing to mirror and the value is
// written once.

/**
 * Write `value` to the selected backend AND mirror it into the
 * encrypted-file fallback. `primary` is injectable for tests only.
 *
 * Failure semantics (the DPAPI-strand fix): a primary-backend write that
 * throws (e.g. a DPAPI write failure on Windows - PowerShell frozen,
 * ProtectedData unavailable, keychain locked) MUST NOT strand the session
 * credential-less. When the primary throws and the primary is NOT already
 * the encrypted-file backend, the value is persisted through the
 * encrypted-file fallback so the session is still written. Only when BOTH
 * the primary AND the fallback fail does this re-throw - a login with no
 * persisted credential anywhere is the one outcome the caller must see.
 *
 * On the happy path (primary write succeeds) the encrypted-file mirror is
 * best-effort: a mirror failure must not break a rotation the primary
 * store already accepted, because the primary holds the fresh value and a
 * read through it still succeeds.
 */
export function setSecretWriteThrough(
  account: string,
  value: string,
  primary: SecureStore = secureStore,
): void {
  // Selected backend IS the encrypted-file fallback: write once, surface any
  // failure (there is no second backend to fall back to).
  if (primary === encFileBackend) {
    primary.setSecret(account, value);
    return;
  }

  let primaryError: unknown;
  try {
    primary.setSecret(account, value);
  } catch (err) {
    primaryError = err;
  }

  // Mirror / fallback write into the encrypted-file backend.
  //   • primary succeeded → this is the best-effort mirror (swallow failures).
  //   • primary failed     → this is the strand-preventing fallback; its
  //     failure means the credential persisted NOWHERE, so re-throw.
  try {
    encFileBackend.setSecret(account, value);
  } catch (mirrorErr) {
    if (primaryError !== undefined) {
      // Both backends failed: the session would be stranded. Surface the
      // original primary error so the caller (login) fails loudly rather
      // than reporting success with no persisted credential.
      throw primaryError;
    }
    // Best-effort mirror after a successful primary write: a stale or empty
    // fallback is repaired by the next successful write-through.
    void mirrorErr;
  }
  // primary threw but the encrypted-file fallback persisted the value: the
  // session is written (in the fallback backend), so do NOT re-throw. The
  // next keyring-available process reads the fallback copy; a later
  // successful primary write repairs the split.
}

/**
 * Thrown by deleteSecretWriteThrough when, AFTER the delete is attempted, the
 * secret is STILL readable from one or more backends. A surviving credential
 * copy is the exact failure that lets a "logged out" CLI silently
 * re-authenticate on the next login (a split-brain enc-file mirror copy
 * outliving a wiped keyring), so this is loud and non-swallowable: the caller
 * (logout) converts it into a non-zero exit with a user-facing message.
 */
export class SecureStoreDeleteError extends Error {
  readonly account: string;
  readonly survivingBackends: string[];
  constructor(account: string, survivingBackends: string[]) {
    super(
      `logout failed to fully clear local credentials: '${account}' survived in ${survivingBackends.join(", ")}`,
    );
    this.name = "SecureStoreDeleteError";
    this.account = account;
    this.survivingBackends = survivingBackends;
  }
}

function backendNameSafe(store: SecureStore): string {
  try {
    return store.backendName();
  } catch {
    return "unknown-backend";
  }
}

/**
 * Read-back probe: is `account` STILL retrievable from `store` after a delete?
 * The OS-native deletes (keychainDelete / secretToolDelete / dpapiDelete) are
 * best-effort and swallow their own failures, so a read-back is the only proof
 * a wipe actually landed. A read that THROWS (e.g. a keyring timeout) cannot
 * prove removal, so it is treated as "still present": logout must fail loud
 * rather than assume a wipe it could not confirm. A false "still present" only
 * costs the user a re-run; a false "gone" silently strands a live credential,
 * the outcome this whole change exists to prevent.
 */
function secretStillPresent(store: SecureStore, account: string): boolean {
  try {
    return store.getSecret(account) !== null;
  } catch {
    return true;
  }
}

/**
 * Delete `account` from the selected backend AND the encrypted-file fallback,
 * then VERIFY (by read-back) that the secret is gone from both, so logout
 * never leaves a live mirrored credential behind. On any surviving copy, emit
 * a stderr warning and throw SecureStoreDeleteError so the caller fails loud
 * instead of reporting a logout that did not happen. `primary` is injectable
 * for tests only.
 */
export function deleteSecretWriteThrough(
  account: string,
  primary: SecureStore = secureStore,
): void {
  const survivors: string[] = [];

  // 1. Selected (primary) backend.
  try {
    primary.deleteSecret(account);
  } catch (err) {
    process.stderr.write(
      `alter: WARNING: delete of '${account}' from the ${backendNameSafe(primary)} backend failed: ${(err as Error)?.message ?? String(err)}\n`,
    );
  }
  if (secretStillPresent(primary, account)) {
    survivors.push(backendNameSafe(primary));
  }

  // 2. Encrypted-file mirror (unless it IS the primary - step 1 covered that).
  if (primary !== encFileBackend) {
    try {
      encFileBackend.deleteSecret(account);
    } catch (err) {
      process.stderr.write(
        `alter: WARNING: delete of '${account}' from the encrypted-file mirror failed: ${(err as Error)?.message ?? String(err)}\n`,
      );
    }
    if (secretStillPresent(encFileBackend, account)) {
      survivors.push(encFileBackend.backendName());
    }
  }

  if (survivors.length > 0) {
    throw new SecureStoreDeleteError(account, survivors);
  }
}

/**
 * Split-brain self-heal for a stale encrypted-file MIRROR session copy.
 *
 * When the SELECTED backend is an OS-native store (keyring / Keychain / DPAPI)
 * and the caller has just read NO secret from it, any encrypted-file mirror
 * copy of `account` is stale residue - a prior logout that failed to clear the
 * mirror, or a backend swap. Left in place, a later keyring-less process
 * (SSH / CC hook / daemon with no session bus) selects the encrypted-file
 * backend, reads that residue, and silently short-circuits `alter login` as
 * "already logged in" against a credential the user revoked.
 *
 * This wipes that residue and returns true when it existed. It is a no-op
 * (returns false) when the selected backend IS the encrypted-file store -
 * there the mirror is the authoritative copy, not residue, and must never be
 * deleted out from under a live session.
 */
export function healEncFileMirrorResidue(account: string): boolean {
  if (selectBackend() === encFileBackend) return false;
  if (encFileBackend.getSecret(account) === null) return false;
  try {
    encFileBackend.deleteSecret(account);
  } catch {
    // Could not remove (locked / read-only): do NOT claim it was healed; the
    // doctor surfaces the residue and the next logout's verifier re-attempts.
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

/** Exposed for test injection: in-process encrypted-file backend. */
export { encFileBackend as _encFileBackend };

/**
 * Test seam for the darwin keychain path, stripped from the published build.
 *
 * The three functions take the `security` invoker as their last argument, so a
 * test can hand in its own, run the real write/read/delete logic, and assert on
 * the exact argument vector a spawn would have received. That assertion is the
 * only way to prove a secret is not on the command line: the backend object
 * itself refuses to run under a test runner (by design), and a spawn-based test
 * would have to write to the developer's live keychain to observe anything.
 */
export const __testing = { keychainSet, keychainGet, keychainDelete, wrappedFilePath, wrapKeyAccount, KEYCHAIN_SERVICE };

/**
 * Resolve the REAL platform OS backend directly, bypassing the backend-selection
 * guard and the module-level _resolvedBackend cache.
 *
 * ONLY callable from the explicitly-gated integration tests
 * (ALTER_SECURE_STORE_INTEGRATION=1), and that is now ENFORCED rather than
 * merely documented. This function used to be an unguarded exported hole: it
 * handed the live keyring backend to any caller that asked, and its docstring
 * asking nicely for an env var was the whole of the protection. A test that
 * imported it got the developer's real credential store no matter what
 * selectBackend() had decided.
 *
 * Note that the returned backend is ALSO guarded at the operation level
 * (guardKeyringOp), so even a caller who obtains it cannot write to the keyring
 * unless the process is permitted to. This throw is the earlier, clearer of the
 * two failures.
 *
 * Does NOT mutate _resolvedBackend: the secureStore proxy is unaffected.
 */
export function _resolveOsBackend(): SecureStore {
  if (process.env.ALTER_SECURE_STORE_INTEGRATION !== "1") {
    throw new KeyringRefusedError(
      "resolve",
      "os-native",
      "_resolveOsBackend() is gated on ALTER_SECURE_STORE_INTEGRATION=1 and it " +
        "is not set. Use secureStore (which selects a safe backend) instead",
    );
  }
  if (probeWin32()) return dpapiBackend;
  if (probeDarwin()) return keychainBackend;
  if (probeLinux()) return secretToolBackend;
  return encFileBackend;
}
