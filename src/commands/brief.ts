/**
 * `alter brief` - print the morning brief once, or stream it with `--watch`
 * (live loop at L264 polls every interval and re-renders on signal change).
 */

import { spawn } from "child_process";
import * as path from "path";

import { parseCommandString } from "../lib/parse-cmd.js";
import { withKeyListenerCancel } from "../ui/biosMenu.js";
import { emitSessionHeartbeat } from "../lib/active-sessions-emit.js";

type BriefType = "morning" | "evening" | "weekly";

interface McpResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function parseArgs(argv: string[]): {
  type: BriefType;
  json: boolean;
  absenceOnly: boolean;
  watch: boolean;
} {
  let type: BriefType = "morning";
  let json = false;
  let absenceOnly = false;
  let watch = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--type") {
      const v = argv[++i];
      if (v !== "morning" && v !== "evening" && v !== "weekly") {
        throw new Error(`--type must be morning|evening|weekly (got ${v})`);
      }
      type = v;
    } else if (a === "--json") json = true;
    else if (a === "--absence-only") absenceOnly = true;
    else if (a === "--watch") watch = true;
    else throw new Error(`Unknown flag: ${a}`);
  }
  return { type, json, absenceOnly, watch };
}

/** Resolve the configured Org Alter MCP entrypoint, when one is present.
 *
 * Reads an optional configured command and parses it with a shell-free
 * splitter (no `sh -c`) so the value cannot smuggle in a compound command
 * via `;`, `|`, `&`, `$()`, etc. The first token must be an absolute path -
 * the target is invoked directly, never resolved through `$PATH`, never
 * wrapped in a shell.
 */
function resolveServerCmd(): { cmd: string; args: string[] } | null {
  const envCmd = process.env.ALTER_ORG_MCP_CMD;
  if (envCmd) {
    let tokens: string[];
    try {
      tokens = parseCommandString(envCmd);
    } catch {
      console.error("alter brief: Org Alter is not configured.");
      process.exitCode = 1;
      return null;
    }
    const [bin, ...args] = tokens;
    if (!bin || !path.isAbsolute(bin)) {
      console.error("alter brief: Org Alter is not configured.");
      process.exitCode = 1;
      return null;
    }
    return { cmd: bin, args };
  }
  console.error("alter brief: Org Alter is not configured.");
  process.exitCode = 1;
  return null;
}

/**
 * Minimal stdio JSON-RPC client: initialize → tools/call → exit.
 *
 * Wrapped in `withKeyListenerCancel` so a stalled server (slow open,
 * missing index, deadlocked subscriber) does not freeze the terminal -
 * q/Esc kills the child, rejects every pending send,
 * and returns `null`. Returns the result on success; throws on
 * unrecoverable child-side errors. Stderr stays inherited so the
 * spawned process's diagnostics surface in the parent terminal.
 */
async function callTool(
  tool: string,
  args: Record<string, unknown>
): Promise<McpResult | null> {
  const serverCmd = resolveServerCmd();
  if (!serverCmd) return null;
  const { cmd, args: srvArgs } = serverCmd;
  const wait = await withKeyListenerCancel(async (signal) => {
    // Windows: Node's child_process.spawn cannot invoke .cmd/.bat shims
    // directly (EINVAL); npm-installed bin entries land as .cmd wrappers,
    // so detect and enable shell mode for those. POSIX and .exe targets
    // stay shell-free.
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

    // If the child exits before responding (crash, missing binary, exec
    // error), every outstanding send must reject so the caller doesn't
    // hang waiting for a reply that will never arrive.
    proc.on("exit", (code, sig) => {
      if (pending.size > 0) {
        failPending(
          new Error(
            `Org Alter exited before responding (code=${code}, signal=${sig})`,
          ),
        );
      }
    });
    proc.on("error", (err) => failPending(err));

    const onAbort = (): void => {
      failPending(
        Object.assign(new Error("aborted"), { name: "AbortError" }),
      );
      try {
        proc.kill();
      } catch {
        /* ignore - the kill is best-effort on cancel */
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
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
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

function printHelp(): void {
  console.log(
    "Usage: alter brief [--type morning|evening|weekly] [--json]\n" +
      "                   [--absence-only]\n" +
      "\n" +
      "Fetch the collective brief for your session.\n" +
      "Flags:\n" +
      "  --type <kind>     morning (default), evening, or weekly\n" +
      "  --json            emit raw JSON instead of pre-rendered text\n" +
      "  --absence-only    print only when the brief state is 'quiet'\n" +
      "  --watch           re-run every hour (Ctrl-C to stop)\n",
  );
}

const WATCH_INTERVAL_MS = 60 * 60 * 1000;

async function renderOnce(opts: {
  type: BriefType;
  json: boolean;
  absenceOnly: boolean;
}): Promise<void> {
  const result = await callTool("org_alter_brief", { type: opts.type });
  if (result === null) return;
  const text = result.content?.find((c) => c.type === "text")?.text ?? "";
  let parsed: { state?: string } | null = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (opts.absenceOnly && parsed?.state !== "quiet") return;
  if (opts.json) {
    console.log(parsed ? JSON.stringify(parsed, null, 2) : text);
  } else {
    console.log(text);
  }
}

export async function brief(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }
  try {
    emitSessionHeartbeat({
      sessionId: String(process.pid),
      workingOn: "alter brief",
    });
  } catch { /* silent - must not block command */ }
  const opts = parseArgs(argv);
  if (!opts.watch) {
    await renderOnce(opts);
    return;
  }
  let stopped = false;
  const stop = (): void => {
    stopped = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  while (!stopped) {
    await renderOnce(opts);
    if (stopped) break;
    await new Promise((r) => setTimeout(r, WATCH_INTERVAL_MS));
  }
}
