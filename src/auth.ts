/**
 * Shared ALTER auth library.
 *
 * ONE session store. MANY consumers.
 * All ALTER tools read from ~/.config/alter/session.json.
 * Only `alter login` writes to it.
 *
 * Consumers: the alter CLI, the MCP bridge, and shell hooks.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import {
  secureStore,
  secureUnlinkSync,
  setSecretWriteThrough,
  deleteSecretWriteThrough,
  secretFreshnessSig,
  healEncFileMirrorResidue,
  lastSecretReadFault,
} from "./secure-store.js";

// ---------------------------------------------------------------------------
// Paths (XDG-compliant)
// ---------------------------------------------------------------------------

const XDG_CONFIG =
  process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");

export const ALTER_CONFIG_DIR = path.join(XDG_CONFIG, "alter");
export const SESSION_FILE = path.join(ALTER_CONFIG_DIR, "session.json");
export const IDENTITY_FILE = path.join(ALTER_CONFIG_DIR, "identity.json");
export const STATUS_SNAPSHOT_FILE = path.join(
  ALTER_CONFIG_DIR,
  "last-status-snapshot.json",
);

/**
 * Resolve the active session-file path, re-reading
 * `XDG_CONFIG_HOME` at call-time. Tests that point the env var at
 * a tmp dir need this behaviour so the schema-validation paths
 * are exercised without poking at the developer's real
 * `~/.config/alter/session.json`. Production callers can keep
 * using the static `SESSION_FILE` constant - they hit the same
 * value, just resolved once at module load.
 */
function activeSessionFile(): string {
  const xdg =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdg, "alter", "session.json");
}

function activeIdentityFile(): string {
  const xdg =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdg, "alter", "identity.json");
}

function activeStatusSnapshotFile(): string {
  const xdg =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdg, "alter", "last-status-snapshot.json");
}

function activeConfigDir(): string {
  const xdg =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdg, "alter");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrgMembership {
  domain: string;
  role: string;
  tier: "trusted" | "supervised" | "observer";
}

export interface AlterSession {
  handle: string;
  api: string;
  jwt: string;
  id_token?: string;
  refresh_token?: string;
  jwt_expires_at: string;
  refresh_expires_at?: string;
  consent_tier: string;
  user_id: string;
  email: string;
  orgs: OrgMembership[];
  logged_in_at: string;
  /**
   * Layer-0 member credential - a member-scoped MCP API key minted by
   * `POST /api/v1/auth/member-key` immediately after a successful OAuth
   * exchange. Consumers (the MCP bridge, shell hooks) read this field and
   * present it as `X-ALTER-API-Key` when calling the public MCP server,
   * which turns identity-shaped personal-alter tools into authenticated
   * own-behalf reads.
   *
   * Optional for backwards compatibility: older sessions produced
   * before the endpoint existed won't carry this field, and the client
   * must fall back to unauthenticated calls in that case.
   */
  member_api_key?: string;
  /** Display prefix of the active member key (for revocation UX). */
  member_api_key_display_prefix?: string;
  /**
   * Server-assigned signing-key id. Every MCP `tools/call` the
   * CLI issues must carry an `Mcp-Invocation-Signature` JWS signed by
   * the private key at `~/.config/alter/signing-key.pem` and
   * identifying this kid. Minted during `alter login` right after the
   * member key.
   */
  signing_kid?: string;
  /**
   * SHA-256 hex fingerprint (over the SPKI DER public half) of the key
   * `signing_kid` was issued against, recorded at login. Signing
   * resolution (signing.ts:resolveBoundSigningKey) refuses to sign when
   * the resolved private key does not fingerprint to this value: the
   * guard against credential split-brain where a stale on-disk key
   * shadows the store the kid was paired with. Optional for backwards
   * compatibility: sessions minted before this field cannot be
   * fingerprint-verified until the next login.
   */
  signing_key_fingerprint?: string;
  /** Space-delimited OAuth scopes actually granted by the server. */
  granted_scopes?: string;
  /**
   * The member's `members.id` PK - persisted from the login response's
   * `member_id` field (= `APIKey.delegated_member_id`). NULL for admin
   * keys; present for every member-scoped key. This is the identity key
   * for doctrine projection and must NEVER be confused with `user_id`
   * (which is the User PK, not the member PK).
   *
   * Optional for backwards compatibility: older sessions produced before
   * this field was added will lack it. Call `backfillMemberId()` to
   * attempt a one-time fetch via `alter_whoami` for those sessions.
   */
  member_id?: string | null;
}

export interface AlterIdentity {
  handle: string;
  attunement: number;
  engagement_level: number;
  engagement_label: string;
  has_alter: boolean;
  ceremony_complete: boolean;
  last_refreshed: string;
}

/**
 * Snapshot of the values the status card renders, taken at the end of
 * every `alter status` invocation. The next run can diff against the
 * previous snapshot to show "+X% attunement, +$Y earnings, +N queries
 * since last visit" - the recurring "yes ALTER is doing something"
 * signal that closes the visibility loop without a web dashboard.
 *
 * Snapshot fields are derived from the live API responses, not cached:
 * `alter status` always re-fetches before computing the diff. The on-disk
 * file is the prior; the live response is the current.
 */
export interface StatusSnapshot {
  taken_at: string;
  /**
   * Bound `~handle` the snapshot belongs to, stamped from the live session
   * at write time. The snapshot file lives at a fixed path keyed only on
   * XDG/home, so a same-machine identity switch (log out of ~a, log in as ~b)
   * would otherwise surface ~a's cached numbers under ~b's status card.
   * `readStatusSnapshot` discards the snapshot when this does not match the
   * current session's handle, so the prior member's figures never bleed into
   * the new member's "since last check" diff or menu depth fallback.
   *
   * ABSENT on legacy snapshots written before this field existed; a missing
   * handle is treated as a mismatch (discard) so the first read after the
   * upgrade re-baselines rather than trusting an unowned snapshot.
   */
  handle?: string;
  attunement: number | null;
  balance_cents: number;
  total_earned: number;
  transaction_count: number;
  trait_count: number;
  /**
   * Engagement level (0-4, Explorer→Deployed) as carried by the
   * namespaced JWT claim at snapshot time. ABSENT when the access
   * token carried no claim - never written as a default, so a
   * missing value stays "unknowable" rather than masquerading as
   * Explorer. Read as a last-resort fallback by
   * `resolveEngagementLevel` (src/lib/member-depth.ts) so the menu
   * still knows the member's depth after a token rotation drops the
   * claim or when identity.json was never written.
   */
  engagement_level?: number;
  /**
   * Identifier of the next-best-action primary suggestion last rendered to
   * the member (`onboarding/next-action-report.ts:pendingSuggestionFields`),
   * paired with the timestamp it was shown. Present only while a report of
   * what happened next is still owed; cleared once reported. ABSENT when no
   * suggestion has been rendered, never written as an empty string.
   */
  pending_suggestion_id?: string;
  /** Timestamp `pending_suggestion_id` was rendered. Present iff it is. */
  pending_suggestion_at?: string;
  /**
   * Guided-walkthrough progress captured by the last `alter status` read
   * that carried a `walkthrough` projection
   * (`onboarding/walkthrough.ts:walkthroughSnapshotFields`), so the menu
   * header can show a step teaser with zero extra network on its
   * synchronous render path - the same contract `attunement` /
   * `transaction_count` / `total_earned` already honour. Present only as a
   * pair; a snapshot with one but not the other is treated as neither
   * being set. ABSENT when no walkthrough was carried on the last run,
   * never written as zero.
   */
  walk_completed?: number;
  /** Countable rungs in the walk (excludes the terminal "explore" rung). */
  walk_total?: number;
}

// ---------------------------------------------------------------------------
// Session I/O
// ---------------------------------------------------------------------------

export function ensureConfigDir(): void {
  fs.mkdirSync(activeConfigDir(), { recursive: true, mode: 0o700 });
}

