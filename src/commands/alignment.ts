/**
 * alter alignment - peer-to-peer trait query (grant model).
 *
 *   alter alignment grant  <peer>                  Authorise a peer to query you
 *   alter alignment revoke <peer>                  Revoke that authorisation
 *   alter alignment query  <peer> [--context X]    Compute alignment with peer
 *
 * Routes to the personal MCP server via JSON-RPC stdio (NOT REST),
 * matching the wire surface that external agents use. The server is
 * configured via the `ALTER_MCP_CMD` env var.
 *
 * Tool routing:
 *   alter alignment grant  <peer>           → alter_alignment_grant({peer})
 *   alter alignment revoke <peer>           → alter_alignment_revoke({peer})
 *   alter alignment query  <peer> [--ctx]   → alter_alignment({peer, context})
 *
 * Defaults: --context peer_recognition
 * Allowed contexts: peer_recognition | collaboration_fit | co_founder_signal
 *
 * Output:
 *   Default - pretty-printed text. `--json` emits the raw response body.
 *   No emojis. Australian English in prose; US English in code identifiers.
 */

import { spawn } from "child_process";
import * as path from "path";

import { parseCommandString, CommandParseError } from "../lib/parse-cmd.js";
import { withKeyListenerCancel } from "../ui/biosMenu.js";
import { emitSessionHeartbeat } from "../lib/active-sessions-emit.js";
import { getSession } from "../auth.js";
import { ensureTilde, isValidHandle } from "./handle.js";

type AlignmentContext =
  | "peer_recognition"
  | "collaboration_fit"
  | "co_founder_signal";

const VALID_CONTEXTS: ReadonlySet<AlignmentContext> = new Set([
  "peer_recognition",
  "collaboration_fit",
  "co_founder_signal",
]);

interface McpResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Server-cmd resolution - resolves the personal MCP server command.
// ---------------------------------------------------------------------------

function resolveServerCmd(): { cmd: string; args: string[] } | null {
  const envCmd = process.env.ALTER_MCP_CMD;
  if (envCmd) {
    let tokens: string[];
    try {
      tokens = parseCommandString(envCmd);
    } catch (err) {
      const message =
        err instanceof CommandParseError ? err.message : String(err);
      console.error(
        `alter alignment: ALTER_MCP_CMD is invalid (${message}). ` +
          "Provide an absolute path with optional space-separated args " +
          "(no shell metacharacters).",
      );
      process.exitCode = 1;
      return null;
    }
    const [bin, ...args] = tokens;
    if (!bin || !path.isAbsolute(bin)) {
      console.error(
        "alter alignment: ALTER_MCP_CMD must start with an absolute " +
          "path (e.g. /usr/local/bin/<mcp-server>). Relative paths and " +
          "shell-resolved binaries are refused.",
      );
      process.exitCode = 1;
      return null;
    }
    return { cmd: bin, args };
  }
  console.error(
    "alter alignment: the alignment MCP server is not configured. " +
      "Set ALTER_MCP_CMD=<absolute-path-to-the-server-binary> to enable. " +
      "See https://truealter.com/docs/cli#alignment",
  );
  process.exitCode = 1;
  return null;
}

// ---------------------------------------------------------------------------
// Minimal stdio JSON-RPC client.
// ---------------------------------------------------------------------------

