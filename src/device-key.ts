/**
 * Ed25519 device key for the alter CLI (desktop half).
 *
 * This is the SIGNING half of a member's device identity, and it is a
 * different primitive from the two keys already in this repo. The member
 * API key (``session.json``) authenticates the CLI. The X25519 key
 * (``src/x25519.ts``) does key-agreement for attachment key-wrap, which
 * is encryption, never a signature. Neither can answer "did this member
 * assent to these exact bytes"; only an Ed25519 signature can, and the
 * identity field records that answer against a W3C ``did:key`` on the
 * member's ``Device`` row.
 *
 * Wire ceremony, matching ``POST /api/v1/identity/devices`` on the live
 * identity field, field for field:
 *
 *   1. ``GET  /api/v1/identity/devices/nonce`` returns a single-use hex
 *      nonce bound to the caller's session.
 *   2. Mint or load this device's persistent Ed25519 keypair.
 *   3. Sign the RAW nonce bytes, never the hex string. The server
 *      hex-decodes before verifying, so signing the text would verify
 *      nowhere and fail with a 400 that says nothing useful.
 *   4. POST ``{did_key, signature, nonce, device_name}``. The server
 *      extracts the public key back out of the ``did:key`` multicodec
 *      prefix, verifies, consumes the nonce atomically in Redis, and
 *      writes the ``Device`` row.
 *
 * At-rest posture is identical to ``src/x25519.ts``: PKCS#8 PEM in the
 * OS secure store under its own account, never a plaintext file that a
 * same-uid process can read at leisure. The private half never leaves
 * this machine and is never sent anywhere: registration submits the
 * PUBLIC key inside the did:key, and a signature, and nothing else.
 *
 * Dependency posture: ``node:crypto`` only. Node has had native Ed25519
 * since 12.x, so the zero-crypto-dependency stance ``src/signing.ts``
 * set holds here too, base58 included (see ``base58btcEncode``).
 */

import * as crypto from "node:crypto";

import { secureStore } from "./secure-store.js";

/** Secure store account key for the Ed25519 device private key. */
const DEVICE_KEY_STORE_ACCOUNT = "device-ed25519-key";

/**
 * Multicodec prefix for an Ed25519 public key, ``0xed 0x01`` in
 * unsigned-varint form. The ``z`` that follows ``did:key:`` is the
 * multibase tag for base58btc; the bytes it encodes are this prefix
 * followed by the raw 32-byte key. Both halves are fixed by W3C
 * did:key, and the backend re-derives the key by stripping exactly
 * these two bytes, so a change here breaks registration at the server.
 */
const ED25519_MULTICODEC_PREFIX = Uint8Array.from([0xed, 0x01]);

/** The base58btc alphabet, Bitcoin ordering. Excludes 0, O, I and l. */
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export interface DeviceKeypair {
  /** PEM-encoded PKCS#8 private key, stored in the secure store verbatim. */
  privateKeyPem: string;
  /** Raw 32-byte public key. */
  publicKey: Buffer;
  /** Canonical W3C ``did:key:z…`` form of the public key. */
  didKey: string;
}

/**
 * Encode bytes as base58btc.
 *
 * Straight big-integer base conversion, with the leading-zero rule
 * base58 requires: a zero byte carries no value in the number, so each
 * leading zero is re-added as an explicit ``1``. Dropping that rule
 * produces a shorter string that decodes to a DIFFERENT key, which is
 * the classic base58 bug and is invisible until a key with a leading
 * zero byte turns up. The multicodec prefix means our input always
 * starts ``0xed``, so this path is unreachable for a did:key today; it
 * is written correctly anyway because a helper that is right only for
 * its current caller is a trap for the next one.
 */
export function base58btcEncode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros++;

  // Base conversion over a byte array: repeatedly divide the whole
  // number by 58, collecting remainders. Cheaper to read than BigInt
  // string juggling and allocation-bounded.
  const digits: number[] = [];
  for (let i = leadingZeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      const value = digits[j] * 256 + carry;
      digits[j] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let out = "1".repeat(leadingZeros);
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]];
  return out;
}

/**
 * Render a raw 32-byte Ed25519 public key as a W3C ``did:key``.
 * Refuses any other length rather than emitting a did:key the server
 * will reject with a 422 the caller then has to decode.
 */
export function encodeDidKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new Error(
      `Ed25519 public key must be 32 bytes, got ${publicKey.length}`,
    );
  }
  const prefixed = new Uint8Array(ED25519_MULTICODEC_PREFIX.length + 32);
  prefixed.set(ED25519_MULTICODEC_PREFIX, 0);
  prefixed.set(publicKey, ED25519_MULTICODEC_PREFIX.length);
  return `did:key:z${base58btcEncode(prefixed)}`;
}

/**
 * Generate a fresh Ed25519 device keypair.
 *
 * The raw public key is the trailing 32 bytes of the SPKI DER encoding:
 * RFC 8410 §4 fixes the ASN.1 header at 12 bytes for Ed25519, the same
 * slice ``generateX25519Keypair`` takes, and the length assertion here
 * is what stops a future Node change turning that assumption into a
 * silently wrong key.
 */
export function generateDeviceKeypair(): DeviceKeypair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const spkiDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  if (spkiDer.length !== 44) {
    throw new Error(
      `unexpected Ed25519 SPKI length ${spkiDer.length} (RFC 8410 mandates 44)`,
    );
  }
  const rawPublic = spkiDer.subarray(spkiDer.length - 32);
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }) as string,
    publicKey: rawPublic,
    didKey: encodeDidKey(rawPublic),
  };
}

/** Persist the device private key into the OS secure store. */
export function writeDevicePrivateKeyPem(pem: string): void {
  secureStore.setSecret(DEVICE_KEY_STORE_ACCOUNT, pem);
}

/**
 * Read the device private key from the OS secure store, or null when
 * this device has never registered. Unlike ``readX25519PrivateKeyPem``
 * there is no legacy-plaintext migration path to walk: this key has
 * only ever been written to the store.
 */
export function readDevicePrivateKeyPem(): string | null {
  return secureStore.getSecret(DEVICE_KEY_STORE_ACCOUNT);
}

/**
 * Load this device's keypair from the secure store, deriving the public
 * half and the did:key from the stored private key rather than storing
 * them separately. One stored secret means the public and private
 * halves cannot drift apart, which is the failure mode that makes a
 * device look registered while signing with a key nobody knows.
 */
export function loadDeviceKeypair(): DeviceKeypair | null {
  const pem = readDevicePrivateKeyPem();
  if (pem === null) return null;
  const privateKey = crypto.createPrivateKey(pem);
  const publicKey = crypto.createPublicKey(privateKey);
  const spkiDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const rawPublic = spkiDer.subarray(spkiDer.length - 32);
  return { privateKeyPem: pem, publicKey: rawPublic, didKey: encodeDidKey(rawPublic) };
}

/**
 * Produce a detached Ed25519 signature over ``message`` with this
 * device's private key, hex-encoded as the registration endpoint
 * expects. Ed25519 in Node takes a null digest algorithm: the scheme
 * hashes internally, and passing "sha256" here is an error rather than
 * a stronger signature.
 */
export function signWithDeviceKey(message: Uint8Array, privateKeyPem: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  return crypto.sign(null, Buffer.from(message), key).toString("hex");
}
