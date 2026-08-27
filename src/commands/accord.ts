/**
 * alter accord - the ~Alter Accord, a cryptographic agreement between two
 * bound ~handles.
 *
 * An accord is a hash-chained, content-addressed record: you begin one
 * with a counterparty, each side responds (accept or counter), and each
 * party signs with a binding human tap. Signing is human-tap-only; it is
 * never delegated to an agent.
 *
 * Subcommands:
 *   alter accord initiate            Begin a new accord with a counterparty
 *   alter accord respond <id>        Accept or counter an accord's terms
 *   alter accord sign <id>           Sign an accord (two-phase human tap)
 *   alter accord status <id>         Read parties, status, and event chain
 *   alter accord bootstrap           How to reach a counterparty who has no
 *                                    ~handle yet (admin-provisioned)
 *
 * Routing: wraps the shipped begin_agreement / propose_terms / sign_accord
 * / query_accord_status MCP tools via @truealter/sdk's AlterClient, the
 * same authed path `alter msg` uses. The binding tap is recorded through
 * the alter_agent_response verb so the server verifies against its own
 * recorded answer, never a value this CLI asserts.
 *
 * Output: pretty-printed text by default; `--json` emits the raw MCP
 * payload. No emojis. Australian English in prose; US English in code
 * identifiers.
 */

import { readFileSync } from "fs";

import chalk from "chalk";
import { AlterToolError, AlterAuthError } from "@truealter/sdk";

import { requireAuthedClient, extractPayload } from "./msg.js";
import { confirmYesNo } from "../ui/picker.js";
import { emitSessionHeartbeat } from "../lib/active-sessions-emit.js";
import { sessionRejectedMessage } from "../auth.js";
import { HANDLE_RE } from "../lib/handle-re.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INSTRUMENT_CLASSES = [
  "unilateral",
  "bilateral",
  "multilateral",
  "statutory_single_signatory",
] as const;
type InstrumentClass = (typeof INSTRUMENT_CLASSES)[number];

/** Answer text recorded for an affirmative binding tap. Must NOT read as a
 *  decline (the server rejects decline tokens on the sign path). */
const AFFIRMATIVE_RESPONSE_TEXT = "yes";

// ---------------------------------------------------------------------------
// Error surface
// ---------------------------------------------------------------------------

/**
 * A structured accord-tool error. The MCP tools return
 * `{error: {code, message}}`; the SDK raises AlterToolError carrying that
 * JSON as its message. `toAccordError` normalises both into a code plus a
 * human message so callers render consistent guidance.
 */
export class AccordError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AccordError";
    this.code = code;
  }
}

/** Parse the `{error:{code,message}}` JSON an accord tool packs into an
 *  AlterToolError message. Returns null when the message is not that shape. */
function parseToolErrorMessage(
  message: string,
): { code: string; message: string } | null {
  try {
    const parsed = JSON.parse(message) as {
      error?: { code?: unknown; message?: unknown };
    };
    const err = parsed?.error;
    if (err && typeof err.code === "string") {
      return {
        code: err.code,
        message: typeof err.message === "string" ? err.message : err.code,
      };
    }
  } catch {
    /* not JSON - fall through */
  }
  return null;
}

