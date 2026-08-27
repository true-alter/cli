/**
 * ES256 per-invocation signing for the alter CLI.
 *
 * Uses Node's built-in `node:crypto` so the CLI does not need to pull
 * in a crypto dependency. The wire format (JWS compact, claims shape,
 * canonical JSON for `args_sha256`) matches the peer SDK and the
 * server-side verifier.
 *
 * Keypair lifecycle
 *   * First login: generate an ES256 P-256 keypair, POST the public
 *     half (PEM, SubjectPublicKeyInfo) to `/api/v1/agents/keys`, stash
 *     the private half at `~/.config/alter/signing-key.pem` (0600)
 *     and cache the returned kid in `session.json`.
 *   * Subsequent sessions: re-use the private key and kid.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ALTER_CONFIG_DIR } from './auth.js';
import { secureStore, secureUnlinkSync } from './secure-store.js';
import {
  fetchWithRetry,
  type FetchWithRetryOptions,
} from './lib/fetch-with-retry.js';

export const SIGNING_KEY_FILE = path.join(ALTER_CONFIG_DIR, 'signing-key.pem');

/** Secure store account key for the ES256 signing private key. */
const SIGNING_STORE_ACCOUNT = 'signing-key';

/** Secure store account key for the session blob (mirrors auth.ts). */
const SESSION_STORE_ACCOUNT = 'session';

/**
 * Resolve the legacy signing-key.pem path at call-time.
 * Mirrors auth.ts:activeSessionFile() - tests redirect XDG_CONFIG_HOME after
 * module load, so the migration read must re-read the env var at call-time.
 */
function activeSigningKeyFile(): string {
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(xdg, 'alter', 'signing-key.pem');
}

/**
 * Resolve the per-kid plaintext key directory at call-time.
 * Mirrors commands/key.ts:signingKeysDir() but call-time so tests that
 * redirect XDG_CONFIG_HOME after module load see the correct path.
 */
function activeSigningKeysDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(xdg, 'alter', 'signing-keys');
}

/**
 * Human-readable location of a secure-store entry for error messages.
 * On the encrypted-file backend this is the actual .bin path under
 * ~/.config/alter/enc/; on OS-native backends it names the backend and
 * the account so the user can locate the entry.
 */
function describeStoreEntry(account: string): string {
  if (secureStore.backendName() === 'encrypted-file') {
    const xdg =
      process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
    const safe = account.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(xdg, 'alter', 'enc', `${safe}.bin`);
  }
  return `${secureStore.backendName()} secure store entry '${account}'`;
}

// ---------------------------------------------------------------------------
// Canonical JSON + SHA-256
// ---------------------------------------------------------------------------

/**
 * Stable stringify mirroring Python's
 *   json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
 *
 * Must produce the same bytes the server hashes. Must match the
 * server-side canonicalisation.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) {
    throw new TypeError('canonicalStringify: undefined is not JSON');
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('canonicalStringify: non-finite numbers rejected');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalStringify(v)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return (
      '{' +
      keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(obj[k])).join(',') +
      '}'
    );
  }
  throw new TypeError(`canonicalStringify: unsupported type ${typeof value}`);
}

export function canonicalArgsSha256(args: Record<string, unknown>): string {
  return crypto
    .createHash('sha256')
    .update(canonicalStringify(args ?? {}), 'utf-8')
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Keypair management
// ---------------------------------------------------------------------------

export interface GeneratedKeypair {
  /** PEM-encoded PKCS#8 private key. */
  privateKeyPem: string;
  /** PEM-encoded SubjectPublicKeyInfo public key. */
  publicKeyPem: string;
}

export function generateSigningKeypair(): GeneratedKeypair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }) as string,
  };
}

/**
 * Write the ES256 signing private key PEM into the OS secure store.
 * The old plaintext file (SIGNING_KEY_FILE) is no longer written.
 *
 * LEGACY-format write (bare PEM, no kid binding). Login uses
 * writeSigningCredential() instead, which records the kid and the
 * public-key fingerprint alongside the key so signing can verify the
 * pairing. Kept for the migration path and existing tests.
 */
