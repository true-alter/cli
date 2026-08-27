/**
 * Bridge auth + CORS gates.
 *
 * Security capabilities provided here:
 *   Origin allowlist (exact-match, never `*`)           - validateOrigin
 *   DNS-rebinding Host check (loopback only)            - validateHost
 *   32-byte bearer entropy                              - mintBridgeToken
 *   ACAO exact origin, never `*`                        - corsHeaders
 *   Per-verb replay-protection nonce                    - NonceCache
 *   Cache-Control: no-store on all responses            - corsHeaders
 *
 * Bearer compare is constant-time via timingSafeEqual; mismatched
 * lengths return false without leaking via early return timing.
 */

import * as crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Origin / Host gates
// ---------------------------------------------------------------------------

/**
 * Exact-match Origin allowlist. Browsers OMIT Origin on same-origin
 * navigations but the bridge surface is always cross-origin from the
 * browser tab's perspective, so missing Origin on POSTs is always
 * rejected. Wildcards in the allowlist are refused defensively.
 *
 * Dev origins (`process.env.ALTER_BRIDGE_DEV_ORIGINS`) are honoured
 * ONLY when `process.env.ALTER_DEV === "1"` - guards against a stray
 * env var leaking into production binaries.
 */
export function validateOrigin(
  headerValue: string | string[] | undefined,
  allowlist: readonly string[],
): boolean {
  if (Array.isArray(headerValue) || headerValue === undefined) return false;
  if (headerValue === "") return false;
  if (headerValue === "*") return false;

  const allowed = new Set<string>();
  for (const entry of allowlist) {
    if (entry === "*" || entry === "") continue;
    allowed.add(entry);
  }
  if (process.env.ALTER_DEV === "1") {
    const dev = process.env.ALTER_BRIDGE_DEV_ORIGINS ?? "";
    for (const raw of dev.split(",")) {
      const trimmed = raw.trim();
      if (!trimmed || trimmed === "*") continue;
      allowed.add(trimmed);
    }
  }
  return allowed.has(headerValue);
}

/**
 * Build the canonical Origin allowlist for a fresh bridge instance.
 * Callers add `https://truealter.com` plus any explicit dev origins
 * the constructor passed in. Kept here so server.ts + manifest.ts
 * agree on the same set without re-deriving env handling.
 */
export function defaultOriginAllowlist(extra: readonly string[] = []): string[] {
  const base = ["https://truealter.com"];
  for (const e of extra) {
    if (!e || e === "*") continue;
    base.push(e);
  }
  return base;
}

/**
 * Host header validation - DNS-rebinding mitigation.
 * Accept only `127.0.0.1:<port>`. `localhost` is rejected because IPv6
 * `::1` resolves through it under different filtering rules and a
 * /etc/hosts re-map can break the loopback assumption. `0.0.0.0` is
 * rejected because nothing should be reaching us on any non-loopback
 * interface - we bind 127.0.0.1.
 */
export function validateHost(
  headerValue: string | string[] | undefined,
  expectedPort: number,
): boolean {
  if (Array.isArray(headerValue) || headerValue === undefined) return false;
  if (headerValue === "") return false;
  return headerValue === `127.0.0.1:${expectedPort}`;
}

// ---------------------------------------------------------------------------
// Bearer token mint + verify
// ---------------------------------------------------------------------------

/**
 * 32-byte (256-bit) base64url bearer. Process-memory
 * only - never persisted to disk. Caller passes the
 * value into the URL fragment (CLI-first) or file rendezvous (browser-
 * first) and into the bridge server constructor.
 */
export function mintBridgeToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * Constant-time bearer verifier. Bearer prefix must be the literal
 * "Bearer " (case-sensitive, single space, no trailing whitespace).
 * Lengths must match exactly before timingSafeEqual is called -
 * Node throws on length mismatch otherwise.
 */
