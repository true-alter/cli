/**
 * Beat orchestration for the three-beat CLI onboarding experience.
 *
 * This module wraps render primitives into the two beats that bookend
 * `alter login`'s OAuth PKCE flow. Beat 2 - the naming + passkey ceremony -
 * remains inside the login command proper because it reuses the existing
 * OAuth exchange; this file owns beat 1 (Be Seen) and beat 3 (Seed Planted).
 *
 * Call order inside the login command:
 *
 *   1. `beatOne(profile, observation)` - returns `"continue" | "exit"`.
 *   2. If continue, run existing OAuth PKCE. If exit, record first-look
 *      timestamp, return cleanly, no session created. (Beat 2 lives in
 *      the login command.)
 *   3. After `storeSession` completes, call `beatThree(profile,
 *      archetype, shownObservationId)`. Beat 3 renders the recognition
 *      payoff (what Alter now holds + the one next self-query) read from
 *      the local status snapshot, and returns the next-observation pick.
 *
 * Neither beat throws. Refusal paths are values, not exceptions.
 *
 * Selector history:
 *   - Orientation field retired; beat 1 is exactly two lines.
 *   - Combos added; selector prefers any matching combo
 *     over archetype-pool pick when one or more combos match.
 *   - Student archetype retired; selector never returns it.
 *   - Fallback collapsed to a single signature line;
 *     partial-match firing handles the "no archetype fired" case via
 *     classify() returning the fallback entry.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

import type { SignalProfile } from "./signals.js";
import type { Archetype } from "./archetypes.js";
import type { ComboKey } from "./combos.js";
import { matchingCombos } from "./combos.js";

// Combos shelved at beat-1 fire-time. Six archetype observations remain
// canonical; the combo predicates and combo copy are kept in the tree but
// inactive. Selector falls back to single-signal archetype matching only.
//
// Re-enable criteria:
//   - 6 archetypes have run long enough to confirm under real-user
//     signal profiles.
//   - User-visible reason exists (measured drop-off on a specific archetype).
//   - Combo copy re-voiced.
//
// Until then: one signal, one observation, no overlap.
const FEATURE_BEAT1_COMBOS = false;
import {
  boxBlank,
  boxDivider,
  boxLine,
  closeBox,
  continueOrExitLabelInline,
  openBox,
  pauseMs,
  printBoxedPhase,
  waitContinueOrExitKeypress,
  type ContinueOrExit,
} from "./render.js";
import { apiCall, readStatusSnapshot } from "../auth.js";
import { reportPendingSuggestion } from "./next-action-report.js";
import { fetchPaired } from "../commands/discover.js";
import {
  parseNextBestAction,
  type NextBestAction,
} from "./next-best-action.js";

const ALTER_BOX_TITLE = "◇ ~alter ◇";

// Load observations.json at module init. Avoids TS import-attribute syntax,
// which requires module:nodenext - the current tsconfig emits ES2022.
const OBS_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "observations.json",
);
const observations = JSON.parse(fs.readFileSync(OBS_PATH, "utf-8"));

// ---------------------------------------------------------------------------
// Observation model (mirrors observations.json)
// ---------------------------------------------------------------------------

interface ArchetypeObservation {
  id: string;
  archetype: Archetype;
  body: string[];
}

interface ComboObservation {
  id: string;
  combo: ComboKey;
  body: string[];
}

interface ObservationsFile {
  _meta?: unknown;
  observations: ArchetypeObservation[];
  combos: ComboObservation[];
}

const OBS: ObservationsFile = observations as unknown as ObservationsFile;

// ---------------------------------------------------------------------------
// First-look trace - the ONLY thing beat 1 writes, and only on refusal
// ---------------------------------------------------------------------------

const CACHE_DIR = path.join(
  process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"),
  "alter",
);
const FIRST_LOOK_FILE = path.join(CACHE_DIR, "first-look-seen-at");

function recordFirstLook(): void {
  // Best-effort - if the cache dir is not writable, we simply leave no
  // trace. The absence of this file is not an error the user needs to see.
  if (process.env.ALTER_DRY_RUN === "1") return;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(FIRST_LOOK_FILE, new Date().toISOString() + "\n", {
      mode: 0o600,
    });
  } catch {
    // Intentional silence.
  }
}

function readFirstLook(): Date | null {
  try {
    const content = fs.readFileSync(FIRST_LOOK_FILE, "utf-8").trim();
    return new Date(content);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Observation selection
// ---------------------------------------------------------------------------

/**
 * Hash a {@link SignalProfile} to a small integer seed. Used to rotate
 * deterministically among tied observations for repeat ctrl-c'ers.
 * NOT cryptographic; NOT stable across significant profile changes.
 */
