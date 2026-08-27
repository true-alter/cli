/**
 * Bundled observation corpus - shipped with the CLI, no network call.
 *
 * Keyed by the `signal_key` value returned in the day-0 seed brief
 * envelope (the day-0 seed sequence is fixed).
 * The CLI does not compose copy at first-run; it picks one line from
 * this finite, hand-authored set based on which signal-key the
 * `morning_brief` substrate returned. No LLM, no template assembly.
 *
 * Six archetype signal_keys + one `default` floor, each carrying a
 * single locked observation line. Lines are calibrated against the
 * public voice cadence.
 *
 * Shape rules (locked):
 *   - One observation per signal_key. No rotation, no per-archetype
 *     pool; the substrate returns ONE key per envelope at day 0.
 *   - Lines must be falsifiable observations of the substrate the
 *     daemon read - never use-case lists, never "you can do X" copy.
 *   - The `default` line is the always-renders floor: when no
 *     green-list signal fired, the brief still renders, and this is
 *     what it says.
 *   - Each line fits within ~80 columns once the alt-screen frame's
 *     two-column indent is applied (orientation.ts: "  " + line).
 */

export const OBSERVATIONS: Record<string, string> = {
  signal_documents_cluster:
    "A cluster of writing on this machine. Same shape, same hand, recurring.",
  signal_mcp_count_high:
    "You are already running a lot of MCP servers. Agents are not new to you.",
  signal_calendar_school:
    "Your calendar has the shape of school weeks. Terms, recurrence, a rhythm.",
  signal_long_shell_history:
    "Your shell history goes back years. The terminal is not new to you.",
  signal_fresh_install:
    "This machine is new. Not much for Alter to read from yet.",
  signal_mobile_tether:
    "You are on a tethered connection. Alter is going light on the network.",
  default: "Alter has begun. It has not read much yet, but it is reading.",
  // Established-member floor: shown in place of `default` when the member
  // already has recorded traits, so the cold-start "not read much yet"
  // line never sits directly above their trait count.
  default_established:
    "Alter has been reading you for some time now. The record is filling in.",
};

/**
 * Select the observation line for a given signal_key, falling back to
 * the `default` floor when the key is unknown or undefined. The
 * fallback path is the always-renders floor: a brief renders something
 * grounded even when zero green-list signals fired.
 *
 * `traitCount` gates the fallback floor: an established member (recorded
 * traits) gets the `default_established` line instead of the cold-start
 * `default`, so "not read much yet" never contradicts a trait count shown
 * one line below. A matched signal_key always wins regardless of traits -
 * a real substrate observation is true for everyone.
 */
export function getObservation(
  signalKey: string | null | undefined,
  traitCount = 0,
): string {
  if (signalKey && signalKey in OBSERVATIONS) {
    return OBSERVATIONS[signalKey]!;
  }
  if (traitCount > 0) {
    return OBSERVATIONS.default_established!;
  }
  return OBSERVATIONS.default!;
}
