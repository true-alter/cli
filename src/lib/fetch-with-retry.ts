/**
 * fetchWithRetry - bounded exponential-backoff retry for transient backend
 * infra failures on backend-targeted POSTs.
 *
 * Retries are scoped to the exact failure class server-side compensation
 * covers - 502/503/504 and transport errors. Validation failures
 * (400/401/403/etc.) are returned verbatim because they are deterministic
 * and a retry would either succeed identically or burn a finite resource
 * (single-use token, idempotency key).
 *
 * Safety contract - only use this helper to wrap requests whose server-side
 * handler is either (a) idempotent or (b) has rolled back partial state on
 * the precise failures retried here. Verify before adding new call sites.
 *
 * The 500 status is intentionally NOT retried. A 500 is an unhandled
 * exception in the server handler, almost always reproducible. Retrying a
 * 500 masks bugs rather than surfacing them.
 */

const RETRIABLE_STATUS = new Set([502, 503, 504]);

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 8000;

export interface FetchWithRetryOptions {
  /** Inject a fetch mock for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Total attempts including the first call. Default 5 → 4 retries. */
  maxAttempts?: number;
  /** First retry delay in ms. Subsequent delays double, capped at maxDelayMs. */
  baseDelayMs?: number;
  /** Hard cap on per-retry sleep. Default 8000 → worst-case ~15.5s wall time. */
  maxDelayMs?: number;
  /** Inject a sleep impl for tests. Defaults to setTimeout-based promise. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional caller hook fired before each retry sleep - for telemetry. */
  onRetry?: (info: {
    attempt: number;
    delayMs: number;
    status?: number;
    error?: Error;
  }) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchWithRetry(
  input: string | URL | Request,
  init?: RequestInit,
  options?: FetchWithRetryOptions,
): Promise<Response> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelay = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelay = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = options?.sleep ?? defaultSleep;
  const onRetry = options?.onRetry;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetchImpl(input, init);
      if (!RETRIABLE_STATUS.has(response.status) || attempt === maxAttempts) {
        return response;
      }
      // Drain the retriable response so the underlying socket is freed
      // before we sleep. undici's connection pool will not check the socket
      // back in until the body stream is consumed or aborted.
      try {
        await response.text();
      } catch {
        // Body may already be aborted/closed by the server; the connection
        // pool will reclaim the socket on next idle sweep regardless.
      }
      const delay = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
      onRetry?.({ attempt, delayMs: delay, status: response.status });
      await sleep(delay);
    } catch (err) {
      lastError = err as Error;
      if (attempt === maxAttempts) {
        throw lastError;
      }
      const delay = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
      onRetry?.({ attempt, delayMs: delay, error: lastError });
      await sleep(delay);
    }
  }

  // Loop always returns or throws above; this is a TypeScript exhaustiveness
  // guard, never reached at runtime.
  throw lastError ?? new Error("fetchWithRetry: exhausted attempts");
}