/**
 * Crash-safe, race-free file write: serialise into a uniquely-named
 * temp file in the *same directory* as the target, fsync it for
 * durability, then `rename(2)` it over the target. POSIX `rename`
 * within one filesystem is atomic - a concurrent reader sees either
 * the old inode or the new one in full, never a truncated prefix or
 * zero bytes. A writer killed before the rename leaves only an orphan
 * `.tmp.*` file; the live target is never opened with `O_TRUNC`, so
 * an interrupted write can't destroy it.
 *
 * The temp file is created 0o600 and `rename` preserves mode, so the
 * caller doesn't need a follow-up `chmod`.
 */
function atomicWriteFileSync(file: string, data: string): void {
  const tmp = `${file}.tmp.${process.pid}.${crypto
    .randomBytes(6)
    .toString("hex")}`;
  try {
    fs.writeFileSync(tmp, data, { encoding: "utf-8", mode: 0o600 });
    fs.chmodSync(tmp, 0o600); // belt-and-braces - honour 0o600 even under a lax umask
    // Windows: libuv maps fs.fsyncSync to FlushFileBuffers, which rejects
    // read-only handles with ERROR_ACCESS_DENIED (surfaces as EPERM).
    // "r+" gives the handle write permission; POSIX accepts fsync on
    // either flag, so Linux/macOS behaviour is unchanged.
    //
    // Even with "r+", some Windows hosts still surface EPERM/EACCES on
    // FlushFileBuffers (Defender Controlled Folder Access, AV scanners,
    // AppLocker policies on %USERPROFILE%\.config). The atomic rename
    // below is kernel-serialised regardless; we lose only the explicit
    // pre-rename volume-cache flush. The user can always re-run `alter
    // login` to regenerate session state on power loss, so the trade is
    // acceptable. Mirror of x25519.ts:writeX25519PrivateKeyPem.
    const fd = fs.openSync(tmp, "r+");
    try {
      fs.fsyncSync(fd); // durable on disk before we expose it via rename
    } catch (fsyncErr) {
      const code = (fsyncErr as NodeJS.ErrnoException).code;
      if (
        process.platform === "win32" &&
        (code === "EPERM" || code === "EACCES")
      ) {
        console.error(
          `notice: skipped fsync on Windows (${code}); relying on atomic rename for durability`,
        );
      } else {
        throw fsyncErr;
      }
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file); // atomic replace - same dir, same filesystem
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best-effort cleanup; the orphan tmp is harmless
    }
    throw err;
  }
}

/** Secure store account key for the session blob. */
const SESSION_STORE_ACCOUNT = "session";

export function writeSession(session: AlterSession): void {
  // GUARD 1: fail-closed sentinel write-path refusal.
  // A sentinel / fixture session (far-future jwt_expires_at year >= 2090, or
  // missing member_api_key) must NEVER reach the real secure store. A test
  // run or a fixture writer that accidentally calls writeSession with a
  // sentinel would silently clobber the member's real session in BOTH backends
  // (OS keyring + encrypted-file mirror), logging them out and producing the
  // exact failure observed in the incident: writeSession was the clobber
  // vector. Fail-closed here regardless of caller context.
  if (isSentinelSession(session)) {
    const year = new Date(session.jwt_expires_at).getUTCFullYear();
    const reason = year >= SENTINEL_YEAR_THRESHOLD
      ? `jwt_expires_at year ${year} is a sentinel/test fixture (threshold: ${SENTINEL_YEAR_THRESHOLD})`
      : "member_api_key is absent (keyless fixture session)";
    process.stderr.write(
      `\nalter: SECURITY: writeSession REFUSED to persist a sentinel session.\n` +
      `  Reason: ${reason}.\n` +
      `  A sentinel or keyless session must never be written to the real secure store.\n` +
      `  If you need a test fixture, use a temp XDG_CONFIG_HOME dir + ALTER_SECURE_STORE_BACKEND=file.\n\n`,
    );
    throw new Error(
      `writeSession: refusing to persist a sentinel/keyless session (${reason}). ` +
      `This is a security guard: test fixtures must use an isolated config dir.`,
    );
  }
  ensureConfigDir();
  // Write-through: the session blob lands in BOTH the selected backend and
  // the encrypted-file fallback. Backend selection is per-process and
  // environment-sensitive (keyring in a desktop session, encrypted file
  // over SSH / in hooks), so a single-backend write left the fallback copy
  // stale after every rotation: the keyring-fresh / enc-stale split-brain
  // behind "you need to login" while logged in.
  setSecretWriteThrough(
    SESSION_STORE_ACCOUNT,
    JSON.stringify(session, null, 2) + "\n",
  );
  // The session memo self-invalidates via its freshness signature (this write
  // changes the enc-mirror mtime), so the next readSession() re-reads the
  // freshly written session without any explicit memo poke here.
}

/**
 * @internal - writes PLAINTEXT session JSON to an explicit path. Never call
 * from production code.
 *
 * This tag predates `stripInternal`, which was turned on in tsconfig.public.json
 * for a different reason (keeping a shared table's test seam out of the
 * published declarations). It was written as a warning to humans and is now
 * also a strip directive, so `writeSessionTo` no longer appears in the shipped
 * `auth.d.ts` while its implementation still exports from `auth.js`. A publish
 * gate caught the change and asked for it to be deliberate rather than
 * discovered later, so: it is deliberate, and it is correct. A function that
 * writes a plaintext session to an arbitrary path has no business in a public
 * type surface, and nothing in the shipped artefact imports it.
 *
 * The only legitimate callers are:
 *   • the test suite (redirects XDG_CONFIG_HOME to a tmp dir)
 *   • internal tooling (act-as impersonation only)
 *
 * Production code always uses writeSession(), which routes through the OS
 * secure store backend (DPAPI / Keychain / libsecret / AES-256-GCM file).
 *
 * Do NOT call this with a path outside ALTER_CONFIG_DIR; caller-supplied
 * paths are not sanitised beyond the directory bootstrap.
 */
export function writeSessionTo(filePath: string, session: AlterSession): void {
  // GUARD 1 (defence-in-depth): sentinel guard on the internal write path too.
  // Even though writeSessionTo is test-only, a sentinel must never be persisted
  // at any path within the config dir. This ensures a test author using the
  // internal helper cannot accidentally drop a sentinel that writeSession (the
  // real path) would now refuse.
  if (isSentinelSession(session)) {
    const year = new Date(session.jwt_expires_at).getUTCFullYear();
    const reason = year >= SENTINEL_YEAR_THRESHOLD
      ? `jwt_expires_at year ${year} is a sentinel/test fixture`
      : "member_api_key is absent (keyless fixture session)";
    throw new Error(
      `writeSessionTo: refusing to write a sentinel/keyless session (${reason}). ` +
      `Use a non-sentinel fixture or an isolated config dir (XDG_CONFIG_HOME).`,
    );
  }
  ensureConfigDir();
  // Defence-in-depth: this writes PLAINTEXT session JSON (jwt + refresh +
  // member key). Even though it is documented test-only, refuse any path
  // outside the ALTER config dir so a future/compromised caller cannot use it
  // to drop credentials at a world-readable or attacker-chosen location.
  const resolved = path.resolve(filePath);
  const allowedBases = [
    path.resolve(ALTER_CONFIG_DIR),
    path.resolve(activeConfigDir()),
  ];
  const within = allowedBases.some(
    (base) => resolved === base || resolved.startsWith(base + path.sep),
  );
  if (!within) {
    throw new Error(
      "writeSessionTo: refusing to write a plaintext session outside the Alter config dir",
    );
  }
  // writeSessionTo is a test-support helper. When the secure-store backend
  // honours ALTER_SECURE_STORE_BACKEND=file (as tests set it), both paths
  // work. For production callers writeSession() should always be used.
  atomicWriteFileSync(filePath, JSON.stringify(session, null, 2) + "\n");
}

