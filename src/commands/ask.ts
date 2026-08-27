/**
 * alter ask - query the identity field by situation, not by name.
 *
 * The companion to `alter verify` (point lookup of a *known* subject). Where
 * verify answers "is this person registered?", `alter ask` answers an *open*
 * question against the field: "who fits this need?" - the moving-house,
 * find-a-collaborator, hiring-a-lead shape, where you are NOT naming anyone.
 *
 * Alter runs no model. The natural-language layer is your own AI agent
 * (Copilot / ChatGPT / Claude), which already speaks MCP: you ask your
 * assistant in plain words and it calls ALTER's structured `query_field` tool.
 * At the bare terminal there is no model to interpret prose, so this command
 * takes a STRUCTURED profile - weighted trait emphasis + an optional context:
 *
 *     alter ask --trait integrity_trust:0.4 --trait adaptability:0.3 \
 *               --context co_living --top 5
 *
 * Results are tier labels + a short narrative over the OPTED-IN field - never
 * numeric scores, never raw identifiers. The field is default-closed: only
 * members who chose to be discoverable (`alter discover` / the visibility
 * surface) are searchable, so an empty result is indistinguishable from "no
 * match".
 *
 * Wraps `POST /api/v1/identity/field`. Requires `alter login`. Dormant until
 * the backend `feature_field_query` flag is enabled - until then the server
 * answers 501 and this command says so plainly.
 */

import { apiCall, failNotLoggedIn, getSession } from "../auth.js";
import { confirmYesNo } from "../ui/picker.js";
import { fetchLivePricing } from "../lib/pricing-reference.js";

export interface FieldMatch {
  rank: number;
  display: string;
  tier: string;
  narrative: string;
}

export interface FieldQueryResponse {
  results?: FieldMatch[];
  count?: number;
  detail?: string;
}

export const FIELD_QUERY_ENDPOINT = "/api/v1/identity/field";
const ENDPOINT = FIELD_QUERY_ENDPOINT;

/**
 * Outcome of a field query attempt, distinguishing the transport/status
 * cases the caller must surface differently. The interactive menu flow and
 * the `alter ask` command both consume this so the 501-dormant, auth, and
 * rate-limit handling stays in one place.
 */
export type FieldQueryOutcome =
  | { kind: "ok"; data: FieldQueryResponse }
  | { kind: "unreachable" }
  | { kind: "dormant" } // 501 - feature_field_query off server-side
  | { kind: "bad-request"; detail: string }
  | { kind: "unauthorized" }
  | { kind: "rate-limited" }
  | { kind: "error"; status: number; statusText: string };

/**
 * Run a single field query against POST /api/v1/identity/field and classify
 * the result. Shared by `alter ask` (non-interactive) and the interactive
 * menu flow so the request body shape and status handling never drift.
 *
 * The caller is responsible for auth pre-checks, the cost confirmation, and
 * rendering. This helper only performs the call and maps the response to a
 * FieldQueryOutcome.
 */
export async function runFieldQuery(
  traitPriorities: Record<string, number>,
  context: string | null,
  topK: number | null,
  signal?: AbortSignal,
): Promise<FieldQueryOutcome> {
  const body: Record<string, unknown> = {
    trait_priorities: traitPriorities,
  };
  if (context) body.context = context;
  if (topK) body.top_k = topK;

  const resp = await apiCall(ENDPOINT, { method: "POST", body, signal });
  if (!resp) return { kind: "unreachable" };
  if (resp.status === 501) return { kind: "dormant" };
  if (resp.status === 400) {
    const b = (await resp.json().catch(() => ({}))) as { detail?: string };
    return { kind: "bad-request", detail: b.detail ?? "bad request" };
  }
  if (resp.status === 401 || resp.status === 403) return { kind: "unauthorized" };
  if (resp.status === 429) return { kind: "rate-limited" };
  if (resp.status >= 500) {
    return { kind: "error", status: resp.status, statusText: resp.statusText };
  }
  if (!resp.ok) {
    return { kind: "error", status: resp.status, statusText: resp.statusText };
  }
  const data = (await resp.json().catch(() => null)) as FieldQueryResponse | null;
  if (!data) {
    return { kind: "error", status: resp.status, statusText: "malformed response" };
  }
  return { kind: "ok", data };
}

