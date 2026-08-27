/**
 * Extended localhost bridge.
 *
 * Binds `127.0.0.1:<random-port>` and exposes:
 *
 *   OPTIONS *           - CORS preflight, 204 + corsHeaders
 *   GET     /health     - liveness probe (no auth, no session info)
 *   GET     /manifest   - signed verb manifest
 *   POST    /v1/verb/<verb>  - auth + CORS + nonce + body-validated dispatch
 *
 * Every authenticated request validates, in order: Origin against the
 * allowlist, Host against the bound loopback port,
 * Bearer via constant-time compare, nonce one-time-use,
 * Content-Type=application/json, body size ≤ 64 KiB.
 *
 * Bearer is constructor-only - never read from URL parameters or
 * disk. Idle timer (default 30 min) resets on every
 * authenticated request and triggers graceful shutdown via the
 * caller-supplied `onShutdown` hook.
 */

import * as http from "node:http";

import type { AlterSession } from "../auth.js";
import { confirmYesNo } from "../ui/picker.js";
import { buildManifest } from "./manifest.js";
import {
  corsHeaders,
  defaultOriginAllowlist,
  NonceCache,
  validateBearer,
  validateHost,
  validateOrigin,
} from "./security.js";
import {
  ALLOWED_VERBS,
  DESTRUCTIVE_VERBS,
  ERR_INTERNAL,
  ERR_INVALID_BODY,
  ERR_NONCE_CACHE_EXHAUSTED,
  ERR_NONCE_REPLAY,
  ERR_VERB_UNKNOWN,
  type BridgeContext,
  type BridgeLogger,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeVerb,
} from "./types.js";
import { VERB_HANDLERS } from "./verbs/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const VERB_PATH_PREFIX = "/v1/verb/";
const ALLOWED_VERB_SET: ReadonlySet<string> = new Set<string>(ALLOWED_VERBS);

/**
 * Exhaustiveness gate for `NonceConsumeResult["reason"]` (security.ts).
 * The parameter type is `never`, so this only compiles at a call site
 * where every other member of the `reason` union has already been
 * narrowed away by preceding `case`s. If `NonceConsumeResult` gains a
 * new reason, or `NonceCache.consume()` ever regresses to a bare
 * `boolean` (the whole point of the switch in `handleRequest` below),
 * the offending call site fails to *compile*
 * rather than the two failure classes silently re-collapsing into one
 * wire response at runtime.
 */