/**
 * Raised when `session.json` parses as JSON but fails schema
 * validation. Surfaces a clear path to recovery (`alter login`)
 * rather than letting a malformed handle / api / jwt propagate
 * silently into downstream consumers.
 */
export class BadSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadSessionError";
  }
}

const HANDLE_RE = /^~[a-z][a-z0-9._-]{0,62}$/;

/**
 * Sessions whose jwt_expires_at year is at or above this threshold are
 * sentinel / test fixtures and must never be accepted as a live credential.
 * Year 2099 is the canonical test sentinel (test_session_schema.ts).
 * Any year ≥ SENTINEL_YEAR_THRESHOLD is treated as a sentinel regardless of
 * origin: a real auth server never issues a token that far in the future.
 */
const SENTINEL_YEAR_THRESHOLD = 2090;

/**
 * Return true when the session looks like a sentinel or test fixture that
 * must not be used as a real credential:
 *   - jwt_expires_at year >= SENTINEL_YEAR_THRESHOLD (far-future fixture), or
 *   - handle is non-anonymous but member_api_key is absent (keyless session
 *     cannot authenticate against the MCP layer; it will degrade to L1).
 *
 * Exported so tests and the doctor surface can call it directly.
 */
export function isSentinelSession(s: AlterSession): boolean {
  const year = new Date(s.jwt_expires_at).getUTCFullYear();
  if (year >= SENTINEL_YEAR_THRESHOLD) return true;
  // A session with a valid handle but no member_api_key will always present
  // as L1. The MCP layer has no key to authenticate with. Flag it so
  // ensureFreshSession is not short-circuited by a "fresh" far-future expiry.
  if (!s.member_api_key) return true;
  return false;
}

function validateSessionShape(s: unknown): AlterSession {
  if (s === null || typeof s !== "object") {
    throw new BadSessionError("session.json: not a JSON object");
  }
  const o = s as Record<string, unknown>;
  const handle = o.handle;
  if (typeof handle !== "string" || handle.length === 0 || !HANDLE_RE.test(handle)) {
    throw new BadSessionError(
      "session.json: 'handle' must match ~[a-z][a-z0-9._-]{0,62}",
    );
  }
  const api = o.api;
  if (typeof api !== "string" || api.length === 0 || !api.startsWith("https://")) {
    throw new BadSessionError(
      "session.json: 'api' must be a non-empty https:// URL",
    );
  }
  const jwt = o.jwt;
  if (typeof jwt !== "string" || jwt.split(".").length !== 3) {
    throw new BadSessionError(
      "session.json: 'jwt' must be a three-segment compact JWS",
    );
  }
  const exp = o.jwt_expires_at;
  if (typeof exp !== "string" || Number.isNaN(Date.parse(exp))) {
    throw new BadSessionError(
      "session.json: 'jwt_expires_at' must be an ISO-8601 timestamp",
    );
  }
  return s as AlterSession;
}

/**
 * Why the last parse of stored session content yielded no session, when content
 * WAS present. Null means the parse succeeded, or no parse was attempted.
 * Recorded rather than logged so each read path announces it once, in its own
 * words; see the JSON branch in parseSessionContent.
 */
let _lastParseFault: string | null = null;

/**
 * Parse and validate raw session JSON content.
 * Shared between the secure-store and legacy-file read paths.
 *
 * Returns null (not a BadSessionError throw) for sentinel/keyless sessions
 * so callers treat them as "no valid session" and do not short-circuit refresh.
 * A LOUD warning is emitted so the next occurrence is visible rather than
 * silently degrading to L1 (remediation item d).
 *
 * Every null return records _lastParseFault, because "content was present and
 * did not yield a session" is a different state from "nothing was there", and
 * only the caller knows which store the content came from.
 */
function parseSessionContent(content: string): AlterSession | null {
  _lastParseFault = null;
  // PowerShell 5.1 Set-Content -Encoding UTF8 injects a BOM that breaks JSON.parse
  let c = content;
  if (c.charCodeAt(0) === 0xFEFF) c = c.slice(1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(c);
  } catch (err) {
    // Record, do not log. This function serves BOTH read paths, and the legacy
    // path already announces a bad file loudly when it quarantines it below;
    // logging here too would say it twice. The secure-store path, which has no
    // quarantine step, does the announcing at its own call site. Either way the
    // fault is no longer silent, which was the defect: content IS present and
    // unparseable, and that is not the same state as nothing being there.
    _lastParseFault = `stored session content is not valid JSON (${(err as Error).message})`;
    return null;
  }
  let session: AlterSession;
  try {
    session = validateSessionShape(parsed);
  } catch (err) {
    // Parsed, but not a session. Still "present and unusable", never "absent",
    // so it records a fault alongside the warning this branch already emits.
    _lastParseFault = `stored session failed validation (${(err as Error).message})`;
    if (err instanceof BadSessionError) {
      console.error(`alter: ${err.message}. Run 'alter login' to repair.`);
      return null;
    }
    return null;
  }
  // Sentinel/keyless guard (remediation items b + d): reject far-future
  // fixture sessions and sessions missing member_api_key. Emit a loud
  // warning so degraded state is visible rather than silent L1 display.
  if (isSentinelSession(session)) {
    const year = new Date(session.jwt_expires_at).getUTCFullYear();
    // A rejected sentinel/keyless session is also present-and-unusable, not
    // absent. It already warns loudly; the fault record is what lets `doctor`
    // name the state instead of reporting an empty store.
    _lastParseFault = "stored session was rejected (sentinel fixture, or missing member_api_key)";
    if (year >= SENTINEL_YEAR_THRESHOLD) {
      console.error(
        `alter: WARNING: session rejected. jwt_expires_at year ${year} looks like a test fixture (sentinel). Run 'alter login' to obtain a real session.`,
      );
    } else {
      console.error(
        `alter: WARNING: session rejected. member_api_key is missing; this session will degrade to L1. Run 'alter login' to re-provision.`,
      );
    }
    return null;
  }
  return session;
}

// In-process session memo (Windows DPAPI stall fix).
// readSession() is invoked 12+ times per command; on Windows each call shells
// out to PowerShell via DPAPI (secure-store.ts dpapiGet), so the uncached path
// turned every command into a multi-spawn stall - the #1 Windows-only freeze.
// The memo collapses that to ONE store read while the on-disk session is
// unchanged. Correctness comes from a cheap, spawn-free freshness signature
// (secretFreshnessSig stats the enc mirror; we also stat the legacy plaintext
// file): the memo is reused only while that signature matches. A fresh login
// or token rotation (this process OR a sibling), a logout, or a config-dir
// swap (XDG_CONFIG_HOME redirection in tests) all change the signature and
// force a re-read - so the memo can never serve a stale session. `undefined` =
// not yet read; `null` = read-as-absent.
let _sessionMemo: AlterSession | null | undefined;
let _sessionMemoSig: string | undefined;

/**
 * Why the last uncached session read yielded no session, when a credential WAS
 * present. Null means either a session was read, or the store is genuinely
 * empty. Set only by readSessionUncached, so it tracks the same read the memo
 * caches and never drifts from it.
 */
let _lastSessionFault: string | null = null;

/** One stderr notice per distinct session fault; see noticeSecretFault. */
const _sessionFaultNoticed = new Set<string>();
function noticeSessionFault(detail: string): void {
  if (_sessionFaultNoticed.has(detail)) return;
  _sessionFaultNoticed.add(detail);
  console.error(
    `alter: WARNING: ${detail}. Run 'alter login' to replace it.`,
  );
}