export function writePrivateKeyPem(pem: string): void {
  secureStore.setSecret(SIGNING_STORE_ACCOUNT, pem);
}

// ---------------------------------------------------------------------------
// Credential binding: kid + key + fingerprint as one atomic record
// ---------------------------------------------------------------------------
//
// Root cause of the bridge signing outage: the kid lived in the
// session record while the private key resolved independently (secure store
// OR a legacy plaintext file). A stale plaintext signing-key.pem could be
// picked up while the session carried a kid issued against a different key,
// so every signature verified against the wrong public half. The fix is a
// versioned envelope that stores kid, key, and the public-key fingerprint
// together in ONE secure-store entry (single atomic write), plus a
// resolution path that refuses to sign when the resolved key does not match
// the kid the session was issued against.

/** Versioned envelope stored under the 'signing-key' secure-store account. */
interface SigningCredentialEnvelope {
  v: 1;
  kid: string;
  private_key_pem: string;
  /** SHA-256 hex of the public half's SPKI DER encoding. */
  public_key_fingerprint: string;
}

/** Resolution result: the key, where it came from, and any binding metadata. */
export interface ResolvedSigningCredential {
  privateKeyPem: string;
  /** kid recorded alongside the key (envelope format only). */
  kid?: string;
  /** Fingerprint recorded alongside the key (envelope format only). */
  recordedFingerprint?: string;
  /** Human-readable location the key was resolved from (for error messages). */
  source: string;
}

/**
 * Raised when the resolved signing key does not match the kid (or
 * fingerprint) the session was issued against. Signing MUST refuse on
 * this error, never silently fall back to another key.
 */
export class SigningKeyMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SigningKeyMismatchError';
  }
}

/**
 * Compute the public-key fingerprint for a PEM key (private or public):
 * SHA-256 hex over the public half's SPKI DER encoding. The server-assigned
 * kid is an opaque `ask_*` token (NOT derived from the key), so the
 * fingerprint is the only stable identity for the key material itself.
 */
export function computePublicKeyFingerprint(pem: string): string {
  const publicKey = pem.includes('PRIVATE KEY')
    ? crypto.createPublicKey(crypto.createPrivateKey({ key: pem, format: 'pem' }))
    : crypto.createPublicKey({ key: pem, format: 'pem' });
  const spkiDer = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return crypto.createHash('sha256').update(spkiDer).digest('hex');
}

/**
 * Remove the LEGACY single-file plaintext signing-key artefacts that the
 * session signing resolution path (readSigningCredential) could otherwise
 * pick up. Covered paths, and ONLY these (never arbitrary user files, so a
 * hand-renamed backup like signing-key.pem.orphaned.bak survives):
 *   - ~/.config/alter/signing-key.pem            (legacy single-key file)
 *   - ~/.config/alter/signing-key.pem.tmp.*      (atomic-write temp leftovers)
 *
 * It deliberately does NOT touch ~/.config/alter/signing-keys/<kid>.pem.
 * Those per-kid agent keys are written by `alter key signing add`, are the
 * ONLY local copy of keys registered server-side, and are NEVER read by the
 * session resolution path - so they are not residue and must not be swept.
 * (A prior incident: a bare PEM restored into the secure store triggered
 * a full wipe that deleted live per-kid agent keys.) Per-kid keys have their
 * own lifecycle: `alter key signing add` writes them, `alter key signing
 * revoke` removes one, and logout (removeManagedSigningArtefacts) clears all.
 */
