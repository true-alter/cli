/**
 * Bridge type surface.
 *
 * Shared types for the localhost browser-onboarding bridge. The bridge
 * extends the OAuth-loopback listener pattern to a verb-whitelisted POST
 * surface that the browser drives during onboarding. Verbs split into
 * non-destructive (idempotent reads / backend-only calls) and destructive
 * (writes disk / mutates user state / triggers wallet signing) - the
 * latter pass through the terminal confirmation gate before executing.
 */

import type { AlterSession } from "../auth.js";

// ---------------------------------------------------------------------------
// Verb whitelist
// ---------------------------------------------------------------------------

/**
 * Compile-time verb whitelist (404 on unlisted verbs).
 * `wire` is parameterised by `body.host_id` against a separate allowlist;
 * the verb itself is a single literal.
 */
export type BridgeVerb =
  | "pair_github"
  | "pair_discord"
  | "pair_website"
  | "pair_orcid"
  | "pair_isni"
  | "wallet_attest"
  | "wallet_attest_revoke"
  | "wallet_register"
  | "wire"
  | "prompt_install"
  | "cosmetics_inscribe"
  | "forget"
  | "health";

export const ALLOWED_VERBS: readonly BridgeVerb[] = [
  "pair_github",
  "pair_discord",
  "pair_website",
  "pair_orcid",
  "pair_isni",
  "wallet_attest",
  "wallet_attest_revoke",
  "wallet_register",
  "wire",
  "prompt_install",
  "cosmetics_inscribe",
  "forget",
  "health",
] as const;

/**
 * Verbs that mutate the user's local machine, trigger an irreversible
 * external effect (wallet signing prompt, DNS-TXT publish instruction),
 * or cause a side-effect that cannot be locally rolled back.
 * Server gates these through the terminal confirmation prompt.
 *
 * `forget` triggers graceful bridge shutdown - an irreversible
 * side-effect for the running session. It must pass through the
 * destructive-gate proxy so the terminal confirmation prompt fires before
 * the server closes. Without this, any bearer-authed caller can silently
 * terminate the bridge without user acknowledgement.
 */
export const DESTRUCTIVE_VERBS: ReadonlySet<BridgeVerb> = new Set<BridgeVerb>([
  "pair_website",
  "wallet_attest",
  "wallet_attest_revoke",
  "wallet_register",
  "wire",
  "prompt_install",
  "cosmetics_inscribe",
  "forget",
]);

/**
 * `wire` body.host_id allowlist. Browser passes the enum, CLI owns the
 * filesystem path resolution - closes the path-traversal gap.
 */
export type WireHostId =
  | "starship"
  | "vscode"
  | "cursor"
  | "tmux"
  | "waybar"
  | "polybar"
  | "eww"
  | "ps1"
  | "kitty"
  | "alacritty";

export const WIRE_HOST_IDS: readonly WireHostId[] = [
  "starship",
  "vscode",
  "cursor",
  "tmux",
  "waybar",
  "polybar",
  "eww",
  "ps1",
  "kitty",
  "alacritty",
] as const;

// ---------------------------------------------------------------------------
// Request / response envelopes
// ---------------------------------------------------------------------------

/**
 * Bridge request envelope. Browser POSTs `{ verb, nonce, body }` to
 * `/v1/verb/<verb>` with `Authorization: Bearer <token>`. `verb` is
 * redundant with the URL path but kept for log audit trails. `nonce`
 * is consumed once by `NonceCache` (replay protection).
 */
export interface BridgeRequest<V extends BridgeVerb = BridgeVerb> {
  verb: V;
  nonce: string;
  body: unknown;
}

/**
 * Bridge response envelope. Error responses carry a stable machine
 * `code` (e.g. `invalid_body`, `verb_unknown`, `confirmation_declined`)
 * so the browser can branch without parsing the human `error` message.
 */
export interface BridgeResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
  code?: string;
}

// ---------------------------------------------------------------------------
// Handler context
// ---------------------------------------------------------------------------

/**
 * Minimal structured logger surface - verbs use this rather than
 * `console.*` so the server can inject a redacting writer. Bearer and
 * raw wallet address MUST NOT pass through logger calls (the sha256
 * redaction convention).
 */
export interface BridgeLogger {
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  error: (msg: string, fields?: Record<string, unknown>) => void;
}

/**
 * Per-request handler context. Verbs receive everything they need
 * without reaching back through globals - keeps the test surface
 * narrow and lets the server inject `confirmDestructive` deterministically.
 */
export interface BridgeContext {
  /** Authenticated session - provides JWT, member key, handle, api base. */
  session: AlterSession;
  /**
   * Process-memory bridge bearer (never persisted).
   * Verbs read it only when proxying onto an inner backend call that
   * accepts the same auth; in practice they use `apiCall` with session.jwt.
   */
  bridgeToken: string;
  /**
   * Terminal y/n gate for destructive verbs. Server wires this to
   * the terminal y/n prompt. Returns `false` if user
   * declines or TTY is unavailable.
   */
  confirmDestructive: (message: string) => Promise<boolean>;
  /** Structured logger - JSON to stderr, no bearer / no raw address. */
  logger: BridgeLogger;
  /**
   * Trigger graceful shutdown of the bridge server. Wired by `forget`.
   * Verbs other than `forget` MUST NOT call this.
   */
  shutdown: () => void;
}

/**
 * Verb handler signature. Async; receives the validated request and
 * the per-request context. Should NEVER throw - wrap failures in a
 * `{ ok: false, error, code }` response so the server can return them
 * with corsHeaders + Cache-Control: no-store consistently.
 */
export type VerbHandler<V extends BridgeVerb = BridgeVerb> = (
  req: BridgeRequest<V>,
  ctx: BridgeContext,
) => Promise<BridgeResponse>;

// ---------------------------------------------------------------------------
// Stable error codes - surface to the browser, log audit trail
// ---------------------------------------------------------------------------

export const ERR_INVALID_BODY = "invalid_body";
export const ERR_VERB_UNKNOWN = "verb_unknown";
export const ERR_CONFIRMATION_DECLINED = "confirmation_declined";
export const ERR_BACKEND = "backend_error";
export const ERR_INTERNAL = "internal_error";
/**
 * A nonce this exact value was already consumed - a genuine replay
 * (attack or client bug). Distinct from `ERR_NONCE_CACHE_EXHAUSTED` -
 * see `NonceCache.consume` in `security.ts` for why the two must never
 * collapse into one code.
 */
export const ERR_NONCE_REPLAY = "nonce_replay";
/**
 * The nonce cache is at capacity and every live entry is still inside
 * its TTL window, so nothing can be evicted to admit this nonce without
 * reopening a replay window. This is an ALTER-side resource condition,
 * NOT a statement that this nonce was replayed - the caller did nothing
 * wrong and should retry with a fresh nonce shortly.
 */
export const ERR_NONCE_CACHE_EXHAUSTED = "nonce_cache_exhausted";