function printHelp(): void {
  console.log(
    "Usage: alter ask --trait <code>:<weight> [--trait ...] [--context <c>]\n" +
      "                 [--top <n>] [--json]\n" +
      "\n" +
      "Query the identity field by situation, not by name. You describe the\n" +
      "shape of who you're looking for as a weighted trait profile; Alter\n" +
      "ranks the opted-in field and returns tier labels + a short narrative.\n" +
      "Numeric scores are never exposed.\n" +
      "\n" +
      "The native way to ask is through your own AI assistant - it turns your\n" +
      "words into this query and calls Alter for you. This terminal form is\n" +
      "the structured escape hatch.\n" +
      "\n" +
      "Flags:\n" +
      "  --trait <code>:<weight>   Emphasised trait and its weight (0-1).\n" +
      "                            Repeatable. At least one required.\n" +
      "  --context <label>         Optional discovery context (e.g. co_living).\n" +
      "  --top <n>                 Max results (default 5, max 20).\n" +
      "  --json                    Emit the raw response as JSON.\n" +
      "  --yes, -y                 Skip the cost confirmation (for scripting).\n" +
      "  --help                    Show this message.\n" +
      "\n" +
      "Example:\n" +
      "  alter ask --trait integrity_trust:0.4 --trait adaptability:0.3 \\\n" +
      "            --context co_living --top 5\n" +
      "\n" +
      "Cost: a field query is the L5 tool - $1.00 USD per call, charged whether\n" +
      "or not anyone surfaces. You'll be asked to confirm before any query runs;\n" +
      "pass --yes to skip the prompt.\n" +
      "\n" +
      "Requires a signed-in session - run 'alter login' first. The field is\n" +
      "default-closed: only members who opted into discovery are searchable.\n",
  );
}

interface ParsedArgs {
  traitPriorities: Record<string, number>;
  context: string | null;
  topK: number | null;
  json: boolean;
  yes: boolean;
}

/** Parse repeatable --trait code:weight flags plus --context/--top/--json. */
function parseArgs(args: string[]): ParsedArgs {
  const traitPriorities: Record<string, number> = {};
  let context: string | null = null;
  let topK: number | null = null;
  let json = false;
  let yes = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") {
      json = true;
    } else if (a === "--yes" || a === "-y") {
      yes = true;
    } else if (a === "--field") {
      // accepted no-op: field mode is the only mode this command serves
      continue;
    } else if (a === "--trait") {
      const spec = args[++i];
      if (!spec) throw new Error("--trait requires <code>:<weight>");
      const idx = spec.lastIndexOf(":");
      if (idx <= 0) throw new Error(`malformed --trait '${spec}', expected code:weight`);
      const code = spec.slice(0, idx);
      const weight = Number(spec.slice(idx + 1));
      if (!Number.isFinite(weight)) {
        throw new Error(`--trait weight for '${code}' is not a number`);
      }
      traitPriorities[code] = weight;
    } else if (a === "--context") {
      context = args[++i] ?? null;
      if (!context) throw new Error("--context requires a value");
    } else if (a === "--top") {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error("--top requires a positive integer");
      topK = n;
    } else {
      throw new Error(`unknown flag: ${a}`);
    }
  }
  return { traitPriorities, context, topK, json, yes };
}


/**
 * One line of stdin for a y/N confirmation. Resolves true on 'y'/'yes'.
 * In a non-interactive context (no TTY) the prompt can't be answered, so
 * it resolves false and the caller must pass --yes to proceed.
 */
async function askConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error(
      `${question} (no TTY - pass --yes to confirm a paid query.)`,
    );
    return false;
  }
  // Esc-aware confirm: a raw `stdin.once("data")` in cooked mode left Esc a
  // dead key from the menu (the prompt trapped the user at [y/N] until n+Enter
  // or Ctrl-C). confirmYesNo reads keys directly so Esc cancels.
  const answer = await confirmYesNo({ message: question, initialValue: false });
  return answer === true; // Esc→null and No both → false; Enter defaults No, matching [y/N]
}