export function removeLegacyShadowingArtefacts(): void {
  const legacyPath = activeSigningKeyFile();
  const configDir = path.dirname(legacyPath);

  try {
    secureUnlinkSync(legacyPath);
  } catch {
    // Not present, nothing to remove.
  }

  let configEntries: string[] = [];
  try {
    configEntries = fs.readdirSync(configDir);
  } catch {
    configEntries = [];
  }
  for (const name of configEntries) {
    if (name.startsWith('signing-key.pem.tmp.')) {
      try {
        secureUnlinkSync(path.join(configDir, name));
      } catch {
        // Best-effort.
      }
    }
  }
}

/**
 * Full wipe of every PLAINTEXT signing-key artefact this CLI manages,
 * INCLUDING the per-kid agent keys under signing-keys/. Covered paths,
 * and ONLY these (never arbitrary user files):
 *   - ~/.config/alter/signing-key.pem            (legacy single-key file)
 *   - ~/.config/alter/signing-key.pem.tmp.*      (atomic-write temp leftovers)
 *   - ~/.config/alter/signing-keys/<kid>.pem     (per-kid variants, key.ts)
 *   - ~/.config/alter/signing-keys/*.pem.tmp.*   (temp leftovers in that dir)
 * The signing-keys directory itself is removed only when left empty.
 *
 * This is the LOGOUT-scoped wipe: it clears the user's per-kid agent signing
 * keys too, which is correct ONLY when the user is logging out. The startup
 * residue sweep and login MUST use removeLegacyShadowingArtefacts() instead,
 * so they leave per-kid agent keys intact.
 */
export function removeManagedSigningArtefacts(): void {
  removeLegacyShadowingArtefacts();

  const kidDir = activeSigningKeysDir();
  let kidEntries: string[] = [];
  try {
    kidEntries = fs.readdirSync(kidDir);
  } catch {
    return; // Directory absent, done.
  }
  for (const name of kidEntries) {
    if (name.endsWith('.pem') || /\.pem\.tmp\./.test(name)) {
      try {
        secureUnlinkSync(path.join(kidDir, name));
      } catch {
        // Best-effort.
      }
    }
  }
  try {
    fs.rmdirSync(kidDir); // Succeeds only when empty; non-managed files keep it.
  } catch {
    // Non-empty or already gone.
  }
}

/**
 * True when a LEGACY single-file plaintext signing-key artefact (the only
 * kind the session resolution path can pick up) exists on disk. Deliberately
 * ignores per-kid agent keys under signing-keys/ (see
 * removeLegacyShadowingArtefacts) so they are never treated as residue.
 */
function hasLegacyShadowingArtefacts(): boolean {
  if (fs.existsSync(activeSigningKeyFile())) return true;
  const configDir = path.dirname(activeSigningKeyFile());
  try {
    return fs
      .readdirSync(configDir)
      .some((name) => name.startsWith('signing-key.pem.tmp.'));
  } catch {
    return false;
  }
}

/**
 * Residue sweep (scope narrowed): when the
 * secure store already holds a well-formed signing credential (envelope or
 * bare PEM - both carry the `-----BEGIN` marker) AND a LEGACY single-file
 * plaintext signing-key artefact still exists beside it, securely remove the
 * legacy artefact. The store entry is verified through the store's own read
 * path BEFORE anything is deleted - never the reverse order. The stale legacy
 * plaintext can never win resolution anyway (store-first), so removing it
 * loses nothing and closes the disclosure window.
 *
 * Scope is the legacy single-file artefacts ONLY. Per-kid agent keys under
 * signing-keys/ are NOT residue (the session path never reads them) and are
 * left untouched - sweeping them deleted live agent keys (a prior
 * incident).
 *
 * Returns true when at least one legacy artefact existed and a sweep ran.
 * Never throws.
 */
export function sweepSigningPlaintextResidue(): boolean {
  if (!hasLegacyShadowingArtefacts()) return false; // cheap gate - common case
  let stored: string | null = null;
  try {
    stored = secureStore.getSecret(SIGNING_STORE_ACCOUNT);
  } catch {
    return false; // store unreadable - keep the plaintext (it may be the only copy)
  }
  if (stored === null || !stored.includes('-----BEGIN')) return false;
  removeLegacyShadowingArtefacts();
  return true;
}