/**
 * What state the stored session credential is actually in.
 *
 * `readSession()` answers "do I have a usable session", which is the right
 * question for the 37 call sites that gate on it and the reason its signature
 * stays as it is. It is the wrong question for a diagnostic, because it returns
 * null for two states that need different things said about them: nothing is
 * stored, versus something is stored and cannot be read. Anything reporting
 * state to a human should ask this instead.
 *
 * The other states a credential can be in are already distinguished elsewhere
 * and are deliberately not duplicated here: expired is `identity.jwt-fresh`,
 * and valid-but-refused-by-the-server is sessionRejectedMessage().
 */
export type SessionDiagnosis =
  | { state: "valid"; session: AlterSession }
  | { state: "absent" }
  | { state: "unreadable"; reason: string };

export function diagnoseSession(): SessionDiagnosis {
  // Deliberately the FRESH read: the memo would serve a cached null without
  // re-running the read that records the fault, and a diagnostic that reports
  // from a cache is the class of thing this function exists to correct.
  const session = readSessionFresh();
  if (session !== null) return { state: "valid", session };
  if (_lastSessionFault !== null) {
    return { state: "unreadable", reason: _lastSessionFault };
  }
  return { state: "absent" };
}

/**
 * Cheap, spawn-free signature of the on-disk session under the CURRENT config
 * dir. Combines the secure-store enc-mirror signature with the legacy
 * plaintext file's stat (the pre-migration source, and the path tests write).
 */
function sessionFreshnessSig(): string {
  let legacy = "absent";
  try {
    const st = fs.statSync(activeSessionFile());
    legacy = `${st.mtimeMs}:${st.size}`;
  } catch {
    // No legacy plaintext file - common after migration.
  }
  return `${secretFreshnessSig(SESSION_STORE_ACCOUNT)}|legacy:${legacy}`;
}

export function readSession(): AlterSession | null {
  const sig = sessionFreshnessSig();
  if (_sessionMemo !== undefined && _sessionMemoSig === sig) {
    return _sessionMemo;
  }
  _sessionMemo = readSessionUncached();
  // Re-stat AFTER the read: readSessionUncached may migrate a legacy file into
  // the store, changing the on-disk state. Capturing the post-read signature
  // means the next call hits the memo instead of re-reading the migration it
  // just performed.
  _sessionMemoSig = sessionFreshnessSig();
  return _sessionMemo;
}

/**
 * Force a fresh re-read on the next readSession() by dropping the memo. The
 * freshness signature already invalidates on any on-disk change, so this is
 * belt-and-braces for the concurrent-rotation re-read sites where observing a
 * sibling process's just-written session is the explicit intent.
 */
export function readSessionFresh(): AlterSession | null {
  _sessionMemo = undefined;
  _sessionMemoSig = undefined;
  return readSession();
}

function readSessionUncached(): AlterSession | null {
  _lastSessionFault = null;
  // Fast path: try the secure store first.
  const stored = secureStore.getSecret(SESSION_STORE_ACCOUNT);
  if (stored !== null) {
    const session = parseSessionContent(stored);
    if (session === null) {
      // The store handed back content and it did not yield a session. Unlike
      // the legacy path below there is no quarantine step here to announce it,
      // so this is where that silence gets broken. Falling through quietly is
      // what let `doctor` go on to report an empty store.
      _lastSessionFault =
        _lastParseFault ?? "stored session content could not be read";
      noticeSessionFault(_lastSessionFault);
    }
    return session;
  }

  // getSecret() returned null. That is ordinarily a true absence, but it is
  // also what a store read returns when a credential IS present and could not
  // be decrypted or read. Note which it was, but do NOT return here: an
  // unreadable store blob is exactly when the legacy-file fallback below is
  // most worth trying, and a recovery path must not be spent buying a
  // diagnosis. The fault is applied only if that fallback also comes up empty.
  const storeFault = lastSecretReadFault();
  const storeFaultDetail =
    storeFault !== null && storeFault.account === SESSION_STORE_ACCOUNT
      ? storeFault.detail
      : null;

  // Split-brain self-heal: the authoritative selected backend holds NO session,
  // so any encrypted-file MIRROR copy is stale residue from a prior incomplete
  // logout. Wipe it here so no later keyring-less process can resurrect it as a
  // false "already logged in" short-circuit. No-op when the selected backend IS
  // the encrypted-file store (there the mirror is authoritative, never residue).
  if (healEncFileMirrorResidue(SESSION_STORE_ACCOUNT)) {
    process.stderr.write(
      "alter: WARNING: removed a stale encrypted-file session mirror left by a prior incomplete logout.\n",
    );
  }

  // Migration: check for legacy plaintext session.json.
  let legacy: string | null = null;
  const legacyPath = activeSessionFile();
  try {
    legacy = fs.readFileSync(legacyPath, "utf-8");
  } catch {
    // Neither store nor legacy file. If the store read faulted, "not logged in"
    // is the wrong thing to say about it: a credential IS there and could not
    // be read, and nothing recovered it. That is the state to report.
    if (storeFaultDetail !== null) {
      _lastSessionFault = storeFaultDetail;
      noticeSessionFault(storeFaultDetail);
    }
    return null;
  }

  const session = parseSessionContent(legacy);
  if (session === null) {
    // Plaintext is present but invalid (bad shape, sentinel, or keyless).
    // Quarantine it to a .legacy-residue sidecar so it cannot be re-read
    // and migrated on the next invocation (remediation item a + b).
    // This path announces itself when it quarantines, so it records the fault
    // without a second notice.
    _lastSessionFault =
      _lastParseFault ?? "legacy session.json was present but unreadable";
    const residuePath = `${legacyPath}.legacy-residue`;
    try {
      fs.renameSync(legacyPath, residuePath);
      console.error(
        `alter: WARNING: legacy session.json was invalid or a sentinel fixture. Quarantined to ${residuePath}. Run 'alter login' to obtain a real session.`,
      );
    } catch {
      // Best-effort quarantine; leave it in place rather than lose it.
    }
    return null;
  }

  // Migrate into the secure store. Confirm exact match before removing plaintext.
  // Fix 3: compare === legacy (not just !== null) to catch truncated writes.
  // Fix 4: try/catch so a transient OS store failure keeps the CLI functional.
  const legacyBlob = JSON.stringify(session, null, 2) + "\n";
  try {
    setSecretWriteThrough(SESSION_STORE_ACCOUNT, legacyBlob);
  } catch {
    console.error("warning: could not migrate session into secure store; using legacy file");
    return session;
  }
  const confirmed = secureStore.getSecret(SESSION_STORE_ACCOUNT);
  if (confirmed === legacyBlob) {
    // Store confirmed with exact match - securely remove the plaintext file
    // (zero-overwrite + unlink; see secureUnlinkSync for the CoW caveat).
    try {
      secureUnlinkSync(activeSessionFile());
    } catch {
      // Best-effort; leaving the plaintext is safe relative to losing the session.
    }
  }
  // If confirmed !== legacyBlob (truncation/corruption), keep the plaintext.
  return session;
}

/**
 * Residue sweep: when the secure store already holds a
 * parseable session AND the legacy plaintext session.json still exists
 * beside it (e.g. a fresh login wrote straight to the store while a
 * pre-migration file lingered), securely remove the plaintext file. The
 * store entry is verified through the store's own read path BEFORE anything
 * is deleted - never the reverse order.
 *
 * Returns true when a plaintext file was removed. Never throws.
 */
export function sweepSessionPlaintextResidue(): boolean {
  const legacyPath = activeSessionFile();
  if (!fs.existsSync(legacyPath)) return false; // cheap gate - common case
  let stored: string | null = null;
  try {
    stored = secureStore.getSecret(SESSION_STORE_ACCOUNT);
  } catch {
    return false; // store unreadable - keep the plaintext (it may be the only copy)
  }
  if (stored === null) return false;
  try {
    JSON.parse(stored);
  } catch {
    return false; // store blob is not a well-formed session - keep the plaintext
  }
  try {
    secureUnlinkSync(legacyPath);
    return true;
  } catch {
    return false; // locked/read-only file - doctor surfaces the residue
  }
}

