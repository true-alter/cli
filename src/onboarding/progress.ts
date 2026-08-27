/**
 * Client-side resume aid for the guided post-login onboarding chain.
 *
 * Lives at `~/.cache/alter/onboarding-progress.json`, alongside the
 * existing `~/.cache/alter/first-look-seen-at` (beat-1 refusal stamp).
 *
 * This file is purely a local resume hint - it is NEVER sent to the
 * server and losing it is harmless: the orchestrator re-derives the
 * account-level step state from the backend (`/members/me/onboarding`,
 * `/me/connections`, the passkey list, the payout-method read) and
 * re-offers the per-machine steps (`wire`, `cosmetics`).
 *
 * Schema:
 *   {
 *     "first_login_at":  "<ISO>",
 *     "last_resumed_at": "<ISO>",
 *     "steps_completed": ["passkey", "pair-github", "wire"],
 *     "steps_skipped":   ["cosmetics"],
 *     "steps_deferred":  ["wallet:level_gated", "pair-obsidian:not_yet_available", ...],
 *     "machine_id":      "<stable-local-hash>"
 *   }
 *
 * `steps_completed` / `steps_skipped` are union sets. A *skipped*
 * (not completed) step is re-presented on the next resume run; a
 * completed one is not. `steps_deferred` carries a sub-reason
 * (`wallet:level_gated`, `pair-obsidian:not_yet_available`,
 * `device-source:future`) so a future build can promote a stub to a
 * real step without mis-labelling it as "you skipped this".
 *
 * `wire` and `cosmetics` are per-machine steps (they write local host
 * config) - the orchestrator keys their completion to `machine_id`, so
 * a second machine re-offers them even when the file is restored from a
 * backup. All other steps are account-level: their completion is read
 * back from the backend, not trusted from this file.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Paths (XDG-compliant; resolved at call time so tests can override
// XDG_CACHE_HOME after this module loads - mirrors the beats.ts pattern)
// ---------------------------------------------------------------------------

function cacheDir(): string {
  const xdg =
    process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  return path.join(xdg, "alter");
}

function progressFile(): string {
  return path.join(cacheDir(), "onboarding-progress.json");
}

/**
 * Sibling marker (cf. `~/.cache/alter/first-look-seen-at`) written when
 * the chain settles - i.e. the orchestrator has called `/complete` or
 * `/skip`. Lets the `alter` menu decide whether to surface the
 * "Finish setting up ~alter" row without a network
 * call on every render. Purely a UX cache aid; harmless to lose (a
 * stale-absent marker just re-shows the rows, and the chain itself
 * re-checks the backend and returns at once if already settled).
 */
function settledMarkerFile(): string {
  return path.join(cacheDir(), "onboarding-settled");
}

/**
 * True when the onboarding chain has already settled on this machine -
 * the menu uses this to hide the resume rows. Best-effort: if the cache
 * dir is unreadable, returns false (re-show the rows).
 */
export function onboardingSettled(): boolean {
  try {
    return fs.existsSync(settledMarkerFile());
  } catch {
    return false;
  }
}

/** Stamp the settled marker. Best-effort; suppressed under ALTER_DRY_RUN=1. */
export function markOnboardingSettled(): void {
  if (process.env.ALTER_DRY_RUN === "1") return;
  try {
    fs.mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(settledMarkerFile(), new Date().toISOString() + "\n", {
      mode: 0o600,
    });
  } catch {
    // Intentional silence.
  }
}

// ---------------------------------------------------------------------------
// Stable machine id
// ---------------------------------------------------------------------------

/**
 * Derive a stable, local-only machine fingerprint. No external lookup,
 * no PII transmitted - it is hashed and only ever written into the
 * local progress file to key the per-machine steps (`wire`,
 * `cosmetics`). Composed from the hostname + the OS username so it is
 * stable across runs on the same box and differs between machines.
 */
