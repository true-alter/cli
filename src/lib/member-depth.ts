/**
 * MemberDepth - the local-only read of "how far into ALTER this member is",
 * used to drive iterative-unlock disclosure in the `alter` menu.
 *
 * Honesty-not-gating, not gamified progression: a row reveals when opening it
 * does something, or when its absence would hide a truth the member should
 * know (income accruing before it can be withdrawn). Recognition over
 * Qualification - no levels earned, no progress %, no completion badge.
 *
 * HARD constraint: the menu renders synchronously and fast, so every field
 * here is resolved from LOCAL signals only - JWT claims, the on-disk status
 * snapshot, the on-disk identity, and local markers. NO network (`apiCall`)
 * on this path. (The onboarding orchestrator can afford network in its
 * one-time chain; the standing menu cannot.)
 */

import {
  type AlterSession,
  readIdentity,
  readStatusSnapshot,
  extractAlterClaims,
} from "../auth.js";
import { onboardingSettled } from "../onboarding/progress.js";
import { isSubstrateActive } from "../commands/cutover.js";

export interface MemberDepth {
  /** Onboarding has called /complete or /skip (local settled marker present). */
  onboardingSettled: boolean;
  /** Engagement level 0–4 (Explorer→Deployed); 1 (Explorer) when unknowable. */
  engagementLevel: number;
  /** Is there a trait vector to show yet? (trait_count / attunement / level ≥ 2). */
  hasVector: boolean;
  /** Has the member been queried at least once? (status-snapshot transaction_count). */
  hasBeenQueried: boolean;
  /** Local substrate (alter-runtime) marker present. */
  substrateActive: boolean;
}

/**
 * Engagement level from JWT claims, falling back to the on-disk identity,
 * then to the on-disk status snapshot (`alter status` persists the claim
 * it last saw), defaulting to Explorer (1) when unknowable.
 *
 * The snapshot fallback sits LAST among the real sources: a live JWT claim
 * is current truth, identity.json is the deliberate identity cache, and the
 * snapshot is an opportunistic capture from the most recent `alter status`
 * run - newest-authority first.
 *
 * NOTE: the onboarding orchestrator (`onboarding/orchestrator.ts`,
 * `buildStepContext`) keeps an equivalent inline copy of this precedence
 * ON PURPOSE - it cannot import this module without forming an import cycle
 * (member-depth → cutover → login → orchestrator → member-depth). The two
 * copies are kept semantically identical; if you change the resolution order
 * here, mirror it there. Do NOT "de-duplicate" by importing member-depth
 * into the onboarding layer - that closes the cycle.
 */
export function resolveEngagementLevel(session: AlterSession | null): number {
  if (session) {
    const claims = extractAlterClaims(session.jwt);
    if (typeof claims.engagement_level === "number") {
      return claims.engagement_level;
    }
  }
  const id = readIdentity();
  if (id && typeof id.engagement_level === "number") {
    return id.engagement_level;
  }
  const snap = readStatusSnapshot();
  if (snap && typeof snap.engagement_level === "number") {
    return snap.engagement_level;
  }
  return 1;
}

/**
 * Resolve the member's depth from purely local signals. Safe on the menu
 * render path: no network, no throw - every read degrades to a sensible
 * floor (a cold member resolves to Explorer with nothing revealed).
 */
export function resolveMemberDepth(session: AlterSession | null): MemberDepth {
  const engagementLevel = resolveEngagementLevel(session);
  const snap = readStatusSnapshot();
  const traitCount = snap?.trait_count ?? 0;
  const attunement = snap?.attunement ?? 0;
  // "A vector exists to show" - any of: extracted traits on file, a non-zero
  // attunement, or an engagement level past Explorer. A paired source alone
  // is NOT the signal (you can pair and still have no vector), and there is
  // no local paired-source bit on the render path anyway.
  const hasVector =
    traitCount > 0 ||
    (typeof attunement === "number" && attunement > 0) ||
    engagementLevel >= 2;
  const hasBeenQueried = (snap?.transaction_count ?? 0) > 0;
  return {
    onboardingSettled: onboardingSettled(),
    engagementLevel,
    hasVector,
    hasBeenQueried,
    substrateActive: isSubstrateActive(),
  };
}