export function deleteSession(): void {
  // Remove from the secure store AND the encrypted-file mirror that
  // writeSession's write-through maintains; logout must never leave a
  // live session copy in the fallback. The session credential is the one
  // whose survival silently re-authenticates a "logged out" CLI, so its wipe
  // is VERIFIED and LOUD: deleteSecretWriteThrough reads both backends back
  // and throws SecureStoreDeleteError on any surviving copy. Capture that
  // error, finish EVERY other cleanup below, then re-throw at the end so
  // logout exits non-zero - a partial-but-thorough wipe still beats aborting
  // mid-cleanup and leaving more copies behind.
  let sessionWipeError: unknown;
  try {
    deleteSecretWriteThrough(SESSION_STORE_ACCOUNT);
  } catch (err) {
    sessionWipeError = err;
  }
  // The session memo self-invalidates via its freshness signature (this delete
  // removes the enc mirror), so a post-logout readSession() re-reads and
  // returns null without an explicit memo poke here.
  // Also remove the 'signing-key' and 'x25519-key' secrets on logout.
  // (x25519.ts imports auth.ts, so we cannot import x25519.ts here -
  // use the same account key strings directly.) These live in a SINGLE
  // backend (never write-through mirrored), so a plain delete suffices;
  // wrapped best-effort since encDelete now propagates real (non-ENOENT)
  // unlink failures rather than swallowing them.
  try {
    secureStore.deleteSecret("signing-key");
  } catch {
    // Best-effort: a single-backend signing-key residue is surfaced by doctor.
  }
  try {
    secureStore.deleteSecret("x25519-key");
  } catch {
    // Best-effort: a single-backend x25519-key residue is surfaced by doctor.
  }
  // Belt-and-braces: remove any legacy plaintext files that may remain
  // from before the migration (e.g. partially-migrated installs).
  try {
    fs.unlinkSync(activeSessionFile());
  } catch {
    // Already gone
  }
  try {
    fs.unlinkSync(activeIdentityFile());
  } catch {
    // Already gone
  }
  // x25519-private-key.pem was not deleted by deleteSession(),
  // leaving the key recoverable from disk post-logout. Resolve the path
  // inline (mirrors x25519.ts:activeX25519PrivateKeyFile) to avoid a circular
  // import - x25519.ts already imports from auth.ts.
  try {
    const xdg =
      process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
    fs.unlinkSync(path.join(xdg, "alter", "x25519-private-key.pem"));
  } catch {
    // Already gone
  }
  // Also clean up legacy signing-key.pem if it still exists.
  try {
    const xdg =
      process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
    fs.unlinkSync(path.join(xdg, "alter", "signing-key.pem"));
  } catch {
    // Already gone
  }
  // Credential split-brain hardening: also remove atomic-write temp
  // leftovers next to signing-key.pem and the per-kid plaintext variants
  // under signing-keys/ (written by `alter key signing add`). Resolved
  // inline (mirrors signing.ts:removeManagedSigningArtefacts) to avoid a
  // circular import, since signing.ts already imports from auth.ts. Only
  // CLI-managed artefact names are touched; never arbitrary user files.
  try {
    const xdg =
      process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
    const alterDir = path.join(xdg, "alter");
    for (const name of fs.readdirSync(alterDir)) {
      if (name.startsWith("signing-key.pem.tmp.")) {
        try {
          fs.unlinkSync(path.join(alterDir, name));
        } catch {
          // Best-effort
        }
      }
    }
    const kidDir = path.join(alterDir, "signing-keys");
    for (const name of fs.readdirSync(kidDir)) {
      if (name.endsWith(".pem") || /\.pem\.tmp\./.test(name)) {
        try {
          fs.unlinkSync(path.join(kidDir, name));
        } catch {
          // Best-effort
        }
      }
    }
    fs.rmdirSync(kidDir); // Succeeds only when empty
  } catch {
    // Directory absent, nothing to clean
  }

  // Every best-effort cleanup above has run; now surface a verified-incomplete
  // session wipe so logout can fail loud and non-zero.
  if (sessionWipeError !== undefined) throw sessionWipeError;
}

export function isAuthenticated(): boolean {
  const session = readSession();
  if (!session) return false;
  // Sentinel sessions (far-future fixture or keyless) are not live credentials.
  if (isSentinelSession(session)) return false;
  return new Date(session.jwt_expires_at) > new Date();
}

export function isExpired(): boolean {
  const session = readSession();
  if (!session) return true;
  // A sentinel is always considered expired so refresh is not suppressed.
  if (isSentinelSession(session)) return true;
  return new Date(session.jwt_expires_at) <= new Date();
}

/**
 * Get the current session, or null if not authenticated/expired.
 * If JWT is expired but refresh token exists and is valid, returns null
 * (caller should trigger refresh).
 */
export function getSession(): AlterSession | null {
  const session = readSession();
  if (!session) return null;
  // Sentinel sessions must not be handed to callers as valid credentials.
  if (isSentinelSession(session)) return null;
  if (new Date(session.jwt_expires_at) <= new Date()) return null;
  return session;
}

/**
 * Get session for display purposes (even if expired).
 */
export function getSessionInfo(): AlterSession | null {
  return readSession();
}

/**
 * The ONE canonical "not logged in" line. Every logged-out command guard
 * prints exactly this string - no per-command variants. It names the fix
 * (`alter login`) so a first-run user always knows the next step.
 */
export const NOT_LOGGED_IN_MESSAGE =
  "alter: not logged in. Run 'alter login' first.";

/**
 * Canonical logged-out exit path. Prints the one canonical line to stderr
 * and arranges exit code 1 WITHOUT a hard `process.exit()`.
 *
 * Why not `process.exit(1)`: on Windows, a hard exit while libuv async
 * handles (keep-alive sockets from the floor-preflight / self-update
 * fetches, timers) are mid-teardown trips the libuv assertion
 * `!(handle->flags & UV_HANDLE_CLOSING)` (src\win\async.c) and crashes
 * with an unstable exit code AFTER the message has printed. Setting
 * `process.exitCode` and returning lets the event loop drain and the
 * process exit cleanly with code 1 on every platform.
 *
 * Callers MUST `return` immediately after calling this.
 */
export function failNotLoggedIn(): void {
  console.error(NOT_LOGGED_IN_MESSAGE);
  process.exitCode = 1;
}

/**
 * Pre-flight session gate for destructive subcommands that show a
 * confirmation prompt before hitting the API. Without it, a non-
 * authenticated user can be prompted to confirm a destructive action
 * (e.g. "Revoke every session?", "Disable MFA?") and only learn
 * afterwards that they were never signed in. Prints the standard
 * error and sets process.exitCode = 1; callers should `return`
 * immediately on a falsy result.
 */
export function requireSessionOrExit(): boolean {
  if (!getSession()) {
    failNotLoggedIn();
    return false;
  }
  return true;
}

/**
 * Message for a 401/403 from a server endpoint when a `session.json`
 * *is* present locally - the session's member API key / signing key
 * has been rejected server-side (partial login, key rotation,
 * revocation). This is NOT "not logged in": `alter login` short-
 * circuits with "Already logged in" for a logged-in user, so the
 * actionable fix is `alter logout && alter login` to re-provision.
 * With no session present we fall through to the plain not-logged-in
 * copy. `{ terse: true }` returns a one-line variant for a TUI flash.
 */
export function sessionRejectedMessage(opts: { terse?: boolean } = {}): string {
  let hasSession = false;
  try {
    hasSession = readSession() !== null;
  } catch {
    hasSession = false;
  }
  if (!hasSession) {
    return opts.terse
      ? "not signed in - run `alter login`."
      : NOT_LOGGED_IN_MESSAGE;
  }
  return opts.terse
    ? "session rejected by the server (401/403) - run `alter logout && alter login`."
    : "Your session's credentials were rejected by the server (401/403). Run `alter logout && alter login` to re-provision.";
}

