/**
 * alter queries - your audit log of x402 queries hit on you.
 *
 * Wraps `GET /api/v1/members/me/queries`. Returns a chronologically
 * ordered list of queriers - individual members, agents, or orgs - that
 * have accessed your identity data, what they paid, and what you earned.
 *
 * L0 free - the member is the subject of their own audit.
 *
 * Pagination is cursor-based with HMAC-signed cursors; tampered
 * cursors return 400. The `--cursor` flag accepts the
 * `pagination.next_cursor` from a previous response.
 */

import {
  apiCall,
  failNotLoggedIn,
  getSession,
  NOT_LOGGED_IN_MESSAGE,
} from "../auth.js";
import { emitSessionHeartbeat } from "../lib/active-sessions-emit.js";
import { withLoadingCancel } from "../ui/biosMenu.js";

interface QueryRow {
  id?: string;
  queried_at?: string | null;
  org_pseudonym?: string;
  org_id?: string;
  data_type?: string;
  price_display?: string;
  your_earning_display?: string;
  your_earning_cents?: number;
  currency?: string;
  status?: string;
  purpose_code?: string | null;
  settled_at?: string | null;
}

interface QueriesResponse {
  data?: QueryRow[];
  pagination?: {
    next_cursor?: string | null;
    has_more?: boolean;
    limit?: number;
  };
  window?: { start?: string; end?: string };
  summary?: {
    queries_in_window?: number;
    total_earned_in_window_cents?: number;
    total_earned_in_window_display?: string;
    unique_orgs_in_window?: number;
  };
}

const ENDPOINT_BASE = "/api/v1/members/me/queries";

// Forbidden substrings - neither the producer nor the renderer should
// imply tier rankings or scoring of queriers.
export const D_QUERIES_FORBIDDEN = [
  "ranked",
  "best org",
  "score",
  "predicted",
] as const;

function printHelp(): void {
  console.log(
    "Usage: alter queries [--window=<days>] [--since=<iso>] [--limit=<n>] [--cursor=<c>] [--json]\n" +
      "\n" +
      "Print your audit log of x402 queries: who's queried you,\n" +
      "what they paid, what you earned.\n" +
      "Member self-read; no payment, L0 free.\n" +
      "\n" +
      "Options:\n" +
      "  --window=<days>  Window length in days (1-365). Default 30.\n" +
      "  --since=<iso>    ISO8601 window-start. Overrides --window.\n" +
      "  --limit=<n>      Page size (1-100). Default 20.\n" +
      "  --cursor=<c>     Pagination cursor from a previous response.\n" +
      "  --json           Emit the raw response as JSON for scripting.\n" +
      "  --help           Show this message.\n",
  );
}

function shortDate(iso?: string | null): string {
  if (!iso) return "-";
  try {
    return new Date(iso).toISOString().slice(0, 16).replace("T", " ");
  } catch {
    return iso;
  }
}

