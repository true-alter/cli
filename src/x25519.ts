/**
 * X25519 keypair management for the alter CLI (desktop half).
 *
 * Pairs with the ES256 invocation-signing key (``src/signing.ts``) and
 * the member API key (``session.json``). Identical at-rest posture to
 * ``signing-key.pem``: PEM-encoded PKCS#8 private key, mode 0600,
 * atomic temp-and-rename write, under ``~/.config/alter/``.
 *
 * Lifecycle
 *   * Member-key mint (``alter login`` + ``alter key member rotate``):
 *     generate a fresh X25519 keypair, persist the private half to
 *     ``x25519-private-key.pem``, and submit the public half as a
 *     64-hex-char raw key in the ``/api/v1/auth/member-key`` POST body
 *     under the optional ``x25519_public_key`` field.
 *   * Backend records the public key against this member's row so the
 *     ``alter_peer_devices(peer_handle)`` MCP tool can surface
 *     desktop-as-recipient handles to senders.
 *
 * Wire format note
 *   The submitted public key is the RAW 32-byte X25519 key, hex-encoded
 *   (64 chars). Node's ``generateKeyPair('x25519')`` returns an SPKI
 *   wrapper (12-byte ASN.1 header + 32-byte raw key); we strip the
 *   header here so the wire shape stays compact and bridge-agnostic.
 *   The private half stays in PEM/PKCS#8 on disk because that is the
 *   form Node's ``crypto.diffieHellman`` consumes directly - no parsing
 *   gymnastics at use-time.
 *
 * Dependency posture
 *   Node-built-in ``node:crypto`` only - no ``tweetnacl``, ``sodium-native``,
 *   ``@noble/curves``, etc. Matches the existing zero-crypto-dep stance
 *   established by ``src/signing.ts``.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ALTER_CONFIG_DIR } from "./auth.js";
import { secureStore, secureUnlinkSync } from "./secure-store.js";

/** Secure store account key for the X25519 private key. */
const X25519_STORE_ACCOUNT = "x25519-key";

/**
 * Module-load path - production callers hit this. Kept exported for
 * scripts and diagnostics that want a stable constant. Test isolation
 * goes through ``activeX25519PrivateKeyFile()`` which re-reads
 * ``XDG_CONFIG_HOME`` at call time (same posture as
 * ``auth.activeSessionFile``).
 */
export const X25519_PRIVATE_KEY_FILE = path.join(
  ALTER_CONFIG_DIR,
  "x25519-private-key.pem",
);

/**
 * Resolve the active X25519 PEM path, re-reading
 * ``XDG_CONFIG_HOME`` each call. Mirrors ``auth.activeSessionFile``
 * so tests can repoint the path at a tmp dir without restarting the
 * process. Production behaviour is unchanged: a typical caller hits
 * the same value the module-load constant resolved to.
 */
function activeX25519PrivateKeyFile(): string {
  const xdg =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdg, "alter", "x25519-private-key.pem");
}

function activeAlterConfigDir(): string {
  const xdg =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdg, "alter");
}

export interface X25519Keypair {
  /** PEM-encoded PKCS#8 private key - stored on disk verbatim. */
  privateKeyPem: string;
  /** Raw 32-byte public key, hex-encoded (64 chars) - submitted to backend. */
  publicKeyHex: string;
}

/**
 * Generate a fresh X25519 keypair. Returns the private half in PEM/PKCS#8
 * form (suitable for ``writeX25519PrivateKeyPem``) and the public half as
 * a 64-hex-char raw 32-byte key (suitable for the
 * ``/api/v1/auth/member-key`` POST body's ``x25519_public_key`` field).
 *
 * Backend agent's schema validates: exact length 64, hex-only charset.
 * We extract the raw key by taking the trailing 32 bytes of the SPKI
 * DER encoding - RFC 8410 §4 fixes the ASN.1 header at 12 bytes for
 * X25519, so this slice is stable.
 */
export function generateX25519Keypair(): X25519Keypair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  const spkiDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  if (spkiDer.length !== 44) {
    throw new Error(
      `unexpected X25519 SPKI length ${spkiDer.length} (RFC 8410 mandates 44)`,
    );
  }
  const rawPublic = spkiDer.subarray(spkiDer.length - 32);
  return {
    privateKeyPem: privateKey.export({
      format: "pem",
      type: "pkcs8",
    }) as string,
    publicKeyHex: rawPublic.toString("hex"),
  };
}

/**
 * Write the X25519 private PEM into the OS secure store.
 * The old plaintext file (X25519_PRIVATE_KEY_FILE) is no longer written.
 */
export function writeX25519PrivateKeyPem(pem: string): void {
  secureStore.setSecret(X25519_STORE_ACCOUNT, pem);
}

/**
 * Read the X25519 private PEM from the OS secure store.
 *
 * Migration path (one-time, crash-safe):
 *   1. Try the secure store first.
 *   2. If absent, check for the legacy plaintext file.
 *   3. If found: write into store, confirm, then remove plaintext.
 *      Never removes plaintext before store-write is confirmed.
 */
export function readX25519PrivateKeyPem(): string | null {
  // Fast path: already in the secure store.
  const stored = secureStore.getSecret(X25519_STORE_ACCOUNT);
  if (stored !== null) return stored;

  // Migration: check for legacy plaintext file.
  let legacy: string | null = null;
  try {
    legacy = fs.readFileSync(activeX25519PrivateKeyFile(), "utf-8");
  } catch {
    return null;
  }

  // Migrate into the secure store. Confirm exact match before removing plaintext.
  // Fix 3: compare === legacy (not just !== null) to catch truncated writes.
  // Fix 4: try/catch so a transient OS store failure keeps the CLI functional.
  try {
    secureStore.setSecret(X25519_STORE_ACCOUNT, legacy);
  } catch {
    console.error("warning: could not migrate x25519-key into secure store; using legacy file");
    return legacy;
  }
  const confirmed = secureStore.getSecret(X25519_STORE_ACCOUNT);
  if (confirmed === legacy) {
    // Store confirmed with exact match - securely remove the plaintext file
    // (zero-overwrite + unlink; see secureUnlinkSync for the CoW caveat).
    try {
      secureUnlinkSync(activeX25519PrivateKeyFile());
    } catch {
      // Best-effort; leaving the plaintext is safe relative to losing the key.
    }
  }
  // If confirmed !== legacy (truncation/corruption), keep the plaintext.
  return legacy;
}

/**
 * Residue sweep: when the secure store already holds a
 * well-formed x25519 key AND the legacy plaintext PEM still exists beside it
 * (e.g. a fresh key was written straight to the store while a pre-migration
 * file lingered), securely remove the plaintext file. The store entry is
 * verified through the store's own read path BEFORE anything is deleted -
 * never the reverse order.
 *
 * Returns true when a plaintext file was removed. Never throws.
 */
export function sweepX25519PlaintextResidue(): boolean {
  const legacyPath = activeX25519PrivateKeyFile();
  if (!fs.existsSync(legacyPath)) return false; // cheap gate - common case
  let stored: string | null = null;
  try {
    stored = secureStore.getSecret(X25519_STORE_ACCOUNT);
  } catch {
    return false; // store unreadable - keep the plaintext (it may be the only copy)
  }
  if (stored === null || !stored.includes("-----BEGIN")) return false;
  try {
    secureUnlinkSync(legacyPath);
    return true;
  } catch {
    return false; // locked/read-only file - doctor surfaces the residue
  }
}