// ---------------------------------------------------------------------------
// Refresh-token rotation - keeps the user logged in for the full
// refresh_token_expire_days window (24h at launch) without re-running the
// browser ceremony each time the short-lived access token expires.
// ---------------------------------------------------------------------------

const ACCESS_TOKEN_REFRESH_BUFFER_MS = 60_000; // refresh ~1min before expiry

function _isAccessFresh(s: AlterSession): boolean {
  // A sentinel session (far-future fixture or keyless) must never be treated
  // as "fresh". Without this guard, a year-2099 jwt_expires_at would cause
  // ensureFreshSession to return the sentinel immediately, suppressing the
  // refresh round-trip entirely and leaving the member in a silent L1 state.
  if (isSentinelSession(s)) return false;
  const exp = new Date(s.jwt_expires_at).getTime();
  return exp - ACCESS_TOKEN_REFRESH_BUFFER_MS > Date.now();
}

function _refreshIsValid(s: AlterSession): boolean {
  if (!s.refresh_token) return false;
  if (!s.refresh_expires_at) return true; // legacy session, optimistic
  return new Date(s.refresh_expires_at).getTime() > Date.now();
}

// ---------------------------------------------------------------------------
// Single-flight refresh lock (cross-process)
// ---------------------------------------------------------------------------
//
// The refresh token is single-use and rotates server-side: whichever process
// presents it second gets `invalid_grant` and a burned token. With N MCP
// bridge processes plus the CLI all sharing ONE session, an expiry boundary
// used to fan out N simultaneous rotations and log the member out
// mid-session. The lock serialises rotation across processes so exactly one
// performs the exchange; the rest wait, re-read the rotated session from the
// store, and never touch the network.
//
// Mechanism follows the agreed cross-process cap-store protocol, also
// implemented by the MCP bridges:
// exclusive-create (`wx`) lockfile at <config-dir>/refresh.lock, mode 0600,
// poll on EEXIST, steal when the holder's mtime is older than the stale
// threshold (a crashed holder must not deadlock every client), and degrade
// to today's unlocked behaviour rather than hard-block when the lock cannot
// be acquired in time. `open(wx)` is atomic on Linux, macOS and Windows,
// with no POSIX-only flock(2) dependency.

/** Lock hold longer than this is treated as abandoned and stolen. Must
 *  exceed the worst-case rotation round-trip (ALTER_REFRESH_TIMEOUT_MS
 *  defaults to 8 s). Matches the shared cap-store stale-lock threshold. */
const REFRESH_LOCK_STALE_MS = 20_000;
/** Give up waiting after this and degrade to an unlocked rotation attempt
 *  (pre-lock behaviour, with the invalid_grant re-read recovery) rather
 *  than blocking the caller. */
const REFRESH_LOCK_ACQUIRE_TIMEOUT_MS = 25_000;
const REFRESH_LOCK_POLL_MS = 50;

function refreshLockPath(): string {
  return path.join(activeConfigDir(), "refresh.lock");
}

function _lockSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Acquire the refresh lock. Returns true when this process owns it; false
 *  when acquisition timed out or the config dir is unwritable (caller then
 *  degrades to an unlocked attempt, never harder than pre-lock behaviour). */
async function acquireRefreshLock(): Promise<boolean> {
  try {
    ensureConfigDir();
  } catch {
    return false; // no config dir (no HOME / read-only fs): degrade
  }
  const lockPath = refreshLockPath();
  const deadline = Date.now() + REFRESH_LOCK_ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeSync(fd, `${process.pid}:${Date.now()}`);
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false;
      // Lock held: steal if stale (crashed holder).
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > REFRESH_LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        // Lock vanished between open and stat: retry immediately.
        continue;
      }
      if (Date.now() >= deadline) return false;
      await _lockSleep(REFRESH_LOCK_POLL_MS);
    }
  }
}

function releaseRefreshLock(): void {
  try {
    fs.unlinkSync(refreshLockPath());
  } catch {
    // Already gone (stolen / never created): nothing to do.
  }
}

/**
 * Resolve a usable session for the current process.
 *
 * If the on-disk session has a still-valid access token, return it as-is.
 * Otherwise, when a non-expired refresh token is present, exchange it via
 * the OAuth ``grant_type=refresh_token`` endpoint, persist the rotated
 * token pair, and return the freshly-minted session. Returns ``null``
 * only when there is no session or both tokens are expired/missing -
 * the caller is expected to surface "please run alter login" in that
 * case rather than failing silently.
 *
 * Safe to call from concurrent processes, in two layers:
 *   1. Single-flight: rotation runs under the cross-process refresh lock.
 *      After acquiring the lock the session is RE-READ from the store; when
 *      another process rotated while this one waited, the re-read pair is
 *      returned and no exchange is attempted: the single-use refresh token
 *      is presented exactly once across all local processes.
 *   2. Recovery: should a duplicate attempt still reach the server (lock
 *      degraded, or a non-local client), the rotation fails with
 *      ``invalid_grant``; this function detects that, re-reads the session
 *      the winning process wrote, and returns it instead of falsely
 *      reporting "logged out". ``writeSession`` writes are atomic, so a
 *      reader never sees a half-written session.
 */
export async function ensureFreshSession(
  options: { signal?: AbortSignal; force?: boolean } = {},
): Promise<AlterSession | null> {
  // `force` makes the caller rotate the access token regardless of how much
  // lifetime remains. The proactive-renew daemon calls
  // `alter creds refresh --force` a few minutes before expiry, when the
  // token is still "fresh" (>buffer left) and the default freshness
  // short-circuit would otherwise no-op. With `force`, both pre-exchange
  // freshness guards are bypassed so the function always proceeds to the
  // refresh-token exchange. The cross-process lock, the single-flight
  // re-read for a sibling's just-written rotation, and the rotation itself
  // are untouched: `force` only removes the "already fresh, return early"
  // skip, never the concurrency safety.
  const force = options.force === true;
  const session = readSession();
  if (!session) return null;
  if (!force && _isAccessFresh(session)) return session;
  if (!_refreshIsValid(session)) return null;

  const locked = await acquireRefreshLock();
  try {
    // Re-read under the lock: another process may have rotated while this
    // one queued. Using its session avoids presenting a refresh token the
    // winner already consumed. Also worth doing when acquisition degraded
    // (locked === false): the read is cheap and the token is single-use.
    // Fresh read (memo-bypass): observing a sibling's just-written rotation is
    // the entire purpose here, which the in-process memo would mask.
    //
    // The under-lock freshness short-circuit is bypassed under `force` for the
    // same reason as the top-level one: a force caller must reach the exchange
    // even when the token is still fresh, and this re-read cannot distinguish
    // "a sibling just rotated" from "our own token is simply still fresh". The
    // single-flight guarantee is unaffected: only one process at a time holds
    // the lock and presents the single-use refresh token. The post-exchange
    // recovery in `_rotateRefreshToken` (re-read a sibling's fresh session on a
    // failed exchange) is intentionally left intact and is never forced.
    const current = readSessionFresh();
    if (!current) return null;
    if (!force && _isAccessFresh(current)) return current;
    if (!_refreshIsValid(current)) return null;
    return await _rotateRefreshToken(current, options);
  } finally {
    if (locked) releaseRefreshLock();
  }
}

/** Perform exactly one refresh-token exchange and persist the rotated pair.
 *  Callers hold the refresh lock (or have explicitly degraded). */
