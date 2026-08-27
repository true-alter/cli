/**
 * pricing-reference.ts - Per-tier reference prices for ALTER identity queries.
 *
 * Values are fetched live from the field's tool-pricing endpoint
 * (GET /api/v1/x402/tools) so cost banners stay accurate after any schedule
 * update. When the endpoint is unreachable (network error, non-200, shape
 * mismatch, unauthenticated context) the module falls back to the reference
 * constants below, and callers receive `live: false` so banners can mark
 * the figure as indicative.
 *
 * Australian English in comments; US English in identifiers.
 */

import { apiCall } from "../auth.js";

// ---------------------------------------------------------------------------
// Reference constants (fallback when the live endpoint is unreachable)
// ---------------------------------------------------------------------------

/**
 * Indicative per-tier reference price map (USD, per query).
 * Mirrors the backend tool-pricing schedule - L0=free.
 * alter_alignment (L3) = $0.30 per query.
 */
export const INDICATIVE_PRICING: Record<string, number> = {
  L0: 0,     // free - member self-query / unauthenticated public
  L1: 0.01,  // basic identity signal
  L2: 0.10,  // enriched identity
  L3: 0.30,  // full alignment query (peer_recognition context)
  L4: 0.60,  // workforce / collaboration context
  L5: 1.00,  // co-founder / strategic context
};

/**
 * Indicative cooperative pool share (subject earns this fraction of any
 * query_field call price when they surface). Mirrors the backend earning
 * share (display only; the split is computed server-side).
 */
export const INDICATIVE_COOPERATIVE_POOL_SHARE = 0.75;

// ---------------------------------------------------------------------------
// Live-pricing contract (mirrors GET /api/v1/x402/tools response shape)
// ---------------------------------------------------------------------------

interface ToolPriceEntry {
  price_usd: number;
  tier: string;
}

interface ToolPricingResponse {
  tools: Record<string, ToolPriceEntry>;
  cooperative_pool_share: number;
  currency: string;
}

function isToolPricingResponse(v: unknown): v is ToolPricingResponse {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  if (!r.tools || typeof r.tools !== "object") return false;
  if (typeof r.cooperative_pool_share !== "number") return false;
  if (typeof r.currency !== "string") return false;
  return true;
}

// ---------------------------------------------------------------------------
// Resolved pricing shape returned to callers
// ---------------------------------------------------------------------------

export interface LivePricing {
  /** USD price for a single query_field (L5) call. */
  queryFieldPrice: number;
  /**
   * USD price for a single standing-requirement check that reveals someone
   * (poll_requirement_matches, L1). Falls back to the L1 reference constant
   * when the live catalogue omits the entry.
   */
  requirementCheckPrice: number;
  /** Fraction of the call price that surfaces members share. */
  cooperativePoolShare: number;
  /**
   * true  - values came from the live endpoint.
   * false - endpoint was unreachable; values are the reference fallback.
   */
  live: boolean;
}

// ---------------------------------------------------------------------------
// In-process memoisation - fetch at most once per CLI invocation
// ---------------------------------------------------------------------------

let _memo: LivePricing | undefined;

/**
 * Fetch live pricing from the field's tool-pricing endpoint.
 *
 * Memoised: multiple banners in the same CLI invocation share one fetch.
 * Short (~2 s) timeout prevents blocking the confirm prompt on a slow network.
 * Any failure (network, non-200, shape mismatch, unauthenticated context)
 * returns the reference constants with `live: false`.
 */
export async function fetchLivePricing(
  signal?: AbortSignal,
): Promise<LivePricing> {
  if (_memo) return _memo;

  const fallback: LivePricing = {
    queryFieldPrice: INDICATIVE_PRICING.L5,
    requirementCheckPrice: INDICATIVE_PRICING.L1,
    cooperativePoolShare: INDICATIVE_COOPERATIVE_POOL_SHARE,
    live: false,
  };

  try {
    const resp = await apiCall("/api/v1/x402/tools", {
      method: "GET",
      timeoutMs: 2000,
      signal,
    });

    // apiCall returns null when there is no session (unauthenticated context).
    if (!resp) {
      _memo = fallback;
      return _memo;
    }

    // Both 200 (authenticated) and 401 (anonymous) are acceptable; the backend
    // may return public pricing without a JWT. Any other non-2xx is a failure.
    if (!resp.ok) {
      _memo = fallback;
      return _memo;
    }

    const json: unknown = await resp.json();
    if (!isToolPricingResponse(json)) {
      _memo = fallback;
      return _memo;
    }

    const qf = json.tools["query_field"];
    if (!qf || typeof qf.price_usd !== "number") {
      _memo = fallback;
      return _memo;
    }

    // The standing-requirement check price falls back independently: the
    // query_field entry is the contract for `live`; an absent
    // poll_requirement_matches entry only degrades that one figure.
    const check = json.tools["poll_requirement_matches"];
    const checkPrice =
      check && typeof check.price_usd === "number"
        ? check.price_usd
        : INDICATIVE_PRICING.L1;

    _memo = {
      queryFieldPrice: qf.price_usd,
      requirementCheckPrice: checkPrice,
      cooperativePoolShare: json.cooperative_pool_share,
      live: true,
    };
    return _memo;
  } catch (err) {
    // A user-cancelled probe must not poison the memo for the rest of the
    // process - rethrow so the cancel wrapper can classify it, leaving the
    // memo unset for the next (uncancelled) attempt.
    if ((err as Error)?.name === "AbortError") throw err;
    _memo = fallback;
    return _memo;
  }
}

/**
 * Reset the in-process memo. Exposed for tests only - production code
 * never calls this.
 */
export function _resetPricingMemoForTests(): void {
  _memo = undefined;
}

// ---------------------------------------------------------------------------
// Human-readable tier label for display
// ---------------------------------------------------------------------------

const TIER_LABELS: Record<string, string> = {
  L0: "L0 - free",
  L1: "L1 - basic",
  L2: "L2 - enriched",
  L3: "L3 - alignment",
  L4: "L4 - workforce",
  L5: "L5 - strategic",
};

/**
 * Format a small indicative per-type/per-tier reference panel suitable for
 * inserting before a confirm prompt.
 *
 * @param indent - optional leading indent string (e.g. "  ")
 * @returns multi-line string ending with "\n"
 */
export function formatPricingPanel(indent = ""): string {
  const lines: string[] = [
    `${indent}Indicative per-query prices (subject to change at on-chain cutover):`,
  ];
  for (const [tier, price] of Object.entries(INDICATIVE_PRICING)) {
    const label = TIER_LABELS[tier] ?? tier;
    const priceStr = price === 0 ? "free" : `$${price.toFixed(3)}`;
    lines.push(`${indent}  ${label.padEnd(24)}  ${priceStr}`);
  }
  lines.push("");
  return lines.join("\n");
}
