/**
 * messenger transport - layered realtime delivery.
 *
 * Three paths, tried in order; first one that yields events wins:
 *
 *   1.  SSE direct.  Authorise against the messaging API, then hold an
 *       open per-handle event stream. The server pings periodically to
 *       keep the connection alive; on EOF or any error we re-authorise
 *       and reconnect with exponential backoff.
 *
 *   2.  Daemon-tail.  If alter-runtime is installed it tails the same
 *       SSE stream and writes `~/.local/share/alter-runtime/inbox.jsonl`
 *       (one event per line). We fs.watch it and re-read the tail on
 *       every modification. Used as fallback when the direct stream
 *       cannot be reached or cannot be authorised.
 *
 *   3.  Poll.  As a last resort, call `alter_message_inbox` every
 *       POLL_INTERVAL_MS and diff against the last seen message_id set.
 *       Always running in the background as a safety net even when
 *       SSE is live, but on a long interval so it costs almost nothing.
 *
 * The transport emits a single normalised event shape regardless of
 * path. Callers don't know or care which path delivered a given message
 * - that's the whole point of the layering.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { EventEmitter } from "events";

import {
  AlterClient,
  type MCPCallToolResult,
  type MCPContentBlock,
} from "@truealter/sdk";

import { apiCall } from "../auth.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// ALTER_DO_ORIGIN was trusted verbatim, so a poisoned env
// (.envrc / CI / shell profile) could redirect the SSE stream - which carries
// the subscribe-capability bearer token AND the service-token pair -
// to an attacker host over plain HTTP. Validate it the same way ALTER_API is
// validated: https + a host allow-list, with a localhost carve-out
// only under ALTER_E2E_DEV. A set-but-invalid value is refused fail-closed.
function resolveDoOrigin(): string {
  const fromEnv = process.env.ALTER_DO_ORIGIN;
  if (!fromEnv) return "https://mcp.truealter.com";
  try {
    const parsed = new URL(fromEnv);
    const e2eDev = process.env.ALTER_E2E_DEV === "1";
    const allowed = new Set<string>(["mcp.truealter.com"]);
    if (e2eDev) {
      allowed.add("localhost");
      allowed.add("127.0.0.1");
    }
    const host = parsed.hostname;
    const httpsOk = parsed.protocol === "https:";
    const localOk =
      e2eDev &&
      parsed.protocol === "http:" &&
      (host === "localhost" || host === "127.0.0.1");
    if (!allowed.has(host) || !(httpsOk || localOk)) {
      throw new Error(`host '${host}' (${parsed.protocol}) is not allow-listed`);
    }
    return parsed.origin;
  } catch (err) {
    process.stderr.write(
      `alter: ALTER_DO_ORIGIN='${fromEnv}' is not in the allow-list - refusing ` +
        `to send the subscribe capability + CF Access headers to an unvalidated ` +
        `host. ${(err as Error).message}\n`,
    );
    // Soft exit: set exit code and return empty sentinel so the event loop
    // drains cleanly on Windows (avoids libuv async.c assertion at line 94).
    // DO_ORIGIN="" means any subsequent network call fails rather than
    // sending credentials to an unvalidated host. The security property holds.
    process.exitCode = 2;
    return "";
  }
}

const DO_ORIGIN = resolveDoOrigin();

/** Daemon-written inbox tail. One JSON event per line. */
const INBOX_FEED_FILE = path.join(
  process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
  "alter-runtime",
  "inbox.jsonl",
);

/** Snapshot file the daemon writes on startup; used to prime the UI. */
const INBOX_SNAPSHOT_FILE = path.join(
  process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"),
  "alter",
  "inbox.json",
);

/** Long-interval safety-net poll. SSE / daemon land messages within seconds; */
/* this only fires when both are dead. */
const POLL_INTERVAL_MS = 30_000;

/** SSE reconnect backoff - capped exponential, jittered. */
const SSE_BACKOFF_BASE_MS = 1_000;
const SSE_BACKOFF_MAX_MS = 30_000;

/**
 * Force-abort the SSE connection just before the subscribe-capability JWT
 * expires (cap TTL is 60 s). The reconnect loop then mints a fresh cap.
 * Without this, a long-lived connection holds an expired cap; if the DO
 * starts rejecting events without closing the socket, deliveries go silent.
 */
const SSE_CAP_REMINT_MS = 55_000;

/** Per-line byte cap for the daemon-tail JSONL parser. A single line above
 * this is treated as malformed and skipped - prevents a runaway file from
 * allocating unbounded buffers in the CLI process. */
