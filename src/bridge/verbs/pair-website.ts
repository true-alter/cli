/**
 * `pair_website` verb.
 *
 * Destructive: surfaces a DNS-TXT / .well-known publish instruction
 * to the user's terminal, gated by confirmDestructive. The actual
 * publish action is user-driven on their DNS provider / web host -
 * the bridge's role is to call the backend resolver entry, surface
 * the resulting instruction to the terminal, and return the
 * resolver state to the browser.
 *
 * Body: { handle: "~handle", domain: "example.com" }
 */

import { apiCall } from "../../auth.js";
import {
  ERR_BACKEND,
  ERR_CONFIRMATION_DECLINED,
  ERR_INTERNAL,
  ERR_INVALID_BODY,
  type BridgeContext,
  type BridgeRequest,
  type BridgeResponse,
} from "../types.js";
import { isObject, looksLikeDomain, looksLikeHandle } from "../validators.js";

interface PairWebsiteBody {
  handle: string;
  domain: string;
}

function parseBody(raw: unknown): PairWebsiteBody | null {
  if (!isObject(raw)) return null;
  if (!looksLikeHandle(raw.handle)) return null;
  if (!looksLikeDomain(raw.domain)) return null;
  return { handle: raw.handle, domain: raw.domain };
}

export default async function pairWebsite(
  req: BridgeRequest,
  ctx: BridgeContext,
): Promise<BridgeResponse> {
  const body = parseBody(req.body);
  if (!body) {
    return {
      ok: false,
      error: "invalid body - expect { handle, domain }",
      code: ERR_INVALID_BODY,
    };
  }

  // Confused-deputy guard: the bridge is bound to one authenticated session.
  // Only that handle may be paired - never relay a caller-supplied foreign
  // handle to the backend under the user's credential.
  if (body.handle !== ctx.session.handle) {
    return {
      ok: false,
      error: "handle does not match the authenticated session",
      code: ERR_INVALID_BODY,
    };
  }

  const ok = await ctx.confirmDestructive(
    `Publish DNS-TXT instruction for ${body.domain}?`,
  );
  if (!ok) {
    return {
      ok: false,
      error: "user declined confirmation",
      code: ERR_CONFIRMATION_DECLINED,
    };
  }

  try {
    const resp = await apiCall("/api/v1/pair/website", {
      method: "POST",
      body: { handle: body.handle, domain: body.domain },
    });
    if (!resp) {
      return {
        ok: false,
        error: "not authenticated",
        code: ERR_BACKEND,
      };
    }
    const text = await resp.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!resp.ok) {
      ctx.logger.warn("pair_website backend non-2xx", {
        status: resp.status,
        domain: body.domain,
      });
      return {
        ok: false,
        error: `backend returned ${resp.status}`,
        code: ERR_BACKEND,
      };
    }
    return { ok: true, result: parsed ?? {} };
  } catch (err) {
    ctx.logger.error("pair_website exception", {
      message: (err as Error).message,
    });
    return {
      ok: false,
      error: "internal error",
      code: ERR_INTERNAL,
    };
  }
}
