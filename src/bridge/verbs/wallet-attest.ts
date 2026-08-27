/**
 * `wallet_attest` verb.
 *
 * Destructive - the actual signing happens browser-side via an
 * injected wallet provider, but the bridge's role is two-fold:
 *
 *   1. (init-leg, no `signature` in body) - proxy onto
 *      `POST /api/v1/wallet/attest/challenge` to mint the SIWE / off-chain
 *      message the browser will pass to the wallet for signing. Surfaces
 *      a terminal confirmation describing the address + chain so the
 *      user knows what their wallet is being asked to sign.
 *
 *   2. (verify-leg, `signature` present) - proxy onto
 *      `POST /api/v1/wallet/attest/verify` to persist the verified
 *      attestation server-side. No additional terminal prompt - the
 *      init-leg's confirmation already covered consent.
 *
 * Logging: raw address NEVER leaves the process in cleartext; sha256
 * redaction (security.redactAddress) is the only form that touches
 * the structured logger.
 */

import { apiCall, getSession } from "../../auth.js";
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
  isNonEmptyString,
  looksLikeEvmAddress,
  looksLikeSolanaAddress,
} from "../validators.js";

// Mirrors app.schemas.wallet_attest.Chain exactly. The request models on the
// other side are `extra="forbid"` and parse `chain` as that enum, so a value
// this set admits but the enum does not is a 422, not a degraded call. This
// set read {"base","eth","solana"} until 2026-08-07: "eth" is in no enum on
// either side, and the five chains the backend had gained since were absent,
// so the verb could not attest on any chain the member could actually pair.
const CHAINS = new Set([
  "base",
  "eth-l1",
  "solana",
  "polygon",
  "arbitrum",
  "optimism",
  "avalanche",
]);

interface WalletAttestBody {
  chain: string;
  address: string;
  signature?: string;
  nonce?: string;
  message?: string;
  consentAdded?: string[];
}

function parseBody(raw: unknown): WalletAttestBody | null {
  if (!isObject(raw)) return null;
  if (typeof raw.chain !== "string" || !CHAINS.has(raw.chain)) return null;
  const chain = raw.chain;
  if (typeof raw.address !== "string") return null;
  if (chain === "solana") {
    if (!looksLikeSolanaAddress(raw.address)) return null;
  } else {
    if (!looksLikeEvmAddress(raw.address)) return null;
  }
  const sig =
    typeof raw.signature === "string" && raw.signature.length > 0
      ? raw.signature
      : undefined;
  const nonce =
    typeof raw.nonce === "string" && raw.nonce.length > 0
      ? raw.nonce
      : undefined;
  // The verify leg must echo the canonical message the challenge leg returned;
  // the backend re-derives the signer from it and finds the nonce inside it.
  const message =
    typeof raw.message === "string" && raw.message.length > 0
      ? raw.message
      : undefined;
  const consentAdded =
    Array.isArray(raw.consent_added) &&
    raw.consent_added.every((c) => typeof c === "string" && CHAINS.has(c))
      ? (raw.consent_added as string[])
      : undefined;
  return { chain, address: raw.address, signature: sig, nonce, message, consentAdded };
}

function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export default async function walletAttest(
  req: BridgeRequest,
  ctx: BridgeContext,
): Promise<BridgeResponse> {
  const body = parseBody(req.body);
  if (!body) {
    return {
      ok: false,
      error:
        "invalid body - expect { chain, address, signature?, nonce?, message?, consent_added? }",
      code: ERR_INVALID_BODY,
    };
  }

  const isVerifyLeg = isNonEmptyString(body.signature) && isNonEmptyString(body.nonce);

  if (isVerifyLeg && !isNonEmptyString(body.message)) {
    return {
      ok: false,
      error: "invalid body - verify leg requires the `message` the challenge returned",
      code: ERR_INVALID_BODY,
    };
  }

  if (!isVerifyLeg) {
    const proceed = await ctx.confirmDestructive(
      `Sign SIWE for wallet ${shortAddress(body.address)} on ${body.chain}?`,
    );
    if (!proceed) {
      return {
        ok: false,
        error: "user declined confirmation",
        code: ERR_CONFIRMATION_DECLINED,
      };
    }

    const handle = getSession()?.handle;
    if (!handle) {
      return { ok: false, error: "not authenticated", code: ERR_BACKEND };
    }

    try {
      const resp = await apiCall("/api/v1/wallet/attest/challenge", {
        method: "POST",
        body: { handle, chain: body.chain, address: body.address },
      });
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
        ctx.logger.warn("wallet_attest challenge backend non-2xx", {
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
      return { ok: true, result: parsed ?? {} };
    } catch (err) {
      ctx.logger.error("wallet_attest challenge exception", {
        message: (err as Error).message,
        address_sha256: redactAddress(body.address),
      });
      return { ok: false, error: "internal error", code: ERR_INTERNAL };
    }
  }

  // verify-leg
  // `handle` comes from the bound session rather than the caller's body, so a
  // client cannot attest a wallet against a handle that is not its own.
  const handle = getSession()?.handle;
  if (!handle) {
    return { ok: false, error: "not authenticated", code: ERR_BACKEND };
  }

  try {
    const resp = await apiCall("/api/v1/wallet/attest/verify", {
      method: "POST",
      body: {
        handle,
        chain: body.chain,
        address: body.address,
        signature: body.signature,
        message: body.message,
        nonce: body.nonce,
        // The backend requires an explicit opt-in for any chain but base on a
        // first attest. Honour what the caller sent, else opt into the one
        // chain this call is actually binding.
        ...(body.chain === "base" && !body.consentAdded
          ? {}
          : { consent_added: body.consentAdded ?? [body.chain] }),
      },
    });
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
      ctx.logger.warn("wallet_attest verify backend non-2xx", {
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
    ctx.logger.info("wallet_attest verified", {
      chain: body.chain,
      address_sha256: redactAddress(body.address),
    });
    return { ok: true, result: parsed ?? {} };
  } catch (err) {
    ctx.logger.error("wallet_attest verify exception", {
      message: (err as Error).message,
      address_sha256: redactAddress(body.address),
    });
    return { ok: false, error: "internal error", code: ERR_INTERNAL };
  }
}
