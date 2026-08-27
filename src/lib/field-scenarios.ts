/**
 * field-scenarios.ts - deterministic prose-to-profile translation for the
 * interactive field query.
 *
 * The member types a plain situation ("I need a reliable flatmate who won't
 * bail on rent") and this module maps it onto a weighted trait profile over
 * the canonical 30 continuous trait codes, with NO model anywhere in the
 * path: a curated scenario-template table plus simple keyword scoring. The
 * CLI is the fallback surface; integrated AI hosts are the primary query
 * path and do this translation natively.
 *
 * CANONICAL SOURCE - SYNC WARNING
 * -------------------------------
 * The 30 trait codes below are a STATIC MIRROR of the canonical backend
 * taxonomy. The CLI cannot import across that boundary, so this table is
 * hand-synced; a pin test fails loudly on drift.
 *
 * Australian English in comments and copy; US English in identifiers.
 */

// ---------------------------------------------------------------------------
// Canonical trait table (30 continuous traits)
// ---------------------------------------------------------------------------

export interface TraitInfo {
  /** Canonical backend trait code (MemberTraitVector column). */
  code: string;
  /** Plain member-facing label. */
  label: string;
  /** Category name (matches the backend taxonomy grouping). */
  category: string;
  /** One-line plain-English reason used in the "Here's how I read that" step. */
  reason: string;
}

export const CANONICAL_TRAITS: ReadonlyArray<TraitInfo> = [
  // Adaptive Capacity
  { code: "pressure_response", label: "Steady under pressure", category: "Adaptive capacity", reason: "stays sharp when the stakes go up" },
  { code: "uncertainty_tolerance", label: "Comfortable not knowing", category: "Adaptive capacity", reason: "stays settled when plans are open-ended" },
  { code: "recovery_velocity", label: "Bounces back", category: "Adaptive capacity", reason: "treats setbacks as data and keeps moving" },
  { code: "dissent_courage", label: "Speaks up", category: "Adaptive capacity", reason: "says the uncomfortable thing when it matters" },
  { code: "vulnerability_capacity", label: "Open about struggles", category: "Adaptive capacity", reason: "shares honestly and asks for help" },
  { code: "conviction_stability", label: "Holds their ground", category: "Adaptive capacity", reason: "changes their mind on evidence, not pressure" },
  { code: "pragmatic_flexibility", label: "Adapts when it counts", category: "Adaptive capacity", reason: "takes new evidence on board and adjusts" },
  { code: "risk_propensity", label: "Comfortable with risk", category: "Adaptive capacity", reason: "takes calculated chances without flinching" },
  // Cognitive Style
  { code: "abstraction_comfort", label: "Thinks in frameworks", category: "Cognitive style", reason: "comfortable with models and the big picture" },
  { code: "learning_velocity", label: "Quick to learn", category: "Cognitive style", reason: "picks new things up fast without hand-holding" },
  { code: "pattern_recognition", label: "Sees the patterns", category: "Cognitive style", reason: "connects experiences others treat as unrelated" },
  { code: "cognitive_load_capacity", label: "Juggles a lot", category: "Cognitive style", reason: "handles several moving streams at once" },
  { code: "precision_orientation", label: "Detail-sharp", category: "Cognitive style", reason: "catches the things others gloss over" },
  { code: "reflective_orientation", label: "Reflective habit", category: "Cognitive style", reason: "regularly pauses to make sense of past experience" },
  // Interpersonal Orientation
  { code: "autonomy_preference", label: "Self-directed", category: "Interpersonal orientation", reason: "runs well without close oversight" },
  { code: "team_energy", label: "Energised by people", category: "Interpersonal orientation", reason: "collaboration lifts them rather than drains them" },
  { code: "emotional_granularity", label: "Emotionally precise", category: "Interpersonal orientation", reason: "reads and names feelings with precision" },
  { code: "feedback_orientation", label: "Takes feedback well", category: "Interpersonal orientation", reason: "seeks out feedback and acts on it" },
  { code: "generosity_of_interpretation", label: "Assumes good intent", category: "Interpersonal orientation", reason: "reads others charitably before judging" },
  // Drive Architecture
  { code: "effort_sustainability", label: "Stays the course", category: "Drive architecture", reason: "keeps showing up over months, not weeks" },
  { code: "meaning_requirement", label: "Needs it to matter", category: "Drive architecture", reason: "engages fully when the work has purpose" },
  { code: "values_clarity", label: "Knows what they stand for", category: "Drive architecture", reason: "clear values that guide their decisions" },
  { code: "growth_orientation", label: "Always improving", category: "Drive architecture", reason: "driven to get better at what they do" },
  { code: "commitment_reliability", label: "Follows through", category: "Drive architecture", reason: "doesn't drop what they signed up for" },
  { code: "initiative_drive", label: "Acts without being asked", category: "Drive architecture", reason: "spots what needs doing and does it" },
  // Integrity & Trust
  { code: "stated_revealed_consistency", label: "Walks the talk", category: "Integrity & trust", reason: "what they do matches what they say" },
  { code: "accountability_ownership", label: "Owns their part", category: "Integrity & trust", reason: "takes responsibility instead of deflecting" },
  { code: "discretion_vault", label: "Keeps confidences", category: "Integrity & trust", reason: "careful with what you share, strong boundaries" },
  { code: "self_awareness_accuracy", label: "Knows themselves", category: "Integrity & trust", reason: "an accurate read on their own strengths and gaps" },
  { code: "narrative_coherence", label: "Their story holds together", category: "Integrity & trust", reason: "consistent across time and topics" },
];

