/**
 * Multi-signal combo predicates for beat-1 observation selection.
 *
 * A combo is a named boolean over a {@link SignalProfile} that, when true,
 * fires a specific high-shock observation regardless of which single-signal
 * archetype the classifier would have preferred. Combos encode the idea
 * that two signals together often carry a richer read than either alone.
 *
 * Adding a combo:
 *   1. Name it here with a ComboKey.
 *   2. Implement the predicate in `comboMatches`.
 *   3. Add an observation in observations.json with `combo: <key>`.
 *   4. If the combo references a new signal, update signals.ts
 *      green-list at the same time.
 *
 * Combos read only local green-list signals, carry their signals in
 * comments, and never infer protected-category or third-party data.
 */

import type { SignalProfile } from "./signals.js";

export type ComboKey =
  | "configyear_pre_2014_modern_runtime"
  | "timezone_email_mismatch"
  | "bareRepo_helix_no_vscode"
  | "polyglot_in_node_project"
  | "committed_pair_worker"
  | "configyear_pre_2013_claude";

/**
 * TLD-to-timezone-prefix heuristic for the email/timezone mismatch combo.
 * Deliberately narrow - only fires for country TLDs paired with a
 * timezone continent that does not match. `.com`, `.org`, `.io` etc. do
 * not carry geographic information and never trigger the combo.
 */
const TLD_TO_TZ_PREFIX: Record<string, string[]> = {
  au: ["Australia/"],
  nz: ["Pacific/Auckland", "Pacific/Wellington"],
  uk: ["Europe/London"],
  de: ["Europe/Berlin"],
  fr: ["Europe/Paris"],
  jp: ["Asia/Tokyo"],
  sg: ["Asia/Singapore"],
  ca: ["America/"],
  us: ["America/"],
  ie: ["Europe/Dublin"],
  nl: ["Europe/Amsterdam"],
};

function tldOf(email: string | null): string | null {
  if (!email) return null;
  const host = email.split("@")[1]?.toLowerCase() ?? null;
  if (!host) return null;
  const parts = host.split(".");
  return parts[parts.length - 1] ?? null;
}

function timezoneEmailMismatch(p: SignalProfile): boolean {
  const tld = tldOf(p.git.userEmail);
  const tz = p.shell.timezone;
  if (!tld || !tz) return false;
  const expected = TLD_TO_TZ_PREFIX[tld];
  if (!expected) return false;
  return !expected.some((prefix) => tz.startsWith(prefix));
}

/**
 * Return true if the named combo fires for this profile. See individual
 * comments for the signals each combo reads - those ARE the provenance.
 */
export function comboMatches(key: ComboKey, p: SignalProfile): boolean {
  switch (key) {
    case "configyear_pre_2014_modern_runtime":
      // Signals: git.configYear, runtime.rust OR runtime.go
      return (
        p.git.configYear !== null &&
        p.git.configYear < 2014 &&
        (p.runtime.rustc || p.runtime.go)
      );

    case "timezone_email_mismatch":
      // Signals: git.userEmail (TLD slice only), shell.timezone
      return timezoneEmailMismatch(p);

    case "bareRepo_helix_no_vscode":
      // Signals: dotfiles.bareRepo, editor.helix, editor.vscode
      return p.dotfiles.bareRepo && p.editor.helix && !p.editor.vscode;

    case "polyglot_in_node_project":
      // Signals: runtime.present.length, project.kind
      return p.runtime.present.length >= 3 && p.project.kind === "node";

    case "committed_pair_worker":
      // Signals: claudeCode, mcp.serverCount, dotfiles (any two)
      return (
        p.claudeCode &&
        p.mcp.serverCount >= 4 &&
        Object.values(p.dotfiles).filter(Boolean).length >= 2
      );

    case "configyear_pre_2013_claude":
      // Signals: git.configYear, claudeCode
      return (
        p.git.configYear !== null && p.git.configYear < 2013 && p.claudeCode
      );
  }
}

/**
 * Return the list of combo keys whose predicate is true for this profile.
 * Order is deterministic (enum declaration order); ties broken by seed at
 * the pickObservation layer.
 */
export function matchingCombos(p: SignalProfile): ComboKey[] {
  const all: ComboKey[] = [
    "configyear_pre_2014_modern_runtime",
    "timezone_email_mismatch",
    "bareRepo_helix_no_vscode",
    "polyglot_in_node_project",
    "committed_pair_worker",
    "configyear_pre_2013_claude",
  ];
  return all.filter((k) => comboMatches(k, p));
}
