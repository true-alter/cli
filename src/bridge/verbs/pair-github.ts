/**
 * `pair_github` verb.
 *
 * Lightweight wrapper around the backend device-code init. Browser
 * receives the user_code + verification_uri payload and continues
 * the polling loop itself. The bridge does not poll on the browser's
 * behalf - keeping device-code mechanics in the browser layer
 * preserves the existing alter-cli CLI-first flow.
 *
 * Non-destructive: backend-only call, no local disk writes, no
 * terminal confirmation required.
 */

import { apiCall } from "../../auth.js";
import {
  ERR_BACKEND,
  ERR_INTERNAL,
  type BridgeContext,
  type BridgeRequest,
  type BridgeResponse,
} from "../types.js";

export default async function pairGithub(
  _req: BridgeRequest,
  ctx: BridgeContext,
): Promise<BridgeResponse> {
  try {
    const resp = await apiCall("/api/v1/connectors/github/device/init", {
      method: "POST",
      body: {},
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
      ctx.logger.warn("pair_github backend non-2xx", {
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
    ctx.logger.error("pair_github exception", {
      message: (err as Error).message,
    });
    return {
      ok: false,
      error: "internal error",
      code: ERR_INTERNAL,
    };
  }
}
