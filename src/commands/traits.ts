/**
 * alter traits - how your trait vector has evolved over time.
 *
 * Wraps `GET /api/v1/members/me/traits/history`. Returns tier-band
 * shifts between the earliest and latest assessment snapshot in a
 * window, plus a summary of how many traits grew, deepened, stayed
 * stable, or recalibrated.
 *
 * Name the GAP, never the distance: this renderer MUST NOT print
 * percentages, distance-to-next-tier, progress bars, or projections.
 * The producer never returns those fields; the renderer never computes
 * them.
 *
 * Every delta carries provenance.
 *
 * Member self-read; no payment.
 */

import {
  apiCall,
  failNotLoggedIn,
  getSession,
  NOT_LOGGED_IN_MESSAGE,
} from "../auth.js";
import { emitSessionHeartbeat } from "../lib/active-sessions-emit.js";
import { withLoadingCancel } from "../ui/biosMenu.js";

interface TraitDelta {
  trait_name: string;
  tier_then: string;
  tier_now: string;
  direction: "up" | "down" | "stable";
  confidence_then_tier?: string;
  confidence_now_tier?: string;
  confidence_deepened?: boolean;
  first_observed_at?: string | null;
  last_observed_at?: string | null;
  provenance?: string;
  compute_location?: string;
}

interface CategoricalChange {
  trait_name: string;
  primary_then?: string | null;
  primary_now?: string | null;
  secondary_then?: string[];
  secondary_now?: string[];
  present_then?: string[];
  present_now?: string[];
  latent_then?: string[];
  latent_now?: string[];
  absent_then?: string[];
  absent_now?: string[];
  direction: "shifted" | "stable";
  provenance?: string;
  compute_location?: string;
}

interface ObservationEvent {
  event_type: string;
  occurred_at?: string | null;
  title?: string;
  tool_name?: string;
  agent_id?: string | null;
  provenance: string;
  compute_location: string;
  source_id?: string | null;
}

interface Pathway {
  key: string;
  label: string;
  detail?: string;
  status?: string;
}

interface TraitsHistoryResponse {
  member_id?: string;
  window_start?: string;
  window_end?: string;
  vectors_in_window?: number;
  deltas?: TraitDelta[];
  categorical_changes?: CategoricalChange[];
  observation_events?: ObservationEvent[];
  summary?: {
    traits_growing?: number;
    traits_deepening?: number;
    traits_stable?: number;
    traits_recalibrated?: number;
  };
  phase_then?: string | null;
  phase_now?: string | null;
  status?: string;
  pathways?: Pathway[];
}

const ENDPOINT_BASE = "/api/v1/members/me/traits/history";

// Unit-test seam. The substrings below MUST NOT appear
// in the pretty output for any input.
export const D_FC11_FORBIDDEN = [
  "%",
  "progress",
  "until",
  "to next",
  "to_next",
  "distance",
  "percent",
  "predicted",
  "projection",
] as const;

function printHelp(): void {
  console.log(
    "Usage: alter traits [--window=<days>] [--since=<iso>] [--json]\n" +
      "\n" +
      "Print how your trait vector has evolved over a time window.\n" +
      "Tier-band shifts only - no numeric scores, no progress bars,\n" +
      "no projections. Member self-read; no payment.\n" +
      "\n" +
      "Options:\n" +
      "  --window=<days>  Window length in days (1-365). Default 30.\n" +
      "  --since=<iso>    ISO8601 window-start. Overrides --window.\n" +
      "  --verbose        Show provenance and compute-location tags.\n" +
      "  --json           Emit the raw response as JSON for scripting.\n" +
      "  --help           Show this message.\n",
  );
}

function arrow(direction: TraitDelta["direction"]): string {
  if (direction === "up") return "↑";
  if (direction === "down") return "↓";
  return "·";
}

function formatWindow(start?: string, end?: string): string {
  if (!start || !end) return "";
  try {
    const s = new Date(start);
    const e = new Date(end);
    const days = Math.round((e.getTime() - s.getTime()) / 86400000);
    return `${days} days (${s.toISOString().slice(0, 10)} → ${e.toISOString().slice(0, 10)})`;
  } catch {
    return `${start} → ${end}`;
  }
}

// Plain-English window phrase for the summary line, e.g. "in the last 30 days".
// Derives the day count from the window bounds; falls back to the 30-day
// default (window_days) when the server omits the timestamps.
function formatWindowDays(start?: string, end?: string): string {
  if (start && end) {
    try {
      const days = Math.round(
        (new Date(end).getTime() - new Date(start).getTime()) / 86400000,
      );
      if (days >= 1) return `in the last ${days} days`;
    } catch {
      // fall through to default
    }
  }
  return "in the last 30 days";
}