async function _rotateRefreshToken(
  session: AlterSession,
  options: { signal?: AbortSignal } = {},
): Promise<AlterSession | null> {
  try {
    // Bound the refresh round-trip. Without a timeout a hung backend froze
    // the whole CLI here - `ensureFreshSession` runs before the menu paints
    // AND inside every `apiCall`, so an unbounded fetch is an indefinite
    // hang. On timeout the AbortError is caught below and we fall through to
    // the concurrent-rotation re-read / return-null path (no new failure
    // mode). Env-overridable for slow SSO deployments.
    const refreshTimeoutMs = parseInt(
      process.env.ALTER_REFRESH_TIMEOUT_MS ?? "8000",
      10,
    );
    const timeoutSignal = AbortSignal.timeout(refreshTimeoutMs);
    const resp = await fetch(`${session.api}/api/v1/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: session.refresh_token!,
        // RFC 6749 §6 / OAuth 2.1: public clients send their client_id on the
        // refresh grant too (the auth-code + device-code grants already do).
        // Lets the server enforce per-client refresh-token binding.
        client_id: process.env.ALTER_CLIENT_ID ?? "alter_cli",
      }).toString(),
      // Callers that rotate in the background (the menu's paint-first
      // path) pass an abort signal so a quit doesn't leave an in-flight
      // fetch holding the event loop open until the timeout fires.
      signal: options.signal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal,
    });
    if (!resp.ok) {
      // Another process may have just rotated and written a fresh session -
      // our refresh_token is stale because *it* succeeded, not because the
      // user is logged out. Re-read before giving up.
      //
      // The rescue requires EVIDENCE of a sibling rotation, which is a
      // DIFFERENT jwt on disk. Freshness alone is not that evidence: it only
      // says our own access token has not expired yet, which is true of every
      // proactive `--force` refresh by construction (the daemon rotates ~5 min
      // BEFORE expiry). Treating "still fresh" as "someone else rotated"
      // returns a non-null session on a REJECTED grant, so `alter creds
      // refresh` exits 0 and the caller believes it rotated. The daemon then
      // logs "subprocess succeeded but JWT did not advance" and backs off,
      // while the real failure - a dead refresh token - stays invisible until
      // the access token expires and every subscriber 401s at once.
      const reread = readSessionFresh();
      if (reread && reread.jwt !== session.jwt && _isAccessFresh(reread)) {
        return reread;
      }
      return null;
    }
    const data = (await resp.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
      /**
       * Server-emitted refresh-token TTL (seconds). DEPRECATION: the
       * 24h CLI-side fallback below remains for legacy backends that
       * never emit this field; remove it once every reachable OIDC
       * deployment carries `refresh_expires_in` on rotation.
       */
      refresh_expires_in?: number;
    };
    const next: AlterSession = {
      ...session,
      jwt: data.access_token,
      jwt_expires_at: new Date(
        Date.now() + data.expires_in * 1000,
      ).toISOString(),
      refresh_token: data.refresh_token ?? session.refresh_token,
      refresh_expires_at: data.refresh_token
        ? new Date(
            Date.now() +
              (typeof data.refresh_expires_in === "number" &&
              data.refresh_expires_in > 0
                ? data.refresh_expires_in
                : 24 * 60 * 60) *
                1000,
          ).toISOString()
        : session.refresh_expires_at,
    };
    writeSession(next);
    return next;
  } catch {
    // Network failure, JSON parse failure, etc. - but a concurrent process may
    // still have rotated successfully. Re-read first. Same evidence bar as the
    // non-2xx path above: a sibling rotation means a DIFFERENT jwt on disk, not
    // merely a still-fresh one.
    const reread = readSessionFresh();
    if (reread && reread.jwt !== session.jwt && _isAccessFresh(reread)) {
      return reread;
    }
    return null;
  }
}

/**
 * Synchronous, network-free read of the on-disk session for paint-first
 * surfaces (the interactive menu). Returns the session whenever the member
 * is still inside the login window - access token fresh, OR rotatable via
 * a locally-valid refresh token - plus whether a background rotation is
 * still owed. Never blocks on the refresh round-trip: callers paint with
 * the on-disk identity immediately and fire `ensureFreshSession()` in the
 * background when `needsRefresh` is true (every `apiCall` re-runs the
 * rotation itself, so leaf actions pick up the rotated pair from disk).
 */
export function peekPaintableSession(): {
  session: AlterSession | null;
  needsRefresh: boolean;
} {
  const session = readSession();
  if (!session) return { session: null, needsRefresh: false };
  if (_isAccessFresh(session)) return { session, needsRefresh: false };
  if (!_refreshIsValid(session)) return { session: null, needsRefresh: false };
  return { session, needsRefresh: true };
}

// ---------------------------------------------------------------------------
// Identity cache
// ---------------------------------------------------------------------------

export function writeIdentity(identity: AlterIdentity): void {
  ensureConfigDir();
  atomicWriteFileSync(
    activeIdentityFile(),
    JSON.stringify(identity, null, 2) + "\n",
  );
}

export function readIdentity(): AlterIdentity | null {
  try {
    const content = fs.readFileSync(activeIdentityFile(), "utf-8");
    return JSON.parse(content) as AlterIdentity;
  } catch {
    return null;
  }
}

export function writeStatusSnapshot(snapshot: StatusSnapshot): void {
  ensureConfigDir();
  // Stamp the bound handle so a later read can refuse a snapshot left by a
  // different member on the same machine. Caller-supplied `handle` wins (tests
  // pass it explicitly); otherwise it is read from the live session. A keyless
  // / handle-less session leaves it absent, which reads as a mismatch.
  const bound = snapshot.handle ?? readSession()?.handle;
  const stamped: StatusSnapshot = bound ? { ...snapshot, handle: bound } : snapshot;
  atomicWriteFileSync(
    activeStatusSnapshotFile(),
    JSON.stringify(stamped, null, 2) + "\n",
  );
}

/**
 * One-time backfill: if the current session lacks `member_id`, fetch it
 * via `alter_whoami` (MCP) and write it back to session.json.
 *
 * Returns the member_id string when successfully fetched or already
 * present, null when the session has no member key / is not a member
 * key (admin), and undefined when the fetch itself failed or no session
 * exists.
 *
 * Callers that need `member_id` and may be running against an older
 * session should call this once at startup. It is a no-op if
 * `member_id` is already populated.
 *
 * LINCHPIN: NEVER fall back to `user_id`. `user_id` is the User PK,
 * not `members.id`. Wrong key ⇒ empty/wrong projection.
 */
