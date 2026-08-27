/**
 * `alter ingest <kind> [payload-json]` - programmatic OrgAlterDO ingest shim.
 *
 * Hidden subcommand: NOT in `alter --help`, NOT in the interactive menu,
 * NOT in the README command table. Exists so machine producers (CC hooks,
 * daemons, CI) have a single auth-handling entry point that doesn't need
 * to know about session refresh, the api base, or the X402 secret.
 *
 * Keep this command machine-only. If humans need to send signals,
 * loops, or notes interactively, the menu and dedicated verbs cover
 * that - `alter ingest` is the substrate hook.
 *
 * Usage:
 *   alter ingest <kind>                   # payload from stdin (JSON)
 *   alter ingest <kind> '<json-payload>'  # payload as second positional
 *
 * Flags:
 *   --thread-id <id>     correlated-event id (e.g. a loop id)
 *   --producer <tag>     l5:cc-hook, l3:alter-runtime, etc. (must start
 *                        with "l5:" or "l3:"; backend rejects others)
 *   --quiet, -q          suppress success line on stdout
 *
 * Output:
 *   stdout: one line of JSON `{"ok": true|false, "do_status": N, ...}`
 *   stderr: human-readable error on failure (also exit code 1)
 */

import { readFileSync } from "fs";
import { getSession, isExpired, httpCall } from "../auth.js";
import { emitSessionHeartbeat } from "../lib/active-sessions-emit.js";

export interface IngestArgs {
  kind: string;
  payload: Record<string, unknown>;
  thread_id?: string;
  producer?: string;
  quiet: boolean;
}

export type ParseResult = IngestArgs | { error: string };

export function parseIngestArgs(
  argv: string[],
  readPayload: () => string = readStdin,
): ParseResult {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return {
      error:
        "Usage: alter ingest <kind> [json-payload]\n" +
        "  --thread-id <id>     correlated-event id\n" +
        "  --producer <tag>     l5:* or l3:* attribution tag\n" +
        "  --quiet, -q          suppress success line\n" +
        "If [json-payload] is omitted, payload is read from stdin.",
    };
  }

  const kind = argv[0];
  let payloadStr: string | null = null;
  let thread_id: string | undefined;
  let producer: string | undefined;
  let quiet = false;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--thread-id") {
      thread_id = argv[++i];
      if (!thread_id) return { error: "--thread-id requires a value" };
    } else if (arg === "--producer") {
      producer = argv[++i];
      if (!producer) return { error: "--producer requires a value" };
    } else if (arg === "--quiet" || arg === "-q") {
      quiet = true;
    } else if (arg.startsWith("--")) {
      return { error: `unknown flag: ${arg}` };
    } else if (payloadStr === null) {
      payloadStr = arg;
    } else {
      return { error: `unexpected positional argument: ${arg}` };
    }
  }

  if (payloadStr === null) {
    payloadStr = readPayload();
  }
  if (!payloadStr.trim()) {
    return { error: "payload is empty (provide as second arg or via stdin)" };
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadStr) as Record<string, unknown>;
  } catch (err) {
    return {
      error: `payload is not valid JSON: ${(err as Error).message}`,
    };
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { error: "payload must be a JSON object" };
  }

  return { kind, payload, thread_id, producer, quiet };
}

function readStdin(): string {
  if (process.stdin.isTTY) return "";
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export async function ingest(argv: string[]): Promise<void> {
  const parsed = parseIngestArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(parsed.error + "\n");
    process.exitCode = 1;
    return;
  }
  try {
    emitSessionHeartbeat({
      sessionId: String(process.pid),
      workingOn: "alter ingest",
    });
  } catch { /* silent - must not block command */ }

  if (isExpired()) {
    process.stderr.write(
      "alter: session expired - run `alter login` and retry\n",
    );
    process.exitCode = 2;
    return;
  }
  const session = getSession();
  if (!session) {
    process.stderr.write(
      "alter: no active session - run `alter login` and retry\n",
    );
    process.exitCode = 2;
    return;
  }

  const apiBase = (session.api ?? "").replace(/\/+$/, "");
  if (!apiBase) {
    process.stderr.write("alter: session is missing api base\n");
    process.exitCode = 2;
    return;
  }

  const url = apiBase + "/api/v1/org-alter/ingest";
  const body: Record<string, unknown> = {
    kind: parsed.kind,
    payload: parsed.payload,
  };
  if (parsed.thread_id) body.thread_id = parsed.thread_id;
  if (parsed.producer) body.producer = parsed.producer;

  let response: Response;
  try {
    response = await httpCall(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.jwt}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    process.stderr.write(
      `alter: ingest transport error: ${(err as Error).message}\n`,
    );
    process.exitCode = 3;
    return;
  }

  let parsedBody: unknown;
  try {
    parsedBody = await response.json();
  } catch {
    parsedBody = null;
  }

  if (!response.ok) {
    process.stderr.write(
      `alter: ingest rejected (HTTP ${response.status}): ${
        parsedBody ? JSON.stringify(parsedBody) : "(no body)"
      }\n`,
    );
    process.exitCode = 4;
    return;
  }

  if (!parsed.quiet) {
    process.stdout.write(JSON.stringify(parsedBody) + "\n");
  }
}
