/**
 * `forget` verb.
 *
 * Browser-initiated graceful bridge shutdown.
 *
 * `forget` is in DESTRUCTIVE_VERBS and must pass through the
 * terminal confirmation gate before triggering shutdown. This prevents
 * any bearer-authed caller from silently terminating the bridge without
 * user acknowledgement. The confirmation message is intentionally brief
 * so the onboarding-close UX is not unduly disruptive.
 */

import type { BridgeContext, BridgeRequest, BridgeResponse } from "../types.js";

export default async function forget(
  _req: BridgeRequest,
  ctx: BridgeContext,
): Promise<BridgeResponse> {
  // Consult the destructive gate before shutting down.
  // The confirmDestructive callback is wired to a terminal y/n prompt
  // in production. If the user declines or a TTY is unavailable, the
  // bridge stays up and the browser is told the request was declined.
  const confirmed = await ctx.confirmDestructive(
    "Close the browser-setup bridge? (y/n)",
  );
  if (!confirmed) {
    return {
      ok: false,
      error: "confirmation declined",
      code: "confirmation_declined",
    };
  }

  // Defer the actual close so the response writes back before the
  // server closes the socket. The server's shutdown callback handles
  // server.close() + idle-timer clearing.
  setImmediate(() => ctx.shutdown());
  return { ok: true, result: { shutdown: true } };
}
