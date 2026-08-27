/**
 * floor-preflight - client-side minimum-version-floor enforcement.
 *
 * Behaviours implemented here:
 *   - disk cache UID + mode-0600 ownership check (POSIX only).
 *   - fire-and-forget background refresh on every preflight.
 *   - Ed25519 `key_id` field selects verification key from a known-keys map.
 *   - atomic disk-cache write (tmp + rename, no advisory lock).
 *
 * The canonical client_below_floor envelope is identical across HTTP 426,
 * MCP `tools/call` error, WebSocket close-4426 reason, and the CLI stdout
 * JSON path.
 *
 * Connectivity ladder:
 *   - Cache fresh (≤1h in-memory, server-advised TTL clamped to [60s, 24h]):
 *     trust the cached floor; no refetch.
 *   - Disk cache ≤24h: trust; permit operation.
 *   - Disk cache 24h–7d: permit with warn.
 *   - Disk cache >7d + backend unreachable: permit with WARN (no offline
 *     lockout for network blips on a fresh-enough cache).
 *   - Below-floor + cache-stale + unreachable: BLOCK. The only intentional
 *     offline lockout case - the user had time to upgrade and didn't.
 *
 * The server-side gate (the server middleware) is the authoritative reject.
 * This client-side preflight is UX polish - it gives a clean upgrade prompt
 * before the network call, so users don't see a 426 wall.
 *
 * Ed25519 signature verification - the server signs the floor document with a
 * floor-only Ed25519 private key. The CLI ships only the corresponding public
 * key (SPKI PEM) in KNOWN_FLOOR_PUBLIC_KEYS, keyed by `key_id`. The `key_id`
 * is the first 8 hex chars of SHA-256(raw 32-byte Ed25519 public key). This
 * is asymmetric - compromise of the floor public key cannot forge signatures,
 * and the symmetric signing key is never shipped in the CLI tarball.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  detectInstallChannel,
  type InstallChannel,
} from "./install-channel.js";
import { buildUpgradePrompt } from "./upgrade-prompt.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MIN_VERSION_ENDPOINT = "/api/v1/clients/min-version";

const IN_MEMORY_TTL_DEFAULT_MS = 60 * 60 * 1000; // 1h
const IN_MEMORY_TTL_MIN_MS = 60 * 1000; // 60s
const IN_MEMORY_TTL_MAX_MS = 24 * 60 * 60 * 1000; // 24h

const DISK_FRESH_MS = 24 * 60 * 60 * 1000; // 24h
const DISK_WARN_MS = 7 * 24 * 60 * 60 * 1000; // 7d

// 1.5s: the floor preflight is awaited before non-menu verbs dispatch, so its
// timeout is a hard ceiling on per-command startup latency. The server-side
// floor gate is the actual reject; this client preflight is UX, so a tight
// bound is correct - a slow/unreachable floor endpoint must not stall the
// command. Was 4000ms.
const FETCH_TIMEOUT_MS = 1500;

/**
 * Compute the 8-char `key_id` for an Ed25519 public key (SPKI PEM).
 *
 * Matches the backend `key_id_for_public_key(pub)`:
 *   raw = pub.public_bytes(Encoding.Raw, PublicFormat.Raw)  # 32 bytes
 *   sha256(raw).hexdigest()[:8]
 *
 * Node equivalent: import PEM → export JWK → decode `.x` (base64url) → 32-byte
 * raw public key → SHA-256 → first 8 hex chars.
 *
 * Returns `"00000000"` for empty input (sentinel).
 */
export function computeKeyId(publicKeyPem: string): string {
  if (!publicKeyPem) return "00000000";
  const pub = crypto.createPublicKey({ key: publicKeyPem, format: "pem" });
  const jwk = pub.export({ format: "jwk" }) as { x: string };
  const rawBytes = Buffer.from(jwk.x, "base64url");
  return crypto.createHash("sha256").update(rawBytes).digest("hex").slice(0, 8);
}

/**
 * Canonical JSON encoding matching Python's
 * `json.dumps(obj, sort_keys=True, separators=(",", ":"))`. Object keys are
 * sorted lexicographically AT EVERY DEPTH; whitespace is stripped via the
 * `,`/`:` separators. The result is the byte-exact input to Ed25519 signing
 * (backend) and verification (this CLI) on both sides.
 */
