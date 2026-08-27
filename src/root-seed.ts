/**
 * The member root seed for the alter CLI (desktop half).
 *
 * A member holds one long-lived secret from which purpose-scoped keys
 * are derived later, and this module mints, stores, exports and imports
 * that secret. It derives nothing itself; a caller that needs a scoped
 * key takes these 32 bytes and does its own derivation.
 *
 * WHY THIS IS NOT THE DEVICE KEY. ``src/device-key.ts`` holds a signing
 * key bound to THIS MACHINE, and the whole point of a device key is
 * that it can be rotated: a stolen laptop is answered by minting a new
 * one and letting the field forget the old. A key derived from a
 * rotatable secret inherits that mortality, so anything derived from
 * the device key dies when the device is replaced. The root seed is the
 * opposite primitive: minted once, never rotated as a matter of course,
 * and carried by the member rather than the machine.
 *
 * WHAT IT COSTS. The seed is registered nowhere. No server holds it, no
 * recovery flow can reissue it, and nothing about a member's account
 * can reconstruct it. That is deliberate, and it is the reason
 * ``encodeRootSeed`` exists: a secret that cannot be reissued has to be
 * writable-down, or losing one machine loses it outright.
 *
 * THE WRITTEN-DOWN FORM. base58btc over the seed plus a four-byte
 * SHA-256 checksum. base58btc because a human transcribes this by hand
 * and its alphabet excludes the four characters people confuse (0, O,
 * I and l). The checksum because a seed is a SILENT failure otherwise:
 * a mistyped seed is still 32 valid bytes, so it derives keys happily
 * and every one of them is wrong, with nothing to say so until a
 * signature fails somewhere far away from the typo. ``decodeRootSeed``
 * rejects a bad checksum rather than returning bytes.
 *
 * At-rest posture matches the device key: raw seed, base64, in the OS
 * secure store under its own account, never a plaintext file.
 *
 * Dependency posture: ``node:crypto`` only, base58 included, matching
 * ``src/device-key.ts`` and ``src/signing.ts``.
 */

import * as crypto from "node:crypto";

import { base58btcEncode } from "./device-key.js";
import { secureStore } from "./secure-store.js";

/** Secure store account key for the member root seed. */
const ROOT_SEED_STORE_ACCOUNT = "member-root-seed";

/** Seed length in bytes. 32 is the input width every KDF here expects. */
export const ROOT_SEED_BYTES = 32;

/** Trailing checksum width, in bytes, inside the written-down form. */
const CHECKSUM_BYTES = 4;

/** The base58btc alphabet, Bitcoin ordering. Excludes 0, O, I and l. */
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Mint a fresh root seed.
 *
 * ``randomBytes`` and not ``generateKeyPairSync``: this is key material
 * for a derivation, not a keypair, and giving it a public half it never
 * uses would invite somebody to publish that half later.
 */
export function generateRootSeed(): Buffer {
  return crypto.randomBytes(ROOT_SEED_BYTES);
}

/** Decode base58btc back to bytes, or null when a character is not in the alphabet. */
function base58btcDecode(text: string): Uint8Array | null {
  if (text.length === 0) return new Uint8Array(0);

  let leadingOnes = 0;
  while (leadingOnes < text.length && text[leadingOnes] === "1") leadingOnes++;

  // Base conversion back the other way: each digit multiplies the
  // accumulated byte array by 58 and adds itself.
  const bytes: number[] = [];
  for (let i = leadingOnes; i < text.length; i++) {
    const digit = BASE58_ALPHABET.indexOf(text[i]);
    if (digit === -1) return null;
    let carry = digit;
    for (let j = bytes.length - 1; j >= 0; j--) {
      const value = bytes[j] * 58 + carry;
      bytes[j] = value % 256;
      carry = Math.floor(value / 256);
    }
    while (carry > 0) {
      bytes.unshift(carry % 256);
      carry = Math.floor(carry / 256);
    }
  }

  return Uint8Array.from([...new Array(leadingOnes).fill(0), ...bytes]);
}

/** First four bytes of SHA-256 over the seed. */
function checksumFor(seed: Uint8Array): Buffer {
  return crypto.createHash("sha256").update(seed).digest().subarray(0, CHECKSUM_BYTES);
}

/**
 * Render a seed in the form a member writes down: base58btc over the
 * seed bytes followed by their checksum.
 */
export function encodeRootSeed(seed: Uint8Array): string {
  if (seed.length !== ROOT_SEED_BYTES) {
    throw new Error(`root seed must be ${ROOT_SEED_BYTES} bytes, got ${seed.length}`);
  }
  const withChecksum = new Uint8Array(ROOT_SEED_BYTES + CHECKSUM_BYTES);
  withChecksum.set(seed, 0);
  withChecksum.set(checksumFor(seed), ROOT_SEED_BYTES);
  return base58btcEncode(withChecksum);
}

/**
 * Recover a seed from its written-down form.
 *
 * Returns null on anything that is not exactly one valid seed: a
 * character outside the alphabet, the wrong length, or a checksum that
 * does not match. The caller reports "that is not a valid seed" and
 * stops, which is the only safe answer, because the alternative is
 * storing 32 bytes that look fine and derive keys nobody recognises.
 *
 * The checksum comparison is length-safe rather than timing-safe on
 * purpose: this compares a checksum the caller already typed in full
 * against one derived from their own input, so there is no secret here
 * for a timing channel to leak.
 */
export function decodeRootSeed(text: string): Buffer | null {
  const decoded = base58btcDecode(text.trim());
  if (decoded === null) return null;
  if (decoded.length !== ROOT_SEED_BYTES + CHECKSUM_BYTES) return null;

  const seed = Buffer.from(decoded.subarray(0, ROOT_SEED_BYTES));
  const given = Buffer.from(decoded.subarray(ROOT_SEED_BYTES));
  if (!checksumFor(seed).equals(given)) return null;
  return seed;
}

/** Persist the root seed into the OS secure store, base64 over the raw bytes. */
export function writeRootSeed(seed: Uint8Array): void {
  secureStore.setSecret(ROOT_SEED_STORE_ACCOUNT, Buffer.from(seed).toString("base64"));
}

/**
 * Read the root seed from the OS secure store, or null when this
 * machine holds none. A stored value of the wrong width reads as absent
 * rather than as a seed: a truncated secret would derive silently wrong
 * keys, which is the failure the checksum exists to prevent on the
 * written-down path and this length check prevents on the stored one.
 */
export function readRootSeed(): Buffer | null {
  const stored = secureStore.getSecret(ROOT_SEED_STORE_ACCOUNT);
  if (stored === null) return null;
  const seed = Buffer.from(stored, "base64");
  return seed.length === ROOT_SEED_BYTES ? seed : null;
}

/**
 * Return this machine's root seed, minting and storing one if it holds
 * none. The boolean says which happened, so a caller can show the
 * written-down form on the mint and stay silent on every later run.
 */
export function ensureRootSeed(): { seed: Buffer; minted: boolean } {
  const existing = readRootSeed();
  if (existing !== null) return { seed: existing, minted: false };
  const seed = generateRootSeed();
  writeRootSeed(seed);
  return { seed, minted: true };
}