export function validateBearer(
  authHeader: string | string[] | undefined,
  expectedToken: string,
): boolean {
  if (Array.isArray(authHeader) || authHeader === undefined) return false;
  if (!authHeader.startsWith("Bearer ")) return false;
  const supplied = authHeader.slice("Bearer ".length);
  if (supplied.length !== expectedToken.length) return false;
  try {
    const a = Buffer.from(supplied, "utf-8");
    const b = Buffer.from(expectedToken, "utf-8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// CORS headers
// ---------------------------------------------------------------------------

/**
 * Per-request CORS + cache headers. Origin echoed exactly (never `*`)
 * because the bridge is credentialed via Bearer - wildcard ACAO breaks
 * the `Authorization` + cross-origin XHR pair anyway. `Vary: Origin`
 * documents that responses differ by Origin for any cache between us
 * and the browser. `Cache-Control: no-store` and
 * `X-Content-Type-Options: nosniff` round out the response defaults.
 */
export function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, X-Alter-Nonce",
    "Access-Control-Max-Age": "600",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    Vary: "Origin",
  };
}

// ---------------------------------------------------------------------------
// Replay-protection nonce cache
// ---------------------------------------------------------------------------

/**
 * Bounded in-memory one-time-use nonce store. Browser MUST mint a fresh
 * nonce per request; the server consumes it once and rejects any replay.
 *
 * Hardening: entries carry a server-side timestamp and are expired
 * after NONCE_TTL_MS (5 minutes). The bridge runs on a single-user
 * machine and the bearer token is process-memory-only (never persisted),
 * so the trust boundary is already loopback-local; the TTL adds a
 * defence-in-depth bound on how long a captured nonce remains useful to
 * any process on the same machine. There is no separate request
 * timestamp / clock-skew check anywhere on the bridge request path
 * (`BridgeRequest` carries only `{ verb, nonce, body }` - see types.ts) -
 * this cache's own TTL is the ONLY thing bounding how long a nonce's
 * replay-protection holds, so eviction must never remove an entry that
 * is still inside that window.
 *
 * At the size cap, `consume()` first purges genuinely-expired entries
 * (their TTL already lapsed, so dropping them changes nothing about
 * replay safety) and only then re-checks capacity. If every remaining
 * entry is still live, the cap fails CLOSED: the new nonce is refused
 * rather than evicting a live entry to make room. A prior revision
 * evicted the oldest entry unconditionally (FIFO-by-insertion, not
 * true LRU) even when it was still inside its TTL window, which let an
 * attacker who could drive `cap` distinct nonces through the cache
 * evict - and thereby re-open replay of - a still-valid target nonce.
 * Failing closed only ever affects an attacker flooding the cache or a
 * process already past its legitimate-traffic envelope; the legitimate
 * client mints a fresh nonce per request and retries.
 *
 * `consume()` fails closed for TWO structurally different reasons and
 * the caller MUST be able to tell them apart (`NonceConsumeResult`,
 * below): `reason: "replay"` means this exact nonce value was already
 * consumed - a genuine replay, an attack or a client bug, the caller
 * did something wrong. `reason: "cap_exhausted"` means the cache is
 * full of entries that are all still live - an ALTER-side capacity
 * condition that says nothing about whether THIS nonce was ever seen
 * before; the caller did nothing wrong and a fresh nonce may succeed
 * moments later once something expires. Collapsing both into one
 * boolean (the pre-fix shape) forces every caller to treat "we're out
 * of room" identically to "you replayed a request", which mislabels an
 * ALTER-side resource condition as caller misbehaviour and makes it
 * impossible for an operator watching the bridge to distinguish a
 * capacity problem from an actual attack.
 *
 * A third `reason: "invalid"` covers a non-string / empty nonce -
 * malformed input, not a temporal or capacity failure. The wire path
 * never reaches it: `server.ts` validates `envelope.nonce` shape
 * before calling `consume()` and returns `ERR_INVALID_BODY` earlier.
 * It exists so the class's own contract stays honest for callers that
 * invoke `consume()` directly (the test suite does).
 */

const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Discriminated result of `NonceCache.consume()`. See the class doc
 * comment above for why `"replay"` and `"cap_exhausted"` must never
 * collapse into a single `false`. Matches the `{ ok: true } |
 * { ok: false, ... }` shape used by every verb handler's
 * `BridgeResponse` (`types.ts`) so callers translate this the same way
 * they already translate a verb result - `reason` (not `error`/`code`)
 * because this is an internal cache result, not a wire response; the
 * caller (`server.ts`) owns mapping `reason` to an HTTP status and a
 * stable `ERR_*` wire code.
 */
export type NonceConsumeResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "replay" | "cap_exhausted" | "invalid";
    };