export function formatQueries(data: QueriesResponse): string {
  const lines: string[] = [];
  const rows = data.data ?? [];
  const summary = data.summary ?? {};

  lines.push("");
  lines.push("Who's looked you up");
  if (data.window?.start && data.window?.end) {
    try {
      const s = new Date(data.window.start).toISOString().slice(0, 10);
      const e = new Date(data.window.end).toISOString().slice(0, 10);
      const days = Math.round(
        (new Date(data.window.end).getTime() -
          new Date(data.window.start).getTime()) /
          86400000,
      );
      lines.push(`Window: ${days} days (${s} → ${e})`);
    } catch {
      // ignore parse failures, keep going
    }
  }

  if (typeof summary.queries_in_window === "number") {
    const earned = summary.total_earned_in_window_display ?? "-";
    // Backend reports a single distinct-querier count and does not split
    // org vs individual askers - keep the label neutral over both.
    const queriers = summary.unique_orgs_in_window ?? 0;
    lines.push(
      `Summary: ${summary.queries_in_window} queries from ${queriers} ${
        queriers === 1 ? "querier" : "queriers"
      }, you earned ${earned}.`,
    );
  }
  lines.push("");

  if (rows.length === 0) {
    lines.push("No queries in this window yet.");
    lines.push("");
    return lines.join("\n");
  }

  // org_pseudonym is the backend's label for whoever queried you - an
  // individual member, an agent, or an org. Render it neutrally.
  const widestQuerier = rows.reduce(
    (max, r) => Math.max(max, (r.org_pseudonym ?? "-").length),
    0,
  );
  const widestType = rows.reduce(
    (max, r) => Math.max(max, (r.data_type ?? "-").length),
    0,
  );
  const widestPrice = rows.reduce(
    (max, r) => Math.max(max, (r.price_display ?? "-").length),
    0,
  );

  for (const r of rows) {
    const when = shortDate(r.queried_at);
    const querier = (r.org_pseudonym ?? "-").padEnd(widestQuerier, " ");
    const type = (r.data_type ?? "-").padEnd(widestType, " ");
    const price = (r.price_display ?? "-").padEnd(widestPrice, " ");
    const earning = r.your_earning_display ?? "-";
    const purpose = r.purpose_code ? `  [${r.purpose_code}]` : "";
    lines.push(
      `  ${when}  ${querier}  ${type}  paid ${price}  → you earned ${earning}${purpose}`,
    );
  }
  lines.push("");

  if (data.pagination?.has_more && data.pagination?.next_cursor) {
    lines.push(
      `More queries available - pass --cursor=${data.pagination.next_cursor} for the next page.`,
    );
    lines.push("");
  }

  return lines.join("\n");
}

function parseFlag(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

export async function queries(
  args: string[] = [],
  opts: { interactive?: boolean } = {},
): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  try {
    emitSessionHeartbeat({
      sessionId: String(process.pid),
      workingOn: "alter queries",
    });
  } catch { /* silent - must not block command */ }

  const fail = (message: string): void => {
    if (opts.interactive) throw new Error(message);
    console.error(message);
    process.exitCode = 1;
  };

  // Canonical logged-out guard: soft exit in CLI mode; throw in
  // interactive (menu) mode so the alt-screen survives.
  if (!getSession()) {
    if (opts.interactive) throw new Error(NOT_LOGGED_IN_MESSAGE);
    failNotLoggedIn();
    return;
  }

  const json = args.includes("--json");
  const window = parseFlag(args, "window");
  const since = parseFlag(args, "since");
  const limit = parseFlag(args, "limit");
  const cursor = parseFlag(args, "cursor");

  const params = new URLSearchParams();
  if (window) {
    const n = parseInt(window, 10);
    if (Number.isNaN(n) || n < 1 || n > 365) {
      return fail("alter queries: --window must be an integer 1-365.");
    }
    params.set("window_days", String(n));
  }
  if (since) params.set("since", since);
  if (limit) {
    const n = parseInt(limit, 10);
    if (Number.isNaN(n) || n < 1 || n > 100) {
      return fail("alter queries: --limit must be an integer 1-100.");
    }
    params.set("limit", String(n));
  }
  if (cursor) params.set("cursor", cursor);
  const qs = params.toString() ? `?${params.toString()}` : "";

  const wait = await withLoadingCancel(
    (signal) => apiCall(`${ENDPOINT_BASE}${qs}`, { signal }),
    "queries",
  );
  if (wait.cancelled) return;
  const resp = wait.result;
  if (!resp) {
    return fail("alter queries: session not authenticated. Run 'alter login'.");
  }
  if (resp.status === 401 || resp.status === 403) {
    return fail("alter queries: session not authenticated. Run 'alter login'.");
  }
  if (resp.status === 400) {
    return fail(
      "alter queries: invalid cursor or parameters. Drop --cursor and try again.",
    );
  }
  if (resp.status >= 500) {
    return fail(
      `alter queries: server error (${resp.status} ${resp.statusText}). Try again in a moment.`,
    );
  }
  if (!resp.ok) {
    return fail(
      `alter queries: could not fetch query log (${resp.status} ${resp.statusText}).`,
    );
  }

  const data = (await resp.json().catch(() => null)) as QueriesResponse | null;
  if (!data) {
    return fail("alter queries: malformed response from backend.");
  }

  if (json) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    return;
  }

  console.log(formatQueries(data));
}
