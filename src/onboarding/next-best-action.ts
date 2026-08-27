/**
 * The canonical "what next" surface for the CLI.
 *
 * Parses and renders the backend's canonical next-best-action projection
 * (one lifecycle-aware resolver: setup -> deepening -> steady). It is the one
 * block members see after `alter login` on every path and beneath `alter
 * status`. The projection answers both "what next" (finish setting up) and
 * "stay known" (keep manifesting), so a member is never left with an empty
 * next step.
 *
 * No fetch of its own: the projection rides the `next_best_action` field on
 * the `GET /api/v1/me/connections/status` response that both the login
 * recognition read (onboarding/beats.ts) and `alter status` already fetch, so
 * callers pass the field they already have in hand rather than paying a
 * second round-trip.
 *
 * Defensive by construction. The field is optional on the wire: a backend
 * that has not attached it yields `null` from {@link parseNextBestAction} and
 * every caller falls back to its prior behaviour. The parse tolerates a
 * partial or malformed projection and the render never crashes on it.
 */

import { indented, indentedDim } from "./render.js";

/** A single actionable next step, mirroring the backend Action shape. */
export interface NbaAction {
  id: string;
  label: string;
  why: string;
  how: string;
  unlocks: string;
}

/** The canonical next-best-action projection for the member. */
export interface NextBestAction {
  /** "setup" | "deepening" | "steady" (kept open for forward compatibility). */
  phase: string;
  /** Known-ness band prose, e.g. "Well known" | "Emerging" | "Faint". */
  headline: string;
  /** Steps-done fraction, 0-100. */
  completeness_pct: number;
  /** The single highest-value next step. Never null when the projection is present. */
  primary_action: NbaAction;
  /** The full ordered set including the primary. */
  actions: NbaAction[];
  /** Ongoing "stay known" hints, or null. */
  ongoing: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Defensive parse
// ---------------------------------------------------------------------------

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Parse one action defensively. Returns null when the object cannot yield a
 * usable label AND a usable next move (`how`) - the two fields the render
 * relies on. Missing optional fields degrade to empty strings.
 */
function parseAction(raw: unknown): NbaAction | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const label = asString(o.label);
  const how = asString(o.how);
  if (label.length === 0 || how.length === 0) return null;
  return {
    id: asString(o.id),
    label,
    why: asString(o.why),
    how,
    unlocks: asString(o.unlocks),
  };
}

function clampPct(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0;
  return Math.max(0, Math.min(100, n));
}

/**
 * Validate and normalise a raw `next_best_action` payload. Returns null when
 * the payload is absent or too malformed to render (no usable headline or no
 * usable primary action). This is the single tolerance gate: every caller
 * treats null as "older backend, fall back".
 */
export function parseNextBestAction(raw: unknown): NextBestAction | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;

  const primary = parseAction(o.primary_action);
  const headline = asString(o.headline);
  if (!primary || headline.length === 0) return null;

  const actions = Array.isArray(o.actions)
    ? o.actions.map(parseAction).filter((a): a is NbaAction => a !== null)
    : [];

  const phase = asString(o.phase) || "setup";
  const ongoing =
    typeof o.ongoing === "object" && o.ongoing !== null
      ? (o.ongoing as Record<string, unknown>)
      : null;

  return {
    phase,
    headline,
    completeness_pct: clampPct(o.completeness_pct),
    primary_action: primary,
    actions: actions.length > 0 ? actions : [primary],
    ongoing,
  };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/**
 * The three content strings of the block, pure over the projection so the
 * copy stays testable with no network or console dependency.
 *
 *   header  known-ness band, plus the setup fraction while it is below 100%.
 *   label   the single primary next step.
 *   how     the exact move that takes it (a CLI command or tool call).
 */
export function whatNextLines(nba: NextBestAction): {
  header: string;
  label: string;
  how: string;
} {
  const pct = clampPct(nba.completeness_pct);
  const header =
    pct < 100 ? `${nba.headline}  ·  setup ${pct}%` : nba.headline;
  return {
    header,
    label: nba.primary_action.label,
    how: nba.primary_action.how,
  };
}

/**
 * Render the "what next" block. One small, labelled section matching the
 * `alter status` section style (label + rule + rows). Terse by design: the
 * known-ness header, the single next step, and the exact move.
 */
export function renderWhatNext(nba: NextBestAction): void {
  const { header, label, how } = whatNextLines(nba);
  indented("");
  indented("What next");
  indented("---------");
  indented(header);
  indented(label);
  indentedDim(`  ${how}`);
  indented("");
}
