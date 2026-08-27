/**
 * Ambient header - standardised template.
 *
 * Two lines:
 *
 *   line 1 (identity): `~handle`  (bare - no domain stamp, see formatIdentityLine)
 *   line 2 (state):    `⌒ {standing} · {att} attunement · ${week} this week · {n} visitors`
 *
 * The state line leads with the member's *engagement standing* - their
 * tier label (Explorer / Learner / Augmented / Deployed). That fact is
 * always present for anyone who has logged in, because the daemon cache
 * reliably carries `level` even when the richer signals (attunement,
 * earnings, visitors) are cold. Each of those richer segments is
 * appended only when its value is real; absent ones are omitted rather
 * than rendered as a bare `-`. Only when *nothing* is known - no
 * standing, no attunement, no earnings, no visitors - does the line
 * collapse to a single neutral "no signal yet". A logged-in member is
 * never "no signal": their standing is the floor.
 *
 * State sources are daemon-cached, never synchronously fetched, so
 * daemon-down is graceful rather than blocking. The contract is shared
 * across any surface that wants the same intimate identity strip; the
 * menu is the first consumer.
 *
 * The `⌒` glyph is the Golden Thread mark, reserved for intimate
 * surfaces only per the two-mark brand doctrine. Line-2 is the most
 * intimate surface in the entire CLI; this is exactly where it belongs.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readStatusSnapshot } from "../auth.js";

export const TRILL_GLYPH = "⌒";
export const EM_DASH = "-";
// The canonical public network domain. Retained as a reference constant
// (and pinned by tests against hostname leaks) - but DELIBERATELY NOT
// stamped on the line-1 handle: see formatIdentityLine.
// Do not re-introduce `~handle @ PUBLIC_DOMAIN` on the identity strip.
export const PUBLIC_DOMAIN = "truealter.com";

/**
 * Window for "current visitors". One hour matches the impedance between
 * presence-feed entries (which can persist long after a peer leaves the
 * room) and the spec's intent (current-room presence). The daemon does
 * not yet emit explicit `presence_end` events, so any peer who pinged
 * within the window is treated as still-present.
 */
export const VISITOR_WINDOW_MS = 60 * 60 * 1000;

export interface IdentityState {
  handle?: string;
  level?: string;
  attunement?: string;
  income?: string;
  label?: string;
}

/**
 * Engagement-level labels keyed by bare numeric tier. Mirrors the
 * vocabulary the backend and the runtime daemon use:
 * Explorer (L1) → Learner (L2) → Augmented (L3) → Deployed (L4).
 */
export const LEVEL_LABELS: Readonly<Record<string, string>> = {
  "1": "Explorer",
  "2": "Learner",
  "3": "Augmented",
  "4": "Deployed",
};

export interface VisitorEntry {
  sender: string;
  state: string;
  sent_at: string;
}

export interface AmbientFacts {
  standing: string;
  attunement: string;
  weekEarnings: string;
  visitors: string;
}

/**
 * One rendered fact in the state line. `value` is the data; `label` is
 * the trailing dim word ("attunement"); `prefix` is a leading dim glyph
 * ("$"). Splitting the parts lets the menu renderer brand each piece
 * (accent value, dim label) while the test formatter joins them flat -
 * a single source of truth so the styled and plain renders never drift.
 */
export interface StateSegment {
  value: string;
  label?: string;
  prefix?: string;
}

/**
 * Resolve the daemon's identity-state cache path. Honours
 * `XDG_CACHE_HOME` so ephemeral test runs can redirect via env, and
 * matches the path the runtime daemon writes.
 */
export function identityCachePath(homeDir: string = os.homedir()): string {
  const xdg = process.env.XDG_CACHE_HOME ?? path.join(homeDir, ".cache");
  return path.join(xdg, "alter", "identity.json");
}

/**
 * Resolve the daemon's presence-feed JSONL path. Honours
 * `XDG_DATA_HOME` so test runs can redirect, and matches the path
 * `alter-runtime` writes for presence broadcasts.
 */
export function presenceFeedPath(homeDir: string = os.homedir()): string {
  const xdg =
    process.env.XDG_DATA_HOME ?? path.join(homeDir, ".local", "share");
  return path.join(xdg, "alter-runtime", "presence.jsonl");
}

/**
 * Read alter-runtime's identity-state cache. Schema is the projection
 * from the runtime daemon
 * (`{ handle, level, attunement, income }`) plus the optional `label`
 * the legacy identity hook writes alongside it
 * (`"deployed"` etc). All values are stringified. Missing file or
 * malformed JSON returns an empty object - the header then falls back
 * through standing → "no signal yet", the locked graceful-render
 * contract.
 */
