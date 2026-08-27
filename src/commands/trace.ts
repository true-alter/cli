/**
/**
 * alter trace - read-side surface for the decision-trace projection,
 * computed deterministically (no model) from observed activity.
 *
 * Renders the grounded trace: identity domains accumulated from observed
 * manifestations (git commits, alter messages, consent decisions).
 *
 * Wraps `GET /api/v1/identity-events/me/trace`. L0 free - the member is
 * the subject of their own trace.
 *
 * Exposed via the `alter` interactive menu (Me > Identity trace), NOT as
 * a top-level CLI verb. The CLI command surface is frozen; reachable only
 * via the menu.
 */

import { apiCall, getSession, readStatusSnapshot } from "../auth.js";
import { confidenceTier } from "../lib/cosmetics/confidence-tier.js";
import { withLoadingCancel } from "../ui/biosMenu.js";

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

interface TraceDomain {
  label: string;
  category: string;
  confidence: number;
  evidence_count: number;
  first_seen: string;
  last_active: string;
  commit_shas?: string[];
  commit_count: number;
}

interface TraceResponse {
  member_id: string;
  generated_at: string;
  domain_count: number;
  domains: TraceDomain[];
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "-";
  const diff = Date.now() - then;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return `${Math.floor(diff / (7 * 86_400_000))}w ago`;
}