const DAEMON_LINE_MAX_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Public event shape
// ---------------------------------------------------------------------------

export interface IncomingMessage {
  message_id: string;
  from: string;
  /** Recipient (typically the bound handle); included for completeness. */
  to?: string;
  /** Body with the `<untrusted-message-body nonce="…">` wrapper stripped. */
  body: string;
  /** ISO-8601 - falls back to "now" when the event doesn't carry one. */
  sent_at: string;
  /** Pre-existing read marker; usually false for live events. */
  read?: boolean;
  /** Path that delivered this event. Useful for debugging only. */
  source: "sse" | "daemon" | "poll" | "snapshot";
}

export interface OutboundDelta {
  message_id: string;
  to: string;
  body: string;
  sent_at: string;
}

export type TransportPath = "sse" | "daemon" | "poll";

export interface TransportStatus {
  /** Which path is currently serving live events. */
  active: TransportPath;
  /** Last connect attempt outcome for each path; useful for diagnostics. */
  sse: "live" | "connecting" | "failed" | "disabled";
  daemon: "live" | "absent" | "stale";
  poll: "live";
  /** Most recent error message, if any. */
  last_error?: string;
}

// ---------------------------------------------------------------------------
// Untrusted-body unwrapping
// ---------------------------------------------------------------------------

const UNTRUSTED_BODY_RE =
  /^<untrusted-message-body nonce="([^"]+)"[^>]*>([\s\S]*?)<\/untrusted-message-body-\1>\s*$/;

/**
 * Strip the `<untrusted-message-body nonce="…">…</untrusted-message-body-…>`
 * wrapper applied on the backend READ path. The DB stores raw bodies; the
 * sanitizer only wraps on emit. The CLI is a trust-boundary the same way
 * the daemon and CC hooks are: render the unwrapped body, never confuse
 * the wrapper for content the user typed.
 */
export function stripUntrustedBody(body: string | undefined | null): string {
  if (!body) return "";
  const m = UNTRUSTED_BODY_RE.exec(body);
  return m ? m[2] : body;
}

// ---------------------------------------------------------------------------
// MCP payload extraction (shared with the message and room views)
// ---------------------------------------------------------------------------