export function readIdentityState(
  cachePath: string = identityCachePath(),
): IdentityState {
  let raw: string;
  try {
    raw = fs.readFileSync(cachePath, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const obj = parsed as Record<string, unknown>;
  const out: IdentityState = {};
  for (const k of ["handle", "level", "attunement", "income", "label"] as const) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  return out;
}

/**
 * Read presence-feed JSONL entries with the three required fields.
 * Mirrors the lightweight reader the menu's Visitors view uses;
 * extracted here so the ambient-header counter and the Visitors view
 * share one parse path. Newest-first sort keeps `slice(0, limit)` on
 * the caller side.
 */
export function readVisitorEntries(
  feedPath: string = presenceFeedPath(),
): VisitorEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(feedPath, "utf8");
  } catch {
    return [];
  }
  const out: VisitorEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const obj = parsed as Record<string, unknown>;
    // presence.jsonl fields are handle/set_at; older builds wrote
    // sender/sent_at. Accept both so a legacy file still parses.
    const sender = obj.handle ?? obj.sender;
    const sentAt = obj.set_at ?? obj.sent_at;
    if (
      typeof sender === "string" &&
      typeof obj.state === "string" &&
      typeof sentAt === "string"
    ) {
      out.push({
        sender,
        state: obj.state,
        sent_at: sentAt,
      });
    }
  }
  out.sort((a, b) => (a.sent_at < b.sent_at ? 1 : -1));
  return out;
}

/**
 * Count distinct senders whose most recent presence-feed entry falls
 * within `VISITOR_WINDOW_MS`. Distinct-by-sender so a chatty peer
 * counts once, not once per ping.
 */
export function countRecentVisitors(
  entries: VisitorEntry[],
  now: number = Date.now(),
): number {
  const cutoff = now - VISITOR_WINDOW_MS;
  const seen = new Set<string>();
  for (const e of entries) {
    const t = new Date(e.sent_at).getTime();
    if (Number.isNaN(t)) continue;
    if (t < cutoff) continue;
    seen.add(e.sender);
  }
  return seen.size;
}

/**
 * Resolve the member's engagement standing - the tier label that anchors
 * the state line. Prefers an explicit `label` field (the legacy
 * identity hook writes `"deployed"` etc), title-casing a bare
 * lowercase value. Falls back to mapping the numeric/`Lx` `level`
 * (reliably written by the runtime daemon) through {@link LEVEL_LABELS}.
 * Returns the em-dash placeholder only when neither is present - i.e. a
 * pre-assessment member who genuinely has no tier yet.
 */
export function engagementStanding(state: IdentityState): string {
  const label = state.label?.trim();
  if (label) {
    return label.charAt(0).toUpperCase() + label.slice(1);
  }
  const level = state.level?.trim();
  if (level) {
    const tier = level.replace(/^[Ll]/, "");
    if (LEVEL_LABELS[tier]) return LEVEL_LABELS[tier];
  }
  return EM_DASH;
}

/**
 * Resolve the locked facts to display, applying the em-dash graceful-
 * render contract. Pure: caller passes the already-read state + visitor
 * count; returns plain strings so styling lives entirely in the renderer
 * (keeps the formatter testable without ANSI codes).
 *
 * `standing` is the always-present anchor (see {@link engagementStanding}).
 *
 * `attunement` prefers the status snapshot's numeric fraction (0-1, from
 * `alter status`) rendered as a percentage, because the runtime daemon does
 * not reliably populate the daemon-cache `attunement` field. The daemon
 * string is the fallback when no snapshot exists yet.
 *
 * `weekEarnings` is intentionally em-dashed regardless of input - the
 * runtime currently writes lifetime `income`, not the rolling 7-day
 * figure the spec calls for. Wire-up is one extra projection key in
 * the runtime daemon once the backend exposes the rolling number; until
 * then, em-dash is honest about the missing field rather than passing
 * lifetime totals as "this week".
 */