function assertNeverNonceReason(reason: never): never {
  throw new Error(`unreachable nonce-consume reason: ${String(reason)}`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface StartBridgeServerOptions {
  session: AlterSession;
  /** 32-byte base64url bridge bearer. Process-memory only - never persisted. */
  bridgeToken: string;
  /** Origin allowlist (canonical + extra). `https://truealter.com` is always honoured. */
  allowedOrigins?: readonly string[];
  /** Idle shutdown threshold; defaults to 30 min. */
  idleTimeoutMs?: number;
  /** Caller hook - invoked exactly once just before server.close(). */
  onShutdown?: () => void;
  /** Inject a logger; defaults to a stderr JSON writer that drops bearer. */
  logger?: BridgeLogger;
  /** Inject the terminal y/n gate; defaults to confirmYesNo (TTY-required). */
  confirmDestructive?: (message: string) => Promise<boolean>;
}

export interface BridgeServerHandle {
  port: number;
  server: http.Server;
  /** Idempotent - safe to call from multiple paths (forget verb, idle, parent process). */
  shutdown: () => void;
}

export async function startBridgeServer(
  opts: StartBridgeServerOptions,
): Promise<BridgeServerHandle> {
  const logger = opts.logger ?? defaultLogger();
  const confirmDestructive =
    opts.confirmDestructive ?? defaultConfirmDestructive;
  const allowedOrigins = defaultOriginAllowlist(opts.allowedOrigins ?? []);
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const nonceCache = new NonceCache();

  let shuttingDown = false;
  let idleTimer: NodeJS.Timeout | null = null;
  let purgeTimer: NodeJS.Timeout | null = null;
  let serverHandle: http.Server | null = null;

  const triggerShutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (purgeTimer) {
      clearInterval(purgeTimer);
      purgeTimer = null;
    }
    try {
      opts.onShutdown?.();
    } catch (err) {
      logger.warn("onShutdown hook threw", {
        message: (err as Error).message,
      });
    }
    if (serverHandle) {
      try {
        serverHandle.close();
      } catch {
        // server already closed - ignore
      }
    }
  };

  const armIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.info("bridge idle timeout - shutting down", {
        idle_ms: idleTimeoutMs,
      });
      triggerShutdown();
    }, idleTimeoutMs);
    // Don't keep the event loop alive purely to fire the idle timer.
    if (typeof idleTimer.unref === "function") idleTimer.unref();
  };

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((err) => {
      logger.error("unhandled server error", {
        message: (err as Error).message,
      });
      try {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
        }
        res.end(
          JSON.stringify({
            ok: false,
            error: "internal error",
            code: ERR_INTERNAL,
          }),
        );
      } catch {
        // socket already torn down - nothing to do
      }
    });
  });

  serverHandle = server;
  armIdleTimer();

  // Bound nonce-cache memory and enforce the replay TTL on a timer, rather
  // than relying solely on the 1024-entry LRU cap (which, under a flood, could
  // evict an in-TTL nonce and reopen a replay window). Purges entries older
  // than the TTL once a minute. unref()'d so it never keeps the process alive.
  purgeTimer = setInterval(() => nonceCache.purgeExpired(), 60_000);
  if (typeof purgeTimer.unref === "function") purgeTimer.unref();

  const handleRequest = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> => {
    const origin = headerStr(req.headers.origin);
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;

    // ---------------------------------------------------------------
    // Pre-flight: CORS / unauthenticated GETs
    // ---------------------------------------------------------------
    if (method === "OPTIONS") {
      const originForResponse =
        origin && validateOrigin(origin, allowedOrigins) ? origin : "null";
      res.writeHead(204, corsHeaders(originForResponse));
      res.end();
      return;
    }

    if (method === "GET" && pathname === "/health") {
      // Public liveness probe - no auth, no session info.
      const originForResponse =
        origin && validateOrigin(origin, allowedOrigins) ? origin : "null";
      const headers = {
        ...corsHeaders(originForResponse),
        "Content-Type": "application/json",
      };
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (method === "GET" && pathname === "/manifest") {
      // DNS-rebinding guard: the manifest is signed but discloses the bound
      // handle + signing kid, so reject a forged Host the same way POSTs do -
      // a rebinding page resolving to 127.0.0.1 must not be able to read it.
      {
        const addr = server.address();
        const boundPort = typeof addr === "object" && addr ? addr.port : 0;
        if (!validateHost(req.headers.host, boundPort)) {
          res.writeHead(403, { Connection: "close" });
          res.end();
          return;
        }
      }
      // Public - the manifest is signed; verification is browser-side.
      const originForResponse =
        origin && validateOrigin(origin, allowedOrigins) ? origin : "null";
      const headers = {
        ...corsHeaders(originForResponse),
        "Content-Type": "application/json",
      };
      const manifest = buildManifest(opts.session);
      res.writeHead(200, headers);
      res.end(JSON.stringify(manifest));
      return;
    }

    // ---------------------------------------------------------------
    // POST /v1/verb/<verb> - authenticated dispatch
    // ---------------------------------------------------------------
    if (method !== "POST" || !pathname.startsWith(VERB_PATH_PREFIX)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ ok: false, error: "not found", code: "not_found" }),
      );
      return;
    }

    // Origin: hard requirement on POSTs (no top-frame OAuth redirects here).
    if (!origin || !validateOrigin(origin, allowedOrigins)) {
      res.writeHead(403, { Connection: "close" });
      res.end();
      return;
    }

    // Host: DNS-rebinding guard against the actually-bound port.
    const addr = server.address();
    const boundPort = typeof addr === "object" && addr ? addr.port : 0;
    if (!validateHost(req.headers.host, boundPort)) {
      res.writeHead(403, { Connection: "close" });
      res.end();
      return;
    }

    // Bearer: constant-time compare.
    if (!validateBearer(req.headers.authorization, opts.bridgeToken)) {
      const headers = {
        ...corsHeaders(origin),
        "Content-Type": "application/json",
      };
      res.writeHead(401, headers);
      res.end(
        JSON.stringify({
          ok: false,
          error: "unauthorized",
          code: "unauthorized",
        }),
      );
      return;
    }

    // Content-Type gate - only application/json bodies.
    const contentType = headerStr(req.headers["content-type"]) ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      const headers = {
        ...corsHeaders(origin),
        "Content-Type": "application/json",
      };
      res.writeHead(415, headers);
      res.end(
        JSON.stringify({
          ok: false,
          error: "content-type must be application/json",
          code: "unsupported_media_type",
        }),
      );
      return;
    }

    // Body - bounded read.
    let raw: string;
    try {
      raw = await readBody(req, MAX_BODY_BYTES);
    } catch (err) {
      const code = (err as Error).message === "body_too_large"
        ? "body_too_large"
        : ERR_INVALID_BODY;
      const status = code === "body_too_large" ? 413 : 400;
      const headers = {
        ...corsHeaders(origin),
        "Content-Type": "application/json",
      };
      res.writeHead(status, headers);
      res.end(
        JSON.stringify({ ok: false, error: code, code }),
      );
      return;
    }

    let parsed: unknown;
    try {
      parsed = raw.length === 0 ? {} : JSON.parse(raw);
    } catch {
      const headers = {
        ...corsHeaders(origin),
        "Content-Type": "application/json",
      };
      res.writeHead(400, headers);
      res.end(
        JSON.stringify({
          ok: false,
          error: "invalid JSON",
          code: ERR_INVALID_BODY,
        }),
      );
      return;
    }

    // Verb resolution + nonce.
    const verbFromPath = pathname.slice(VERB_PATH_PREFIX.length);
    if (!ALLOWED_VERB_SET.has(verbFromPath)) {
      const headers = {
        ...corsHeaders(origin),
        "Content-Type": "application/json",
      };
      res.writeHead(404, headers);
      res.end(
        JSON.stringify({
          ok: false,
          error: "unknown verb",
          code: ERR_VERB_UNKNOWN,
        }),
      );
      return;
    }
    const verb = verbFromPath as BridgeVerb;

    const envelope = parsed as Partial<BridgeRequest>;
    if (
      !envelope ||
      typeof envelope !== "object" ||
      typeof envelope.nonce !== "string" ||
      envelope.nonce.length === 0
    ) {
      const headers = {
        ...corsHeaders(origin),
        "Content-Type": "application/json",
      };
      res.writeHead(400, headers);
      res.end(
        JSON.stringify({
          ok: false,
          error: "nonce required",
          code: ERR_INVALID_BODY,
        }),
      );
      return;
    }
    if (envelope.verb !== undefined && envelope.verb !== verb) {
      const headers = {
        ...corsHeaders(origin),
        "Content-Type": "application/json",
      };
      res.writeHead(400, headers);
      res.end(
        JSON.stringify({
          ok: false,
          error: "verb mismatch between path and body",
          code: ERR_INVALID_BODY,
        }),
      );
      return;
    }
    const nonceResult = nonceCache.consume(envelope.nonce);
    if (!nonceResult.ok) {
      const headers: Record<string, string> = {
        ...corsHeaders(origin),
        "Content-Type": "application/json",
      };
      // Exhaustive switch, not if/else on a boolean: this IS the type
      // gate against a future regression back to a bare `boolean`
      // return from `consume()`. If `NonceConsumeResult` ever grows a
      // new `reason` without a case here, or `consume()` reverts to
      // `boolean` (which has no `.reason` at all), this fails to
      // *compile* - `assertNeverNonceReason`'s parameter type is
      // `never`, so anything reaching it that isn't already narrowed
      // away by the two cases above is a type error, not a silent
      // runtime fallthrough. See `NonceConsumeResult` in security.ts
      // for why "replay" and "cap_exhausted" must stay distinguishable.
      switch (nonceResult.reason) {
        case "cap_exhausted": {
          // ALTER-side resource condition, not caller misbehaviour: the
          // nonce cache is full of entries that are all still live, so
          // nothing can be evicted without reopening a replay window
          // (NonceCache.consume, security.ts). This is honestly a 503,
          // not a 409 - the caller did not replay anything. Retry-After
          // matches the server's own periodic purge cadence
          // (purgeTimer below, 60s) as the nearest thing to a real
          // reclaim signal; it is a hint, not a guarantee capacity has
          // freed by then.
          headers["Retry-After"] = "60";
          res.writeHead(503, headers);
          res.end(
            JSON.stringify({
              ok: false,
              error: "nonce cache at capacity, retry with a fresh nonce",
              code: ERR_NONCE_CACHE_EXHAUSTED,
            }),
          );
          return;
        }
        case "replay":
        case "invalid": {
          // "replay" (genuine replay) and "invalid" (malformed nonce -
          // not reachable here, the shape check above already returned
          // 400 for that) both refuse as a replay from the wire's
          // perspective - a 409 is correct for both, they are both
          // "this nonce is not usable right now", never a capacity
          // signal.
          res.writeHead(409, headers);
          res.end(
            JSON.stringify({
              ok: false,
              error: "nonce replay",
              code: ERR_NONCE_REPLAY,
            }),
          );
          return;
        }
        default:
          return assertNeverNonceReason(nonceResult.reason);
      }
    }

    // Idle-timer reset on every authenticated request.
    armIdleTimer();

    const ctx: BridgeContext = {
      session: opts.session,
      bridgeToken: opts.bridgeToken,
      confirmDestructive,
      logger,
      shutdown: triggerShutdown,
    };

    // Destructive-verb gate. We intentionally let the verb handler
    // re-call confirmDestructive with a verb-specific message -
    // here we only enforce that *if* a verb is destructive, the
    // handler MUST have done so. We use a wrapping proxy to record
    // that the gate was consulted, and refuse the response if not.
    let gateConsulted = false;
    const trackingConfirm = async (message: string): Promise<boolean> => {
      gateConsulted = true;
      return confirmDestructive(message);
    };
    if (DESTRUCTIVE_VERBS.has(verb)) {
      ctx.confirmDestructive = trackingConfirm;
    }

    const request: BridgeRequest = {
      verb,
      nonce: envelope.nonce,
      body: envelope.body,
    };

    let response: BridgeResponse;
    try {
      response = await VERB_HANDLERS[verb](request, ctx);
    } catch (err) {
      logger.error("verb handler threw", {
        verb,
        message: (err as Error).message,
      });
      response = {
        ok: false,
        error: "internal error",
        code: ERR_INTERNAL,
      };
    }

    if (DESTRUCTIVE_VERBS.has(verb) && !gateConsulted && response.ok) {
      // A destructive verb that succeeded without ever asking is a
      // bug - refuse to forward the (bad) success to the browser.
      logger.error("destructive verb skipped confirmation gate", { verb });
      response = {
        ok: false,
        error: "internal error",
        code: ERR_INTERNAL,
      };
    }

    const status = response.ok ? 200 : statusForCode(response.code);
    const headers = {
      ...corsHeaders(origin),
      "Content-Type": "application/json",
    };
    res.writeHead(status, headers);
    res.end(JSON.stringify(response));
    return;
  };

  return new Promise<BridgeServerHandle>((resolve, reject) => {
    server.on("error", (err) => {
      logger.error("server listen error", { message: err.message });
      reject(err);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      logger.info("bridge listening", { port });
      resolve({
        port,
        server,
        shutdown: triggerShutdown,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function headerStr(
  v: string | string[] | undefined,
): string | undefined {
  // A duplicated header (Node represents these as an array) is treated as
  // invalid rather than silently collapsing to the first value - otherwise a
  // crafted two-Origin request could slip a benign first value past
  // validateOrigin while the real intent was the second.
  if (Array.isArray(v)) return undefined;
  return v;
}

function readBody(
  req: http.IncomingMessage,
  cap: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > cap) {
        req.destroy();
        reject(new Error("body_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(Buffer.concat(chunks).toString("utf-8"));
      } catch (err) {
        reject(err as Error);
      }
    });
    req.on("error", (err) => reject(err));
  });
}

function statusForCode(code?: string): number {
  switch (code) {
    case ERR_INVALID_BODY:
      return 400;
    case ERR_VERB_UNKNOWN:
      return 404;
    case "unauthorized":
      return 401;
    case "body_too_large":
      return 413;
    case "unsupported_media_type":
      return 415;
    case "confirmation_declined":
      return 403;
    case "nonce_replay":
      return 409;
    case "backend_error":
      return 502;
    default:
      return 500;
  }
}

function defaultLogger(): BridgeLogger {
  // The bridge runs inside the user's interactive terminal during
  // `alter login` onboarding. Structured JSON diagnostics must not pollute
  // that surface: a bare `{"level":"info","msg":"bridge listening",...}` line
  // reads as an error to a user who just saw the "Welcome" card, and it is
  // redundant with the plain-English "Bridge listening on 127.0.0.1:<port>"
  // line the login flow already prints. So info/warn are emitted only when
  // debugging is explicitly enabled; errors always write, since a genuine
  // bridge failure is worth surfacing even in a clean terminal.
  const debug =
    process.env.ALTER_DEBUG === "1" || process.env.ALTER_BRIDGE_DEBUG === "1";
  const write = (
    level: string,
    msg: string,
    fields?: Record<string, unknown>,
  ): void => {
    if (level !== "error" && !debug) return;
    const line = JSON.stringify({
      level,
      msg,
      ts: new Date().toISOString(),
      ...(fields ?? {}),
    });
    try {
      process.stderr.write(line + "\n");
    } catch {
      // stderr closed - swallow rather than crash the bridge.
    }
  };
  return {
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}

async function defaultConfirmDestructive(message: string): Promise<boolean> {
  const result = await confirmYesNo({ message, initialValue: false });
  // null = user invoked the quit modal; treat as decline.
  return result === true;
}