export function prettyPrint(data: FieldQueryResponse): void {
  const results = data.results ?? [];
  console.log("");
  if (results.length === 0) {
    console.log("  No opted-in identities match this profile.");
    console.log("  The field is default-closed - only members who chose to be");
    console.log("  discoverable are searchable.");
    console.log("");
    return;
  }
  console.log(
    results.length === 1
      ? "  Field match"
      : `  Top ${results.length} field matches`,
  );
  console.log("  ===========================");
  console.log("");
  for (const m of results) {
    console.log(`  ${m.rank}. [${m.tier}] ${m.display}`);
    console.log(`     ${m.narrative}`);
    console.log("");
  }
}

export async function ask(args: string[] = []): Promise<void> {
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    printHelp();
    return;
  }

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (e) {
    console.error(`alter ask: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }

  if (Object.keys(parsed.traitPriorities).length === 0) {
    console.error(
      "alter ask: at least one --trait <code>:<weight> is required.\n" +
        "Run 'alter ask --help' for usage, or ask your AI assistant to query\n" +
        "the field for you - it fills the trait profile from your words.",
    );
    process.exitCode = 1;
    return;
  }

  if (!getSession()) {
    failNotLoggedIn();
    return;
  }

  // Cost banner: a field query is the L5 tool. Fetch the live price so the
  // figure is always accurate; fall back to the reference constant if the
  // endpoint is unreachable, and mark the figure as indicative in that case.
  // `--yes` (or `-y`) skips the prompt for scripting; `--json` output is for
  // machine consumers who likewise pre-consent with `--yes`. The cost is
  // transparent, never buried.
  const pricing = await fetchLivePricing();
  if (!parsed.yes) {
    const priceStr = `$${pricing.queryFieldPrice.toFixed(2)}`;
    const indicator = pricing.live ? "" : " (reference rate, field unreachable)";
    console.log("");
    console.log(
      `  This identity-field query costs ${priceStr} (L5) per call.${indicator}`,
    );
    console.log(
      "  You're charged whether or not anyone surfaces. Pass --yes to skip",
    );
    console.log("  this prompt in scripts.");
    console.log("");
    const confirmed = await askConfirm("  Continue?");
    if (!confirmed) {
      console.log("  Cancelled - no query was made, nothing was charged.");
      console.log("");
      return;
    }
  }

  const outcome = await runFieldQuery(
    parsed.traitPriorities,
    parsed.context,
    parsed.topK,
  );
  switch (outcome.kind) {
    case "unreachable":
      console.error("alter ask: could not reach the identity field.");
      process.exitCode = 1;
      return;
    case "dormant":
      console.error(
        "alter ask: the field query isn't enabled yet (feature_field_query is\n" +
          "off server-side). The query was validated but no field was read.",
      );
      process.exitCode = 1;
      return;
    case "bad-request":
      console.error(`alter ask: ${outcome.detail}`);
      process.exitCode = 1;
      return;
    case "unauthorized":
      console.error(
        "alter ask: session expired or unauthorized. Run 'alter login' to re-authenticate.",
      );
      process.exitCode = 1;
      return;
    case "rate-limited":
      console.error(
        "alter ask: rate limit reached. Repeated narrow queries are throttled - try again later.",
      );
      process.exitCode = 1;
      return;
    case "error":
      if (outcome.status >= 500) {
        console.error(`alter ask: server error (${outcome.status} ${outcome.statusText}).`);
      } else if (outcome.statusText === "malformed response") {
        console.error("alter ask: malformed response from backend.");
      } else {
        console.error(`alter ask: query failed (${outcome.status} ${outcome.statusText}).`);
      }
      process.exitCode = 1;
      return;
    case "ok":
      if (parsed.json) {
        process.stdout.write(JSON.stringify(outcome.data, null, 2) + "\n");
        return;
      }
      prettyPrint(outcome.data);
  }
}