export function resolveAmbientFacts(
  state: IdentityState,
  visitorCount: number,
): AmbientFacts {
  // Prefer the status snapshot's numeric attunement (0-1 fraction written
  // by `alter status`) over the daemon cache's pre-formatted string.
  const snap = readStatusSnapshot();
  let attunement: string = EM_DASH;
  if (snap && typeof snap.attunement === "number" && snap.attunement > 0) {
    attunement = `${Math.round(snap.attunement * 100)}%`;
  } else if (state.attunement && state.attunement.length > 0) {
    attunement = state.attunement;
  }

  return {
    standing: engagementStanding(state),
    attunement,
    weekEarnings: EM_DASH,
    visitors: visitorCount > 0 ? String(visitorCount) : EM_DASH,
  };
}

/**
 * Compose the real (non-placeholder) segments of the state line in
 * display order: standing → attunement → earnings → visitors. Absent
 * facts (em-dash) are omitted entirely rather than rendered as a bare
 * `-`, so the line reads cleanly at any level of coldness. The single
 * shared composer is consumed by both {@link formatStateLine} (flat,
 * for tests) and `menu.ts:renderHeader` (branded), keeping the two
 * renders structurally identical.
 */
export function composeStateSegments(facts: AmbientFacts): StateSegment[] {
  const segments: StateSegment[] = [];
  if (facts.standing !== EM_DASH) {
    segments.push({ value: facts.standing });
  }
  if (facts.attunement !== EM_DASH) {
    segments.push({ value: facts.attunement, label: "attunement" });
  }
  if (facts.weekEarnings !== EM_DASH) {
    segments.push({ value: facts.weekEarnings, prefix: "$", label: "this week" });
  }
  if (facts.visitors !== EM_DASH) {
    segments.push({ value: facts.visitors, label: "visitors" });
  }
  return segments;
}

/** Render a single segment to its flat (un-branded) string form. */
export function flattenSegment(seg: StateSegment): string {
  return (
    (seg.prefix ?? "") +
    seg.value +
    (seg.label ? ` ${seg.label}` : "")
  );
}

/**
 * The neutral state-line text shown when nothing at all is known about
 * the member - no standing, no attunement, no earnings, no visitors.
 */
export const NO_SIGNAL_TEXT = "no signal yet";

/**
 * Format the line-2 state strip without ANSI codes. The renderer
 * (`menu.ts:renderHeader`) wraps each segment in `brand` colours; this
 * function captures the visual structure exactly - same composer, same
 * "no signal yet" fallback - so tests pin the real shape without colour
 * noise.
 */
export function formatStateLine(facts: AmbientFacts): string {
  const segments = composeStateSegments(facts);
  if (segments.length === 0) {
    return `${TRILL_GLYPH} ${NO_SIGNAL_TEXT}`;
  }
  return `${TRILL_GLYPH} ` + segments.map(flattenSegment).join("  ·  ");
}

/**
 * The public-presence open-qualifier.
 *
 * When (and only when) the member's own state is `open`, the ambient
 * header distinguishes WHO the open sign faces:
 *
 *   - public-presence capability ON   →  "open to the street"
 *                                          (verified strangers can read the
 *                                           open-or-closed bit - the shop-
 *                                           front sign)
 *   - public-presence capability OFF  →  "open to peers"
 *                                          (only granted peers see it; the
 *                                           default-closed floor)
 *
 * For any non-open own-state - `here`, `focus`, `quiet`, or unknown -
 * this returns `null` and the header shows no qualifier: those states
 * never reach a stranger and the "to the street / to peers" framing is
 * meaningless for them. Pure: the caller passes the already-read public-
 * enabled flag and own-state, so this never touches disk.
 */
export const OPEN_TO_STREET = "open to the street";
export const OPEN_TO_PEERS = "open to peers";

export function openPresenceQualifier(
  publicEnabled: boolean,
  ownState: string | null,
): string | null {
  if (ownState !== "open") return null;
  return publicEnabled ? OPEN_TO_STREET : OPEN_TO_PEERS;
}

/**
 * Format the line-1 identity strip without ANSI codes - the sovereign
 * `~handle`, alone.
 *
 * No `@ domain` suffix. `truealter.com` is the
 * commercial reference implementation - the "bank" - not a namespace the
 * handle belongs to; the neutral-rails positioning frames members as
 * sovereign identities that *use* ALTER, never as "truealter.com users".
 * The `~` and `@` marks answer different questions and stay
 * separate, and per the handle spec `@domain` is an *optional resolution
 * qualifier*, not an ownership stamp. A bare `~handle` is the first-class,
 * launch-correct form; any future suffix is sovereign/context-derived
 * (e.g. `<handle>.alter.id`), never the commercial domain. The renderer
 * applies the brand handle-accent colour.
 */
export function formatIdentityLine(handle: string): string {
  return handle;
}