async function callTool(
  tool: string,
  args: Record<string, unknown>,
): Promise<McpResult | null> {
  const serverCmd = resolveServerCmd();
  if (!serverCmd) return null;
  const { cmd, args: srvArgs } = serverCmd;
  const wait = await withKeyListenerCancel(async (signal) => {
    // Windows: Node's child_process.spawn cannot invoke .cmd/.bat shims
    // directly (returns EINVAL); npm-installed bin entries land as .cmd
    // wrappers, so detect and enable shell mode for those. POSIX and
    // .exe targets stay shell-free for the usual reasons (no quoting
    // surprises, cleaner exit semantics).
    const needsShell =
      process.platform === "win32" &&
      (cmd.toLowerCase().endsWith(".cmd") || cmd.toLowerCase().endsWith(".bat"));
    const proc = spawn(cmd, srvArgs, {
      stdio: ["pipe", "pipe", "inherit"],
      shell: needsShell,
    });
    let buf = "";
    const pending = new Map<
      number,
      { resolve: (v: unknown) => void; reject: (err: Error) => void }
    >();

    const failPending = (err: Error): void => {
      for (const [, h] of pending) h.reject(err);
      pending.clear();
    };

    proc.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { id?: number; result?: unknown };
          if (typeof msg.id === "number" && pending.has(msg.id)) {
            pending.get(msg.id)!.resolve(msg.result);
            pending.delete(msg.id);
          }
        } catch {
          /* ignore non-JSON lines */
        }
      }
    });

    proc.on("exit", (code, sig) => {
      if (pending.size > 0) {
        failPending(
          new Error(
            `the MCP server exited before responding (code=${code}, signal=${sig})`,
          ),
        );
      }
    });
    proc.on("error", (err) => failPending(err));

    const onAbort = (): void => {
      failPending(Object.assign(new Error("aborted"), { name: "AbortError" }));
      try {
        proc.kill();
      } catch {
        /* best-effort */
      }
    };
    if (signal.aborted) {
      onAbort();
      return null;
    }
    signal.addEventListener("abort", onAbort);

    const send = <T>(id: number, method: string, params: unknown) =>
      new Promise<T>((resolve, reject) => {
        pending.set(id, {
          resolve: resolve as (v: unknown) => void,
          reject,
        });
        proc.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
        );
      });

    try {
      await send(1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "alter-cli", version: "0.1.0" },
      });
      proc.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }) + "\n",
      );
      const result = await send<McpResult>(2, "tools/call", {
        name: tool,
        arguments: args,
      });
      proc.stdin.end();
      proc.kill();
      return result;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  });
  if (wait.cancelled) return null;
  return wait.result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a peer handle via the canonical ensureTilde normaliser
 * (handle.ts): prepend ~ when absent so a bare "yourhandle" becomes
 * "~yourhandle",
 * lowercase, then validate against the shared HANDLE_RE. Returns null on
 * genuinely invalid input - preserving this module's null-on-failure
 * contract so callers (queryAlignmentInteractive, alignment) keep their
 * existing branch logic. The prepend-first ordering is the fix: previously
 * a bare handle failed the leading-~ check before it could be accepted.
 */
function normaliseHandle(raw: string | undefined): string | null {
  if (!raw) return null;
  const normalised = ensureTilde(raw);
  return isValidHandle(normalised) ? normalised : null;
}

function extractPayload(result: McpResult | null): unknown {
  if (!result || !result.content) return null;
  const block = result.content.find((b) => b.type === "text" && b.text);
  if (!block || !block.text) return null;
  try {
    return JSON.parse(block.text);
  } catch {
    return block.text;
  }
}

function isErrorPayload(
  payload: unknown,
): payload is { error: string; message?: string } {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof (payload as { error: unknown }).error === "string"
  );
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

interface QueryPayload {
  alignment_tier?: string;
  drivers?: string[];
  complementarity_tier?: string;
  confidence_band?: string;
  context?: string;
  vertical?: string;
  peer?: string;
  caller?: string;
}