/** Code -> TraitInfo lookup. */
export const TRAIT_BY_CODE: ReadonlyMap<string, TraitInfo> = new Map(
  CANONICAL_TRAITS.map((t) => [t.code, t]),
);

/** Ordered category names for grouped pickers. */
export const TRAIT_CATEGORIES: ReadonlyArray<string> = [
  "Adaptive capacity",
  "Cognitive style",
  "Interpersonal orientation",
  "Drive architecture",
  "Integrity & trust",
];

// ---------------------------------------------------------------------------
// Emphasis mapping (plain High/Med/Low <-> 0-1 weights)
// ---------------------------------------------------------------------------

export type Emphasis = "high" | "medium" | "low";

/**
 * Emphasis -> numeric weight. Weights are relative emphasis, not scores;
 * the backend normalises across the supplied set.
 */
export const EMPHASIS_WEIGHT: Record<Emphasis, number> = {
  high: 0.6,
  medium: 0.3,
  low: 0.15,
};

/** Map a 0-1 weight back to the plain emphasis band it renders as. */
export function emphasisFor(weight: number): Emphasis {
  if (weight >= 0.5) return "high";
  if (weight >= 0.25) return "medium";
  return "low";
}

/** Display label for an emphasis band. */
export function emphasisDisplay(e: Emphasis): string {
  return e === "high" ? "High" : e === "medium" ? "Med" : "Low";
}

// ---------------------------------------------------------------------------
// Scenario templates
// ---------------------------------------------------------------------------

/** Discovery contexts the field query accepts. */
export type FieldContext =
  | "peer_recognition"
  | "collaboration_fit"
  | "co_founder_signal";

export interface ScenarioTrigger {
  /**
   * Trigger phrase, matched after normalisation (lowercase, punctuation to
   * spaces) with a word-start boundary and a permissive tail, so "climb"
   * also matches "climbing" and "flatmate" matches "flatmates".
   */
  phrase: string;
  /** Specificity weight: 2 for distinctive phrases, 1 for generic ones. */
  weight: number;
}

export interface Scenario {
  id: string;
  /** Plain label shown when the member picks from the closest-fits list. */
  label: string;
  context: FieldContext;
  triggers: ScenarioTrigger[];
  /** Weighted trait profile over the canonical 30 codes (3-6 traits). */
  traits: Record<string, number>;
}