// Static fallback pathway list used when the server omits the pathways field.
// Render order matches the server default render order.
const FALLBACK_PATHWAYS: Pathway[] = [
  {
    key: "agent_query",
    label: "agents querying you",
    detail: "each priced query writes a signal back",
  },
  {
    key: "peer_recognition",
    label: "peer recognition",
    detail: "handle-to-handle, declarative",
    status: "coming_soon",
  },
  {
    key: "side_quest",
    label: "side quests",
    detail: "Discovery's optional surfaces",
  },
  { key: "assessment", label: "Discovery itself", detail: "the longest pathway, deepest signal" },
];

function provenanceTag(
  provenance?: string,
  computeLocation?: string,
  verbose = false,
): string {
  if (!verbose || !provenance) return "";
  const loc = computeLocation ? ` [${computeLocation}]` : "";
  return ` (${provenance}${loc})`;
}

export function formatTraitsHistory(data: TraitsHistoryResponse, verbose = false): string {
  const lines: string[] = [];

  if (data.status === "no_observations_in_window") {
    const pathways = data.pathways ?? FALLBACK_PATHWAYS;
    lines.push("");
    lines.push("Trait history");
    lines.push("");
    lines.push("Your traits accrue as you act, not just from Discovery.");
    lines.push("Pathways open right now:");
    for (const p of pathways) {
      const detail = p.detail ? ` (${p.detail})` : "";
      const soon = p.status === "coming_soon" ? " - coming soon" : "";
      lines.push(`  · ${p.label}${detail}${soon}`);
    }
    lines.push("");
    lines.push("Come back after any of these and the trace will start.");
    lines.push("");
    return lines.join("\n");
  }

  if (data.status === "events_only") {
    lines.push("");
    lines.push("Trait history");
    lines.push("");
    lines.push(
      "Signals recorded - no trait vector yet. Once enough evidence accumulates, tiers will appear.",
    );
    lines.push("");
    _appendObservationEvents(lines, data.observation_events ?? []);
    return lines.join("\n");
  }

  if (data.status === "single_observation") {
    lines.push("");
    lines.push("Trait history");
    lines.push("");
    lines.push(
      "One snapshot in this window - current tiers shown below; more evidence needed for movement.",
    );
    lines.push("");
  } else {
    lines.push("");
    lines.push("Trait history");
  }

  const window = formatWindow(data.window_start, data.window_end);
  if (window) lines.push(`Window: ${window}`);
  if (typeof data.vectors_in_window === "number") {
    lines.push(`Snapshots in window: ${data.vectors_in_window}`);
  }
  if (data.phase_then && data.phase_now) {
    if (data.phase_then === data.phase_now) {
      lines.push(`Phase: ${data.phase_now}`);
    } else {
      lines.push(`Phase: ${data.phase_then} → ${data.phase_now}`);
    }
  }
  lines.push("");

  const summary = data.summary;
  if (summary) {
    const parts: string[] = [];
    if (typeof summary.traits_growing === "number") {
      parts.push(`${summary.traits_growing} growing`);
    }
    if (typeof summary.traits_deepening === "number") {
      parts.push(`${summary.traits_deepening} deepening`);
    }
    if (typeof summary.traits_stable === "number") {
      parts.push(`${summary.traits_stable} stable`);
    }
    if (
      typeof summary.traits_recalibrated === "number" &&
      summary.traits_recalibrated > 0
    ) {
      parts.push(`${summary.traits_recalibrated} recalibrated`);
    }
    if (parts.length > 0) {
      const totalShifted =
        (summary.traits_growing ?? 0) +
        (summary.traits_deepening ?? 0) +
        (summary.traits_stable ?? 0) +
        (summary.traits_recalibrated ?? 0);
      const windowPhrase = formatWindowDays(data.window_start, data.window_end);
      lines.push(
        `${totalShifted} traits changed ${windowPhrase}: ${parts.join(", ")}.`,
      );
      lines.push(
        "(This counts only traits that moved - not your total on file. Run 'alter status' for the full count.)",
      );
      lines.push("");
    }
  }

  const deltas = data.deltas ?? [];
  if (deltas.length === 0) {
    lines.push("No trait deltas to report.");
    lines.push("");
    _appendObservationEvents(lines, data.observation_events ?? []);
    return lines.join("\n");
  }

  // Group: growing first (most positive), then deepening, then stable,
  // then recalibrated.
  const growing = deltas.filter((d) => d.direction === "up");
  const deepening = deltas.filter(
    (d) => d.direction === "stable" && d.confidence_deepened,
  );
  const stable = deltas.filter(
    (d) => d.direction === "stable" && !d.confidence_deepened,
  );
  const recalibrated = deltas.filter((d) => d.direction === "down");

  const widest = deltas.reduce(
    (max, d) => Math.max(max, d.trait_name.length),
    0,
  );

  function printGroup(title: string, group: TraitDelta[]): void {
    if (group.length === 0) return;
    lines.push(title);
    for (const d of group) {
      const sym = arrow(d.direction);
      const padded = d.trait_name.padEnd(widest, " ");
      const change =
        d.tier_then === d.tier_now
          ? d.tier_now
          : `${d.tier_then} → ${d.tier_now}`;
      const conf = d.confidence_now_tier
        ? `  [confidence: ${d.confidence_now_tier}]`
        : "";
      const prov = provenanceTag(d.provenance, d.compute_location, verbose);
      lines.push(`  ${sym} ${padded}  ${change}${conf}${prov}`);
    }
    lines.push("");
  }

  printGroup("Growing", growing);
  printGroup("Deepening (same tier, stronger signal)", deepening);
  printGroup("Stable", stable);
  printGroup("Recalibrated (model updated with new evidence)", recalibrated);

  const cats = data.categorical_changes ?? [];
  if (cats.length > 0) {
    lines.push("Categorical shifts");
    for (const c of cats) {
      const then = c.primary_then ?? "-";
      const now = c.primary_now ?? "-";
      const change =
        c.direction === "shifted" ? `${then} → ${now}` : `${now}`;
      const prov = provenanceTag(c.provenance, c.compute_location, verbose);
      lines.push(`  ${c.trait_name}  ${change}${prov}`);
    }
    lines.push("");
  }

  _appendObservationEvents(lines, data.observation_events ?? []);

  return lines.join("\n");
}

