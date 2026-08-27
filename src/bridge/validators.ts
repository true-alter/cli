/**
 * Hand-written body validators.
 *
 * The CLI dependency surface is intentionally narrow (no zod in
 * package.json today). Each verb exports a `parseBody` that turns
 * `unknown` into a typed body or returns `null` so the server can
 * emit `400 invalid_body` consistently.
 *
 * TODO(deps): once we can add a dep without churn, swap these for
 * zod schemas - same call-site shape, better error messages.
 */

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

export function isString(v: unknown): v is string {
  return typeof v === "string";
}

/**
 * Loose handle check - server is the authoritative validator. We
 * just want to refuse obviously malformed bodies before proxying.
 */
export function looksLikeHandle(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length > 1 &&
    v.length <= 64 &&
    v.startsWith("~") &&
    /^~[a-z0-9][a-z0-9-]*$/i.test(v)
  );
}

/**
 * Hostname syntax sanity - refuses obvious junk before we hit the
 * resolver. Real validation (IDN canonicalisation, public-suffix
 * check) is server-side per the resolver spec.
 */
export function looksLikeDomain(v: unknown): v is string {
  if (typeof v !== "string") return false;
  if (v.length < 3 || v.length > 253) return false;
  if (v.startsWith(".") || v.endsWith(".")) return false;
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v);
}

/** EVM address sanity: 0x + 40 hex chars. */
export function looksLikeEvmAddress(v: unknown): v is string {
  return typeof v === "string" && /^0x[a-fA-F0-9]{40}$/.test(v);
}

/** Solana base58 address sanity: 32–44 base58 chars. */
export function looksLikeSolanaAddress(v: unknown): v is string {
  return (
    typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)
  );
}