function extractPayload<T>(result: MCPCallToolResult): T | null {
  if (result.data !== undefined && result.data !== null) {
    return result.data as T;
  }
  const text = result.content?.find((c: MCPContentBlock) => c.type === "text")
    ?.text;
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

interface InboxRow {
  message_id?: string;
  id?: string;
  from?: string;
  sender?: string;
  to?: string;
  recipient?: string;
  body?: string;
  body_md?: string;
  preview?: string;
  sent_at?: string;
  created_at?: string;
  read?: boolean;
  unread?: boolean;
}

interface InboxPayload {
  messages?: InboxRow[];
  items?: InboxRow[];
}

/**
 * Normalise an inbox row into the public `IncomingMessage` shape. The
 * backend has shipped under a few naming conventions over time; we accept
 * any of them rather than tie the CLI to one snapshot of the schema.
 */
function normaliseRow(row: InboxRow, source: IncomingMessage["source"]): IncomingMessage | null {
  const message_id = row.message_id ?? row.id;
  const from = row.from ?? row.sender;
  if (!message_id || !from) return null;
  const sent_at = row.sent_at ?? row.created_at ?? new Date().toISOString();
  const raw = row.body ?? row.body_md ?? row.preview ?? "";
  const read = row.read === true || row.unread === false;
  return {
    message_id,
    from,
    to: row.to ?? row.recipient,
    body: stripUntrustedBody(raw),
    sent_at,
    read,
    source,
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface TransportOptions {
  /** Caller's bound ~handle. Used in the SSE URL and to filter loopback. */
  handle: string;
  /** Authenticated MCP client for the poll fallback. */
  client: AlterClient;
  /** Override for tests / staging. Defaults to mcp.truealter.com. */
  doOrigin?: string;
  /** Suppress the SSE direct path; useful for tests. */
  disableSse?: boolean;
  /** Suppress the daemon-tail path; useful for tests. */
  disableDaemon?: boolean;
  /**
   * Extra HTTP headers applied to the SSE direct fetch - the service-token
   * pair plus the agent-version-hash. Resolved by `getMcpExtraHeaders` in the
   * caller and threaded through here so the SSE path admits at the edge the
   * same way the poll path does.
   */
  extraHeaders?: Record<string, string>;
}

/**
 * Layered realtime transport. EventEmitter contract:
 *
 *   .on("message", (m: IncomingMessage) => …)   incoming, normalised
 *   .on("outbound", (m: OutboundDelta) => …)    local optimistic echo
 *   .on("status",  (s: TransportStatus) => …)   path / health changes
 *   .on("error",   (err: Error)         => …)   non-fatal diagnostics
 *
 * Start with `await t.start()`; stop with `t.stop()`. Dedup is by
 * `message_id`; the same event arriving on two paths is reported once.
 */
export class MessengerTransport extends EventEmitter {
  private readonly handle: string;
  private readonly client: AlterClient;
  private readonly doOrigin: string;
  private readonly disableSse: boolean;
  private readonly disableDaemon: boolean;

  private readonly seen = new Set<string>();
  private stopped = false;

  private sseAbort: AbortController | null = null;
  private sseBackoff = SSE_BACKOFF_BASE_MS;
  private sseRemintTimer: NodeJS.Timeout | null = null;
  private daemonWatcher: fs.FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;

  private readonly extraHeaders: Record<string, string>;

  private status: TransportStatus = {
    active: "poll",
    sse: "disabled",
    daemon: "absent",
    poll: "live",
  };

  constructor(opts: TransportOptions) {
    super();
    this.handle = opts.handle;
    this.client = opts.client;
    this.doOrigin = opts.doOrigin ?? DO_ORIGIN;
    this.disableSse = opts.disableSse ?? false;
    this.disableDaemon = opts.disableDaemon ?? false;
    this.extraHeaders = opts.extraHeaders ?? {};
  }

  /** Begin the layered subscription. Resolves once the first path is up. */
  async start(): Promise<void> {
    // Prime the conversation list from the snapshot file (zero-latency) and
    // from a single backstop inbox read in parallel. Whichever returns rows
    // first paints the UI.
    void this.primeFromSnapshot();
    void this.primeFromBackend();

    if (!this.disableDaemon) this.startDaemonTail();
    if (!this.disableSse) void this.startSse();
    this.startPoll();
  }

  stop(): void {
    this.stopped = true;
    if (this.sseRemintTimer) {
      clearTimeout(this.sseRemintTimer);
      this.sseRemintTimer = null;
    }
    if (this.sseAbort) {
      this.sseAbort.abort();
      this.sseAbort = null;
    }
    if (this.daemonWatcher) {
      this.daemonWatcher.close();
      this.daemonWatcher = null;
    }
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  getStatus(): TransportStatus {
    return { ...this.status };
  }

  /**
   * Mark an outbound message as seen - keeps the dedup set honest when
   * the user sends from this same CLI process (SSE will echo the message
   * back from the DO; we don't want to re-render it as inbound).
   */
  noteOutbound(delta: OutboundDelta): void {
    this.seen.add(delta.message_id);
    this.emit("outbound", delta);
  }

  // ---------------------------------------------------------------------
  // Path 0 - snapshot prime
  // ---------------------------------------------------------------------

  private primeFromSnapshot(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(INBOX_SNAPSHOT_FILE, "utf8");
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as InboxPayload;
      const rows = parsed.messages ?? parsed.items ?? [];
      for (const row of rows) {
        const msg = normaliseRow(row, "snapshot");
        if (msg && !this.seen.has(msg.message_id)) {
          this.seen.add(msg.message_id);
          this.emit("message", msg);
        }
      }
    } catch {
      // Malformed snapshot - never fatal; the other paths will catch up.
    }
  }

  // ---------------------------------------------------------------------
  // Path 1 - SSE direct (preferred)
  // ---------------------------------------------------------------------

  private async startSse(): Promise<void> {
    if (this.stopped) return;
    this.setStatus({ sse: "connecting" });

    let capability: string;
    try {
      capability = await this.mintSubscribeCapability();
    } catch (err) {
      this.setStatus({
        sse: "failed",
        last_error: (err as Error).message,
      });
      this.scheduleSseReconnect();
      return;
    }

    this.sseAbort = new AbortController();
    const url = `${this.doOrigin}/events/${this.handle}/stream`;

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "GET",
        headers: {
          ...this.extraHeaders,
          Authorization: `Bearer ${capability}`,
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
        },
        signal: this.sseAbort.signal,
      });
    } catch (err) {
      this.setStatus({ sse: "failed", last_error: (err as Error).message });
      this.scheduleSseReconnect();
      return;
    }

    if (!resp.ok || !resp.body) {
      this.setStatus({
        sse: "failed",
        last_error: `SSE HTTP ${resp.status}`,
      });
      this.scheduleSseReconnect();
      return;
    }

    this.setStatus({ sse: "live", active: "sse" });
    this.sseBackoff = SSE_BACKOFF_BASE_MS;

    // Proactively cycle the connection ~5s before the 60s cap-token TTL so a
    // stale cap can't strand the stream. Aborting triggers the EOF path below
    // which then calls scheduleSseReconnect → startSse → mintSubscribeCapability.
    if (this.sseRemintTimer) clearTimeout(this.sseRemintTimer);
    this.sseRemintTimer = setTimeout(() => {
      this.sseRemintTimer = null;
      if (this.stopped) return;
      this.sseAbort?.abort();
    }, SSE_CAP_REMINT_MS);
    this.sseRemintTimer.unref();

    try {
      await this.consumeSseStream(resp.body);
    } catch (err) {
      if (!this.stopped) {
        this.emit("error", err as Error);
      }
    }

    if (this.sseRemintTimer) {
      clearTimeout(this.sseRemintTimer);
      this.sseRemintTimer = null;
    }

    // EOF or error - schedule a reconnect unless we're shutting down.
    this.setStatus({ sse: "failed" });
    this.scheduleSseReconnect();
  }

  private async mintSubscribeCapability(): Promise<string> {
    const resp = await apiCall("/api/v1/messaging/subscribe-capability", {
      method: "POST",
      timeoutMs: 10_000,
    });
    if (!resp) throw new Error("not authenticated");
    if (!resp.ok) {
      throw new Error(`subscribe-capability HTTP ${resp.status}`);
    }
    // Bound + validate before trusting it: this value is presented verbatim as
    // a Bearer token on the SSE stream, so a rogue/compromised backend must not
    // be able to stream an unbounded body into memory or hand us a junk value.
    const text = await resp.text();
    if (text.length > 8192) {
      throw new Error("subscribe-capability: response too large");
    }
    let body: { capability?: string };
    try {
      body = JSON.parse(text) as { capability?: string };
    } catch {
      throw new Error("subscribe-capability: malformed response");
    }
    const cap = body.capability;
    if (typeof cap !== "string" || cap.length === 0 || cap.length > 4096) {
      throw new Error("subscribe-capability: missing or malformed token");
    }
    return cap;
  }

  private async consumeSseStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    // A well-formed SSE stream flushes complete events on double-newline
    // boundaries, so the buffer never grows large. A stream with no boundaries
    // (rogue origin / misbehaving DO) would otherwise grow unbounded → OOM.
    // Throwing here is caught by startSse, which reconnects.
    const MAX_SSE_BUF = 4 * 1024 * 1024; // 4 MiB
    while (!this.stopped) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      if (buf.length > MAX_SSE_BUF) {
        throw new Error("SSE buffer exceeded cap without an event boundary");
      }
      let nl: number;
      // Events are double-newline-separated per the SSE spec.
      while ((nl = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        this.handleSseEvent(raw);
      }
    }
  }

  private handleSseEvent(raw: string): void {
    // Parse a single SSE event: a sequence of "field: value" lines.
    let event = "message";
    let dataLines: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith(":")) continue; // comment / keepalive
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const field = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).replace(/^ /, "");
      if (field === "event") event = val;
      else if (field === "data") dataLines.push(val);
    }
    if (dataLines.length === 0) return;
    // We only care about message events. Other event kinds (state,
    // presence, ceremony-echo) flow over the same stream but aren't ours.
    if (event !== "alter_message" && event !== "message") return;
    const payload = dataLines.join("\n");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return;
    }
    // The DO's frame envelope wraps the message payload under `data` or
    // `payload`; tolerate either, or a flat row.
    const inner =
      (parsed.data as InboxRow | undefined) ??
      (parsed.payload as InboxRow | undefined) ??
      (parsed as InboxRow);
    // Drop our own loopback echoes - outbound noteOutbound() already
    // added their ids to seen, so the dedup below skips them.
    const msg = normaliseRow(inner, "sse");
    if (msg && !this.seen.has(msg.message_id)) {
      this.seen.add(msg.message_id);
      this.emit("message", msg);
    }
  }

  private scheduleSseReconnect(): void {
    if (this.stopped) return;
    const jitter = Math.floor(Math.random() * 400);
    const delay = Math.min(this.sseBackoff + jitter, SSE_BACKOFF_MAX_MS);
    this.sseBackoff = Math.min(this.sseBackoff * 2, SSE_BACKOFF_MAX_MS);
    setTimeout(() => {
      if (!this.stopped) void this.startSse();
    }, delay).unref();
  }

  // ---------------------------------------------------------------------
  // Path 2 - daemon-tail
  // ---------------------------------------------------------------------

  private startDaemonTail(): void {
    let exists = false;
    try {
      fs.accessSync(INBOX_FEED_FILE, fs.constants.R_OK);
      exists = true;
    } catch {
      this.setStatus({ daemon: "absent" });
    }
    if (!exists) return;

    // Reject symlinks at the daemon feed path. A local attacker who can
    // write inside ~/.local/share/alter-runtime/ otherwise gets to point
    // the CLI at arbitrary readable files (e.g. /dev/urandom, /etc/shadow).
    // Use lstat so we see the symlink itself, not its target.
    try {
      const lst = fs.lstatSync(INBOX_FEED_FILE);
      if (lst.isSymbolicLink()) {
        this.setStatus({ daemon: "absent", last_error: "daemon feed is a symlink - refusing to tail" });
        return;
      }
    } catch {
      this.setStatus({ daemon: "absent" });
      return;
    }

    this.setStatus({ daemon: "live" });
    if (this.status.sse !== "live") {
      this.setStatus({ active: "daemon" });
    }

    // Track the high-water byte offset so each watch tick reads only the
    // freshly appended tail. fs.watch fires on every write; we read from
    // `seen_bytes` to EOF and update.
    let seenBytes = 0;
    try {
      seenBytes = fs.statSync(INBOX_FEED_FILE).size;
      // Prime from existing content on startup so the conversation list
      // reflects what's already happened today.
      this.replayDaemonFile(0, seenBytes);
    } catch {
      // File vanished between access check and stat - treat as absent.
      this.setStatus({ daemon: "absent" });
      return;
    }

    const onChange = (): void => {
      let nowSize: number;
      try {
        nowSize = fs.statSync(INBOX_FEED_FILE).size;
      } catch {
        return;
      }
      if (nowSize < seenBytes) {
        // Daemon rotated the file. Re-read from the top.
        seenBytes = 0;
      }
      if (nowSize > seenBytes) {
        this.replayDaemonFile(seenBytes, nowSize);
        seenBytes = nowSize;
      }
    };

    try {
      this.daemonWatcher = fs.watch(INBOX_FEED_FILE, { persistent: false }, onChange);
    } catch (err) {
      this.emit("error", err as Error);
      this.setStatus({ daemon: "stale" });
    }
  }

  private replayDaemonFile(start: number, end: number): void {
    let raw: Buffer;
    try {
      const fd = fs.openSync(INBOX_FEED_FILE, "r");
      try {
        raw = Buffer.alloc(end - start);
        fs.readSync(fd, raw, 0, end - start, start);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }
    for (const line of raw.toString("utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // A single line above the cap is almost certainly malformed or
      // adversarial - skip it rather than feeding JSON.parse an unbounded
      // input. The poll backstop covers any messages we drop here.
      if (Buffer.byteLength(trimmed, "utf8") > DAEMON_LINE_MAX_BYTES) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      const inner =
        (parsed.data as InboxRow | undefined) ??
        (parsed.payload as InboxRow | undefined) ??
        (parsed as InboxRow);
      const msg = normaliseRow(inner, "daemon");
      if (msg && !this.seen.has(msg.message_id)) {
        this.seen.add(msg.message_id);
        this.emit("message", msg);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Path 3 - poll backstop
  // ---------------------------------------------------------------------

  private startPoll(): void {
    const tick = async (): Promise<void> => {
      if (this.stopped) return;
      try {
        await this.pollOnce();
      } catch (err) {
        this.emit("error", err as Error);
      }
      if (!this.stopped) {
        this.pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
        this.pollTimer.unref();
      }
    };
    // First poll fires immediately so the conversation list paints even
    // when SSE and daemon are both down.
    void tick();
  }

  /** Single round-trip poll. Exposed for tests. */
  async pollOnce(): Promise<void> {
    const result = await this.client.mcp.callTool("alter_message_inbox", {
      unread_only: false,
      limit: 50,
    });
    const payload = extractPayload<InboxPayload>(result);
    const rows = payload?.messages ?? payload?.items ?? [];
    for (const row of rows) {
      const msg = normaliseRow(row, "poll");
      if (msg && !this.seen.has(msg.message_id)) {
        this.seen.add(msg.message_id);
        this.emit("message", msg);
      }
    }
  }

  private async primeFromBackend(): Promise<void> {
    try {
      await this.pollOnce();
    } catch (err) {
      this.emit("error", err as Error);
    }
  }

  // ---------------------------------------------------------------------
  // Status plumbing
  // ---------------------------------------------------------------------

  private setStatus(patch: Partial<TransportStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit("status", this.getStatus());
  }
}
