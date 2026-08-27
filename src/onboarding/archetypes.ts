/**
 * Pure signal → archetype classifier.
 *
 * Given a {@link SignalProfile}, return the archetypes that match - ranked
 * by strength. The archetype is a short string key (`"polyglot"`,
 * `"dotfiles-curator"`, etc.), used only as a selector into
 * `observations.json`. It is NEVER a trait vector, NEVER a profile, NEVER
 * persisted. One archetype selects copy; nothing else.
 *
 * Note: classification is deliberately coarse. Five archetypes
 * plus fallback means ≤5 observations per archetype on a first-run, plus
 * fallback and cross-cutting combos (see combos.ts). If you find yourself
 * adding a seventh archetype, stop - the observation already-authored
 * under one of the five probably covers it.
 *
 * History: `student` archetype retired - the detector was brittle.
 * Users who matched the former
 * student shape now fall through to the best-partial-match or to the
 * signature-line fallback. Revisit post-launch with real-user data.
 *
 * Multi-match is the norm - many machines fire several archetypes at
 * once (e.g. polyglot + claude-code-user + dotfiles-curator). The
 * classifier returns all matches ordered by strength; the beat-1
 * renderer picks the top match but could round-robin between ties.
 */

import type { SignalProfile } from "./signals.js";

export type Archetype =
  | "polyglot"
  | "claude-code-user"
  | "dotfiles-curator"
  | "fresh-machine"
  | "long-timer"
  | "fallback";