export function canonicalJson(obj: unknown): string {
  return JSON.stringify(sortKeysDeep(obj));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = sortKeysDeep(obj[k]);
    }
    return sorted;
  }
  return value;
}

/**
 * Known Ed25519 public keys (SPKI PEM) keyed by `key_id`.
 *
 * `key_id` = first 8 hex chars of SHA-256(raw 32-byte Ed25519 public key).
 * Use `computeKeyId(spkiPem)` to re-derive and validate the map key.
 *
 * The backend may rotate via a dual-key path - clients keep N keys and
 * select via `key_id`. Add new keys additively; remove old keys only after
 * all deployed clients have received the new key.
 *
 * Current keys:
 *   8aa59e05 - non-prod public key (public half only).
 *   640f7d9a - prod public key, public half only.
 */
export const KNOWN_FLOOR_PUBLIC_KEYS: Record<string, string> = {
  "8aa59e05": `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAgqw28dlniOuiTE1f4BxCPSEgMLaPtHsO8wN5RWEwEhE=
-----END PUBLIC KEY-----`,
  "640f7d9a": `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEARzvAWayDwHvZRfOZizGZe+/a7PF082WGhyMS3tx06H4=
-----END PUBLIC KEY-----`,
};

/**
 * Allowlist - commands permitted to run even when below floor. Mirrors the
 * doctrine: `--version`, `--help`, `alter update`, `alter update check`,
 * `alter update channel`, `alter update auto`.
 */
export const BELOW_FLOOR_COMMAND_ALLOWLIST: ReadonlySet<string> = new Set([
  "version",
  "--version",
  "-v",
  "help",
  "--help",
  "-h",
  "update",
  // The detached background self-update worker must run even on a below-floor
  // client, otherwise a stale CLI could never self-heal back above the floor.
  "__bg-update",
]);

// ---------------------------------------------------------------------------
// Types - canonical envelope shared across HTTP 426 / MCP / WS / stdout JSON
// ---------------------------------------------------------------------------

export interface ClientBelowFloorEnvelope {
  error: {
    code: "client_below_floor";
    message: string;
    client_version: string;
    min_version: string;
    upgrade_cmd: string;
    channel: string;
  };
}

export interface ChannelFloor {
  min_version: string;
  upgrade_cmd: string;
}

export interface FloorDocument {
  floors: Record<string, ChannelFloor | Record<string, ChannelFloor>>;
  served_at: string;
  cache_ttl_seconds: number;
  signature: string;
  key_id: string;
}

interface DiskCacheEntry {
  doc: FloorDocument;
  fetched_at_ms: number;
}

export interface PreflightResult {
  ok: boolean;
  envelope?: ClientBelowFloorEnvelope;
  /** Warning emitted but operation still permitted (24h–7d stale cache). */
  warn?: string;
  /** Promoted to the caller for logging - which path bit. */
  diagnostic: string;
}

export interface PreflightOpts {
  clientId: string;
  clientVersion: string;
  channel: InstallChannel;
  /** Command being run; below-floor allowlist consults this. */
  command?: string;
  /** Backend API base, defaults to ALTER_API env or production. */
  apiBase?: string;
  deps?: PreflightDeps;
}

export interface PreflightDeps {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  platform?: NodeJS.Platform;
  now?: () => number;
  fetchImpl?: typeof fetch;
  readFile?: (p: string) => string | null;
  writeFileAtomic?: (p: string, contents: string) => void;
  statFile?: (p: string) => { uid: number; mode: number } | null;
  effectiveUid?: () => number;
}

// ---------------------------------------------------------------------------
// In-memory cache (per-process)
// ---------------------------------------------------------------------------

interface MemEntry {
  doc: FloorDocument;
  fetched_at_ms: number;
  ttl_ms: number;
}

let memCache: MemEntry | null = null;

