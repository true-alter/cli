/**
 * alter style - your cognitive and communication style profile.
 *
 * Wraps `GET /api/v1/members/me/style`. Returns the five-category
 * trait tier dict + archetype + family + assignment
 * confidence. Member self-read; no payment.
 *
 * Distinct from `alter portfolio` (portfolio.ts): style answers "HOW do
 * I think and communicate"; portfolio answers "what has been assessed
 * and attested about me". `alter style` renders the style-only view
 * (renderStyle) and does NOT print the portfolio's data-completeness /
 * verified-record framing. Only the consolidated menu entry
 * (identityProfile) shows both views together.
 *
 * Name the GAP, never the distance: this renderer
 * MUST NOT print percentages, distance-to-next-tier, or progress
 * bars. The producer never returns those fields; the renderer never
 * computes them. If something looks like it's missing from the
 * output, that's deliberate.
 *
 * The exported surface (style, formatStyle, D_FC11_FORBIDDEN) is
 * preserved so nothing else breaks.
 */

import { apiCall, failNotLoggedIn, getSession } from "../auth.js";
import { emitSessionHeartbeat } from "../lib/active-sessions-emit.js";
import { renderStyle } from "./portfolio.js";

interface StyleResponse {
  member_pseudonym?: string;
  style_profile?: Record<string, string>;
  archetype?: string | null;
  archetype_family?: string | null;
  confidence?: number | null;
  phase?: string | null;
  status?: string;
  message?: string;
  [key: string]: unknown;
}

const ENDPOINT = "/api/v1/members/me/style";

// Unit-test seam: the substrings below MUST NOT appear in
// the pretty output for any input. The unit suite asserts this, so
// keep the renderer free of the family.
export const D_FC11_FORBIDDEN = [
  "%",
  "progress",
  "until",
  "to next",
  "to_next",
  "distance",
  "percent",
] as const;

function printHelp(): void {
  console.log(
    "Usage: alter style [--json]\n" +
      "\n" +
      "Your cognitive and communication style: archetype, archetype family,\n" +
      "assignment confidence, and your style tiers - how you think and communicate.\n" +
      "\n" +
      "For your verified record and trait portfolio, see 'alter portfolio'.\n" +
      "\n" +
      "Options:\n" +
      "  --json     Emit the raw response as JSON for scripting.\n" +
      "  --help     Show this message.\n",
  );
}

/**
 * formatStyle is preserved as an exported symbol for callers that depend on it.
 * It renders the style-only view via renderStyle and returns it as a string.
 *
 * Forbidden substrings must not appear in output. confidenceTier()
 * maps the raw float to a tier label; no raw numbers, no percentages.
 */
export function formatStyle(data: StyleResponse): string {
  // Capture console.log output into a buffer so we can return a string.
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  try {
    renderStyle(data);
  } finally {
    console.log = origLog;
  }
  return lines.join("\n");
}

export async function style(args: string[] = []): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  try {
    emitSessionHeartbeat({
      sessionId: String(process.pid),
      workingOn: "alter style",
    });
  } catch { /* silent - must not block command */ }

  if (!getSession()) {
    failNotLoggedIn();
    return;
  }

  const json = args.includes("--json");

  const resp = await apiCall(ENDPOINT).catch(() => null);

  let data: StyleResponse | null = null;
  if (resp && resp.ok) {
    data = (await resp.json().catch(() => null)) as StyleResponse | null;
  } else if (resp && (resp.status === 401 || resp.status === 403)) {
    console.error("alter: session not authenticated. Run 'alter login'.");
    process.exitCode = 1;
    return;
  }

  if (!data) {
    const statusLine = resp ? `${resp.status} ${resp.statusText}` : "no response";
    console.error(`alter: could not fetch style profile (${statusLine}).`);
    process.exitCode = 1;
    return;
  }

  if (json) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    return;
  }

  renderStyle(data);
}