export const SCENARIOS: ReadonlyArray<Scenario> = [
  {
    id: "flatmate",
    label: "A flatmate or housemate",
    context: "peer_recognition",
    triggers: [
      { phrase: "flatmate", weight: 2 },
      { phrase: "housemate", weight: 2 },
      { phrase: "roommate", weight: 2 },
      { phrase: "room mate", weight: 2 },
      { phrase: "sharehouse", weight: 2 },
      { phrase: "share house", weight: 2 },
      { phrase: "share a house", weight: 2 },
      { phrase: "share a flat", weight: 2 },
      { phrase: "co living", weight: 2 },
      { phrase: "coliving", weight: 2 },
      { phrase: "spare room", weight: 2 },
      { phrase: "rent", weight: 1 },
      { phrase: "lease", weight: 1 },
      { phrase: "tenant", weight: 1 },
      { phrase: "live with", weight: 1 },
      { phrase: "move in", weight: 1 },
      { phrase: "moving in", weight: 1 },
    ],
    traits: {
      commitment_reliability: 0.9,
      accountability_ownership: 0.7,
      stated_revealed_consistency: 0.6,
      discretion_vault: 0.5,
      generosity_of_interpretation: 0.4,
    },
  },
  {
    id: "co-founder",
    label: "A co-founder",
    context: "co_founder_signal",
    triggers: [
      { phrase: "co founder", weight: 2 },
      { phrase: "cofounder", weight: 2 },
      { phrase: "founding partner", weight: 2 },
      { phrase: "start a company", weight: 2 },
      { phrase: "start a business", weight: 2 },
      { phrase: "startup", weight: 2 },
      { phrase: "start up", weight: 1 },
      { phrase: "founder", weight: 1 },
      { phrase: "venture", weight: 1 },
      { phrase: "equity", weight: 1 },
    ],
    traits: {
      effort_sustainability: 0.9,
      conviction_stability: 0.8,
      initiative_drive: 0.8,
      risk_propensity: 0.7,
      values_clarity: 0.6,
      dissent_courage: 0.5,
    },
  },
  {
    id: "hire",
    label: "Someone to hire for the team",
    context: "collaboration_fit",
    triggers: [
      { phrase: "hire", weight: 2 },
      { phrase: "hiring", weight: 2 },
      { phrase: "recruit", weight: 2 },
      { phrase: "employee", weight: 2 },
      { phrase: "new team member", weight: 2 },
      { phrase: "fill a role", weight: 2 },
      { phrase: "candidate", weight: 1 },
      { phrase: "teammate", weight: 1 },
      { phrase: "engineer", weight: 1 },
      { phrase: "developer", weight: 1 },
      { phrase: "designer", weight: 1 },
      { phrase: "role", weight: 1 },
      { phrase: "position", weight: 1 },
    ],
    traits: {
      commitment_reliability: 0.8,
      accountability_ownership: 0.7,
      learning_velocity: 0.7,
      team_energy: 0.5,
      feedback_orientation: 0.5,
    },
  },
  {
    id: "study",
    label: "A study partner",
    context: "peer_recognition",
    triggers: [
      { phrase: "study", weight: 2 },
      { phrase: "studying", weight: 2 },
      { phrase: "study group", weight: 2 },
      { phrase: "exam", weight: 2 },
      { phrase: "revision", weight: 2 },
      { phrase: "classmate", weight: 2 },
      { phrase: "learn together", weight: 2 },
      { phrase: "course", weight: 1 },
      { phrase: "thesis", weight: 1 },
      { phrase: "university", weight: 1 },
      { phrase: "uni", weight: 1 },
    ],
    traits: {
      effort_sustainability: 0.8,
      commitment_reliability: 0.7,
      learning_velocity: 0.6,
      precision_orientation: 0.4,
    },
  },
  {
    id: "training",
    label: "A training or climbing partner",
    context: "peer_recognition",
    triggers: [
      { phrase: "climbing", weight: 2 },
      { phrase: "belay", weight: 2 },
      { phrase: "gym", weight: 2 },
      { phrase: "training partner", weight: 2 },
      { phrase: "workout", weight: 2 },
      { phrase: "marathon", weight: 2 },
      { phrase: "cycling", weight: 2 },
      { phrase: "climb", weight: 1 },
      { phrase: "train", weight: 1 },
      { phrase: "training", weight: 1 },
      { phrase: "running", weight: 1 },
      { phrase: "swim", weight: 1 },
      { phrase: "hike", weight: 1 },
      { phrase: "hiking", weight: 1 },
      { phrase: "exercise", weight: 1 },
    ],
    traits: {
      commitment_reliability: 0.9,
      effort_sustainability: 0.8,
      recovery_velocity: 0.5,
      risk_propensity: 0.4,
    },
  },
  {
    id: "mentor",
    label: "A mentor",
    context: "peer_recognition",
    triggers: [
      { phrase: "mentor", weight: 2 },
      { phrase: "mentorship", weight: 2 },
      { phrase: "coach", weight: 2 },
      { phrase: "career advice", weight: 2 },
      { phrase: "guide me", weight: 2 },
      { phrase: "guidance", weight: 1 },
      { phrase: "advise", weight: 1 },
      { phrase: "advice", weight: 1 },
    ],
    traits: {
      pattern_recognition: 0.8,
      feedback_orientation: 0.7,
      self_awareness_accuracy: 0.6,
      values_clarity: 0.6,
      generosity_of_interpretation: 0.5,
    },
  },
  {
    id: "collaborator",
    label: "A collaborator on a project",
    context: "collaboration_fit",
    triggers: [
      { phrase: "collaborator", weight: 2 },
      { phrase: "collaborate", weight: 2 },
      { phrase: "side project", weight: 2 },
      { phrase: "open source", weight: 2 },
      { phrase: "hackathon", weight: 2 },
      { phrase: "build together", weight: 2 },
      { phrase: "work on a project", weight: 2 },
      { phrase: "project", weight: 1 },
      { phrase: "build something", weight: 1 },
      { phrase: "prototype", weight: 1 },
    ],
    traits: {
      initiative_drive: 0.8,
      commitment_reliability: 0.7,
      learning_velocity: 0.6,
      team_energy: 0.5,
      abstraction_comfort: 0.4,
    },
  },
  {
    id: "creative",
    label: "A band or creative partner",
    context: "peer_recognition",
    triggers: [
      { phrase: "band", weight: 2 },
      { phrase: "musician", weight: 2 },
      { phrase: "jam", weight: 2 },
      { phrase: "songwriter", weight: 2 },
      { phrase: "co write", weight: 2 },
      { phrase: "creative partner", weight: 2 },
      { phrase: "write together", weight: 2 },
      { phrase: "music", weight: 1 },
      { phrase: "artist", weight: 1 },
      { phrase: "film", weight: 1 },
      { phrase: "album", weight: 1 },
    ],
    traits: {
      uncertainty_tolerance: 0.7,
      meaning_requirement: 0.7,
      team_energy: 0.6,
      emotional_granularity: 0.5,
      conviction_stability: 0.4,
    },
  },
  {
    id: "travel",
    label: "A travel companion",
    context: "peer_recognition",
    triggers: [
      { phrase: "travel", weight: 2 },
      { phrase: "trip", weight: 2 },
      { phrase: "backpacking", weight: 2 },
      { phrase: "road trip", weight: 2 },
      { phrase: "itinerary", weight: 2 },
      { phrase: "backpack", weight: 1 },
      { phrase: "holiday", weight: 1 },
      { phrase: "overseas", weight: 1 },
      { phrase: "abroad", weight: 1 },
      { phrase: "tour", weight: 1 },
    ],
    traits: {
      uncertainty_tolerance: 0.8,
      pragmatic_flexibility: 0.7,
      generosity_of_interpretation: 0.6,
      recovery_velocity: 0.5,
    },
  },
  {
    id: "carpool",
    label: "A carpool or commute partner",
    context: "peer_recognition",
    triggers: [
      { phrase: "carpool", weight: 2 },
      { phrase: "car pool", weight: 2 },
      { phrase: "rideshare", weight: 2 },
      { phrase: "ride share", weight: 2 },
      { phrase: "commute", weight: 2 },
      { phrase: "lift to work", weight: 2 },
      { phrase: "drive together", weight: 2 },
    ],
    traits: {
      commitment_reliability: 0.9,
      stated_revealed_consistency: 0.5,
      precision_orientation: 0.4,
      discretion_vault: 0.3,
    },
  },
  {
    id: "volunteer",
    label: "A community volunteer lead",
    context: "collaboration_fit",
    triggers: [
      { phrase: "volunteer", weight: 2 },
      { phrase: "charity", weight: 2 },
      { phrase: "nonprofit", weight: 2 },
      { phrase: "non profit", weight: 2 },
      { phrase: "not for profit", weight: 2 },
      { phrase: "fundraiser", weight: 2 },
      { phrase: "community", weight: 1 },
      { phrase: "committee", weight: 1 },
      { phrase: "organise", weight: 1 },
      { phrase: "organize", weight: 1 },
      { phrase: "event", weight: 1 },
    ],
    traits: {
      initiative_drive: 0.8,
      meaning_requirement: 0.7,
      accountability_ownership: 0.7,
      team_energy: 0.6,
    },
  },
  {
    id: "business",
    label: "A business partner",
    context: "collaboration_fit",
    triggers: [
      { phrase: "business partner", weight: 2 },
      { phrase: "joint venture", weight: 2 },
      { phrase: "go into business", weight: 2 },
      { phrase: "partnership", weight: 2 },
      { phrase: "invest together", weight: 2 },
      { phrase: "franchise", weight: 2 },
      { phrase: "business", weight: 1 },
      { phrase: "investor", weight: 1 },
    ],
    traits: {
      accountability_ownership: 0.8,
      stated_revealed_consistency: 0.8,
      values_clarity: 0.7,
      conviction_stability: 0.6,
      risk_propensity: 0.5,
    },
  },
  {
    id: "accountability",
    label: "An accountability partner",
    context: "peer_recognition",
    triggers: [
      { phrase: "accountability partner", weight: 2 },
      { phrase: "accountability", weight: 2 },
      { phrase: "keep me on track", weight: 2 },
      { phrase: "hold me to", weight: 2 },
      { phrase: "stay motivated", weight: 2 },
      { phrase: "habit", weight: 2 },
      { phrase: "check in", weight: 1 },
      { phrase: "goals", weight: 1 },
      { phrase: "discipline", weight: 1 },
    ],
    traits: {
      commitment_reliability: 0.9,
      feedback_orientation: 0.7,
      effort_sustainability: 0.6,
      dissent_courage: 0.5,
    },
  },
];

