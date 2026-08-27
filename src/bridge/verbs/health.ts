/**
 * `health` verb.
 *
 * Authenticated session probe. Distinct from the public `GET /health`
 * liveness endpoint on the server (which carries no session info) -
 * this verb returns the active handle + bridge uptime so the browser
 * can render "connected to ~handle" once the bearer is validated.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { BridgeContext, BridgeRequest, BridgeResponse } from "../types.js";

const BRIDGE_STARTED_AT = Date.now();

/** Resolve the CLI package version without coupling to a build-time env. */
function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // src/bridge/verbs → up three levels to package root in dev,
    // dist/bridge/verbs → same shape after build.
    const pkgPath = resolve(here, "..", "..", "..", "package.json");
    const raw = readFileSync(pkgPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const VERSION = readPackageVersion();

export default async function health(
  _req: BridgeRequest,
  ctx: BridgeContext,
): Promise<BridgeResponse> {
  // Note: `session_handle` is returned to any caller that holds a valid
  // bearer token. The bearer is 32 bytes of process-memory-only entropy -
  // never persisted to disk and never logged. The bridge
  // binds exclusively to 127.0.0.1, so the handle is bounded to the
  // single-user-machine trust boundary. The NonceCache TTL (5 min) added in
  // security.ts limits the replay window for any captured nonce.
  return {
    ok: true,
    result: {
      version: VERSION,
      uptime_s: Math.floor((Date.now() - BRIDGE_STARTED_AT) / 1000),
      session_handle: ctx.session.handle,
    },
  };
}