/**
 * Atomically persist the kid + private key + fingerprint as ONE
 * secure-store record (single setSecret; the encrypted-file backend
 * writes temp-then-rename, so the pairing lands whole or not at all),
 * then purge the legacy single-file plaintext artefact the resolution
 * path could otherwise pick up. Login calls this after the server confirms
 * registration, so a fresh login can never leave a stale plaintext key
 * paired with a different kid. Uses the legacy-scoped purge (NOT the full
 * wipe): logging in must not delete the user's per-kid agent signing keys.
 */
export function writeSigningCredential(kid: string, privateKeyPem: string): void {
  const envelope: SigningCredentialEnvelope = {
    v: 1,
    kid,
    private_key_pem: privateKeyPem,
    public_key_fingerprint: computePublicKeyFingerprint(privateKeyPem),
  };
  secureStore.setSecret(SIGNING_STORE_ACCOUNT, JSON.stringify(envelope));
  removeLegacyShadowingArtefacts();
}

/**
 * Resolve the signing credential with full provenance.
 *
 * Resolution order (the secure store ALWAYS wins over plaintext):
 *   1. Secure-store envelope (v1 JSON: kid + key + fingerprint).
 *   2. Secure-store bare PEM (legacy format, pre-envelope: no binding
 *      metadata available).
 *   3. Legacy plaintext file migration (one-time, crash-safe): write it
 *      into the store, confirm the store holds it, THEN remove the
 *      plaintext file. Never removes before store-write is confirmed.
 */
export function readSigningCredential(): ResolvedSigningCredential | null {
  // Fast path: already in the secure store.
  const stored = secureStore.getSecret(SIGNING_STORE_ACCOUNT);
  if (stored !== null) {
    const source = describeStoreEntry(SIGNING_STORE_ACCOUNT);
    if (stored.trimStart().startsWith('{')) {
      try {
        const env = JSON.parse(stored) as Partial<SigningCredentialEnvelope>;
        if (
          typeof env.private_key_pem === 'string' &&
          typeof env.kid === 'string'
        ) {
          return {
            privateKeyPem: env.private_key_pem,
            kid: env.kid,
            recordedFingerprint:
              typeof env.public_key_fingerprint === 'string'
                ? env.public_key_fingerprint
                : undefined,
            source,
          };
        }
      } catch {
        // Not a parseable envelope, fall through to bare-PEM handling.
      }
    }
    // Legacy bare-PEM store value (pre-envelope): no binding metadata.
    return { privateKeyPem: stored, source };
  }

  // Migration: check for legacy plaintext file.
  // Use activeSigningKeyFile() (call-time) rather than SIGNING_KEY_FILE
  // (module-load-time) so tests that redirect XDG_CONFIG_HOME after module
  // load see the correct path.
  const legacyPath = activeSigningKeyFile();
  let legacy: string | null = null;
  try {
    legacy = fs.readFileSync(legacyPath, 'utf-8');
  } catch {
    return null; // neither store nor legacy file - key not present
  }

  // Migrate into the secure store. Confirm exact match before removing plaintext.
  // Fix 3: compare === legacy (not just !== null) to catch truncated writes.
  // Fix 4: try/catch so a transient OS store failure keeps the CLI functional.
  try {
    secureStore.setSecret(SIGNING_STORE_ACCOUNT, legacy);
  } catch {
    console.error("warning: could not migrate signing-key into secure store; using legacy file");
    return { privateKeyPem: legacy, source: legacyPath };
  }
  const confirmed = secureStore.getSecret(SIGNING_STORE_ACCOUNT);
  if (confirmed === legacy) {
    // Store confirmed with exact match - securely remove the plaintext file
    // (zero-overwrite + unlink; see secureUnlinkSync for the CoW caveat).
    try {
      secureUnlinkSync(legacyPath);
    } catch {
      // Best-effort; leaving the plaintext is safe relative to losing the key.
    }
  }
  // If confirmed !== legacy (truncation/corruption), we keep the plaintext and
  // return legacy so the caller still has the key.
  return { privateKeyPem: legacy, source: legacyPath };
}