function toAccordError(err: unknown): AccordError {
  if (err instanceof AccordError) return err;
  if (err instanceof AlterAuthError) {
    return new AccordError("auth", sessionRejectedMessage());
  }
  if (err instanceof AlterToolError) {
    const parsed = parseToolErrorMessage(err.message);
    if (parsed) return new AccordError(parsed.code, parsed.message);
    const code = typeof err.rpcCode === "number" ? String(err.rpcCode) : "tool_error";
    return new AccordError(code, err.message);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new AccordError("unknown", message);
}

/** Map an accord error code to actionable guidance, defaulting to the
 *  server's own message. */
export function renderAccordError(code: string, message: string): string {
  switch (code) {
    case "no_bound_handle":
      return "You have no bound ~handle. Run `alter login` to bind one.";
    case "not_a_party":
      return "You are not a listed party of this accord, so you cannot act on it.";
    case "accord_not_found":
      return "No accord found with that id. Check the id and try again.";
    case "auth":
      return message;
    default:
      return message || `accord error: ${code}`;
  }
}

// ---------------------------------------------------------------------------
// Tool-call plumbing
// ---------------------------------------------------------------------------

/** A single tool invocation: returns the parsed payload, or throws an
 *  AccordError. Injected into flows so they stay testable without a client. */
export type ToolCaller = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

/** Build a ToolCaller over an authed AlterClient's MCP channel. */
function makeToolCaller(client: {
  mcp: { callTool: (name: string, args?: Record<string, unknown>) => Promise<unknown> };
}): ToolCaller {
  return async (tool, args) => {
    try {
      const result = await client.mcp.callTool(tool, args);
      // extractPayload accepts the SDK's MCPCallToolResult shape.
      return extractPayload(result as never);
    } catch (err) {
      throw toAccordError(err);
    }
  };
}

/** True when a payload is the `{error:{...}}` envelope rather than a result. */
function payloadError(
  payload: unknown,
): { code: string; message: string } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const e = (payload as { error?: { code?: unknown; message?: unknown } }).error;
  if (e && typeof e === "object") {
    return {
      code: typeof e.code === "string" ? e.code : "unknown",
      message: typeof e.message === "string" ? e.message : "",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise and validate a ~handle. Accepts with or without the leading
 * tilde, lowercases the body, enforces the canonical regex. Throws a
 * user-facing Error on malformed input.
 */
export function normaliseHandle(raw: string | undefined, fieldName = "handle"): string {
  if (!raw || typeof raw !== "string") {
    throw new Error(`${fieldName} is required`);
  }
  const trimmed = raw.trim();
  const withTilde = trimmed.startsWith("~") ? trimmed : `~${trimmed}`;
  const lowered = "~" + withTilde.slice(1).toLowerCase();
  if (!HANDLE_RE.test(lowered)) {
    throw new Error(
      `malformed ${fieldName} "${raw}" - must match ~[a-z0-9][a-z0-9-]{1,31}`,
    );
  }
  return lowered;
}

/**
 * Resolve a terms payload from an inline JSON string and/or a file path.
 * Exactly one source may be given. Returns the parsed object, or null when
 * neither is supplied. Throws on invalid JSON, a non-object, both sources,
 * or a file read failure.
 */
export function loadTerms(
  inline: string | undefined,
  filePath: string | undefined,
): Record<string, unknown> | null {
  if (inline != null && filePath != null) {
    throw new Error("pass either --terms or --terms-file, not both");
  }
  let text: string | undefined = inline;
  if (filePath != null) {
    try {
      text = readFileSync(filePath, "utf-8");
    } catch (err) {
      throw new Error(
        `could not read --terms-file "${filePath}": ${(err as Error).message}`,
      );
    }
  }
  if (text == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("terms must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("terms must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function emitJson(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// initiate
// ---------------------------------------------------------------------------

export interface InitiateArgs {
  instrumentClass: InstrumentClass | null;
  counterparty: string | null;
  termsInline: string | undefined;
  termsFile: string | undefined;
  legalEntity: string | undefined;
  assuranceTier: string | undefined;
  json: boolean;
  help: boolean;
  error?: string;
}

export function parseInitiateArgs(argv: string[]): InitiateArgs {
  const out: InitiateArgs = {
    instrumentClass: null,
    counterparty: null,
    termsInline: undefined,
    termsFile: undefined,
    legalEntity: undefined,
    assuranceTier: undefined,
    json: false,
    help: false,
  };
  const takeValue = (i: number, flag: string): string | undefined => {
    const v = argv[i + 1];
    if (v == null || v.startsWith("--")) {
      out.error = `${flag} requires a value`;
      return undefined;
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (a === "--json") {
      out.json = true;
    } else if (a === "--class" || a === "--instrument-class") {
      const v = takeValue(i, a);
      if (out.error) return out;
      if (!INSTRUMENT_CLASSES.includes(v as InstrumentClass)) {
        out.error = `--class must be one of ${INSTRUMENT_CLASSES.join(" | ")}`;
        return out;
      }
      out.instrumentClass = v as InstrumentClass;
      i++;
    } else if (a === "--counterparty" || a === "--to") {
      out.counterparty = takeValue(i, a) ?? null;
      if (out.error) return out;
      i++;
    } else if (a === "--terms") {
      out.termsInline = takeValue(i, a);
      if (out.error) return out;
      i++;
    } else if (a === "--terms-file") {
      out.termsFile = takeValue(i, a);
      if (out.error) return out;
      i++;
    } else if (a === "--legal-entity") {
      out.legalEntity = takeValue(i, a);
      if (out.error) return out;
      i++;
    } else if (a === "--assurance-tier") {
      out.assuranceTier = takeValue(i, a);
      if (out.error) return out;
      i++;
    } else {
      out.error = `unknown argument: ${a}`;
      return out;
    }
  }
  return out;
}

async function runInitiate(argv: string[]): Promise<void> {
  const opts = parseInitiateArgs(argv);
  if (opts.help) {
    printInitiateHelp();
    return;
  }
  if (opts.error) {
    console.error(`alter accord initiate: ${opts.error}`);
    process.exitCode = 1;
    return;
  }
  if (!opts.instrumentClass) {
    console.error(
      "alter accord initiate: --class is required " +
        `(${INSTRUMENT_CLASSES.join(" | ")}).`,
    );
    process.exitCode = 1;
    return;
  }
  let counterparty: string;
  try {
    counterparty = normaliseHandle(opts.counterparty ?? undefined, "counterparty");
  } catch (err) {
    console.error(`alter accord initiate: ${(err as Error).message}`);
    console.error("  Pass the counterparty with --counterparty ~handle.");
    process.exitCode = 1;
    return;
  }
  let terms: Record<string, unknown> | null;
  try {
    terms = loadTerms(opts.termsInline, opts.termsFile);
  } catch (err) {
    console.error(`alter accord initiate: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  if (terms === null) {
    console.error(
      "alter accord initiate: terms are required. Pass --terms '<json>' " +
        "or --terms-file <path>.",
    );
    process.exitCode = 1;
    return;
  }

  const authed = requireAuthedClient();
  if (!authed) return;
  const callTool = makeToolCaller(authed.client);

  const args: Record<string, unknown> = {
    instrument_class: opts.instrumentClass,
    counterparty_handle: counterparty,
    terms,
  };
  if (opts.legalEntity != null) args.legal_entity = opts.legalEntity;
  if (opts.assuranceTier != null) args.assurance_tier = opts.assuranceTier;

  let payload: unknown;
  try {
    payload = await callTool("begin_agreement", args);
  } catch (err) {
    const e = toAccordError(err);
    console.error(`alter accord initiate: ${renderAccordError(e.code, e.message)}`);
    process.exitCode = 1;
    return;
  }
  if (opts.json) {
    emitJson(payload);
    return;
  }
  const perr = payloadError(payload);
  if (perr) {
    console.error(`alter accord initiate: ${renderAccordError(perr.code, perr.message)}`);
    process.exitCode = 1;
    return;
  }
  const p = payload as { accord_id?: string; content_hash?: string; status?: string };
  console.log("");
  console.log(`  Accord begun with ${counterparty}.`);
  console.log(`    id:            ${p.accord_id ?? "-"}`);
  console.log(`    status:        ${p.status ?? "-"}`);
  console.log(`    content hash:  ${p.content_hash ?? "-"}`);
  console.log("");
  console.log(`  Next: ${counterparty} can accept or counter with`);
  console.log(`        alter accord respond ${p.accord_id ?? "<id>"} --accept`);
  console.log("");
}

// ---------------------------------------------------------------------------
// respond
// ---------------------------------------------------------------------------

export interface RespondArgs {
  accordId: string | null;
  accept: boolean | null;
  termsInline: string | undefined;
  termsFile: string | undefined;
  json: boolean;
  help: boolean;
  error?: string;
}

export function parseRespondArgs(argv: string[]): RespondArgs {
  const out: RespondArgs = {
    accordId: null,
    accept: null,
    termsInline: undefined,
    termsFile: undefined,
    json: false,
    help: false,
  };
  const takeValue = (i: number, flag: string): string | undefined => {
    const v = argv[i + 1];
    if (v == null || v.startsWith("--")) {
      out.error = `${flag} requires a value`;
      return undefined;
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (a === "--json") {
      out.json = true;
    } else if (a === "--accept") {
      if (out.accept === false) {
        out.error = "--accept and --counter are mutually exclusive";
        return out;
      }
      out.accept = true;
    } else if (a === "--counter") {
      if (out.accept === true) {
        out.error = "--accept and --counter are mutually exclusive";
        return out;
      }
      out.accept = false;
    } else if (a === "--terms") {
      out.termsInline = takeValue(i, a);
      if (out.error) return out;
      i++;
    } else if (a === "--terms-file") {
      out.termsFile = takeValue(i, a);
      if (out.error) return out;
      i++;
    } else if (!a.startsWith("-") && out.accordId === null) {
      out.accordId = a;
    } else {
      out.error = `unknown argument: ${a}`;
      return out;
    }
  }
  return out;
}

async function runRespond(argv: string[]): Promise<void> {
  const opts = parseRespondArgs(argv);
  if (opts.help) {
    printRespondHelp();
    return;
  }
  if (opts.error) {
    console.error(`alter accord respond: ${opts.error}`);
    process.exitCode = 1;
    return;
  }
  if (!opts.accordId) {
    console.error("alter accord respond: <accord_id> is required.");
    process.exitCode = 1;
    return;
  }
  if (opts.accept === null) {
    console.error(
      "alter accord respond: choose --accept or --counter.",
    );
    process.exitCode = 1;
    return;
  }
  let terms: Record<string, unknown> | null;
  try {
    terms = loadTerms(opts.termsInline, opts.termsFile);
  } catch (err) {
    console.error(`alter accord respond: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const authed = requireAuthedClient();
  if (!authed) return;
  const callTool = makeToolCaller(authed.client);

  const args: Record<string, unknown> = {
    accord_id: opts.accordId,
    accept: opts.accept,
  };
  if (terms !== null) args.terms = terms;

  let payload: unknown;
  try {
    payload = await callTool("propose_terms", args);
  } catch (err) {
    const e = toAccordError(err);
    console.error(`alter accord respond: ${renderAccordError(e.code, e.message)}`);
    process.exitCode = 1;
    return;
  }
  if (opts.json) {
    emitJson(payload);
    return;
  }
  const perr = payloadError(payload);
  if (perr) {
    console.error(`alter accord respond: ${renderAccordError(perr.code, perr.message)}`);
    process.exitCode = 1;
    return;
  }
  const p = payload as { status?: string; accord_id?: string };
  const verb = opts.accept ? "accepted" : "counter-proposed";
  console.log(`  Response recorded (${verb}). Accord ${p.accord_id ?? opts.accordId} is now ${p.status ?? "updated"}.`);
  console.log(`  Sign it with: alter accord sign ${p.accord_id ?? opts.accordId}`);
}

// ---------------------------------------------------------------------------
// sign - two-phase, human-tap-only
// ---------------------------------------------------------------------------

export interface SignFlowDeps {
  callTool: ToolCaller;
  /** Capture the human tap. Returns true to sign, false/null to decline. */
  confirm: (message: string) => Promise<boolean | null>;
  accordId: string;
  out: (line: string) => void;
  json: boolean;
}

export interface SignFlowOutcome {
  signed: boolean;
  declined: boolean;
  frameId?: string;
  error?: { code: string; message: string };
  payload?: unknown;
}

/**
 * The two-phase sign flow.
 *
 *   1. Call sign_accord with no binding_moment_response. The server emits
 *      a binding-moment tap and returns {status:"awaiting_tap", frame_id}.
 *   2. Render the tap locally and capture a REAL human y/n.
 *   3. On decline: stop. Never record, never call the second step, never sign.
 *   4. On affirmative: record the answer server-side via
 *      alter_agent_response (so the server verifies against its OWN
 *      recorded response), then call sign_accord again with
 *      binding_moment_response.responded_to_frame_id = frame_id.
 *
 * response_text is advisory only on the second step; the server decides accept vs
 * decline from the response it recorded, never from a value we assert.
 */
export async function signAccordFlow(deps: SignFlowDeps): Promise<SignFlowOutcome> {
  const { callTool, confirm, accordId, out, json } = deps;

  // Step one: emit the tap.
  let phase1: unknown;
  try {
    phase1 = await callTool("sign_accord", { accord_id: accordId });
  } catch (err) {
    const e = toAccordError(err);
    return { signed: false, declined: false, error: { code: e.code, message: e.message } };
  }
  const perr1 = payloadError(phase1);
  if (perr1) {
    return { signed: false, declined: false, error: perr1 };
  }
  const p1 = phase1 as { status?: string; frame_id?: string };
  const frameId = p1.frame_id;
  if (p1.status !== "awaiting_tap" || typeof frameId !== "string" || !frameId) {
    return {
      signed: false,
      declined: false,
      error: {
        code: "no_tap",
        message: "The server did not return a binding-moment tap to confirm.",
      },
    };
  }

  // Best-effort preview so the human sees what they are signing.
  try {
    const status = await callTool("query_accord_status", { accord_id: accordId });
    if (!payloadError(status)) {
      out(renderSignPreview(status));
    }
  } catch {
    /* preview is best-effort; the tap proceeds regardless */
  }

  // Second-step gate: the REAL local human tap.
  const answer = await confirm(`Sign accord ${accordId}? This is a binding signature.`);
  if (answer !== true) {
    out("  Not signed. No signature was produced.");
    return { signed: false, declined: true, frameId };
  }

  // Record the affirmative answer server-side. The server checks the sign
  // against THIS recorded response, not the second step's request fields.
  try {
    await callTool("alter_agent_response", {
      responded_to_frame_id: frameId,
      query_id: frameId,
      response_text: AFFIRMATIVE_RESPONSE_TEXT,
      answer_attempt_idx: 1,
    });
  } catch (err) {
    const e = toAccordError(err);
    return {
      signed: false,
      declined: false,
      frameId,
      error: { code: e.code, message: e.message },
    };
  }

  // Step two: sign. response_text is advisory only.
  let phase2: unknown;
  try {
    phase2 = await callTool("sign_accord", {
      accord_id: accordId,
      binding_moment_response: {
        responded_to_frame_id: frameId,
        response_text: AFFIRMATIVE_RESPONSE_TEXT,
      },
    });
  } catch (err) {
    const e = toAccordError(err);
    return {
      signed: false,
      declined: false,
      frameId,
      error: { code: e.code, message: e.message },
    };
  }
  const perr2 = payloadError(phase2);
  if (perr2) {
    return { signed: false, declined: false, frameId, error: perr2 };
  }
  const p2 = phase2 as { status?: string };
  // The server can still record a decline (e.g. a "no" answered elsewhere);
  // honour its verdict rather than assuming a signature.
  if (p2.status === "declined") {
    out("  The recorded answer was a decline. Not signed.");
    return { signed: false, declined: true, frameId, payload: phase2 };
  }
  if (json) {
    emitJson(phase2);
  } else {
    out(renderSignResult(phase2, accordId));
  }
  return { signed: true, declined: false, frameId, payload: phase2 };
}

function renderSignPreview(payload: unknown): string {
  const p = payload as {
    status?: string;
    content_hash?: string;
    parties?: Array<{ handle?: string; role?: string }>;
  };
  const lines: string[] = [];
  lines.push("");
  lines.push("  You are about to sign:");
  lines.push(`    status:        ${p.status ?? "-"}`);
  lines.push(`    content hash:  ${p.content_hash ?? "-"}`);
  if (Array.isArray(p.parties) && p.parties.length) {
    lines.push("    parties:");
    for (const party of p.parties) {
      lines.push(`      - ${party.handle ?? "?"} (${party.role ?? "party"})`);
    }
  }
  lines.push("");
  lines.push("  Signing is a binding human tap. It cannot be delegated to an agent.");
  return lines.join("\n");
}

function renderSignResult(payload: unknown, accordId: string): string {
  const p = payload as {
    status?: string;
    signature?: string;
    entry_hash?: string;
  };
  const lines: string[] = [];
  lines.push("");
  lines.push(`  Signed. Accord ${accordId} is now ${p.status ?? "signed"}.`);
  if (p.signature) lines.push(`    signature:   ${p.signature}`);
  if (p.entry_hash) lines.push(`    entry hash:  ${p.entry_hash}`);
  lines.push("");
  return lines.join("\n");
}

async function runSign(argv: string[]): Promise<void> {
  // Parse: a single accord_id positional, plus --json / --help. --yes is
  // explicitly refused: a signature needs a real human tap, so it can
  // never be auto-confirmed.
  let accordId: string | null = null;
  let json = false;
  for (const a of argv) {
    if (a === "--help" || a === "-h") {
      printSignHelp();
      return;
    }
    if (a === "--json") {
      json = true;
    } else if (a === "--yes" || a === "-y") {
      console.error(
        "alter accord sign: a signature cannot be auto-confirmed. " +
          "Signing needs a real human tap.",
      );
      process.exitCode = 1;
      return;
    } else if (!a.startsWith("-") && accordId === null) {
      accordId = a;
    } else {
      console.error(`alter accord sign: unknown argument: ${a}`);
      process.exitCode = 1;
      return;
    }
  }
  if (!accordId) {
    console.error("alter accord sign: <accord_id> is required.");
    process.exitCode = 1;
    return;
  }

  // The tap is a live keypress: it needs an interactive terminal. Under a
  // pipe or CI there is no human to tap, so refuse rather than hang or
  // fabricate consent.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      "alter accord sign: signing needs an interactive terminal for the " +
        "binding tap. Run it in a real terminal.",
    );
    process.exitCode = 1;
    return;
  }

  const authed = requireAuthedClient();
  if (!authed) return;
  const callTool = makeToolCaller(authed.client);

  const outcome = await signAccordFlow({
    callTool,
    confirm: (message) => confirmYesNo({ message, initialValue: false }),
    accordId,
    out: (line) => console.log(line),
    json,
  });

  if (outcome.error) {
    console.error(
      `alter accord sign: ${renderAccordError(outcome.error.code, outcome.error.message)}`,
    );
    process.exitCode = 1;
    return;
  }
  if (!outcome.signed) {
    // A clean decline is not an error exit; it is a valid choice.
    return;
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function runStatus(argv: string[]): Promise<void> {
  let accordId: string | null = null;
  let json = false;
  for (const a of argv) {
    if (a === "--help" || a === "-h") {
      printStatusHelp();
      return;
    }
    if (a === "--json") {
      json = true;
    } else if (!a.startsWith("-") && accordId === null) {
      accordId = a;
    } else {
      console.error(`alter accord status: unknown argument: ${a}`);
      process.exitCode = 1;
      return;
    }
  }
  if (!accordId) {
    console.error("alter accord status: <accord_id> is required.");
    process.exitCode = 1;
    return;
  }

  const authed = requireAuthedClient();
  if (!authed) return;
  const callTool = makeToolCaller(authed.client);

  let payload: unknown;
  try {
    payload = await callTool("query_accord_status", { accord_id: accordId });
  } catch (err) {
    const e = toAccordError(err);
    console.error(`alter accord status: ${renderAccordError(e.code, e.message)}`);
    process.exitCode = 1;
    return;
  }
  if (json) {
    emitJson(payload);
    return;
  }
  const perr = payloadError(payload);
  if (perr) {
    console.error(`alter accord status: ${renderAccordError(perr.code, perr.message)}`);
    process.exitCode = 1;
    return;
  }
  console.log(renderStatus(payload));
}

export function renderStatus(payload: unknown): string {
  const p = payload as {
    accord_id?: string;
    instrument_class?: string;
    status?: string;
    content_hash?: string;
    fully_executed?: boolean;
    chain_intact?: boolean;
    parties?: Array<{
      handle?: string;
      role?: string;
      signatory_authority?: string;
      assurance_tier?: string;
      legal_entity?: string | null;
    }>;
    events?: Array<{
      seq?: number;
      event_type?: string;
      entry_hash?: string;
      signature_valid?: boolean | null;
      created_at?: string | null;
    }>;
  };
  const lines: string[] = [];
  lines.push("");
  lines.push(chalk.bold(`  Accord ${p.accord_id ?? "-"}`));
  lines.push(`    class:          ${p.instrument_class ?? "-"}`);
  lines.push(`    status:         ${p.status ?? "-"}`);
  lines.push(`    content hash:   ${p.content_hash ?? "-"}`);
  lines.push(
    `    fully executed: ${p.fully_executed ? "yes" : "no"}` +
      `    chain intact: ${p.chain_intact ? "yes" : "no"}`,
  );
  lines.push("");
  lines.push("  Parties:");
  if (Array.isArray(p.parties) && p.parties.length) {
    for (const party of p.parties) {
      const entity = party.legal_entity ? `  on behalf of ${party.legal_entity}` : "";
      lines.push(
        `    - ${party.handle ?? "?"}  (${party.role ?? "party"}, ` +
          `${party.assurance_tier ?? "-"})${entity}`,
      );
    }
  } else {
    lines.push("    (none)");
  }
  lines.push("");
  lines.push("  Event chain:");
  if (Array.isArray(p.events) && p.events.length) {
    for (const e of p.events) {
      const sig =
        e.signature_valid === true
          ? "  signature verified"
          : e.signature_valid === false
            ? "  signature INVALID"
            : "";
      const when = e.created_at ? `  ${e.created_at}` : "";
      lines.push(`    ${String(e.seq ?? "?").padStart(3)}  ${e.event_type ?? "?"}${when}${sig}`);
    }
  } else {
    lines.push("    (none)");
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// bootstrap - cold-start shell only (admin-provisioned, never self-serve)
// ---------------------------------------------------------------------------

function runBootstrap(argv: string[]): void {
  if (argv[0] === "--help" || argv[0] === "-h") {
    printBootstrapHelp();
    return;
  }
  console.log("");
  console.log("  Reaching a counterparty who has no ~handle yet");
  console.log("  --------------------------------------------");
  console.log("");
  console.log("  An accord needs both parties bound to a ~handle. If your");
  console.log("  counterparty is not on ~Alter yet, a cold-start accord needs a");
  console.log("  bootstrap credential that your workspace admin provisions.");
  console.log("");
  console.log("  What to do:");
  console.log("    - Ask the counterparty to run `alter login` and bind a ~handle,");
  console.log("      then begin the accord normally with");
  console.log("      `alter accord initiate --counterparty ~their-handle ...`.");
  console.log("    - If they cannot self-onboard, contact your workspace admin to");
  console.log("      provision the bootstrap path for you.");
  console.log("");
  console.log("  You never mint or paste a credential yourself. Provisioning is");
  console.log("  admin-only by design.");
  console.log("");
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(
    "Usage: alter accord <subcommand> [args]\n" +
      "\n" +
      "The ~Alter Accord: a cryptographic agreement between two bound ~handles.\n" +
      "Each side responds, then each party signs with a binding human tap.\n" +
      "\n" +
      "Subcommands:\n" +
      "  initiate                 Begin a new accord with a counterparty\n" +
      "  respond <accord_id>      Accept or counter an accord's terms\n" +
      "  sign <accord_id>         Sign an accord (two-phase human tap)\n" +
      "  status <accord_id>       Read parties, status, and event chain\n" +
      "  bootstrap                Reach a counterparty who has no ~handle yet\n" +
      "\n" +
      "Run `alter accord <subcommand> --help` for details.\n" +
      "\n" +
      "Note: signing is human-tap-only. Agent-delegated signing, enforcement,\n" +
      "and external anchors are not part of this version.\n",
  );
}

function printInitiateHelp(): void {
  console.log(
    "Usage: alter accord initiate --class <class> --counterparty ~handle \\\n" +
      "                            (--terms '<json>' | --terms-file <path>) [flags]\n" +
      "\n" +
      "Begin a new accord. You are recorded as the initiator; the\n" +
      "counterparty is added as the counterparty party.\n" +
      "\n" +
      "Required:\n" +
      "  --class <class>          unilateral | bilateral | multilateral |\n" +
      "                           statutory_single_signatory\n" +
      "  --counterparty ~handle   The counterparty's bound ~handle (--to also works)\n" +
      "  --terms '<json>'         Terms as a JSON object, or:\n" +
      "  --terms-file <path>      Read the terms JSON from a file\n" +
      "\n" +
      "Optional:\n" +
      "  --legal-entity <id>      Entity id if you sign on behalf of an org\n" +
      "  --assurance-tier <tier>  Defaults to sovereign_to_bind\n" +
      "  --json                   Emit the raw response as JSON\n",
  );
}

function printRespondHelp(): void {
  console.log(
    "Usage: alter accord respond <accord_id> (--accept | --counter) [flags]\n" +
      "\n" +
      "Respond to an accord you are a party to.\n" +
      "\n" +
      "  --accept                 Accept the current terms\n" +
      "  --counter                Counter-propose (pass new terms below)\n" +
      "  --terms '<json>'         Counter-proposal terms as a JSON object, or:\n" +
      "  --terms-file <path>      Read the counter terms JSON from a file\n" +
      "  --json                   Emit the raw response as JSON\n",
  );
}

function printSignHelp(): void {
  console.log(
    "Usage: alter accord sign <accord_id> [--json]\n" +
      "\n" +
      "Sign an accord you are a party to. Two-phase and human-tap-only:\n" +
      "the command shows what you are signing, then asks for a real tap.\n" +
      "A decline never produces a signature.\n" +
      "\n" +
      "Signing needs an interactive terminal. It cannot be auto-confirmed\n" +
      "and cannot be delegated to an agent.\n" +
      "\n" +
      "  --json                   Emit the raw signature response as JSON\n",
  );
}

function printStatusHelp(): void {
  console.log(
    "Usage: alter accord status <accord_id> [--json]\n" +
      "\n" +
      "Read an accord's parties, status, and ordered event chain. You must\n" +
      "be a party to the accord.\n" +
      "\n" +
      "  --json                   Emit the raw response as JSON\n",
  );
}

function printBootstrapHelp(): void {
  console.log(
    "Usage: alter accord bootstrap\n" +
      "\n" +
      "Explains how to reach a counterparty who has no ~handle yet. The\n" +
      "cold-start path is provisioned by your workspace admin; you never\n" +
      "mint or paste a credential yourself.\n",
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function accord(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    printHelp();
    return;
  }
  try {
    emitSessionHeartbeat({
      sessionId: String(process.pid),
      workingOn: "alter accord",
    });
  } catch {
    /* silent - must not block command */
  }
  const rest = argv.slice(1);
  switch (sub) {
    case "initiate":
      await runInitiate(rest);
      return;
    case "respond":
      await runRespond(rest);
      return;
    case "sign":
      await runSign(rest);
      return;
    case "status":
      await runStatus(rest);
      return;
    case "bootstrap":
      runBootstrap(rest);
      return;
    default:
      console.error(`alter accord: unknown subcommand: ${sub}`);
      printHelp();
      process.exitCode = 1;
      return;
  }
}

export const __testing = {
  parseInitiateArgs,
  parseRespondArgs,
  loadTerms,
  normaliseHandle,
  signAccordFlow,
  renderStatus,
  renderAccordError,
  AccordError,
};