/** Test hook - reset the in-memory cache between tests. */
export function _resetInMemoryCache(): void {
  memCache = null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Preflight the floor for the running CLI. Returns `{ ok: true }` when the
 * command is permitted; otherwise `{ ok: false, envelope }` with the
 * canonical client_below_floor envelope.
 *
 * Caller is responsible for rendering the envelope (stderr human + optional
 * stdout JSON) and exiting non-zero.
 */
export async function preflightFloor(
  opts: PreflightOpts,
): Promise<PreflightResult> {
  const d = withDefaults(opts.deps);
  const apiBase = opts.apiBase ?? defaultApiBase(d);

  // Allowlist short-circuit - `alter update`, `alter --version`, etc. always
  // run, even below floor.
  if (opts.command && BELOW_FLOOR_COMMAND_ALLOWLIST.has(opts.command)) {
    return { ok: true, diagnostic: "allowlist-permit" };
  }

  // 1. Fast path - in-memory cache hit.
  const memDoc = readInMemoryCache(d);
  if (memDoc) {
    const verdict = compareToFloor(memDoc, opts);
    // Fire-and-forget background refresh - keeps the cache fresh
    // without blocking the command.
    void refreshFloorCacheBackground(apiBase, d);
    return verdict;
  }

  // 2. Disk cache path.
  const diskEntry = readDiskCache(d);
  const age = diskEntry
    ? d.now() - diskEntry.fetched_at_ms
    : Number.POSITIVE_INFINITY;

  // 3. Fetch if disk cache is stale or absent.
  let fetched: FloorDocument | null = null;
  let fetchError: string | null = null;
  if (!diskEntry || age > IN_MEMORY_TTL_DEFAULT_MS) {
    try {
      fetched = await fetchFloorDoc(apiBase, d);
    } catch (err) {
      fetchError = (err as Error).message ?? "fetch-error";
    }
  }

  if (fetched) {
    // Successful fetch - write to disk + populate memory.
    writeDiskCache(fetched, d);
    populateMemCache(fetched, d.now());
    const verdict = compareToFloor(fetched, opts);
    return verdict;
  }

  // 4. Fetch failed (or skipped) - fall back to disk cache.
  if (diskEntry) {
    populateMemCache(diskEntry.doc, diskEntry.fetched_at_ms);
    const verdict = compareToFloor(diskEntry.doc, opts);
    if (age > DISK_WARN_MS) {
      // Cache >7d AND unreachable. If below floor → BLOCK. If above
      // floor → permit with WARN.
      if (!verdict.ok) {
        return {
          ...verdict,
          diagnostic: "below-floor-offline-stale-blocked",
        };
      }
      return {
        ok: true,
        warn: `floor cache is >7d old and backend unreachable (${fetchError ?? "no refresh attempted"}); permitting`,
        diagnostic: "stale-cache-permit-warn",
      };
    }
    if (age > DISK_FRESH_MS) {
      // 24h–7d window: permit with warn.
      if (!verdict.ok) return verdict;
      return {
        ok: true,
        warn: `floor cache is ${Math.round(age / (60 * 60 * 1000))}h old; refresh recommended`,
        diagnostic: "warn-stale-permit",
      };
    }
    return verdict;
  }

  // 5. No cache + fetch failed - permit (no offline lockout for first-run
  // with network blip). Server-side gate will catch below-floor on the first
  // real request.
  // NOTE: do NOT set `warn` here. Doctrine (header comment) treats 404 /
  // unreachable as a silent permit. Emitting a warning on this path makes
  // every shell-verb invocation look broken when the endpoint is absent or
  // returns 404. A warning is warranted only when the client is actually
  // below floor - that is already handled by the `!verdict.ok` branch above.
  return {
    ok: true,
    diagnostic: "no-cache-no-fetch-permit",
  };
}

// ---------------------------------------------------------------------------
// Floor comparison
// ---------------------------------------------------------------------------

function compareToFloor(
  doc: FloorDocument,
  opts: PreflightOpts,
): PreflightResult {
  const floor = lookupFloor(doc, opts.clientId, opts.channel);
  if (!floor) {
    return { ok: true, diagnostic: "no-floor-defined" };
  }
  if (compareSemver(opts.clientVersion, floor.min_version) >= 0) {
    return { ok: true, diagnostic: "above-floor" };
  }
  const envelope: ClientBelowFloorEnvelope = {
    error: {
      code: "client_below_floor",
      message: `Your ${opts.clientId} is too old. Upgrade required.`,
      client_version: opts.clientVersion,
      min_version: floor.min_version,
      upgrade_cmd: floor.upgrade_cmd,
      channel: opts.channel,
    },
  };
  return { ok: false, envelope, diagnostic: "below-floor" };
}

/** Look up a `(client_id, channel)` floor entry from the document. */
function lookupFloor(
  doc: FloorDocument,
  clientId: string,
  channel: InstallChannel,
): ChannelFloor | null {
  const clientEntry = doc.floors[clientId];
  if (!clientEntry) return null;
  // alter-cli carries per-channel floors; other clients carry a single floor.
  if (isChannelFloor(clientEntry)) {
    return clientEntry;
  }
  // Per-channel map (e.g. alter-cli).
  const byChannel = clientEntry;
  const exact = byChannel[channel];
  if (exact) return exact;
  // Fall back to the `unknown` channel row - server seeds the conservative
  // MAX floor under `unknown`.
  const fallback = byChannel["unknown"];
  if (fallback) return fallback;
  return null;
}

function isChannelFloor(
  v: ChannelFloor | Record<string, ChannelFloor>,
): v is ChannelFloor {
  return (
    typeof (v as ChannelFloor).min_version === "string" &&
    typeof (v as ChannelFloor).upgrade_cmd === "string"
  );
}

// ---------------------------------------------------------------------------
// Semver
// ---------------------------------------------------------------------------

export function compareSemver(a: string, b: string): number {
  const [aMaj, aMin, aPat, aPre] = parseSemver(a);
  const [bMaj, bMin, bPat, bPre] = parseSemver(b);
  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  if (aPat !== bPat) return aPat - bPat;
  if (aPre && !bPre) return -1;
  if (!aPre && bPre) return 1;
  if (aPre && bPre) return aPre.localeCompare(bPre);
  return 0;
}

function parseSemver(v: string): [number, number, number, string | null] {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v);
  if (!m) return [0, 0, 0, null];
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? null];
}