export interface ArchetypeMatch {
  archetype: Archetype;
  /** Strength 0-100; higher = better match. Deterministic given a profile. */
  strength: number;
  /** Human-readable reason - shown only in `alter audit`. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Individual detectors - each returns 0 (no match) or a strength 1-100
// ---------------------------------------------------------------------------

function polyglotStrength(p: SignalProfile): ArchetypeMatch | null {
  const count = p.runtime.present.length;
  if (count < 3) return null;
  // 3 runtimes → 60, 4 → 75, 5 → 90.
  const strength = Math.min(90, 30 + count * 12);
  return {
    archetype: "polyglot",
    strength,
    reason: `${count} language runtimes present (${p.runtime.present.join(", ")})`,
  };
}

function claudeCodeStrength(p: SignalProfile): ArchetypeMatch | null {
  if (!p.claudeCode && !p.mcp.claudeCode) return null;
  // Presence alone: 55. With MCP servers wired: +5 per server, cap 85.
  let strength = 55;
  if (p.mcp.claudeCode && p.mcp.serverCount > 0) {
    strength = Math.min(85, 55 + p.mcp.serverCount * 5);
  }
  return {
    archetype: "claude-code-user",
    strength,
    reason: p.mcp.serverCount > 0
      ? `~/.claude/ present with ${p.mcp.serverCount} MCP servers`
      : "~/.claude/ directory present",
  };
}

function dotfilesCuratorStrength(p: SignalProfile): ArchetypeMatch | null {
  const markers = [
    p.dotfiles.dotfilesDir,
    p.dotfiles.yadm,
    p.dotfiles.chezmoi,
    p.dotfiles.stow,
    p.dotfiles.bareRepo,
    p.dotfiles.symlinkCurated,
  ].filter(Boolean).length;
  // Any single marker is enough - the archetype is about the *choice* to
  // maintain one's own shell, not about which tool. Symlink-curated is
  // the strongest signal on its own because it evidences active use, not
  // just the presence of a directory.
  if (markers === 0) return null;
  let strength = Math.min(80, 55 + markers * 6);
  if (p.dotfiles.symlinkCurated) strength = Math.max(strength, 70);

  const tools: string[] = [];
  if (p.dotfiles.dotfilesDir) tools.push("dotfiles-dir");
  if (p.dotfiles.yadm) tools.push("yadm");
  if (p.dotfiles.chezmoi) tools.push("chezmoi");
  if (p.dotfiles.stow) tools.push("stow");
  if (p.dotfiles.bareRepo) tools.push("bare-repo");
  if (p.dotfiles.symlinkCurated) tools.push("home-symlinks");

  return {
    archetype: "dotfiles-curator",
    strength,
    reason: `dotfiles layout: ${tools.join(", ")}`,
  };
}

function freshMachineStrength(p: SignalProfile): ArchetypeMatch | null {
  // Fresh machine = the machine is *clean*. We fire when almost no signals
  // resolved. "Almost no" = fewer than three green-list groups matched.
  if (p.signalCount >= 3) return null;
  // Inverse: 2 signals → 60, 1 → 75, 0 → 85.
  const strength = 85 - p.signalCount * 12;
  return {
    archetype: "fresh-machine",
    strength,
    reason: `${p.signalCount} green-list groups matched (threshold: <3)`,
  };
}

function longTimerStrength(p: SignalProfile): ArchetypeMatch | null {
  // "Long-timer" fires on evidence of pre-2015 online presence. Single
  // proxy available locally without reading history: ~/.gitconfig ctime.
  // Not perfect - a reinstall resets ctime - but good enough for a first-
  // run observation. If ctime < 2016, we fire; if the user has a @gmail
  // address (a rough proxy for early-adopter-era identity) we boost.
  const year = p.git.configYear;
  if (year === null || year >= 2018) return null;
  let strength = 60;
  if (year < 2016) strength = 70;
  if (year < 2014) strength = 80;
  // A ~2005-era email host nudges further.
  const emailHost = p.git.userEmail?.split("@")[1]?.toLowerCase() ?? "";
  if (
    emailHost.endsWith("hotmail.com") ||
    emailHost.endsWith("yahoo.com") ||
    emailHost.endsWith("aol.com")
  ) {
    strength = Math.min(85, strength + 5);
  }
  return {
    archetype: "long-timer",
    strength,
    reason: `~/.gitconfig ctime year: ${year}`,
  };
}

// ---------------------------------------------------------------------------
// Composition - `classify` is the only function callers should use
// ---------------------------------------------------------------------------

export function classify(profile: SignalProfile): ArchetypeMatch[] {
  const detectors: Array<(p: SignalProfile) => ArchetypeMatch | null> = [
    polyglotStrength,
    claudeCodeStrength,
    dotfilesCuratorStrength,
    freshMachineStrength,
    longTimerStrength,
  ];

  const matches = detectors
    .map((d) => d(profile))
    .filter((m): m is ArchetypeMatch => m !== null)
    .sort((a, b) => b.strength - a.strength);

  if (matches.length === 0) {
    // Fallback match - always present so the renderer always has an
    // observation to pick. The single fallback observation is the
    // signature line: true by construction for every
    // user who executed this command, zero Barnum.
    return [
      {
        archetype: "fallback",
        strength: 50,
        reason: "no specific archetype matched",
      },
    ];
  }

  return matches;
}

/**
 * Pick the archetype whose observation will render at beat 1.
 *
 * Returning-user variance (§13 Q4) is handled here: when a
 * `fingerprintSeed` is provided (e.g. a hash of the git-config ctime +
 * username), we rotate through tied-strength matches so that a user who
 * ctrl-c'd and came back doesn't see the same line twice. Without a seed
 * we just pick the top match.
 */
export function pickPrimaryArchetype(
  matches: ArchetypeMatch[],
  fingerprintSeed?: number,
): Archetype {
  if (matches.length === 0) return "fallback";
  const top = matches[0];
  if (fingerprintSeed === undefined) return top.archetype;

  // Among tied-for-top, pick deterministically from the seed so repeat
  // runs see the same observation (no rotation) unless the seed changes.
  const ties = matches.filter((m) => m.strength === top.strength);
  if (ties.length === 1) return top.archetype;
  const index = Math.abs(fingerprintSeed) % ties.length;
  return ties[index].archetype;
}
