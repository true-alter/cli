/**
 * `wire` verb.
 *
 * Destructive - writes shell/IDE/WM config files.
 * The browser passes a `host_id` enum drawn from WIRE_HOST_IDS; the
 * CLI owns the filesystem path resolution. Closes the path-traversal
 * surface the browser would otherwise have.
 *
 * For v1, the verb prints the instruction the user would run (the
 * actual installer machinery lives in `src/commands/wire.ts` and
 * ships under a separate change). Returns the host_id + a flag so
 * the browser can render "wire-up surfaced in terminal - run the
 * printed command to enable" and move on.
 *
 * Body: { host_id: WireHostId }
 */

import {
  ERR_CONFIRMATION_DECLINED,
  ERR_INVALID_BODY,
  WIRE_HOST_IDS,
  type BridgeContext,
  type BridgeRequest,
  type BridgeResponse,
  type WireHostId,
} from "../types.js";
import { isObject } from "../validators.js";

interface WireBody {
  host_id: WireHostId;
}

const HOST_ID_SET: ReadonlySet<string> = new Set<string>(WIRE_HOST_IDS);

function parseBody(raw: unknown): WireBody | null {
  if (!isObject(raw)) return null;
  if (typeof raw.host_id !== "string") return null;
  if (!HOST_ID_SET.has(raw.host_id)) return null;
  return { host_id: raw.host_id as WireHostId };
}

export default async function wire(
  req: BridgeRequest,
  ctx: BridgeContext,
): Promise<BridgeResponse> {
  const body = parseBody(req.body);
  if (!body) {
    return {
      ok: false,
      error: `invalid body - host_id must be one of: ${WIRE_HOST_IDS.join(", ")}`,
      code: ERR_INVALID_BODY,
    };
  }

  const proceed = await ctx.confirmDestructive(
    `Wire Alter into ${body.host_id}?`,
  );
  if (!proceed) {
    return {
      ok: false,
      error: "user declined confirmation",
      code: ERR_CONFIRMATION_DECLINED,
    };
  }

  // v1 surface: print the alter-cli command the user would run from
  // their terminal. Actual wire-up machinery is the existing
  // `src/commands/wire.ts` surface and ships its installer logic
  // under a separate change.
  process.stdout.write(`\nRun this to complete: alter wire\n\n`);

  ctx.logger.info("wire surfaced instruction", { host_id: body.host_id });
  return {
    ok: true,
    result: { host_id: body.host_id, surfaced: true },
  };
}