export async function backfillMemberId(): Promise<string | null | undefined> {
  const session = readSession();
  if (!session) return undefined;

  // Already populated (including explicitly null for admin keys).
  if ("member_id" in session) return session.member_id ?? null;

  // Need a member API key to call the MCP tool.
  if (!session.member_api_key) return undefined;

  try {
    const { AlterClient } = await import("@truealter/sdk");
    const { resolveBoundSigningKey, SigningKeyMismatchError } = await import(
      "./signing.js"
    );
    const { getMcpExtraHeaders } = await import("./lib/cf-access-headers.js");
    const { getCliVersion } = await import("./lib/version.js");

    // Bound resolution: refuses (throws) when the resolved key does not
    // match the session's kid. Surface the mismatch loudly: this backfill
    // is best-effort, but a silent return here would hide a split-brain.
    let privateKeyPem: string | null;
    try {
      privateKeyPem = resolveBoundSigningKey(session);
    } catch (err) {
      if (err instanceof SigningKeyMismatchError) {
        console.error(`alter: ${err.message}`);
        return undefined;
      }
      throw err;
    }
    if (!privateKeyPem || !session.signing_kid) return undefined;

    const cli_version = getCliVersion();
    const client = new AlterClient({
      apiKey: session.member_api_key,
      clientInfo: { name: "alter-cli", version: cli_version },
      signing: {
        kid: session.signing_kid,
        privateKey: privateKeyPem,
        handle: session.handle,
      },
      extraHeaders: getMcpExtraHeaders(cli_version),
    });

    const result = await client.mcp.callTool("alter_whoami", {});
    // Extract member_id from the response payload.
    let payload: Record<string, unknown> | null = null;
    if ((result as any).data && typeof (result as any).data === "object") {
      payload = (result as any).data as Record<string, unknown>;
    } else {
      const text = result.content?.find((c: any) => c.type === "text")?.text;
      if (text) {
        try { payload = JSON.parse(text); } catch { /* ignore */ }
      }
    }

    // alter_whoami returns member_id (= delegated_member_id) at top level.
    // null is a valid value for admin keys.
    const memberId: string | null =
      payload && typeof payload.member_id === "string"
        ? payload.member_id
        : payload && payload.member_id === null
          ? null
          : undefined as any;

    if (memberId !== undefined) {
      const updated: AlterSession = { ...session, member_id: memberId };
      writeSession(updated);
      return memberId;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function readStatusSnapshot(): StatusSnapshot | null {
  try {
    const content = fs.readFileSync(activeStatusSnapshotFile(), "utf-8");
    const parsed = JSON.parse(content) as Partial<StatusSnapshot>;
    if (typeof parsed.taken_at !== "string") return null;
    // Identity-bind guard: a snapshot belongs to the handle that wrote it.
    // When a session is present, refuse a snapshot whose stamped handle does
    // not match the current handle (including a legacy snapshot with no handle
    // at all). This stops a prior member's cached figures showing under a new
    // member's status card / menu depth after a same-machine login switch.
    // With NO current session (logged out) the guard is skipped so display-only
    // callers can still read the last figures.
    const currentHandle = readSession()?.handle;
    if (currentHandle && parsed.handle !== currentHandle) return null;
    return {
      taken_at: parsed.taken_at,
      ...(typeof parsed.handle === "string" ? { handle: parsed.handle } : {}),
      attunement:
        typeof parsed.attunement === "number" ? parsed.attunement : null,
      balance_cents:
        typeof parsed.balance_cents === "number" ? parsed.balance_cents : 0,
      total_earned:
        typeof parsed.total_earned === "number" ? parsed.total_earned : 0,
      transaction_count:
        typeof parsed.transaction_count === "number"
          ? parsed.transaction_count
          : 0,
      trait_count:
        typeof parsed.trait_count === "number" ? parsed.trait_count : 0,
      // Optional: present only when the snapshot writer saw the JWT
      // claim. Stays absent (not defaulted) when missing or malformed.
      ...(typeof parsed.engagement_level === "number"
        ? { engagement_level: parsed.engagement_level }
        : {}),
      // Present only as a pair; a snapshot with one but not the other
      // (hand-edited or truncated) is treated as neither being set.
      ...(typeof parsed.pending_suggestion_id === "string" &&
      parsed.pending_suggestion_id.length > 0 &&
      typeof parsed.pending_suggestion_at === "string"
        ? {
            pending_suggestion_id: parsed.pending_suggestion_id,
            pending_suggestion_at: parsed.pending_suggestion_at,
          }
        : {}),
      ...(typeof parsed.walk_completed === "number" &&
      typeof parsed.walk_total === "number"
        ? {
            walk_completed: parsed.walk_completed,
            walk_total: parsed.walk_total,
          }
        : {}),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// JWT helpers (decode without verification - verification happens server-side)
// ---------------------------------------------------------------------------

export function decodeJwtPayload(
  jwt: string
): Record<string, unknown> | null {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/**
 * Extract ALTER-specific claims from a JWT or ID token.
 */
export function extractAlterClaims(jwt: string): {
  sub?: string;
  email?: string;
  role?: string;
  engagement_level?: number;
  engagement_label?: string;
  has_alter?: boolean;
  ceremony_complete?: boolean;
  alter_handle?: string;
  exp?: number;
} {
  const payload = decodeJwtPayload(jwt);
  if (!payload) return {};
  return {
    sub: payload.sub as string | undefined,
    email: payload.email as string | undefined,
    role: payload.role as string | undefined,
    engagement_level: payload[
      "https://truealter.com/claims/engagement_level"
    ] as number | undefined,
    engagement_label: payload[
      "https://truealter.com/claims/engagement_label"
    ] as string | undefined,
    has_alter: payload["https://truealter.com/claims/has_alter"] as
      | boolean
      | undefined,
    ceremony_complete: payload[
      "https://truealter.com/claims/ceremony_complete"
    ] as boolean | undefined,
    alter_handle: payload[
      "https://truealter.com/claims/alter_handle"
    ] as string | undefined,
    exp: payload.exp as number | undefined,
  };
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function generateCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Generate a cryptographically random state parameter.
 *
 * The OAuth `state` is 32 bytes (base64url) - it is the bearer that binds the
 * browser-callback request to the originating CLI invocation, so it is
 * treated at the same entropy floor as the PKCE verifier and the OIDC
 * nonce. base64url of 32 bytes is 43 chars (256 bits).
 */
export function generateState(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * Generate a cryptographically random nonce for OIDC id_token replay
 * protection. The CLI sends this on `/oauth/authorize` and asserts the
 * server-issued id_token's `nonce` claim matches on token-exchange -
 * preventing a stolen-and-replayed id_token from being accepted by a
 * different login attempt. base64url, 32 bytes ≈ 256 bits.
 */
export function generateNonce(): string {
  return crypto.randomBytes(32).toString("base64url");
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

/**
 * Make an authenticated API call.
 * Returns null if not authenticated.
 *
 * Transparently rotates the access token via the refresh-token grant
 * when the local one is expired but a valid refresh token is on disk
 * - so a long-running CLI session stays authenticated for the full
 * refresh-token TTL without nudging the user back through the browser
 * ceremony.
 *
 * Cancellation contract:
 * `signal` lets a TUI surface cancel an in-flight call when the user
 * presses q/Esc; `timeoutMs` is the hard upper bound (default 30s) so
 * a hung backend never strands the menu. Both are optional - existing
 * call sites continue to work unchanged.
 */
/**
 * Default per-request timeout for the authenticated HTTP helpers
 * (`apiCall` / `httpCall`). Lowered from 30s - that upper bound let one
 * cold/slow backend call freeze an interactive menu leaf for half a minute
 * with no feedback. 15s still covers a cold Fly-instance wake; a per-call
 * `timeoutMs` override always wins, and ALTER_API_TIMEOUT_MS lets power
 * users on slow links widen it.
 */
export function defaultApiTimeoutMs(): number {
  return parseInt(process.env.ALTER_API_TIMEOUT_MS ?? "15000", 10);
}

export async function apiCall(
  endpoint: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {}
): Promise<Response | null> {
  // Thread the caller's signal into the token rotation too: an expired
  // access token used to block here for up to ALTER_REFRESH_TIMEOUT_MS
  // (8s) BEFORE the request even started, with esc dead - the menu's
  // intermittent "stickiness". Now esc aborts the refresh as well.
  const session = await ensureFreshSession({ signal: options.signal });
  if (!session) return null;

  const url = `${session.api}${endpoint}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.jwt}`,
    "Content-Type": "application/json",
    ...options.headers,
  };

  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? defaultApiTimeoutMs());
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  return fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal,
  });
}

/**
 * Bare-bones HTTP wrapper for endpoints that don't fit `apiCall`'s
 * Bearer-JWT + JSON-body shape - member-key authenticated endpoints
 * (`X-ALTER-API-Key`), pre-auth flows, OAuth `/oauth/revoke` form-encoded
 * bodies, and so on. Otherwise identical contract: caller supplies the
 * full `RequestInit`; this wrapper composes a 30 s default timeout with
 * any caller-supplied AbortSignal so q/Esc still works in TUI surfaces.
 *
 * Centralising the AbortSignal contract here is the structural reason
 * the escape-coverage CI guard can ban raw `fetch(` outside `auth.ts` -
 * every authenticated caller flows through `apiCall` or `httpCall`, both
 * of which honour the cancellation contract.
 */
export async function httpCall(
  url: string,
  options: RequestInit & { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? defaultApiTimeoutMs());
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  return fetch(url, { ...options, signal });
}