function _appendObservationEvents(
  lines: string[],
  events: ObservationEvent[],
): void {
  if (events.length === 0) return;
  lines.push("Other signals");
  for (const ev of events) {
    const date = ev.occurred_at
      ? new Date(ev.occurred_at).toISOString().slice(0, 10)
      : "unknown date";
    if (ev.event_type === "side_quest") {
      lines.push(`  · side quest  ${date}  ${ev.title ?? ""}`);
    } else if (ev.event_type === "agent_query") {
      const agent = ev.agent_id ? ` by ${ev.agent_id}` : "";
      lines.push(`  · agent query  ${date}  ${ev.tool_name ?? ""}${agent}`);
    } else {
      lines.push(`  · ${ev.event_type}  ${date}`);
    }
  }
  lines.push("");
}

function parseFlag(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

export async function traits(
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
      workingOn: "alter traits",
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
  const verbose = args.includes("--verbose");
  const window = parseFlag(args, "window");
  const since = parseFlag(args, "since");

  const params = new URLSearchParams();
  if (window) {
    const n = parseInt(window, 10);
    if (Number.isNaN(n) || n < 1 || n > 365) {
      return fail("alter traits: --window must be an integer 1-365.");
    }
    params.set("window_days", String(n));
  }
  if (since) params.set("since", since);
  const qs = params.toString() ? `?${params.toString()}` : "";

  const wait = await withLoadingCancel((signal) =>
    apiCall(`${ENDPOINT_BASE}${qs}`, { signal }),
  );
  if (wait.cancelled) return;
  const resp = wait.result;
  if (!resp) {
    return fail("alter traits: session not authenticated. Run 'alter login'.");
  }
  if (resp.status === 401 || resp.status === 403) {
    return fail("alter traits: session not authenticated. Run 'alter login'.");
  }
  if (resp.status >= 500) {
    return fail(
      `alter traits: server error (${resp.status} ${resp.statusText}). Try again in a moment.`,
    );
  }
  if (!resp.ok) {
    return fail(
      `alter traits: could not fetch trait history (${resp.status} ${resp.statusText}).`,
    );
  }

  const data = (await resp.json().catch(() => null)) as
    | TraitsHistoryResponse
    | null;
  if (!data) {
    return fail("alter traits: malformed response from backend.");
  }

  if (json) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    return;
  }

  console.log(formatTraitsHistory(data, verbose));
}