export class NonceCache {
  private readonly seen: Map<string, number>;
  private readonly cap: number;
  private readonly ttlMs: number;

  constructor(cap = 1024, ttlMs = NONCE_TTL_MS) {
    this.cap = Math.max(1, cap);
    this.ttlMs = ttlMs;
    this.seen = new Map<string, number>();
  }

  /**
   * Returns `{ ok: true }` if the nonce was unseen and has now been
   * recorded. Returns `{ ok: false, reason }` otherwise, and the
   * caller MUST branch on `reason` rather than treating every failure
   * identically (see `NonceConsumeResult` above for why):
   *
   *  - `"replay"` - this exact nonce was already consumed. A genuine
   *    replay; refuse the request, this is a caller/attacker fault.
   *  - `"cap_exhausted"` - the cache is at capacity and every entry is
   *    still inside its TTL window, so nothing is safe to evict. An
   *    ALTER-side resource condition; the caller did nothing wrong.
   *  - `"invalid"` - non-string or empty nonce (caller bug or attacker
   *    probing the gate). Not reachable via the wire path - see the
   *    class doc comment.
   */
  consume(nonce: string): NonceConsumeResult {
    if (typeof nonce !== "string") return { ok: false, reason: "invalid" };
    if (nonce.length === 0) return { ok: false, reason: "invalid" };
    const now = Date.now();
    const seenAt = this.seen.get(nonce);
    if (seenAt !== undefined) {
      // Already consumed - refuse regardless of TTL.
      return { ok: false, reason: "replay" };
    }
    if (this.seen.size >= this.cap) {
      // Opportunistic purge before considering eviction: entries whose
      // TTL has genuinely lapsed are already safe to forget, so relieve
      // cap pressure with those first. The periodic timer (server.ts,
      // every 60s) also calls this, but that interval can lag a burst
      // of distinct nonces, so purge inline too rather than relying on
      // it alone.
      this.purgeExpired(now);
    }
    if (this.seen.size >= this.cap) {
      // Every remaining entry is still inside its TTL window - there is
      // no nonce here that is safe to evict without reopening a live
      // replay window. Fail closed: refuse this nonce rather than
      // silently evict a still-valid one. The caller (server.ts)
      // distinguishes this from a genuine replay via `reason` and maps
      // it to a distinct wire response; the legitimate client mints a
      // fresh nonce and retries.
      return { ok: false, reason: "cap_exhausted" };
    }
    this.seen.set(nonce, now);
    return { ok: true };
  }

  /**
   * Purge entries older than `ttlMs`. Called by the server on a periodic
   * interval to bound memory use without waiting for the LRU cap to
   * trigger. Also closes the TTL window: once an entry expires here it
   * cannot be replayed via the LRU eviction path either, because a
   * subsequent `consume` call will see the slot empty and accept a fresh
   * same-nonce value - but that is the intended behaviour (the TTL
   * represents the window within which a nonce must not be reused).
   */
  purgeExpired(now = Date.now()): void {
    for (const [nonce, seenAt] of this.seen) {
      if (now - seenAt > this.ttlMs) {
        this.seen.delete(nonce);
      }
    }
  }

  /** Test surface - current cache size. */
  size(): number {
    return this.seen.size;
  }
}

// ---------------------------------------------------------------------------
// Address redaction - log helper
// ---------------------------------------------------------------------------

/**
 * Returns sha256(address) hex - logging convention. Verbs that
 * touch wallet addresses MUST pass them through this before any log
 * call, and never log the raw value.
 */
export function redactAddress(address: string): string {
  return crypto.createHash("sha256").update(address, "utf-8").digest("hex");
}