export function profileSeed(profile: SignalProfile): number {
  const surface = [
    profile.git.userEmail ?? "",
    profile.shell.shell ?? "",
    profile.shell.timezone ?? "",
    profile.signalCount.toString(),
  ].join("|");
  let h = 0;
  for (let i = 0; i < surface.length; i++) {
    h = (h * 31 + surface.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Observation shape returned to callers - unified across archetype and
 * combo observations. Callers never need to know which source a chosen
 * observation came from; they only need id + body for rendering and for
 * the return-rotation avoidId.
 */
export interface PickedObservation {
  id: string;
  body: string[];
  source: "archetype" | "combo";
}

/**
 * Pick the beat-1 observation.
 *
 * Selection order:
 *   1. If any combo matches the profile, pick a combo observation
 *      deterministically by seed. Combo observations override archetype
 *      picks because a multi-signal read is almost always richer than a
 *      single-archetype one.
 *   2. Otherwise, pick from the chosen archetype's pool.
 *   3. If the chosen archetype has no observations (shouldn't happen -
 *      every live archetype has at least one entry), fall through to the
 *      fallback signature line.
 *
 * `avoidId` lets a returning user skip the exact observation they saw
 * first time. If the candidate pool is size 1 (fallback), avoidId is
 * ignored and the same line fires again - the signature line is
 * deliberately singular.
 */
export function pickObservation(
  archetype: Archetype,
  profile: SignalProfile,
  avoidId?: string | null,
  opts?: { skipCombos?: boolean },
): PickedObservation {
  // 1. Combo preference (skip when caller asks - dry-run --all uses this
  //    to inspect archetype pools without combo override).
  //    Combos shelved at beat-1 fire-time. Caller's skipCombos still
  //    honoured for dry-run --all introspection of the dormant pool.
  const combos =
    !FEATURE_BEAT1_COMBOS || opts?.skipCombos ? [] : matchingCombos(profile);
  if (combos.length > 0) {
    const candidates = OBS.combos.filter(
      (o) => combos.includes(o.combo) && o.id !== avoidId,
    );
    const pool = candidates.length > 0
      ? candidates
      : OBS.combos.filter((o) => combos.includes(o.combo));
    if (pool.length > 0) {
      const firstLook = readFirstLook();
      const seed = profileSeed(profile) + (firstLook?.getTime() ?? 0);
      const index = seed % pool.length;
      const chosen = pool[index];
      return { id: chosen.id, body: chosen.body, source: "combo" };
    }
  }

  // 2. Archetype pool
  const candidates = OBS.observations.filter(
    (o) => o.archetype === archetype && o.id !== avoidId,
  );
  const pool = candidates.length > 0
    ? candidates
    : OBS.observations.filter((o) => o.archetype === archetype);

  if (pool.length > 0) {
    const firstLook = readFirstLook();
    const seed = profileSeed(profile) + (firstLook?.getTime() ?? 0);
    const index = seed % pool.length;
    const chosen = pool[index];
    return { id: chosen.id, body: chosen.body, source: "archetype" };
  }

  // 3. Signature-line fallback (always present in observations.json)
  const fallback = OBS.observations.find((o) => o.archetype === "fallback");
  if (fallback) {
    return { id: fallback.id, body: fallback.body, source: "archetype" };
  }

  // Defensive - should never hit. If observations.json is broken, render
  // something inoffensive rather than crashing the login flow.
  return {
    id: "emergency-fallback",
    body: ["You ran the command.", "That is the first thing."],
    source: "archetype",
  };
}

// ---------------------------------------------------------------------------
// Beat 1 - Be Seen
// ---------------------------------------------------------------------------

export interface BeatOneResult {
  decision: ContinueOrExit;
  shownObservationId: string;
}

/**
 * Render beat 1 and wait for a keypress.
 *
 * On `"exit"` the caller MUST NOT create a session, MUST NOT make any
 * network calls, and MUST return control to the shell cleanly. A single
 * timestamp is written to `~/.cache/alter/first-look-seen-at` so that a
 * future first-run for this user offers a different observation.
 *
 * Rendering: exactly two lines plus the continue prompt.
 * No orientation dim-coda line; no third sentence. The pause happens in
 * the user's head, not in the terminal.
 */
export async function beatOne(
  profile: SignalProfile,
  archetype: Archetype,
): Promise<BeatOneResult> {
  const observation = pickObservation(archetype, profile);

  // Pre-body friction: a brief silence before the box opens. The CLI is
  // not in a rush to speak. (~350ms to give the user a moment to settle.)
  await pauseMs(350);

  // Beat 1 renders as a single bounded panel: title slot carries the
  // ~alter speaker (no separate flush-left tag), body carries the
  // two-line observation, footer carries the continue/exit prompt. The
  // box is a recognition container; the intimate copy register inside is
  // unchanged from the prior flush-left rendering.
  openBox(ALTER_BOX_TITLE);
  boxBlank();
  for (const line of observation.body) {
    boxLine(line);
  }
  boxBlank();
  boxDivider();
  boxLine(continueOrExitLabelInline());
  closeBox();

  const decision = await waitContinueOrExitKeypress();

  if (decision === "exit") {
    recordFirstLook();
  }

  return { decision, shownObservationId: observation.id };
}

// ---------------------------------------------------------------------------
// Beat 3 - Seed Planted (recognition payoff)
// ---------------------------------------------------------------------------

export interface NextObservationSeed {
  /** Body of the second observation, paired against beat 1's archetype. */
  line: string;
  /** Archetype the seed was drawn against - for future re-selection. */
  drawn_from_archetype: Archetype;
  /** Seen-observation id from beat 1, so we do not repeat it. */
  prior_observation_id: string;
}

/**
 * What ~alter has read into the member at the close of login. Aggregate
 * counts only (IaI: identity is inferred from manifestation, never declared;
 * a count, never a trait name/value/score). Resolved best-effort by
 * {@link resolveRecognitionRead} from a live read, a local snapshot, or the
 * cold floor.
 */
export interface RecognitionRead {
  /** Number of paired external sources contributing signal. */
  pairedCount: number;
  /** Trait-vector slots that carry a value (non-null trait count). */
  traitCount: number;
  /** Where the counts came from - live read, local snapshot, or cold floor. */
  source: "live" | "snapshot" | "cold";
  /**
   * The canonical next-best-action projection carried on the SAME live
   * connections-status read the counts come from (no extra round-trip). Null
   * when the read was not live, or the backend has not attached the field.
   * Present independent of the counts: a brand-new member with zero signal
   * still gets a setup-phase projection.
   */
  nextBestAction?: NextBestAction | null;
}

/** Fast budget for the login-time recognition read; degrade past it. */
const RECOGNITION_READ_TIMEOUT_MS = 1500;

/**
 * The recognition payoff a member sees at the close of login. Pure over the
 * resolved {@link RecognitionRead} so it stays testable with no network or
 * snapshot dependency.
 *
 * Register is IaI-honest:
 *   - any real count (paired sources or traits read): the warm register,
 *     phrased as aggregate counts read from manifestation, and points at
 *     `alter status` (there is something to read back).
 *   - zero signal (the brand-new floor): the emerging register - a bare
 *     `alter status` would read as "nothing happened", so point at
 *     `alter pair` first (the U2-D empty-result guard).
 */
export interface RecognitionPayoff {
  /** Box body rows (no leading/trailing blanks - the caller pads). */
  lines: string[];
  /** Single plain next-step row, e.g. "next: alter status". */
  nextLine: string;
  /** The command the next-step points at. */
  command: "alter status" | "alter pair";
}

function warmLines(pairedCount: number, traitCount: number): string[] {
  let lead: string;
  if (pairedCount > 0) {
    const pairedClause = `${pairedCount} paired ${pairedCount === 1 ? "source" : "sources"}`;
    lead =
      traitCount > 0
        ? `Known through ${pairedClause}; ${traitCount} ${traitCount === 1 ? "trait" : "traits"} read so far.`
        : `Known through ${pairedClause}.`;
  } else {
    // Traits-only (typically the local-snapshot fallback): a trait count is
    // not a channel you are "known through", so lead with the count itself.
    lead = `${traitCount} ${traitCount === 1 ? "trait" : "traits"} read from your work so far.`;
  }
  return [lead, "Read from your work, not declared. It deepens as you keep manifesting."];
}

export function recognitionPayoff(read: RecognitionRead): RecognitionPayoff {
  const pairedCount = Math.max(0, Math.floor(read.pairedCount));
  const traitCount = Math.max(0, Math.floor(read.traitCount));
  if (pairedCount === 0 && traitCount === 0) {
    return {
      lines: [
        "You're named. Nothing read into you yet.",
        "~alter reads who you are from what you do, never what you declare.",
        "Wire a source in with `alter pair` and this fills in.",
      ],
      nextLine: "next: alter pair",
      command: "alter pair",
    };
  }
  return {
    lines: warmLines(pairedCount, traitCount),
    nextLine: "next: alter status",
    command: "alter status",
  };
}

/**
 * Merge a (possibly-failed) live read with the local snapshot's trait count
 * into the resolved recognition read. Pure + synchronous so the resolution
 * order is unit-testable with no network: live (real counts) wins, else a
 * non-zero snapshot trait count, else the cold floor.
 */
export function mergeRecognitionRead(
  live: {
    pairedCount: number;
    traitCount: number;
    nextBestAction?: NextBestAction | null;
  } | null,
  snapshotTraitCount: number,
): RecognitionRead {
  // The projection is independent of the recognition counts: a brand-new
  // member (zero counts, cold-floor copy) still gets a setup-phase next step.
  // Carry it in every branch whenever the live read succeeded.
  const nextBestAction = live?.nextBestAction ?? null;
  if (live && (live.pairedCount > 0 || live.traitCount > 0)) {
    return {
      pairedCount: live.pairedCount,
      traitCount: live.traitCount,
      source: "live",
      nextBestAction,
    };
  }
  if (snapshotTraitCount > 0) {
    return {
      pairedCount: 0,
      traitCount: snapshotTraitCount,
      source: "snapshot",
      nextBestAction,
    };
  }
  return { pairedCount: 0, traitCount: 0, source: "cold", nextBestAction };
}

/** Trait count from the live connections-status read; 0 on any non-200. */
async function fetchLiveConnectionsStatus(
  signal: AbortSignal,
): Promise<{ traitCount: number; nextBestAction: NextBestAction | null }> {
  const resp = await apiCall("/api/v1/me/connections/status", {
    signal,
    timeoutMs: RECOGNITION_READ_TIMEOUT_MS,
  });
  if (!resp || !resp.ok) return { traitCount: 0, nextBestAction: null };
  const body = (await resp.json().catch(() => null)) as
    | {
        trait_vector?: { non_null_trait_count?: number };
        next_best_action?: unknown;
      }
    | null;
  return {
    traitCount: body?.trait_vector?.non_null_trait_count ?? 0,
    // The canonical projection rides the same response, so it costs no extra
    // fetch. Parsed defensively: an older backend omits it and yields null.
    nextBestAction: parseNextBestAction(body?.next_best_action),
  };
}

/**
 * Live recognition read with the freshly-minted member key. Paired-source
 * count via the shared `fetchPaired` fetcher, trait count AND the canonical
 * next-best-action via the same connections-status response `alter status`
 * reads. Both bounded by one fast-timeout signal so the read can never stall
 * the login. May throw on a network blip / timeout / not-logged-in; the
 * caller catches.
 */
async function fetchLiveRecognition(): Promise<{
  pairedCount: number;
  traitCount: number;
  nextBestAction: NextBestAction | null;
}> {
  const signal = AbortSignal.timeout(RECOGNITION_READ_TIMEOUT_MS);
  const [paired, conn] = await Promise.all([
    fetchPaired(signal),
    fetchLiveConnectionsStatus(signal),
  ]);
  return {
    pairedCount: Array.isArray(paired) ? paired.length : 0,
    traitCount: conn.traitCount,
    nextBestAction: conn.nextBestAction,
  };
}

/**
 * Resolve the recognition read best-effort, in order: a live read (with the
 * freshly-minted member key, fast-timeout bounded), then the local status
 * snapshot, then the cold floor. Every step is guarded; this NEVER throws
 * and NEVER blocks login on a network blip or timeout. The live read is
 * skipped under ALTER_DRY_RUN so a dry-run journey stays network-free.
 *
 * Fetchers are injectable for deterministic tests; production passes none.
 */
export async function resolveRecognitionRead(
  deps: {
    fetchLive?: () => Promise<{
      pairedCount: number;
      traitCount: number;
      nextBestAction?: NextBestAction | null;
    }>;
    readSnapshotTraitCount?: () => number;
    dryRun?: boolean;
  } = {},
): Promise<RecognitionRead> {
  const dryRun = deps.dryRun ?? process.env.ALTER_DRY_RUN === "1";

  let live: {
    pairedCount: number;
    traitCount: number;
    nextBestAction?: NextBestAction | null;
  } | null = null;
  if (!dryRun) {
    try {
      live = deps.fetchLive ? await deps.fetchLive() : await fetchLiveRecognition();
    } catch {
      // Network blip / timeout / not-logged-in: fall back, never throw.
      live = null;
    }
  }

  let snapshotTraitCount = 0;
  try {
    snapshotTraitCount = deps.readSnapshotTraitCount
      ? deps.readSnapshotTraitCount()
      : readStatusSnapshot()?.trait_count ?? 0;
  } catch {
    snapshotTraitCount = 0;
  }

  return mergeRecognitionRead(live, snapshotTraitCount);
}

/**
 * Render beat 3.
 *
 * Beat 3 closes the recognition loop in-terminal: it resolves the
 * recognition read best-effort (live read -> local snapshot -> cold floor),
 * renders the payoff box (the aggregate counts ~alter has read), and still
 * returns the next-observation seed so the selection logic stays exercised by
 * tests and any future menu-seed writer.
 *
 * The read is bounded by a fast timeout and fully guarded, so the payoff
 * never stalls or fails the login. A brand-new member with a live signal
 * sees real counts; one with none (and no snapshot) gets the emerging floor.
 * No next-step line is printed: login ends on the payoff box.
 */
export async function beatThree(
  profile: SignalProfile,
  archetype: Archetype,
  shownObservationId: string,
): Promise<NextObservationSeed> {
  const next = pickObservation(archetype, profile, shownObservationId);

  const read = await resolveRecognitionRead();
  const payoff = recognitionPayoff(read);
  // The box carries the IaI body only. Login prints no next-step surface:
  // no "what next" block and no "next:" footer. `alter status` is where the
  // canonical next-best-action lives.
  printBoxedPhase({
    title: ALTER_BOX_TITLE,
    body: ["", ...payoff.lines, ""],
  });

  // If a suggestion from an earlier `alter status` run is still pending,
  // report what happened next now that a fresh projection is in hand. This
  // flow renders no new suggestion of its own (see comment above), so it
  // never records a new pending marker - only clears an old one. Runs after
  // the box above so it can never delay what the member just saw; any
  // failure is silent.
  await reportPendingSuggestion(
    readStatusSnapshot()?.pending_suggestion_id,
    read.nextBestAction ?? null,
  );

  return {
    line: next.body.join(" "),
    drawn_from_archetype: archetype,
    prior_observation_id: shownObservationId,
  };
}

// ---------------------------------------------------------------------------
// Audit entrypoint - invoked by `alter audit` and `alter login --audit-signals`
// ---------------------------------------------------------------------------

export { readFirstLook };