function renderGrantOrRevoke(
  verb: "grant" | "revoke",
  peer: string,
  payload: unknown,
): string {
  if (isErrorPayload(payload)) {
    return [
      `alter alignment ${verb} ${peer}: ${payload.error}`,
      payload.message ? `  ${payload.message}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (verb === "grant") {
    return (
      `Granted: ${peer} can now query alignment with you.\n` +
      `Revoke any time:  alter alignment revoke ${peer}`
    );
  }
  return (
    `Revoked: ${peer} can no longer query alignment with you.\n` +
    `Grant again later: alter alignment grant ${peer}`
  );
}

function renderQuery(payload: unknown): string {
  if (isErrorPayload(payload)) {
    // Substitute the active session's ~handle into the consent-missing
    // hint so a cold-start user doesn't have to figure out their own
    // handle. Falls back to the placeholder string only if the session
    // is somehow absent at render time.
    const yourHandle = getSession()?.handle ?? "<your-handle>";
    const hint =
      payload.error === "consent_required" ||
      payload.error === "stream_consent_required" ||
      payload.error === "consent_missing"
        ? `  Ask the peer to run: alter alignment grant ${yourHandle}`
        : payload.error === "indeterminate"
          ? "  Both vectors share fewer than 3 traits - pair more sources first."
          : "";
    return [
      `alter alignment query: ${payload.error}`,
      payload.message ? `  ${payload.message}` : "",
      hint,
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (typeof payload !== "object" || payload === null) {
    return "alter alignment query: malformed response from the MCP server.";
  }
  const q = payload as QueryPayload;
  const lines: string[] = [];
  lines.push("");
  lines.push(
    `Alignment with ${q.peer ?? "<peer>"}` +
      (q.context ? `  (context: ${q.context})` : ""),
  );
  if (q.vertical) {
    lines.push(`Vertical gate: ${q.vertical}`);
  }
  lines.push("");
  lines.push(`  Alignment tier:        ${q.alignment_tier ?? "-"}`);
  lines.push(`  Complementarity tier:  ${q.complementarity_tier ?? "-"}`);
  lines.push(`  Confidence band:       ${q.confidence_band ?? "-"}`);
  if (q.drivers && q.drivers.length > 0) {
    lines.push("");
    lines.push("  Top driver traits:");
    for (const d of q.drivers.slice(0, 3)) {
      lines.push(`    - ${d}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

interface SubArgs {
  peer: string | null;
  context: AlignmentContext;
  json: boolean;
  help: boolean;
  /** Set when parsing failed and exitCode has already been set; caller must return. */
  parseError: boolean;
}

function parseSubArgs(argv: string[]): SubArgs {
  let peer: string | null = null;
  let context: AlignmentContext = "peer_recognition";
  let json = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      json = true;
    } else if (a === "--help" || a === "-h") {
      help = true;
    } else if (a === "--context") {
      const v = argv[++i] as AlignmentContext;
      if (!VALID_CONTEXTS.has(v)) {
        console.error(
          `alter alignment: --context must be one of ` +
            `peer_recognition | collaboration_fit | co_founder_signal (got ${v})`,
        );
        process.exitCode = 1;
        return { peer, context, json, help: false, parseError: true };
      }
      context = v;
    } else if (a.startsWith("--context=")) {
      const v = a.slice("--context=".length) as AlignmentContext;
      if (!VALID_CONTEXTS.has(v)) {
        console.error(
          `alter alignment: --context must be one of ` +
            `peer_recognition | collaboration_fit | co_founder_signal (got ${v})`,
        );
        process.exitCode = 1;
        return { peer, context, json, help: false, parseError: true };
      }
      context = v;
    } else if (!peer && !a.startsWith("--")) {
      peer = a;
    } else {
      console.error(`alter alignment: unknown argument: ${a}`);
      process.exitCode = 1;
      return { peer, context, json, help: false, parseError: true };
    }
  }
  return { peer, context, json, help, parseError: false };
}

function printHelp(): void {
  console.log(
    "Usage: alter alignment <subcommand> <peer> [flags]\n" +
      "\n" +
      "Subcommands:\n" +
      "  grant  ~peer            Authorise ~peer to query alignment with you\n" +
      "  revoke ~peer            Revoke a prior grant\n" +
      "  query  ~peer [flags]    Compute alignment between you and ~peer\n" +
      "                          (requires ~peer to have granted you first)\n" +
      "\n" +
      "Query flags:\n" +
      "  --context <enum>        peer_recognition (default) |\n" +
      "                          collaboration_fit | co_founder_signal\n" +
      "  --json                  Emit the raw MCP response as JSON\n" +
      "\n" +
      "Routes to the personal MCP server. Configure via:\n" +
      "  ALTER_MCP_CMD=<absolute-path-to-the-server>\n",
  );
}

async function runGrant(peer: string, json: boolean): Promise<void> {
  const result = await callTool("alter_alignment_grant", { peer });
  const payload = extractPayload(result);
  if (json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }
  console.log(renderGrantOrRevoke("grant", peer, payload));
  if (isErrorPayload(payload)) {
    process.exitCode = 1;
    return;
  }
}

async function runRevoke(peer: string, json: boolean): Promise<void> {
  const result = await callTool("alter_alignment_revoke", { peer });
  const payload = extractPayload(result);
  if (json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }
  console.log(renderGrantOrRevoke("revoke", peer, payload));
  if (isErrorPayload(payload)) {
    process.exitCode = 1;
    return;
  }
}

async function runQuery(
  peer: string,
  context: AlignmentContext,
  json: boolean,
): Promise<void> {
  const result = await callTool("alter_alignment", { peer, context });
  const payload = extractPayload(result);
  if (json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }
  console.log(renderQuery(payload));
  if (isErrorPayload(payload)) {
    process.exitCode = 1;
    return;
  }
}

// ---------------------------------------------------------------------------
// Menu-facing query
// ---------------------------------------------------------------------------

export interface InteractiveQueryOutcome {
  /** Pretty-printed result (or error) text, ready to write to stdout. */
  rendered: string;
  /** True when the MCP returned an error payload. */
  isError: boolean;
  /** True when the error is the expected "peer hasn't granted you" state. */
  consentRequired: boolean;
}

/**
 * Alignment query for the interactive menu. Unlike runQuery (the standalone
 * `alter alignment query` verb, which sets process.exitCode = 1 and returns on
 * an error payload so scripts get a non-zero exit), this RETURNS the rendered
 * outcome so the menu can keep its alt-screen alive and offer follow-up actions
 * - notably asking the peer for a grant when consent is required. A hard
 * process.exit from inside the menu would tear the whole TUI down.
 */
export async function queryAlignmentInteractive(
  peer: string,
  context: string,
): Promise<InteractiveQueryOutcome> {
  const handle = normaliseHandle(peer);
  if (!handle) {
    return {
      rendered: `alter alignment query: ${peer} is not a valid ~handle.`,
      isError: true,
      consentRequired: false,
    };
  }
  const ctx: AlignmentContext = VALID_CONTEXTS.has(context as AlignmentContext)
    ? (context as AlignmentContext)
    : "peer_recognition";
  const result = await callTool("alter_alignment", { peer: handle, context: ctx });
  const payload = extractPayload(result);
  const errPayload = isErrorPayload(payload) ? payload : null;
  const consentRequired =
    errPayload !== null &&
    (errPayload.error === "consent_required" ||
      errPayload.error === "stream_consent_required" ||
      errPayload.error === "consent_missing");
  return {
    rendered: renderQuery(payload),
    isError: errPayload !== null,
    consentRequired,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function alignment(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    printHelp();
    return;
  }
  if (sub !== "grant" && sub !== "revoke" && sub !== "query") {
    console.error(`alter alignment: unknown subcommand: ${sub}`);
    printHelp();
    process.exitCode = 1;
    return;
  }
  try {
    emitSessionHeartbeat({
      sessionId: String(process.pid),
      workingOn: "alter alignment",
    });
  } catch { /* silent - must not block command */ }

  const { peer, context, json, help, parseError } = parseSubArgs(argv.slice(1));
  if (parseError) return;
  if (help) {
    printHelp();
    return;
  }
  const handle = normaliseHandle(peer ?? undefined);
  if (!handle) {
    console.error(
      `alter alignment ${sub}: <peer> must be a valid ~handle ` +
        `(e.g. ~peer). Got: ${peer ?? "<missing>"}`,
    );
    process.exitCode = 1;
    return;
  }

  switch (sub) {
    case "grant":
      await runGrant(handle, json);
      break;
    case "revoke":
      await runRevoke(handle, json);
      break;
    case "query":
      await runQuery(handle, context, json);
      break;
  }
}