// ---------------------------------------------------------------------------
// Ed25519 signature verification
// ---------------------------------------------------------------------------

/**
 * Verify the floor document's Ed25519 signature. Returns true on valid sig,
 * false on invalid signature or unknown `key_id`. The signed payload is the
 * canonical JSON of `{ floors, served_at }` - `signature` + `key_id` +
 * `cache_ttl_seconds` are excluded from the signed bytes.
 *
 * MUST stay byte-compatible with the backend signer:
 *   - Algorithm: Ed25519 (RFC 8032). Deterministic - same key + payload = same sig.
 *   - Payload: `canonicalJson({floors, served_at})` - sorted-keys + compact.
 *   - `key_id`: first 8 hex chars of SHA-256(raw 32-byte Ed25519 public key).
 *   - `signature`: hex-encoded 64-byte Ed25519 signature.
 *
 * The `keys` parameter maps `key_id → SPKI PEM string`; defaults to
 * `KNOWN_FLOOR_PUBLIC_KEYS`. Returns false on unknown key_id (triggers refetch
 * via the rotation path).
 */
export function verifyFloorSignature(
  doc: FloorDocument,
  keys: Record<string, string> = KNOWN_FLOOR_PUBLIC_KEYS,
): boolean {
  const pem = keys[doc.key_id];
  if (!pem) return false;
  // Re-derive key_id from the PEM - defends against a mis-keyed map entry.
  if (computeKeyId(pem) !== doc.key_id) return false;
  try {
    const pubKeyObject = crypto.createPublicKey({ key: pem, format: "pem" });
    const canonical = canonicalJson({
      floors: doc.floors,
      served_at: doc.served_at,
    });
    return crypto.verify(
      null,
      Buffer.from(canonical, "utf-8"),
      pubKeyObject,
      Buffer.from(doc.signature, "hex"),
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async function fetchFloorDoc(
  apiBase: string,
  d: Required<PreflightDeps>,
): Promise<FloorDocument | null> {
  const url = `${apiBase}${MIN_VERSION_ENDPOINT}`;
  let response: Response;
  try {
    response = await d.fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`network: ${(err as Error).message}`);
  }
  if (!response.ok) {
    throw new Error(`http-${response.status}`);
  }
  const body = (await response.json()) as FloorDocument;
  if (!body.floors || !body.signature || !body.key_id) {
    throw new Error("malformed-floor-doc");
  }
  if (!verifyFloorSignature(body)) {
    throw new Error("signature-invalid");
  }
  return body;
}

/**
 * Fire-and-forget background refresh. Never throws; never blocks. Errors are
 * swallowed because the foreground call already established a valid cache
 * verdict - refresh failure is a logging concern, not an enforcement one.
 */
async function refreshFloorCacheBackground(
  apiBase: string,
  d: Required<PreflightDeps>,
): Promise<void> {
  try {
    const fetched = await fetchFloorDoc(apiBase, d);
    if (fetched) {
      writeDiskCache(fetched, d);
      populateMemCache(fetched, d.now());
    }
  } catch {
    // Swallow - background refresh is best-effort.
  }
}

// ---------------------------------------------------------------------------
// In-memory cache helpers
// ---------------------------------------------------------------------------

function readInMemoryCache(d: Required<PreflightDeps>): FloorDocument | null {
  if (!memCache) return null;
  if (d.now() - memCache.fetched_at_ms > memCache.ttl_ms) {
    memCache = null;
    return null;
  }
  return memCache.doc;
}

function populateMemCache(doc: FloorDocument, fetched_at_ms: number): void {
  const ttlSec = doc.cache_ttl_seconds ?? 3600;
  const ttlMs = Math.min(
    Math.max(ttlSec * 1000, IN_MEMORY_TTL_MIN_MS),
    IN_MEMORY_TTL_MAX_MS,
  );
  memCache = { doc, fetched_at_ms, ttl_ms: ttlMs };
}

// ---------------------------------------------------------------------------
// Disk cache
// ---------------------------------------------------------------------------

function diskCachePath(d: Required<PreflightDeps>): string {
  const xdg =
    d.env.XDG_CONFIG_HOME ?? path.join(d.homedir(), ".config");
  // Normalise to forward-slash separators so the path string is consistent
  // across all platforms (Node.js fs APIs accept forward slashes on Windows).
  // Without this, path.join on win32 produces backslash keys that diverge from
  // the forward-slash test fixtures - and from XDG_CONFIG_HOME values that
  // callers supply in Unix form.
  return path.join(xdg, "alter", "floor-cache.json").replace(/\\/g, "/");
}

function readDiskCache(d: Required<PreflightDeps>): DiskCacheEntry | null {
  const p = diskCachePath(d);
  // POSIX ownership + mode-0600 check.
  if (d.platform !== "win32") {
    const stat = d.statFile(p);
    if (!stat) return null;
    if (stat.uid !== d.effectiveUid()) {
      // Foreign-owned cache - treat as miss to avoid attacker pre-seed.
      return null;
    }
    // Mode-0600 - file permission bits must be exactly 0o600 (rw owner only).
    if ((stat.mode & 0o777) !== 0o600) {
      return null;
    }
  }
  // NOTE: Windows ACL parity is deferred - Windows skips the ownership check
  // for now. A follow-up uses `fs.statSync` + DACL inspection via PowerShell
  // or the `winreg` binding.

  const raw = d.readFile(p);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DiskCacheEntry;
    if (!parsed.doc || typeof parsed.fetched_at_ms !== "number") return null;
    // Re-verify signature on read - an attacker who swapped the file (without
    // changing ownership) still has to forge the HMAC.
    if (!verifyFloorSignature(parsed.doc)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeDiskCache(
  doc: FloorDocument,
  d: Required<PreflightDeps>,
): void {
  const p = diskCachePath(d);
  const entry: DiskCacheEntry = { doc, fetched_at_ms: d.now() };
  try {
    d.writeFileAtomic(p, JSON.stringify(entry));
  } catch {
    // Cache write is best-effort.
  }
}

// ---------------------------------------------------------------------------
// IO defaults
// ---------------------------------------------------------------------------

const PROD_API_BASE = "https://api.truealter.com";

// Honour `ALTER_API` only when it passes the same allow-list
// as `--api` (https + api.truealter.com, or localhost under ALTER_E2E_DEV).
// A poisoned env must not be able to point the floor-document fetch at an
// attacker host (which, chained with a shipped placeholder HMAC key, could
// serve a forged min-version floor). Non-allow-listed → fall back to prod.
function defaultApiBase(d: Required<PreflightDeps>): string {
  const fromEnv = d.env.ALTER_API;
  if (!fromEnv) return PROD_API_BASE;
  try {
    const parsed = new URL(fromEnv);
    const e2eDev = d.env.ALTER_E2E_DEV === "1";
    const allowed = new Set<string>(["api.truealter.com"]);
    if (e2eDev) {
      allowed.add("localhost");
      allowed.add("127.0.0.1");
    }
    const httpsOk = parsed.protocol === "https:";
    const localOk =
      e2eDev &&
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
    if (allowed.has(parsed.hostname) && (httpsOk || localOk)) {
      return parsed.origin;
    }
  } catch {
    // fall through to prod default
  }
  return PROD_API_BASE;
}

function withDefaults(deps?: PreflightDeps): Required<PreflightDeps> {
  return {
    env: deps?.env ?? process.env,
    homedir: deps?.homedir ?? (() => os.homedir()),
    platform: deps?.platform ?? process.platform,
    now: deps?.now ?? (() => Date.now()),
    fetchImpl: deps?.fetchImpl ?? fetch,
    readFile: deps?.readFile ?? defaultReadFile,
    writeFileAtomic: deps?.writeFileAtomic ?? defaultWriteFileAtomic,
    statFile: deps?.statFile ?? defaultStatFile,
    effectiveUid:
      deps?.effectiveUid ??
      (() => (typeof process.geteuid === "function" ? process.geteuid() : 0)),
  };
}

function defaultReadFile(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/**
 * Atomic disk write: write to `<path>.tmp`, then `rename()` to `<path>`.
 * POSIX rename is atomic; Windows rename within the same volume is atomic.
 * No advisory lock - last-rename-wins is the correct semantics for a cache
 * file (concurrent CLI invocations may race and that's fine).
 *
 * File is created with mode 0o600 to satisfy the ownership check on
 * subsequent reads.
 *
 * Windows note: `fs.renameSync` on win32 throws EEXIST / EPERM when the
 * destination already exists (unlike POSIX where rename is atomic-replace).
 * We unlink the destination first on win32 before renaming, keeping the
 * write atomic-enough for a cache file (no advisory lock needed; last-rename
 * wins semantics are preserved).
 */
function defaultWriteFileAtomic(p: string, contents: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  // Ensure mode is 0o600 even if umask interfered.
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // Windows ignores mode bits - chmod may no-op or fail; not critical.
  }
  if (process.platform === "win32") {
    // On win32, rename over an existing file throws EEXIST / EPERM.
    // Unlink the destination first; a crash between unlink and rename leaves
    // no cache file, which is safe - the next run just refetches.
    try {
      fs.unlinkSync(p);
    } catch {
      // Destination didn't exist yet - that's fine.
    }
  }
  fs.renameSync(tmp, p);
}

function defaultStatFile(p: string): { uid: number; mode: number } | null {
  try {
    const st = fs.statSync(p);
    return { uid: st.uid, mode: st.mode };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Convenience - detect channel + run preflight for the running CLI.
// ---------------------------------------------------------------------------

/**
 * High-level wrapper used by `src/index.ts`. Detects the install channel
 * automatically and runs the preflight against the running CLI's version.
 */
export async function preflightFloorForCli(opts: {
  clientVersion: string;
  command?: string;
  apiBase?: string;
  deps?: PreflightDeps;
}): Promise<PreflightResult & { channel: InstallChannel; upgradePrompt?: string }> {
  // Channel detection needs the CLI's OWN entrypoint, not the running node
  // binary. Passing a bare `{ env }` object trips install-channel's "injected"
  // branch, where an absent scriptPath defaults to "" and the resolver falls
  // through to process.execPath (node's path), the exact misclassification the
  // self-update path was fixed for. With no injected deps we take the production
  // path (no argument), which reads the real entrypoint; with injected deps we
  // thread the entrypoint and interpreter through so a test still classifies by
  // a real path rather than node's.
  const channel =
    opts.deps === undefined
      ? detectInstallChannel()
      : detectInstallChannel({
          env: opts.deps.env,
          platform: opts.deps.platform,
          execPath: process.execPath,
          scriptPath: process.argv[1],
        });
  const result = await preflightFloor({
    clientId: "alter-cli",
    clientVersion: opts.clientVersion,
    channel,
    command: opts.command,
    apiBase: opts.apiBase,
    deps: opts.deps,
  });
  if (!result.ok && result.envelope) {
    const prompt = buildUpgradePrompt({
      channel,
      currentVersion: opts.clientVersion,
      minVersion: result.envelope.error.min_version,
    });
    return { ...result, channel, upgradePrompt: prompt.human };
  }
  return { ...result, channel };
}
