/**
 * `pair_orcid` verb.
 *
 * Registry attestation. Non-destructive - the backend resolver does
 * an HTTPS GET against ORCID public API; nothing on the user's
 * machine changes.
 *
 * Body: { handle: "~handle", orcid: "0000-0002-1825-0097" }
 */

import { apiCall } from "../../auth.js";
import {
  ERR_BACKEND,
  ERR_INTERNAL,
  ERR_INVALID_BODY,
  type BridgeContext,
  type BridgeRequest,
  type BridgeResponse,
} from "../types.js";
import { isObject, looksLikeHandle } from "../validators.js";

interface PairOrcidBody {
  handle: string;
  orcid: string;
}

const ORCID_RE = /^[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{3}[0-9Xx]$/;

function parseBody(raw: unknown): PairOrcidBody | null {
  if (!isObject(raw)) return null;
  if (!looksLikeHandle(raw.handle)) return null;
  if (typeof raw.orcid !== "string" || !ORCID_RE.test(raw.orcid)) return null;
  return { handle: raw.handle, orcid: raw.orcid };
}

export default async function pairOrcid(
  req: BridgeRequest,
  ctx: BridgeContext,
): Promise<BridgeResponse> {
  const body = parseBody(req.body);
  if (!body) {
    return {
      ok: false,
      error: "invalid body - expect { handle, orcid }",
      code: ERR_INVALID_BODY,
    };
  }

  // Confused-deputy guard: only the authenticated session handle may be
  // paired - never relay a caller-supplied foreign handle under the user's
  // credential.
  if (body.handle !== ctx.session.handle) {
    return {
      ok: false,
      error: "handle does not match the authenticated session",
      code: ERR_INVALID_BODY,
    };
  }

  try {
    const resp = await apiCall("/api/v1/pair/orcid", {
      method: "POST",
      body: { handle: body.handle, orcid: body.orcid },
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
      ctx.logger.warn("pair_orcid backend non-2xx", {
        status: resp.status,
      });
      return {
        ok: false,
        error: `backend returned ${resp.status}`,
        code: ERR_BACKEND,
      };
    }
    return { ok: true, result: parsed ?? {} };
  } catch (err) {
    ctx.logger.error("pair_orcid exception", {
      message: (err as Error).message,
    });
    return {
      ok: false,
      error: "internal error",
      code: ERR_INTERNAL,
    };
  }
}
