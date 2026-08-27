/**
 * `pair_discord` verb.
 *
 * Symmetric to pair_github - wraps the backend device-code init for
 * Discord. Non-destructive.
 */

import { apiCall } from "../../auth.js";
import {
  ERR_BACKEND,
  ERR_INTERNAL,
  type BridgeContext,
  type BridgeRequest,
  type BridgeResponse,
} from "../types.js";

export default async function pairDiscord(
  _req: BridgeRequest,
  ctx: BridgeContext,
): Promise<BridgeResponse> {
  try {
    const resp = await apiCall("/api/v1/connectors/discord/device/init", {
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
      ctx.logger.warn("pair_discord backend non-2xx", {
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
    ctx.logger.error("pair_discord exception", {
      message: (err as Error).message,
    });
    return {
      ok: false,
      error: "internal error",
      code: ERR_INTERNAL,
    };
  }
}
