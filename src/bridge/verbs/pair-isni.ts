/**
 * `pair_isni` verb.
 *
 * Registry attestation against ISNI / MusicBrainz cross-resolution.
 * Non-destructive - backend resolver only.
 *
 * Body: { handle: "~handle", isni: "0000000121032683" }
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

interface PairIsniBody {
  handle: string;
  isni: string;
}

const ISNI_RE = /^[0-9]{15}[0-9Xx]$/;

function parseBody(raw: unknown): PairIsniBody | null {
  if (!isObject(raw)) return null;
  if (!looksLikeHandle(raw.handle)) return null;
  if (typeof raw.isni !== "string") return null;
  const stripped = raw.isni.replace(/[\s-]/g, "");
  if (!ISNI_RE.test(stripped)) return null;
  return { handle: raw.handle, isni: stripped };
}

export default async function pairIsni(
  req: BridgeRequest,
  ctx: BridgeContext,
): Promise<BridgeResponse> {
  const body = parseBody(req.body);
  if (!body) {
    return {
      ok: false,
      error: "invalid body - expect { handle, isni }",
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
    const resp = await apiCall("/api/v1/pair/isni", {
      method: "POST",
      body: { handle: body.handle, isni: body.isni },
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
      ctx.logger.warn("pair_isni backend non-2xx", {
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
    ctx.logger.error("pair_isni exception", {
      message: (err as Error).message,
    });
    return {
      ok: false,
      error: "internal error",
      code: ERR_INTERNAL,
    };
  }
}
