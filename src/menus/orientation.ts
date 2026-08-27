/**
 * "What is alter?" - conceptual orientation page.
 *
 * Single-screen render inside the alternate buffer. Three sections,
 * fixed layout:
 *
 *   Section 1 - "What it is"        : 2-line conceptual copy
 *   Section 2 - "What just happened" : ONE line picked from the
 *                                       bundled observation corpus by
 *                                       `signal_key` returned in the
 *                                       day-0 seed brief envelope
 *   Section 3 - "What next"          : 1-line next-step prompt, plus a
 *                                       standing faint line naming mobile
 *                                       apps as coming (no date, agent-
 *                                       facing surface only per the
 *                                       2026-08-09 ruling)
 *
 * Section 1 + Section 3 carry the locked on-voice copy below. Section 2 is
 * grounded: it reads `~/.cache/alter/local-signals.json` (daemon
 * cache), calls `GET /api/v1/brief/{handle}?day=0` ONCE through
 * `apiCall` (auth + fresh-session refresh handled), then picks ONE line
 * from `OBSERVATIONS` by the returned `signal_key`. When the cache is
 * missing or the brief call fails, Section 2 renders the `default`
 * observation line - the always-renders floor.
 *
 * Visual styling matches `biosMenu`: brand colours, alt-screen frame,
 * press-enter-to-return cue at the bottom.
 *
 * No `~handle` in any header / footer / status row (locked CLI-chrome
 * rule) - the action header just says "What is alter?".
 */

import { apiCall, getSession, readStatusSnapshot } from "../auth.js";
import { brand } from "../ui/biosMenu.js";
import { getObservation } from "../lib/observations.js";
import { readLocalSignals } from "../lib/local-signals.js";

/**
 * Shape of the day-0 seed brief envelope we extract `signal_key` from.
 * Stream A owns the canonical schema; this is the minimum surface the
 * CLI needs to render. Unknown fields are tolerated.
 */
interface SeedBriefEnvelope {
  signal_key?: string | null;
}

/**
 * Fetch the day-0 seed brief and extract `signal_key`. Returns `null`
 * on any failure (no session, network error, malformed body) - callers
 * fall back to the `default` observation line. Silent failure is the
 * locked graceful-degradation contract; the brief is a render input,
 * not a blocking dependency.
 */
async function fetchSeedSignalKey(handle: string): Promise<string | null> {
  let resp: Response | null;
  try {
    resp = await apiCall(
      `/api/v1/brief/${encodeURIComponent(handle)}?day=0`,
      { method: "GET" },
    );
  } catch {
    return null;
  }
  if (!resp || !resp.ok) return null;
  let body: SeedBriefEnvelope;
  try {
    body = (await resp.json()) as SeedBriefEnvelope;
  } catch {
    return null;
  }
  if (typeof body?.signal_key === "string" && body.signal_key.length > 0) {
    return body.signal_key;
  }
  return null;
}

/**
 * Render the orientation page body lines. Pure function for testability
 * - composes section labels, placeholder copy, and the picked
 * observation line into a flat list of strings. The interactive entry
 * point (`orientation` below) wraps this with the alt-screen frame and
 * the press-enter-to-return cue.
 *
 * `observationLine` is the line already resolved from the corpus; this
 * function does not re-fetch or re-pick so tests can assert the
 * composed shape without spinning up `apiCall`.
 *
 * `traitCount` gates the "What next" copy: a member with recorded traits
 * has already completed Discovery, so the cold-start prompt is replaced
 * with an established-member line.
 */
export function renderOrientationBody(observationLine: string, traitCount: number = 0): string[] {
  const whatNext =
    traitCount > 0
      ? `${traitCount} traits recorded. Alter is already reading you.`
      : "Discovery is where Alter begins to know you. Open it when you're ready.";

  return [
    brand.titleDim("What it is"),
    brand.text("Alter is the record of you. Kept by you, not in someone else's database."),
    brand.text("When something asks who you are, Alter answers. Whoever asks pays you."),
    "",
    brand.titleDim("What just happened"),
    brand.text(observationLine),
    "",
    brand.titleDim("What next"),
    brand.text(whatNext),
    brand.faint("Mobile apps for Alter are coming."),
  ];
}

/**
 * Interactive entry point. Wired into the menu under the Me zone as
 * "What is alter?". Reads local-signals + the day-0 seed brief, picks
 * the matching observation line, writes the three sections, and waits
 * for press-enter-to-return.
 *
 * The action header (drawn by the caller in `menu.ts`) carries the
 * crumb "Me  ›  What is alter?" - this function only writes the body.
 */
export async function orientation(): Promise<void> {
  // Read the daemon cache. Cold cache yields an empty key-set -
  // `getObservation(undefined)` then resolves to `default`. Silent skip
  // is intentional: a missing daemon must not block the render.
  const signals = readLocalSignals();

  // Prefer the substrate-returned `signal_key` (single source of truth
  // for day-0 selection). When the brief call is
  // unreachable or returns no key, fall back to the first locally-
  // flagged signal so the page still renders something grounded.
  let signalKey: string | null = null;
  const session = getSession();
  if (session?.handle) {
    signalKey = await fetchSeedSignalKey(session.handle);
  }
  if (!signalKey && signals.signalKeys.length > 0) {
    signalKey = signals.signalKeys[0]!;
  }

  const snap = readStatusSnapshot();
  const traitCount = snap?.trait_count ?? 0;
  const observationLine = getObservation(signalKey, traitCount);
  const body = renderOrientationBody(observationLine, traitCount);

  process.stdout.write("\n");
  for (const line of body) {
    process.stdout.write("  " + line + "\n");
  }
  process.stdout.write("\n");
  // The caller (menu.ts) wraps with `pressEnterToReturn` for every
  // non-interactive leaf - do NOT call it here or the user sees the
  // press-enter cue twice in a row.
}
