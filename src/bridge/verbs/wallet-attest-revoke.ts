/**
 * `wallet_attest_revoke` verb.
 *
 * Unbinds a wallet the member previously attested via `wallet_attest`
 * (POST .../challenge + .../verify). Proxies onto
 * `DELETE /api/v1/wallet/attest/{address}?chain=<chain>`.
 *
 * Destructive - passes through `ctx.confirmDestructive` before the
 * backend call, same as `wallet_attest`'s init-leg and `wallet_register`.
 * The server's destructive-verb gate refuses a success response from any
 * verb in DESTRUCTIVE_VERBS that never consulted the gate (see
 * bridge/server.ts), so this verb MUST call `confirmDestructive` before
 * every branch that can return `ok: true`.
 *
 * `chain` is optional in the request body. When omitted, the verb reads
 * the caller's own attestation list (GET /api/v1/wallet/attest, self-
 * scoped) to resolve which chain(s) the address is bound under:
 *
 *   - zero matches -> `no_active_attestation` (nothing to revoke, no
 *     existence disclosure beyond the caller's own rows)
 *   - one match -> revoke it
 *   - more than one match (the same address attested on multiple
 *     chains) -> `chain_ambiguous`, listing the candidate chains. A
 *     bridge verb returns exactly one result and has no interactive
 *     back-and-forth, so silently picking one or revoking every match
 *     is the wrong default for a destructive, unconfirmable-per-item
 *     action; the caller re-issues with an explicit `chain`.
 *
 * Logging: raw address NEVER leaves the process in cleartext; sha256
 * redaction (security.redactAddress) is the only form that touches the
 * structured logger, same convention as wallet-attest.ts.
 */

import { apiCall } from "../../auth.js";
import { redactAddress } from "../security.js";
import {
  ERR_BACKEND,
  ERR_CONFIRMATION_DECLINED,
  ERR_INTERNAL,
  ERR_INVALID_BODY,
  type BridgeContext,
  type BridgeRequest,
  type BridgeResponse,
} from "../types.js";
import { isObject, looksLikeEvmAddress, looksLikeSolanaAddress } from "../validators.js";

// Full chain identifier set the backend accepts (app.schemas.wallet_attest.
// Chain). Deliberately NOT the wallet-attest.ts CHAINS set ({"base","eth",
// "solana"}), which pre-dates eth-l1/polygon/arbitrum/optimism/avalanche
// and would refuse a valid --chain for any row attested since #3205.
const ATTEST_CHAIN_VALUES = new Set([
  "base",
  "eth-l1",
  "solana",
  "polygon",
  "arbitrum",
  "optimism",
  "avalanche",
]);

interface WalletAttestRevokeBody {
  address: string;
  chain?: string;
}

interface WalletAttestationSummary {
  address: string;
  chain: string;
  [key: string]: unknown;
}

function parseBody(raw: unknown): WalletAttestRevokeBody | null {
  if (!isObject(raw)) return null;
  if (typeof raw.address !== "string") return null;
  if (!looksLikeEvmAddress(raw.address) && !looksLikeSolanaAddress(raw.address)) {
    return null;
  }
  if (raw.chain !== undefined) {
    if (typeof raw.chain !== "string" || !ATTEST_CHAIN_VALUES.has(raw.chain)) {
      return null;
    }
    return { address: raw.address, chain: raw.chain };
  }
  return { address: raw.address };
}

function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

async function resolveChain(
  address: string,
): Promise<{ ok: true; chain: string } | { ok: false; response: BridgeResponse }> {
  const resp = await apiCall("/api/v1/wallet/attest");
  if (!resp) {
    return { ok: false, response: { ok: false, error: "not authenticated", code: ERR_BACKEND } };
  }
  if (!resp.ok) {
    return {
      ok: false,
      response: { ok: false, error: `backend returned ${resp.status}`, code: ERR_BACKEND },
    };
  }
  const text = await resp.text();
  let parsed: { wallets?: WalletAttestationSummary[] } | null = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  const wallets = parsed?.wallets ?? [];
  const lower = address.toLowerCase();
  const matches = wallets.filter((w) => w.address.toLowerCase() === lower);

  if (matches.length === 0) {
    return {
      ok: false,
      response: {
        ok: false,
        error: "no active attestation found for that address",
        code: "no_active_attestation",
      },
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      response: {
        ok: false,
        error: `address is attested on multiple chains (${matches
          .map((w) => w.chain)
          .join(", ")}); retry with an explicit chain`,
        code: "chain_ambiguous",
      },
    };
  }
  return { ok: true, chain: matches[0].chain };
}

export default async function walletAttestRevoke(
  req: BridgeRequest,
  ctx: BridgeContext,
): Promise<BridgeResponse> {
  const body = parseBody(req.body);
  if (!body) {
    return {
      ok: false,
      error: "invalid body - expect { address, chain? }",
      code: ERR_INVALID_BODY,
    };
  }

  let chain = body.chain;
  if (chain === undefined) {
    const resolved = await resolveChain(body.address);
    if (!resolved.ok) {
      // Chain resolution failed before any destructive action was
      // proposed - nothing to confirm, nothing was revoked.
      return resolved.response;
    }
    chain = resolved.chain;
  }

  const proceed = await ctx.confirmDestructive(
    `Revoke wallet attestation for ${shortAddress(body.address)} on ${chain}?`,
  );
  if (!proceed) {
    return {
      ok: false,
      error: "user declined confirmation",
      code: ERR_CONFIRMATION_DECLINED,
    };
  }

  try {
    const resp = await apiCall(
      `/api/v1/wallet/attest/${encodeURIComponent(body.address)}?chain=${encodeURIComponent(chain)}`,
      { method: "DELETE" },
    );
    if (!resp) {
      return { ok: false, error: "not authenticated", code: ERR_BACKEND };
    }
    if (!resp.ok) {
      ctx.logger.warn("wallet_attest_revoke backend non-2xx", {
        status: resp.status,
        chain,
        address_sha256: redactAddress(body.address),
      });
      return {
        ok: false,
        error: `backend returned ${resp.status}`,
        code: ERR_BACKEND,
      };
    }
    ctx.logger.info("wallet_attest_revoke revoked", {
      chain,
      address_sha256: redactAddress(body.address),
    });
    return { ok: true, result: { revoked: true, chain } };
  } catch (err) {
    ctx.logger.error("wallet_attest_revoke exception", {
      message: (err as Error).message,
      address_sha256: redactAddress(body.address),
    });
    return { ok: false, error: "internal error", code: ERR_INTERNAL };
  }
}
