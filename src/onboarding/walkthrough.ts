/**
 * The guided walkthrough - a durable, teaching-first onboarding arc with a
 * live tutorial query against a bounded allowance.
 *
 * Rides the same pipe as next-best-action.ts: an additive field on the
 * `GET /api/v1/me/connections/status` response, returned only when the
 * caller passes `include_walkthrough=true`. The backend renders the whole
 * current step server-side (concept, why-you, the exact next move, and the
 * map of every rung beneath it) - this module's job is to parse that
 * defensively, then print it, never to reconstruct the teaching copy
 * client-side.
 *
 * Defensive by construction, same contract as next-best-action.ts: the
 * field is optional on the wire and degrades to null on any backend
 * failure (older backend, resolver exception, consent gate). Every caller
 * treats null as "nothing to show" and falls back to its prior behaviour -
 * absence is the normal case here, never an error.
 */

import { indented } from "./render.js";

/** One rung of the walk, mirroring the backend `Rung` shape. */
export interface WalkRung {
  id: string;
  title: string;
  concept: string;
  why_you: string;
  call: string | null;
}

/** The whole walk's progress - how far in, and whether the arc is done. */
export interface WalkProgress {
  completed: number;
  total: number;
  current_rung: string;
  complete: boolean;
}

/** The canonical guided-walkthrough projection for the member. */
export interface Walkthrough {
  current: WalkRung;
  /**
   * The current rung, pre-rendered server-side: title, concept, why-you,
   * the exact next move, and the map of every rung ("Where you are:").
   * Printed verbatim - the CLI never rebuilds this copy.
   */
  rendered: string;
  progress: WalkProgress;
}

// ---------------------------------------------------------------------------
// Defensive parse
// ---------------------------------------------------------------------------

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asNullableString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asCount(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
}

/**
 * Parse one rung defensively. Returns null when the object cannot yield a
 * usable title - the one field the render relies on to be worth showing.
 * Missing optional fields degrade to empty strings, matching
 * next-best-action.ts's `parseAction`.
 */
function parseRung(raw: unknown): WalkRung | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const title = asString(o.title);
  if (title.length === 0) return null;
  return {
    id: asString(o.id),
    title,
    concept: asString(o.concept),
    why_you: asString(o.why_you),
    call: asNullableString(o.call),
  };
}

/** Malformed or absent progress degrades to a zeroed, incomplete map rather
 *  than failing the whole parse - the rendered body still stands on its
 *  own without it. */
function parseProgress(raw: unknown, fallbackRungId: string): WalkProgress {
  if (typeof raw !== "object" || raw === null) {
    return { completed: 0, total: 0, current_rung: fallbackRungId, complete: false };
  }
  const o = raw as Record<string, unknown>;
  return {
    completed: asCount(o.completed),
    total: asCount(o.total),
    current_rung: asString(o.current_rung) || fallbackRungId,
    complete: o.complete === true,
  };
}

/**
 * Validate and normalise a raw `walkthrough` payload. Returns null when the
 * payload is absent or too malformed to render (no usable current rung, or
 * no rendered body) - the single tolerance gate every caller relies on,
 * matching `parseNextBestAction`'s contract.
 */
export function parseWalkthrough(raw: unknown): Walkthrough | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;

  const current = parseRung(o.current);
  const rendered = asString(o.rendered);
  if (!current || rendered.length === 0) return null;

  return {
    current,
    rendered,
    progress: parseProgress(o.progress, current.id),
  };
}

// ---------------------------------------------------------------------------
// Render - `alter status` (the full block)
// ---------------------------------------------------------------------------

/** "step 2 of 6", or "" when the map carries no countable rungs. */
export function walkStepLabel(progress: WalkProgress): string {
  if (progress.total <= 0) return "";
  const step = Math.min(progress.completed + 1, progress.total);
  return `step ${step} of ${progress.total}`;
}

/**
 * Render the guided-walkthrough block. One small labelled section matching
 * the `alter status` section style (label + rule + body), with the body
 * verbatim from the server's `rendered` string - it already carries the
 * concept, the why-you, the exact next move, and the map beneath it.
 */
export function renderWalkthroughBlock(walk: Walkthrough): void {
  const step = walkStepLabel(walk.progress);
  indented("");
  indented("Guided walk" + (step ? `  ·  ${step}` : ""));
  indented("-----------");
  for (const line of walk.rendered.split("\n")) {
    indented(line);
  }
  indented("");
}

// ---------------------------------------------------------------------------
// Snapshot fields - carries a compact progress reading into StatusSnapshot
// so the menu header can show a step teaser with ZERO extra network on its
// synchronous render path, the same contract every other header segment
// (attunement / queries / $earned) already honours.
// ---------------------------------------------------------------------------

/** The subset of `StatusSnapshot` this module writes and reads. Kept as a
 *  narrow structural type rather than importing `StatusSnapshot` itself, so
 *  this module has no dependency on auth.ts. */
export interface WalkSnapshotFields {
  walk_completed?: number;
  walk_total?: number;
}

/** Fields to fold into the `StatusSnapshot` object a caller is about to
 *  pass to `writeStatusSnapshot`. Empty when there is nothing to carry
 *  (no walkthrough this run), which also clears the fields on read since
 *  `readStatusSnapshot` treats a missing pair as absent - a completed or
 *  no-longer-offered walk stops teasing in the header on the very next
 *  `alter status` run. */
export function walkthroughSnapshotFields(
  walk: Walkthrough | null,
): WalkSnapshotFields {
  if (!walk) return {};
  return {
    walk_completed: walk.progress.completed,
    walk_total: walk.progress.total,
  };
}

// ---------------------------------------------------------------------------
// Render - `alter menu` header teaser (one segment, cached-snapshot only)
// ---------------------------------------------------------------------------

/**
 * The one-line header teaser, e.g. "guided walk: step 2 of 6". Null when
 * there is nothing to carry the segment (no snapshot yet, malformed pair)
 * or when the countable arc is already complete - the header goes quiet
 * once there is nothing left to nudge toward; the full block on
 * `alter status` still renders the walk's terminal "explore" rung for
 * anyone who goes looking.
 */
export function walkthroughHeaderTeaser(fields: WalkSnapshotFields): string | null {
  const { walk_completed, walk_total } = fields;
  if (typeof walk_completed !== "number" || typeof walk_total !== "number") return null;
  if (walk_total <= 0) return null;
  if (walk_completed >= walk_total) return null;
  const step = Math.min(walk_completed + 1, walk_total);
  return `guided walk: step ${step} of ${walk_total}`;
}