/**
 * Read the ES256 signing private key PEM from the OS secure store.
 *
 * UNBOUND read: returns the key without verifying it against the
 * session's kid. Signing call-sites must use resolveBoundSigningKey()
 * instead; this remains for reuse-at-login (where a NEW kid is about to
 * be registered for whatever key exists) and for the migration tests.
 */
export function readPrivateKeyPem(): string | null {
  return readSigningCredential()?.privateKeyPem ?? null;
}

/**
 * Resolve the signing private key AND verify it is the key the session's
 * kid was issued against. This is the only correct entry point for any
 * code path that is about to sign with `session.signing_kid`.
 *
 * Checks, in order (each failure throws SigningKeyMismatchError; the
 * caller must surface the error, NEVER fall back to another key):
 *   1. Envelope self-consistency: the stored fingerprint matches the
 *      stored key (detects a corrupted or tampered record).
 *   2. kid binding: the kid stored alongside the key equals the kid the
 *      session carries.
 *   3. Fingerprint binding: the resolved key's public fingerprint equals
 *      the fingerprint the session recorded at login (covers legacy and
 *      cross-store split-brain, e.g. a stale plaintext key picked up
 *      after a secure-store backend flip).
 *
 * A legacy credential with no binding metadata AND a session with no
 * recorded fingerprint cannot be verified; it is returned as-is for
 * backwards compatibility, and the next `alter login` upgrades it to the
 * bound envelope format.
 *
 * Returns null when no key exists at all.
 */
export function resolveBoundSigningKey(session: {
  signing_kid?: string;
  signing_key_fingerprint?: string;
}): string | null {
  const cred = readSigningCredential();
  if (cred === null) return null;

  const sessionSource = describeStoreEntry(SESSION_STORE_ACCOUNT);
  const wantsCheck =
    cred.recordedFingerprint !== undefined ||
    session.signing_key_fingerprint !== undefined;
  const fingerprint = wantsCheck
    ? computePublicKeyFingerprint(cred.privateKeyPem)
    : undefined;

  if (
    cred.recordedFingerprint !== undefined &&
    cred.recordedFingerprint !== fingerprint
  ) {
    throw new SigningKeyMismatchError(
      `signing key mismatch: the stored credential record (from ${cred.source}) pairs kid ${cred.kid} with key fingerprint ${cred.recordedFingerprint}, but the key it holds fingerprints as ${fingerprint}; the record is corrupt. Run \`alter login\` to re-pair.`,
    );
  }
  if (
    cred.kid !== undefined &&
    session.signing_kid !== undefined &&
    cred.kid !== session.signing_kid
  ) {
    throw new SigningKeyMismatchError(
      `signing key mismatch: session kid ${session.signing_kid} (from ${sessionSource}) does not match stored credential kid ${cred.kid} (from ${cred.source}); run \`alter login\` to re-pair.`,
    );
  }
  if (
    session.signing_key_fingerprint !== undefined &&
    session.signing_key_fingerprint !== fingerprint
  ) {
    throw new SigningKeyMismatchError(
      `signing key mismatch: session kid ${session.signing_kid} (from ${sessionSource}) was issued for key fingerprint ${session.signing_key_fingerprint}, but the resolved key (from ${cred.source}) fingerprints as ${fingerprint}; run \`alter login\` to re-pair.`,
    );
  }
  return cred.privateKeyPem;
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

export interface InvocationClaims {
  tool: string;
  args_sha256: string;
  nonce: string;
  iat: number;
  iss: string;
}

export interface SignInvocationOptions {
  kid: string;
  /** PEM-encoded PKCS#8 or SEC1 EC private key. */
  privateKeyPem: string;
  handle: string;
  nonce?: string;
  iatSeconds?: number;
}

function b64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf-8') : input;
  return buf.toString('base64url');
}