export function deriveMachineId(): string {
  let host = "";
  try {
    host = os.hostname();
  } catch {
    host = "";
  }
  let user = "";
  try {
    user = os.userInfo().username;
  } catch {
    user = "";
  }
  return crypto
    .createHash("sha256")
    .update(`${host}\0${user}`)
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// Schema + validation
// ---------------------------------------------------------------------------

export interface OnboardingProgress {
  first_login_at: string;
  last_resumed_at: string;
  steps_completed: string[];
  steps_skipped: string[];
  steps_deferred: string[];
  machine_id: string;
}

function arrayOfStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function normalise(parsed: unknown): OnboardingProgress {
  const o = (parsed ?? {}) as Record<string, unknown>;
  const nowIso = new Date().toISOString();
  return {
    first_login_at:
      typeof o.first_login_at === "string" ? o.first_login_at : nowIso,
    last_resumed_at:
      typeof o.last_resumed_at === "string" ? o.last_resumed_at : nowIso,
    steps_completed: dedupe(arrayOfStrings(o.steps_completed)),
    steps_skipped: dedupe(arrayOfStrings(o.steps_skipped)),
    steps_deferred: dedupe(arrayOfStrings(o.steps_deferred)),
    machine_id:
      typeof o.machine_id === "string" && o.machine_id.length > 0
        ? o.machine_id
        : deriveMachineId(),
  };
}

function dedupe(xs: string[]): string[] {
  return Array.from(new Set(xs));
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

/**
 * Read the progress file, returning `null` if it doesn't exist or is
 * unreadable. A malformed-but-present file is normalised rather than
 * discarded - a partial resume hint beats none.
 */
export function readProgress(): OnboardingProgress | null {
  let content: string;
  try {
    content = fs.readFileSync(progressFile(), "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  return normalise(parsed);
}

/**
 * Read the progress file, creating a fresh in-memory record if absent.
 * Never throws.
 */
export function loadOrInitProgress(): OnboardingProgress {
  const existing = readProgress();
  if (existing) return existing;
  const nowIso = new Date().toISOString();
  return {
    first_login_at: nowIso,
    last_resumed_at: nowIso,
    steps_completed: [],
    steps_skipped: [],
    steps_deferred: [],
    machine_id: deriveMachineId(),
  };
}

/**
 * Persist the progress record. Best-effort - if the cache dir is not
 * writable the chain still works, it just won't remember per-step
 * progress between runs. Suppressed under `ALTER_DRY_RUN=1`.
 */
export function writeProgress(progress: OnboardingProgress): void {
  if (process.env.ALTER_DRY_RUN === "1") return;
  try {
    fs.mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      progressFile(),
      JSON.stringify(normalise(progress), null, 2) + "\n",
      { mode: 0o600 },
    );
  } catch {
    // Intentional silence - the absence of this file is not an error
    // the user needs to see.
  }
}

// ---------------------------------------------------------------------------
// Mutators - small helpers the orchestrator uses to record outcomes
// ---------------------------------------------------------------------------

/** Mark a step completed (also removes it from the skipped set). */
export function markCompleted(
  progress: OnboardingProgress,
  step: string,
): OnboardingProgress {
  return {
    ...progress,
    steps_completed: dedupe([...progress.steps_completed, step]),
    steps_skipped: progress.steps_skipped.filter((s) => s !== step),
  };
}

/** Mark a step skipped (only if not already completed). */
export function markSkipped(
  progress: OnboardingProgress,
  step: string,
): OnboardingProgress {
  if (progress.steps_completed.includes(step)) return progress;
  return {
    ...progress,
    steps_skipped: dedupe([...progress.steps_skipped, step]),
  };
}

/** Record a deferred / stub / level-gated step with its sub-reason. */
export function markDeferred(
  progress: OnboardingProgress,
  step: string,
  reason: string,
): OnboardingProgress {
  const key = `${step}:${reason}`;
  return {
    ...progress,
    steps_deferred: dedupe([...progress.steps_deferred, key]),
  };
}

/** Stamp `last_resumed_at` to now. */
export function touchResumed(
  progress: OnboardingProgress,
): OnboardingProgress {
  return { ...progress, last_resumed_at: new Date().toISOString() };
}

/**
 * True when this is a second-or-later resume - i.e. `last_resumed_at`
 * has already been advanced past `first_login_at` at least once. Used
 * to decide whether to offer the once-only "stop asking me about setup
 * entirely" affordance after `[q]`.
 */
export function isSecondOrLaterResume(
  progress: OnboardingProgress,
): boolean {
  const first = Date.parse(progress.first_login_at);
  const last = Date.parse(progress.last_resumed_at);
  if (Number.isNaN(first) || Number.isNaN(last)) return false;
  return last > first;
}