export function formatTrace(data: TraceResponse, includeShas: boolean): string {
  const lines: string[] = [];

  lines.push("");
  lines.push("Observation record - what ~Alter has observed about you");

  try {
    const gen = new Date(data.generated_at).toISOString().slice(0, 16).replace("T", " ");
    lines.push(`Generated: ${gen}  ·  ${data.domain_count} domain${data.domain_count === 1 ? "" : "s"}`);
  } catch {
    // ignore parse failure
  }

  lines.push("");

  if (data.domain_count === 0 || data.domains.length === 0) {
    // Cross-check the status snapshot: if the member has traits or earnings
    // in the snapshot, the trace endpoint is not yet projecting their data -
    // distinguish that from a member who genuinely has nothing observed.
    const snap = readStatusSnapshot();
    const hasKnownActivity =
      (snap && snap.trait_count > 0) ||
      (snap && snap.total_earned > 0) ||
      (snap && snap.transaction_count > 0);
    if (hasKnownActivity) {
      lines.push("Your connectors and traits are recorded - but this record is a");
      lines.push("different layer. It maps domains of activity from things you do");
      lines.push("over time (commits attributed to your handle, messages, consent");
      lines.push("decisions), not from your paired sources or assessment.");
      lines.push("");
      lines.push("Domains appear here once that activity is observed. Your traits");
      lines.push("and earnings remain visible in status and pair-status meanwhile.");
    } else {
      lines.push("Nothing recorded yet. Domains appear as you act through your handle");
      lines.push("over time - commits, messages, and consent decisions are observed");
      lines.push("and mapped here. Pairing connectors feeds your traits, not this record.");
    }
    lines.push("");
    return lines.join("\n");
  }

  // Sort by last_active desc (matches queries.ts pattern).
  const sorted = [...data.domains].sort(
    (a, b) => new Date(b.last_active).getTime() - new Date(a.last_active).getTime(),
  );

  // Column widths.
  const widestLabel = sorted.reduce((max, d) => Math.max(max, d.label.length), "Domain".length);
  const widestCat = sorted.reduce((max, d) => Math.max(max, Math.min(d.category.length, 4)), "Cat".length);
  const widestEvidence = sorted.reduce(
    (max, d) => Math.max(max, String(d.evidence_count).length),
    "Evidence".length,
  );
  const widestCommits = sorted.reduce(
    (max, d) => Math.max(max, String(d.commit_count).length),
    "Commits".length,
  );
  // Tier-labels-only: the Conf column shows a named tier label, never
  // a raw confidence float. Width is the widest tier label actually present.
  const widestConf = sorted.reduce(
    (max, d) => Math.max(max, confidenceTier(d.confidence).length),
    "Conf".length,
  );

  // Header.
  if (includeShas) {
    lines.push(
      "  " +
        "Domain".padEnd(widestLabel) +
        "  " +
        "Cat".padEnd(widestCat) +
        "  " +
        "Conf".padEnd(widestConf) +
        "  " +
        "Evidence".padEnd(widestEvidence) +
        "  " +
        "Commits".padEnd(widestCommits) +
        "  " +
        "Last active",
    );
    lines.push(
      "  " +
        "─".repeat(widestLabel) +
        "  " +
        "─".repeat(widestCat) +
        "  " +
        "─".repeat(widestConf) +
        "  " +
        "─".repeat(widestEvidence) +
        "  " +
        "─".repeat(widestCommits) +
        "  " +
        "─────────────",
    );
  } else {
    lines.push(
      "  " +
        "Domain".padEnd(widestLabel) +
        "  " +
        "Cat".padEnd(widestCat) +
        "  " +
        "Conf".padEnd(widestConf) +
        "  " +
        "Evidence".padEnd(widestEvidence) +
        "  " +
        "Last active",
    );
    lines.push(
      "  " +
        "─".repeat(widestLabel) +
        "  " +
        "─".repeat(widestCat) +
        "  " +
        "─".repeat(widestConf) +
        "  " +
        "─".repeat(widestEvidence) +
        "  " +
        "─────────────",
    );
  }

  // Rows.
  for (const d of sorted) {
    const label = d.label.padEnd(widestLabel);
    const cat = d.category.slice(0, 4).padEnd(widestCat);
    const conf = confidenceTier(d.confidence).padEnd(widestConf);
    const evidence = String(d.evidence_count).padEnd(widestEvidence);
    const lastActive = formatRelative(d.last_active);

    if (includeShas) {
      const commits = String(d.commit_count).padEnd(widestCommits);
      lines.push(`  ${label}  ${cat}  ${conf}  ${evidence}  ${commits}  ${lastActive}`);
    } else {
      lines.push(`  ${label}  ${cat}  ${conf}  ${evidence}  ${lastActive}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Flag parsing (mirrors queries.ts parseFlag convention)
// ---------------------------------------------------------------------------

function parseFlag(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function trace(
  args: string[] = [],
  opts: { interactive?: boolean } = {},
): Promise<void> {
  // In interactive (menu) mode, throw instead of process.exit so the
  // menu's try/catch can handle errors without killing the whole process.
  function fail(msg: string, code = 1): void {
    if (opts.interactive) throw new Error(msg);
    console.error(msg);
    process.exitCode = code;
  }

  // Reject unknown flags early so the user gets a clear error.
  const KNOWN_FLAGS = [
    "--min-confidence",
    "--limit",
    "--no-shas",
    "--help",
    "-h",
  ];
  const unknownFlags = args.filter(
    (a) =>
      a.startsWith("--") &&
      !KNOWN_FLAGS.some((k) => a === k || a.startsWith(`${k}=`)),
  );
  if (unknownFlags.length > 0) {
    fail(
      `alter trace: unknown flag(s): ${unknownFlags.join(", ")}\nUsage: trace [--min-confidence <float>] [--limit <int>] [--no-shas]`,
      2,
    );
    return;
  }

  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: trace [--min-confidence <float>] [--limit <int>] [--no-shas]\n" +
        "\n" +
        "Shows the domains of activity ~Alter has observed from your connected sources.\n" +
        "Member self-read; L0 free.\n" +
        "\n" +
        "Options:\n" +
        "  --min-confidence <f>  Only show domains at or above this confidence (0.0-1.0).\n" +
        "  --limit <n>           Max domains returned (1-500). Default 100.\n" +
        "  --no-shas             Omit commit SHA list from API; hide Commits column.\n" +
        "  --help                Show this message.\n",
    );
    return;
  }

  if (!getSession()) {
    fail("Not signed in. Run `alter login` first.");
    return;
  }

  const noShas = args.includes("--no-shas");
  const minConf = parseFlag(args, "min-confidence");
  const limit = parseFlag(args, "limit");

  const params = new URLSearchParams();

  if (minConf !== undefined) {
    const f = parseFloat(minConf);
    if (Number.isNaN(f) || f < 0.0 || f > 1.0) {
      fail("alter trace: --min-confidence must be a float between 0.0 and 1.0.", 2);
      return;
    }
    params.set("min_confidence", String(f));
  }

  if (noShas) {
    params.set("include_commit_shas", "false");
  }

  if (limit !== undefined) {
    const n = parseInt(limit, 10);
    if (Number.isNaN(n) || n < 1 || n > 500) {
      fail("alter trace: --limit must be an integer 1-500.", 2);
      return;
    }
    params.set("limit_domains", String(n));
  }

  const qs = params.toString() ? `?${params.toString()}` : "";
  const traceWait = await withLoadingCancel(
    (signal) => apiCall(`/api/v1/identity-events/me/trace${qs}`, { signal }),
    "loading trace",
  );
  if (traceWait.cancelled) return;
  const resp = traceWait.result;

  if (!resp) {
    fail("Not signed in. Run `alter login` first.");
    return;
  }

  if (resp.status === 401) {
    fail("Not signed in. Run `alter login` first.");
    return;
  }

  if (resp.status === 403) {
    let detail = "forbidden";
    try {
      const body = await resp.json() as { detail?: string };
      if (body?.detail) detail = body.detail;
    } catch {
      // ignore parse failure
    }
    fail(detail);
    return;
  }

  if (resp.status === 422) {
    let detail = "query parameter validation failed";
    try {
      const body = await resp.json() as { detail?: unknown };
      if (body?.detail) detail = JSON.stringify(body.detail);
    } catch {
      // ignore
    }
    fail(`alter trace: ${detail}`);
    return;
  }

  if (!resp.ok) {
    fail(`alter trace: ${resp.status} ${resp.statusText}`);
    return;
  }

  const data = (await resp.json().catch(() => null)) as TraceResponse | null;
  if (!data) {
    fail("alter trace: malformed response from backend.");
    return;
  }

  console.log(formatTrace(data, !noShas));
}