// ---------------------------------------------------------------------------
// Matcher
// ---------------------------------------------------------------------------

export interface RankedScenario {
  scenario: Scenario;
  score: number;
}

export interface MatchResult {
  /** Best scenario when confidently above the floor, else null. */
  best: Scenario | null;
  /** All scenarios with score > 0, highest first. */
  ranked: RankedScenario[];
}

/** Lowercase and collapse punctuation to single spaces. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a permissive matcher for a normalised trigger phrase: word-start
 * boundary at the front, a flexible tail on the last token so simple
 * inflections still hit ("flatmate" matches "flatmates", "climb" matches
 * "climbing").
 */
function triggerRegex(phrase: string): RegExp {
  const tokens = normalise(phrase).split(" ").map(escapeRegExp);
  return new RegExp("\\b" + tokens.join("\\s+") + "\\w*", "i");
}

/**
 * Score the prose against every scenario template and pick the best when
 * it clears the confidence floor: a score of at least 2 (one distinctive
 * phrase, or two generic ones) that strictly beats the runner-up. Below
 * the floor `best` is null and the caller falls back to the closest-fits
 * picker.
 */
export function matchScenario(prose: string): MatchResult {
  const text = normalise(prose);
  const ranked: RankedScenario[] = [];

  for (const scenario of SCENARIOS) {
    let score = 0;
    for (const trigger of scenario.triggers) {
      if (triggerRegex(trigger.phrase).test(text)) score += trigger.weight;
    }
    if (score > 0) ranked.push({ scenario, score });
  }

  ranked.sort((a, b) => b.score - a.score);

  const best = ranked[0];
  const runnerUp = ranked[1];
  const confident =
    best !== undefined &&
    best.score >= 2 &&
    (runnerUp === undefined || best.score > runnerUp.score);

  return { best: confident ? best.scenario : null, ranked };
}
