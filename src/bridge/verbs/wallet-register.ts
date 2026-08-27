/**
 * `wallet_register` verb.
 *
 * Destructive - registers the payout wallet (x402 destination).
 * Terminal confirmation gate before the backend POST. Distinct from
 * `wallet_attest`: attest binds a wallet for manifestation reads,
 * register routes future Identity Income payouts.
 *
 * Body: { chain: "base"|"eth"|"solana", address: string }
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
import {
  isObject,
  looksLikeEvmAddress,
  looksLikeSolanaAddress,
} from "../validators.js";

const CHAINS = new Set(["base", "eth", "solana"]);

interface WalletRegisterBody {
  chain: "base" | "eth" | "solana";
  address: string;
}

function parseBody(raw: unknown): WalletRegisterBody | null {
  if (!isObject(raw)) return null;
  if (typeof raw.chain !== "string" || !CHAINS.has(raw.chain)) return null;
  const chain = raw.chain as WalletRegisterBody["chain"];
  if (typeof raw.address !== "string") return null;
  if (chain === "solana") {
    if (!looksLikeSolanaAddress(raw.address)) return null;
  } else {
    if (!looksLikeEvmAddress(raw.address)) return null;
  }
  return { chain, address: raw.address };
}

function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export default async function walletRegister(
  req: BridgeRequest,
  ctx: BridgeContext,
): Promise<BridgeResponse> {
  const body = parseBody(req.body);
  if (!body) {
    return {
      ok: false,
      error: "invalid body - expect { chain, address }",
      code: ERR_INVALID_BODY,
    };
  }

  const proceed = await ctx.confirmDestructive(
    `Register ${shortAddress(body.address)} on ${body.chain} as your payout wallet?`,
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
      `/api/v1/members/me/wallet?wallet_address=${encodeURIComponent(body.address)}`,
      { method: "PUT" },
    );
    if (!resp) {
      return { ok: false, error: "not authenticated", code: ERR_BACKEND };
    }
    const text = await resp.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!resp.ok) {
      ctx.logger.warn("wallet_register backend non-2xx", {
        status: resp.status,
        chain: body.chain,
        address_sha256: redactAddress(body.address),
      });
      return {
        ok: false,
        error: `backend returned ${resp.status}`,
        code: ERR_BACKEND,
      };
    }
    ctx.logger.info("wallet_register success", {
      chain: body.chain,
      address_sha256: redactAddress(body.address),
    });
    return { ok: true, result: parsed ?? {} };
  } catch (err) {
    ctx.logger.error("wallet_register exception", {
      message: (err as Error).message,
      address_sha256: redactAddress(body.address),
    });
    return { ok: false, error: "internal error", code: ERR_INTERNAL };
  }
}