/**
 * Produce an `Mcp-Invocation-Signature` header value.
 *
 * Algorithm: ES256 (ECDSA on P-256, signed over SHA-256 of the
 * signing input). Signature encoding: JOSE "compact" (r||s, 64
 * bytes). Node's default `crypto.sign` on an EC key produces DER; we
 * convert to JOSE here.
 */
export function signInvocation(
  toolName: string,
  toolArgs: Record<string, unknown>,
  options: SignInvocationOptions,
): string {
  const nonce = options.nonce ?? crypto.randomBytes(24).toString('base64url');
  const iat = options.iatSeconds ?? Math.floor(Date.now() / 1000);

  const claims: InvocationClaims = {
    tool: toolName,
    args_sha256: canonicalArgsSha256(toolArgs ?? {}),
    nonce,
    iat,
    iss: options.handle,
  };

  const headerB64 = b64url(JSON.stringify({ alg: 'ES256', kid: options.kid }));
  const payloadB64 = b64url(JSON.stringify(claims));
  const signingInput = `${headerB64}.${payloadB64}`;

  const signer = crypto.createSign('SHA256');
  signer.update(signingInput);
  const derSig = signer.sign({
    key: options.privateKeyPem,
    dsaEncoding: 'ieee-p1363', // JOSE compact - 64 bytes (r||s) for P-256.
  });
  if (derSig.length !== 64) {
    throw new Error(`unexpected ES256 signature length ${derSig.length}`);
  }
  return `${signingInput}.${b64url(derSig)}`;
}

// ---------------------------------------------------------------------------
// Registration (alter login hook)
// ---------------------------------------------------------------------------

export interface SigningKeyRegistration {
  id: string;
  kid: string;
  alg: string;
  api_key_id: string;
  handle: string | null;
  created_at: string;
  revoked_at: string | null;
}

/**
 * Register a public key with the server. The caller MUST pass a valid
 * MCP API key header value (an `alt_live_*` or member-key). Returns
 * the server's registration record (including the assigned kid).
 */
export async function registerSigningKey(params: {
  api: string;
  apiKey: string;
  publicKeyPem: string;
  kid?: string;
  /**
   * Durable validator-device attestation (optional, independent of each
   * other's presence). Both fields come from the TPM2 device-sign helper
   * (see lib/device-sign.ts); when the helper is absent, untrusted, or
   * fails, the caller simply omits both and this request is byte-identical
   * to a pre-device-countersignature registration. The server verifies the
   * countersignature itself (agent_keys.py, landed) - the CLI never
   * validates it, only passes through what the helper returned.
   */
  devicePublicKeyPem?: string;
  deviceCountersignature?: string;
  fetchImpl?: typeof fetch;
  /** Override retry behaviour - tests inject a no-op sleep to avoid waiting. */
  retryOptions?: Omit<FetchWithRetryOptions, 'fetchImpl'>;
}): Promise<SigningKeyRegistration> {
  const resp = await fetchWithRetry(
    `${params.api}/api/v1/agents/keys`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ALTER-API-Key': params.apiKey,
      },
      body: JSON.stringify({
        public_key_pem: params.publicKeyPem,
        ...(params.kid ? { kid: params.kid } : {}),
        ...(params.devicePublicKeyPem
          ? { device_public_key_pem: params.devicePublicKeyPem }
          : {}),
        ...(params.deviceCountersignature
          ? { device_countersignature: params.deviceCountersignature }
          : {}),
      }),
    },
    { fetchImpl: params.fetchImpl, ...params.retryOptions },
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `agent_keys register failed: ${resp.status} ${text.slice(0, 200)}`,
    );
  }
  return (await resp.json()) as SigningKeyRegistration;
}
