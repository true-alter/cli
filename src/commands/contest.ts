/**
 * alter contest - dispute a decision Alter recorded about you.
 *
 * Wraps `POST /api/v1/contests`. The request the backend accepts is a
 * typed one:
 *
 *   { claim_type, target, target_row_id, target_field, detail? }
 *
 * `claim_type` is a closed enum of nine values. Nobody arriving at this
 * command knows those nine words. They know "that's not me", "that's out
 * of date", "you never explained this". So the interactive path asks the
 * grievance in the words a person actually uses, derives the typed claim
 * from the answers, and then SHOWS the derived claim back and waits for a
 * yes before anything is lodged. The mapping is never a silent judgement
 * this code makes on their behalf.
 *
 * Subcommands and flags:
 *   alter contest                      walk through it (default)
 *   alter contest types                list the nine claim types
 *   alter contest types --json         same, machine-readable
 *   alter contest --type <t> --ref <id>   lodge without a TTY (agents,
 *                                          scripts); --target and --field
 *                                          default from the type when it
 *                                          admits only one
 *   alter contest ... --detail "<text>"   optional free text on the record
 *   alter contest ... --json           emit the raw response
 *   alter contest status <reference>   read back a claim you already lodged
 *   alter contest status <reference> --json
 *   alter contest --help               usage
 *
 * Every resolver behind this endpoint is mechanical. No one at Alter reads
 * a claim and decides whether the person is right, and this command never
 * says or implies otherwise.
 *
 * The read-back (`status`) wraps `GET /api/v1/contests/{receipt_ref}`. A
 * reference naming somebody else's claim answers with the identical 404 a
 * missing reference gets - this command never differentiates the two, on
 * purpose, matching the property the endpoint itself holds.
 *
 * One field in that response needs care rather than a straight print:
 * `resolver_evidence.rescore` moves through `queued`, then one of `done` /
 * `skipped_not_computed` / `failed`, once the AUTO_APPLIED input_stale rescore
 * dispatches on the backend. `queued` means a write was triggered, not that
 * it has landed; a member
 * reading `queued` and mistaking it for finished would believe a match was
 * already recomputed when it might not be for a while yet. `formatRescoreLine`
 * below is the one place that state is turned into words, precisely so no
 * other call site has to reinvent it and risk collapsing the distinction.
 */

import { apiCall, failNotLoggedIn, getSession } from "../auth.js";
import { pickOne, textInput, confirmYesNo } from "../ui/picker.js";
import { emitSessionHeartbeat } from "../lib/active-sessions-emit.js";
import { withLoadingCancel } from "../ui/biosMenu.js";

const ENDPOINT = "/api/v1/contests";

// ---------------------------------------------------------------------------
// The closed vocabulary, mirrored client-side
// ---------------------------------------------------------------------------
//
// The nine values, the tables each may attach to, and the field roots each
// table admits, are the backend's own matrix. They are mirrored here for two
// reasons and no others: to derive an unambiguous target so a person never
// has to type a column name, and to say something useful when the server
// refuses. The server remains the authority - a refusal is always rendered
// from the server's own code, never predicted client-side and never
// suppressed because this table disagrees.

export type ClaimType =
  | "input_factually_wrong"
  | "input_stale"
  | "input_not_mine"
  | "input_consent_withdrawn"
  | "output_not_reproducible"
  | "version_mismatch"
  | "missing_explanation"
  | "gate_predicate_false"
  | "gate_stale_state";

/**
 * Which of the two opening questions a claim type belongs under.
 *
 * `decision` - a score, result or record Alter holds about you.
 * `gate`     - something Alter is blocking, holding or restricting.
 */
export type Lane = "decision" | "gate";

export interface TargetSpec {
  /** Wire value for `target`: the public vocabulary name, never a substrate table name. */
  target: string;
  /** What the target is, in the words of someone who has never seen it. */
  label: string;
  /**
   * Field roots this claim type may attach to on this target. Empty means
   * the backend admits any field, so the person names it themselves and
   * `fieldPrompt` is the question they are asked.
   */
  fields: readonly string[];
  /** Plain-English label per field root, for the picker. */
  fieldLabels?: Readonly<Record<string, string>>;
  /** Asked when `fields` is empty. */
  fieldPrompt?: string;
  /**
   * What the system does once THIS exact (claim type, target) pair is
   * lodged. Shown before lodging and after. Keyed on the pair, not the
   * claim type alone: the resolver a claim type dispatches to routinely
   * branches on the target itself, so a sentence keyed on claim type alone
   * is true for at most one of its targets and silently wrong for the
   * rest. The server keys its own next-lever vocabulary on the same pair,
   * for the same reason, and this table mirrors that. Every value
   * here is written from what the matching resolver branch for this exact
   * pair actually does, never from the claim type's other branches.
   */
  onReceipt: string;
  /**
   * Set only when this exact claim type can never mechanically resolve
   * against this target - a door that is always locked. Shown to the
   * member at the point of choice, in the target picker, rather than only
   * after they have already picked it and read the refusal. Names the
   * target that actually works.
   */
  neverResolves?: string;
}

export interface ClaimTypeSpec {
  id: ClaimType;
  lane: Lane;
  /** The grievance, phrased as the person would say it. Picker label. */
  grievance: string;
  /** One line under the picker label. */
  detail: string;
  targets: readonly TargetSpec[];
}

const IDENTITY_LOG_LABEL = "a decision or score Alter recorded about you";
const TRAIT_VECTOR_LABEL = "a trait Alter holds on your record";
const SANCTION_LABEL = "a restriction Alter has placed on your account";
const MODERATION_LABEL = "a restriction on your ~handle";

export const CLAIM_TYPES: readonly ClaimTypeSpec[] = [
  {
    id: "input_factually_wrong",
    lane: "decision",
    grievance: "Something it used about me is not true",
    detail: "the recorded value is wrong, and was wrong when it was recorded",
    targets: [
      {
        target: "decision_receipt",
        label: IDENTITY_LOG_LABEL,
        fields: ["decision_inputs"],
        fieldLabels: { decision_inputs: "the information the decision was based on" },
        onReceipt:
          "This is marked frozen and the claim itself is the durable record " +
          "of that freeze. A decision receipt is a written-once historical " +
          "record no future score reads from, so nothing here strips this " +
          "value out of a later computation. Supply a corrected value " +
          "through Discovery or a connector re-pair; a future score " +
          "computed from the corrected input carries its own new receipt.",
      },
      {
        target: "trait_record",
        label: TRAIT_VECTOR_LABEL,
        fields: [],
        fieldPrompt: "Which trait is wrong? Type its name as it appears on your record.",
        onReceipt:
          "This is frozen from further scoring use: the field is stripped " +
          "from your trait record before the next match computation or " +
          "query reads it. Supply a corrected value through Discovery or a " +
          "connector re-pair, and the score re-runs against the corrected " +
          "input and issues a new receipt.",
      },
      {
        target: "prior_contest",
        label: "a score you have already disputed once",
        fields: ["original_score"],
        fieldLabels: { original_score: "the score as it stood before" },
        onReceipt:
          "This is marked frozen and lodged as the durable record of it. " +
          "A prior contest is not read by any live scoring computation, so " +
          "nothing here removes this value from a future score. Supply a " +
          "corrected value through Discovery or a connector re-pair for " +
          "future scores to reflect it.",
      },
    ],
  },
  {
    id: "input_stale",
    lane: "decision",
    grievance: "It was true once, it is out of date now",
    detail: "the value was right when recorded and has since gone stale",
    targets: [
      {
        target: "decision_receipt",
        label: IDENTITY_LOG_LABEL,
        fields: ["decision_inputs"],
        fieldLabels: { decision_inputs: "the information the decision was based on" },
        onReceipt:
          "This receipt's own recorded timestamp is compared against the " +
          "staleness ceiling for a receipt. Short of the ceiling, the " +
          "remaining duration is returned. Past it, the input expires, and " +
          "where the receipt still names a re-computable match, a fresh " +
          "score is dispatched and a new receipt issues once it completes; " +
          "a match already presented to an organisation or placed is left " +
          "untouched, and a receipt with nothing left to re-compute gets no " +
          "re-score dispatched.",
      },
      {
        target: "trait_record",
        label: TRAIT_VECTOR_LABEL,
        fields: [],
        fieldPrompt: "Which trait is out of date? Type its name as it appears on your record.",
        onReceipt:
          "This trait record's own recorded timestamp is compared against " +
          "the staleness ceiling for a trait. Short of the ceiling, the " +
          "remaining duration is returned. Past it, the field is stripped " +
          "from your trait record before the next match computation or " +
          "query reads it, so the score re-runs without it.",
      },
    ],
  },
  {
    id: "input_not_mine",
    lane: "decision",
    grievance: "That is not about me at all",
    detail: "recorded, but Alter cannot resolve this one yet",
    targets: [
      {
        target: "decision_receipt",
        label: IDENTITY_LOG_LABEL,
        fields: ["decision_inputs", "member_pseudonym_id"],
        fieldLabels: {
          decision_inputs: "the information the decision was based on",
          member_pseudonym_id: "who the decision says it is about",
        },
        neverResolves:
          "This claim can never resolve, on any target: nothing on record " +
          "joins a trait value to the party who contributed it, only the " +
          "channel it arrived through, so there is nothing to check it " +
          "against. Lodging it still puts your dispute on your record " +
          "permanently, and that record is the whole of what it does.",
        onReceipt:
          "This claim cannot be mechanically resolved today: no record " +
          "joins a specific trait value to the party who contributed it, " +
          "only the signal's channel, so there is nothing to " +
          "cross-reference against. The claim is lodged and kept on " +
          "record, but it stays at its lodged state rather than resolving " +
          "to an answer.",
      },
      {
        target: "trait_record",
        label: TRAIT_VECTOR_LABEL,
        fields: [],
        fieldPrompt: "Which trait is not yours? Type its name as it appears on your record.",
        neverResolves:
          "This claim can never resolve, on any target: nothing on record " +
          "joins a trait value to the party who contributed it, only the " +
          "channel it arrived through, so there is nothing to check it " +
          "against. Lodging it still puts your dispute on your record " +
          "permanently, and that record is the whole of what it does.",
        onReceipt:
          "This claim cannot be mechanically resolved today: no record " +
          "joins a specific trait value to the party who contributed it, " +
          "only the signal's channel, so there is nothing to " +
          "cross-reference against. The claim is lodged and kept on " +
          "record, but it stays at its lodged state rather than resolving " +
          "to an answer.",
      },
    ],
  },
  {
    id: "input_consent_withdrawn",
    lane: "decision",
    grievance: "I took back my consent for the data behind it",
    detail: "it used something you had already withdrawn permission for",
    targets: [
      {
        target: "decision_receipt",
        label: IDENTITY_LOG_LABEL,
        fields: ["decision_inputs"],
        fieldLabels: { decision_inputs: "the information the decision was based on" },
        neverResolves:
          "This claim can never resolve here: nothing on a decision " +
          "receipt names which consent grant and scope the input actually " +
          "came from, so a withdrawal on file can't be confirmed to be " +
          "about this specific input. Lodge it against the consent grant " +
          "itself instead - that resolves this claim precisely.",
        onReceipt:
          "Nothing on this decision receipt names which consent grant and " +
          "scope the input actually came from, so a withdrawal on file " +
          "cannot be confirmed to be about this specific input rather than " +
          "merely predating it. Lodge this claim against the specific " +
          "consent grant instead, which this claim type answers precisely. " +
          "The claim is lodged and kept on record, but it stays at its " +
          "lodged state rather than settling to an answer.",
      },
      {
        target: "consent_record",
        label: "a consent grant on your record",
        fields: [],
        fieldPrompt: "Which part of the grant is at issue? Type the field name if you know it.",
        onReceipt:
          "The named consent grant is checked for a currently active " +
          "record. An active grant found means there is nothing to " +
          "withdraw and the claim resolves. No active grant found confirms " +
          "the revocation, but nothing links the data a gated tool wrote " +
          "back to the consent grant that authorised it, so there is no " +
          "addressable target to purge; the claim is lodged and kept on " +
          "record, but it stays at its lodged state rather than resolving " +
          "to an answer.",
      },
    ],
  },
  {
    id: "output_not_reproducible",
    lane: "decision",
    grievance: "The result does not follow from what it used",
    detail: "you accept what it used; the result that came out of it is the problem",
    targets: [
      {
        target: "decision_receipt",
        label: IDENTITY_LOG_LABEL,
        fields: ["decision_output"],
        fieldLabels: { decision_output: "the result the decision produced" },
        onReceipt:
          "The exact scorer version recorded on the decision is re-run against the exact " +
          "inputs recorded on it, and the two results are compared. Same result, the " +
          "claim closes with the replay attached, which is proof rather than an opinion. " +
          "Different result, that is a defect in Alter: the decision is quarantined, and " +
          "your lever is to ask for a fresh score. Alter issues no verdict on the old one.",
      },
    ],
  },
  {
    id: "version_mismatch",
    lane: "decision",
    grievance: "It was scored by a version I never agreed to",
    detail: "recorded, but Alter cannot resolve this one yet",
    targets: [
      {
        target: "decision_receipt",
        label: IDENTITY_LOG_LABEL,
        fields: ["algorithm_version", "model_version"],
        fieldLabels: {
          algorithm_version: "the scoring algorithm version",
          model_version: "the model version",
        },
        neverResolves:
          "This claim can never resolve: nothing records which version was " +
          "in force, so there is no independent value to compare the one " +
          "on your receipt against. Lodging it still puts your dispute on " +
          "your record permanently, and that record is the whole of what " +
          "it does.",
        onReceipt:
          "Alter cannot resolve this claim today. Nothing in the system records " +
          "which algorithm or model version your consent names as in force, so " +
          "there is nothing authoritative to compare the decision's version " +
          "against. Approximating that comparison from other data was considered " +
          "and rejected: a value the system produces about itself is not evidence " +
          "about itself. This claim is recorded on your account and stays open " +
          "with no resolution until a real version is pinned at decision time.",
      },
    ],
  },
  {
    id: "missing_explanation",
    lane: "decision",
    grievance: "Nobody ever explained how it reached this",
    detail: "there is no explanation attached to the decision at all",
    targets: [
      {
        target: "decision_receipt",
        label: IDENTITY_LOG_LABEL,
        fields: ["feature_contributions", "explanation_text"],
        fieldLabels: {
          feature_contributions: "which inputs mattered and how much",
          explanation_text: "the written explanation",
        },
        onReceipt:
          "Alter checks whether an explanation was ever computed for this decision. If " +
          "one exists, the claim is refused and you are shown it. If none was ever " +
          "computed, that finding is the end of the road for this particular decision: " +
          "re-running the same code would produce the same absence. It is logged as a " +
          "gap in Alter, and your forward lever is a fresh score once the gap is closed.",
      },
    ],
  },
  {
    id: "gate_predicate_false",
    lane: "gate",
    grievance: "The thing you say is true of me is not true",
    detail: "the condition the block was based on does not hold",
    targets: [
      {
        target: "restriction",
        label: SANCTION_LABEL,
        fields: ["level"],
        fieldLabels: { level: "the level of the restriction" },
        onReceipt:
          "The gate's own predicate for this restriction is re-evaluated " +
          "against current state. No longer in force (or, where escalation " +
          "set this level, its supporting warn no longer stands): this " +
          "claim lifts the restriction and returns the current level. " +
          "Still in force: the current supporting state is returned as " +
          "evidence, and a claim that it has since lapsed against the same " +
          "restriction returns its remaining duration.",
      },
      {
        target: "moderation_record",
        label: MODERATION_LABEL,
        fields: ["restricted"],
        fieldLabels: { restricted: "the restricted flag on your ~handle" },
        onReceipt:
          "The same handle-restriction check the messaging send path " +
          "enforces with is re-run against current state. No longer " +
          "restricted: that is reported and the claim resolves; nothing " +
          "here performs a write, since whatever lifted it already did. " +
          "Still restricted: a handle restriction carries no mechanical " +
          "clearing predicate this claim can flip, so nothing is lifted " +
          "here; your own levers are fresh substantiation through the " +
          "evidence pipeline, or a new handle through the mint path.",
      },
      {
        target: "earning_decision",
        label: "a hold on an earning",
        // `held` is the only field this target admits. The earlier `code`
        // named a reason code, which is not addressable and which a member
        // is never shown: a held earning tells them it is held and never
        // which link tripped it, so a field inviting them to dispute the
        // reason would promise a disclosure that does not exist.
        fields: ["held"],
        fieldLabels: { held: "the hold itself, that your earning is being held" },
        onReceipt:
          "Both halves of the payer-independence hold are re-tested " +
          "against current state, in the same order the original hold " +
          "used. No longer holds: this claim performs no write of its " +
          "own, the next scheduled settlement run releases the hold " +
          "regardless of whether you ask. Still holds: nothing further is " +
          "required of you, it clears on its own the moment the check no " +
          "longer finds what it is looking for, on the next settlement " +
          "run.",
      },
    ],
  },
  {
    id: "gate_stale_state",
    lane: "gate",
    grievance: "It was true once and it has since lapsed",
    detail: "the condition has expired but the block is still on",
    targets: [
      {
        target: "restriction",
        label: SANCTION_LABEL,
        fields: ["level", "liftable_at"],
        fieldLabels: {
          level: "the level of the restriction",
          liftable_at: "when the restriction was due to lapse",
        },
        onReceipt:
          "This restriction's own expiry instant is compared against now. " +
          "If it carries no expiry instant at all, there is no ceiling to " +
          "compare against, and a claim that the condition itself is " +
          "untrue against the same restriction re-runs the predicate that " +
          "holds it instead. If an expiry instant exists and has passed, " +
          "this claim lifts now instead of whenever it would have lapsed " +
          "on its own, and returns the current level. If it has not yet " +
          "passed, the remaining duration is returned.",
      },
      {
        target: "moderation_record",
        label: MODERATION_LABEL,
        fields: ["restricted"],
        fieldLabels: { restricted: "the restricted flag on your ~handle" },
        onReceipt:
          "A ~handle restriction carries no expiry instant of its own, so " +
          "this checks the same current-restriction state a claim that " +
          "the condition itself is untrue would, not a timestamp ceiling. " +
          "No longer restricted: that is reported and the claim resolves; " +
          "nothing here performs a write. Still restricted: no ceiling can " +
          "arrive because none exists, so nothing here can lift it; your " +
          "own levers are fresh substantiation through the evidence " +
          "pipeline, or a new handle through the mint path.",
      },
    ],
  },
];

const LANE_LABEL: Readonly<Record<Lane, string>> = {
  decision: "A decision, score or record Alter holds about me",
  gate: "Something Alter is blocking, holding or restricting",
};

export function specFor(type: string): ClaimTypeSpec | undefined {
  return CLAIM_TYPES.find((c) => c.id === type);
}

/** The grievance options offered under one opening answer, in order. */
export function grievancesFor(lane: Lane): readonly ClaimTypeSpec[] {
  return CLAIM_TYPES.filter((c) => c.lane === lane);
}

/**
 * Plain-English name for a claim type, for use mid-sentence. Falls back to
 * the raw wire value so a type the server knows and this build does not is
 * still named rather than swallowed.
 */
export function plainName(type: string): string {
  const spec = specFor(type);
  if (!spec) return type;
  return spec.grievance.charAt(0).toLowerCase() + spec.grievance.slice(1);
}

// ---------------------------------------------------------------------------
// Target resolution - so a script never has to know a column name
// ---------------------------------------------------------------------------

export interface ResolvedTarget {
  /** The public target name (never a substrate table name). */
  name: string;
  field: string;
}

export type TargetResolution =
  | { ok: true; target: ResolvedTarget }
  | { ok: false; error: string };

/**
 * Fill in `target` and `target_field` from the claim type where the
 * type admits only one answer, and refuse with the choices named where it
 * does not. Pure, so the defaulting that decides what gets lodged is
 * testable without a network or a TTY.
 */
export function resolveTarget(
  type: string,
  target?: string,
  field?: string,
): TargetResolution {
  const spec = specFor(type);
  if (!spec) {
    return {
      ok: false,
      error:
        `'${type}' is not a claim type. Run 'alter contest types' for the list, ` +
        "or 'alter contest' to be asked in plain words instead.",
    };
  }

  let chosen: TargetSpec | undefined;
  if (target) {
    chosen = spec.targets.find((t) => t.target === target);
    if (!chosen) {
      return {
        ok: false,
        error:
          `A '${type}' claim cannot attach to '${target}'. It can attach to: ` +
          `${spec.targets.map((t) => t.target).join(", ")}.`,
      };
    }
  } else if (spec.targets.length === 1) {
    chosen = spec.targets[0];
  } else {
    return {
      ok: false,
      error:
        `A '${type}' claim can attach to more than one kind of record, so ` +
        "--target is required. Choose one of: " +
        `${spec.targets.map((t) => t.target).join(", ")}.`,
    };
  }

  if (field) {
    if (chosen.fields.length > 0) {
      const root = field.split(".")[0];
      if (!chosen.fields.includes(root)) {
        return {
          ok: false,
          error:
            `'${field}' is not a part of '${chosen.target}' that a '${type}' claim ` +
            `can attach to. It can attach to: ${chosen.fields.join(", ")}.`,
        };
      }
    }
    return { ok: true, target: { name: chosen.target, field } };
  }

  if (chosen.fields.length === 1) {
    return { ok: true, target: { name: chosen.target, field: chosen.fields[0] } };
  }
  if (chosen.fields.length === 0) {
    return {
      ok: false,
      error:
        `--field is required for '${chosen.target}': name the part of the record ` +
        "you are contesting (for a trait, its name).",
    };
  }
  return {
    ok: false,
    error:
      `--field is required for a '${type}' claim against '${chosen.target}'. ` +
      `Choose one of: ${chosen.fields.join(", ")}.`,
  };
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export interface ContestArgs {
  /**
   * `types` lists the vocabulary; `status` reads one claim back; `lodge` is
   * everything else.
   */
  mode: "lodge" | "types" | "status" | "help";
  type?: string;
  target?: string;
  field?: string;
  ref?: string;
  detail?: string;
  json: boolean;
  /** True when enough was passed on the command line to skip the questions. */
  nonInteractive: boolean;
  /** Flags that are not recognised, reported rather than ignored. */
  unknown: string[];
}

function valueOf(args: string[], i: number, name: string): [string | undefined, number] {
  const a = args[i];
  if (a.startsWith(`--${name}=`)) return [a.slice(name.length + 3), i];
  const next = args[i + 1];
  if (next !== undefined && !next.startsWith("--")) return [next, i + 1];
  return [undefined, i];
}

/**
 * Pure flag routing. `--type` is what switches the verb out of its
 * interactive default: a caller who names a claim type has already decided,
 * and gets no questions.
 */
export function parseContestArgs(args: string[]): ContestArgs {
  const out: ContestArgs = {
    mode: "lodge",
    json: false,
    nonInteractive: false,
    unknown: [],
  };

  if (args[0] === "types") {
    out.mode = "types";
  } else if (args[0] === "status") {
    out.mode = "status";
  }

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h" || a === "help") {
      out.mode = "help";
      continue;
    }
    if (a === "--json") {
      out.json = true;
      continue;
    }
    if (a === "types") continue;
    if (a === "status") continue;
    if (out.mode === "status" && i > 0 && !a.startsWith("-") && out.ref === undefined) {
      // The positional form: `alter contest status <reference>`. An
      // explicit `--ref` anywhere in the same command line always wins:
      // if it comes first this branch never fires (ref already set); if
      // it comes after, the `--ref` branch below overwrites this value.
      out.ref = a;
      continue;
    }
    if (a.startsWith("--type")) {
      const [v, ni] = valueOf(args, i, "type");
      out.type = v;
      i = ni;
      continue;
    }
    if (a.startsWith("--target")) {
      const [v, ni] = valueOf(args, i, "target");
      out.target = v;
      i = ni;
      continue;
    }
    if (a.startsWith("--field")) {
      const [v, ni] = valueOf(args, i, "field");
      out.field = v;
      i = ni;
      continue;
    }
    if (a.startsWith("--ref")) {
      const [v, ni] = valueOf(args, i, "ref");
      out.ref = v;
      i = ni;
      continue;
    }
    if (a.startsWith("--detail")) {
      const [v, ni] = valueOf(args, i, "detail");
      out.detail = v;
      i = ni;
      continue;
    }
    if (a.startsWith("-")) {
      out.unknown.push(a);
    }
  }

  out.nonInteractive = out.type !== undefined;
  return out;
}

// ---------------------------------------------------------------------------
// Refusals, said in words a person can act on
// ---------------------------------------------------------------------------

export interface RefusalBody {
  code?: string;
  reroute_to?: string;
  pending_substrate?: string;
  receipt_ref?: string;
  claim_id?: string;
  disposition?: string;
  message?: string;
  [key: string]: unknown;
}

/**
 * Pull the structured refusal out of a FastAPI error body. The endpoint
 * puts its stable `code` inside `detail`; a plain-string `detail` (the 403
 * path) has no code and is carried through as a message.
 */
export function readRefusal(body: unknown): RefusalBody {
  const b = body as { detail?: unknown } | null;
  const d = b?.detail;
  if (typeof d === "string") return { message: d };
  if (d && typeof d === "object") return d as RefusalBody;
  if (b && typeof b === "object") return b as RefusalBody;
  return {};
}

/**
 * Turn a refusal into something the person can read and act on.
 *
 * `CLAIM_TYPE_ROUTED` is deliberately not phrased as a failure. From the
 * person's side nothing is wrong: what they described is a different kind
 * of claim, and the answer is where to go next, not what they did badly.
 */
export function explainRefusal(
  status: number,
  refusal: RefusalBody,
  ctx: { type?: string; target?: string; field?: string; ref?: string } = {},
): string {
  const code = refusal.code;

  if (status === 401) {
    return "Your session is not authenticated. Run 'alter login' and try again.";
  }

  switch (code) {
    case "CLAIM_TYPE_ROUTED": {
      const to = refusal.reroute_to;
      const named = to ? plainName(to) : undefined;
      return (
        "Nothing was lodged, and nothing you did was wrong.\n" +
        "  What you described belongs to a different kind of claim" +
        (named ? `: ${named}.` : ".") +
        (to
          ? "\n  Lodge it as that instead:\n" +
            `    alter contest --type ${to}` +
            (ctx.ref ? ` --ref ${ctx.ref}` : " --ref <reference>")
          : "")
      );
    }

    case "CLAIM_TYPE_TARGET_MISMATCH": {
      const spec = ctx.type ? specFor(ctx.type) : undefined;
      const can = spec ? spec.targets.map((t) => t.target).join(", ") : undefined;
      return (
        "That kind of claim cannot attach to the record you pointed it at.\n" +
        (can ? `  It can attach to: ${can}.\n` : "") +
        "  Run 'alter contest' with no flags and the questions will land on a record that fits."
      );
    }

    case "TARGET_FIELD_NOT_ADDRESSABLE": {
      const spec = ctx.type ? specFor(ctx.type) : undefined;
      const target = spec?.targets.find((t) => t.target === ctx.target);
      const fields = target && target.fields.length ? target.fields.join(", ") : undefined;
      return (
        "The record exists, but the part of it you named is not one this claim can attach to.\n" +
        (fields ? `  Parts this claim can attach to: ${fields}.\n` : "") +
        "  Run 'alter contest' with no flags to be walked through the choices."
      );
    }

    case "TARGET_SUBSTRATE_PENDING": {
      const what = refusal.pending_substrate;
      return (
        "Alter has not built the record this claim needs to attach to yet.\n" +
        "  This is a gap on our side, not a mistake on yours. Nothing was lodged,\n" +
        "  and there is nothing you could type differently today that would change it." +
        (what ? `\n  What is missing: ${what}` : "")
      );
    }

    case "TARGET_ROW_NOT_FOUND":
      return (
        "No record with that reference is on your account.\n" +
        "  Check the reference you passed" +
        (ctx.ref ? ` (${ctx.ref})` : "") +
        ".\n" +
        "  The same answer comes back for a reference that does not exist and one that\n" +
        "  belongs to someone else, so this does not tell you which of the two it is."
      );

    case "CONTEST_ALREADY_OPEN":
      return (
        "You already have this exact claim open, so a second one was not lodged.\n" +
        (refusal.receipt_ref ? `  Your existing reference: ${refusal.receipt_ref}\n` : "") +
        (refusal.disposition ? `  Where it stands: ${refusal.disposition}\n` : "") +
        "  It stays open until it resolves. Lodging it again would not make it move faster."
      );
  }

  if (status === 403) {
    return (
      "This account cannot lodge a contest about a member record.\n" +
      "  Contests are lodged by the person the record is about, from their own account."
    );
  }
  if (status === 422) {
    return (
      "The claim was not accepted as written." +
      (refusal.message ? `\n  ${refusal.message}` : "")
    );
  }
  if (status >= 500) {
    return "Alter could not take the claim right now. Nothing was lodged. Try again in a moment.";
  }
  return (
    `The claim was not accepted (${status}).` +
    (refusal.message ? `\n  ${refusal.message}` : "") +
    "\n  Nothing was lodged."
  );
}

/**
 * Refusal copy for `GET /api/v1/contests/{receipt_ref}`. Kept separate from
 * `explainRefusal` above rather than folded in: that function's language is
 * lodge-specific ("was not accepted", "nothing was lodged"), which is wrong
 * for a read that never wrote anything. `CONTEST_NOT_FOUND` deliberately
 * does not say whether the reference is wrong or belongs to someone else -
 * the endpoint returns the identical body for both, and naming that here
 * would undo what the identical-404 already buys.
 */
export function explainStatusRefusal(status: number, refusal: RefusalBody, ref: string): string {
  if (status === 401) {
    return "Your session is not authenticated. Run 'alter login' and try again.";
  }
  if (status === 404 || refusal.code === "CONTEST_NOT_FOUND") {
    return (
      "No claim found at that reference.\n" +
      `  Check the reference you passed (${ref}).\n` +
      "  The same answer comes back for a reference that does not exist and one that\n" +
      "  belongs to someone else, so this does not tell you which of the two it is."
    );
  }
  if (status >= 500) {
    return "Alter could not read that claim back right now. Try again in a moment.";
  }
  return (
    `That claim could not be read back (${status}).` +
    (refusal.message ? `\n  ${refusal.message}` : "")
  );
}

// ---------------------------------------------------------------------------
// The receipt - the thing the person walks away with
// ---------------------------------------------------------------------------

export interface ContestReceipt {
  receipt_ref?: string;
  claim_id?: string;
  claim_type?: string;
  claim_class?: string;
  /** `kind` is the public target name the backend serves in the receipt. */
  target?: { kind?: string; row_id?: string; field?: string };
  lodged_at?: string;
  disposition?: string;
  member_next_lever?: string;
  receipt_hash?: string;
  [key: string]: unknown;
}

export interface ContestResponse {
  claim_id?: string;
  receipt_ref?: string;
  receipt_hash?: string;
  disposition?: string;
  receipt?: ContestReceipt;
  [key: string]: unknown;
}

/**
 * `GET /api/v1/contests/{receipt_ref}` - same wire shape as the lodge
 * response, plus the two columns a resolver writes.
 */
export interface ContestStatusResponse extends ContestResponse {
  resolved_at?: string | null;
  resolver_evidence?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// The rescore state - the one field that must never read as further along
// than it is
// ---------------------------------------------------------------------------
//
// `resolver_evidence.rescore` only appears at all for an `input_stale`
// claim against the `decision_receipt` target that resolved AUTO_APPLIED
// and named an addressable match (see the backend rescore dispatch gate).
// Its value moves through
// exactly these four words, server-side, and nowhere else in this file may
// turn one of them into prose - every call site routes through
// `formatRescoreLine` so the four words can only ever mean one thing on
// screen.
export const RESCORE_RENDER: Readonly<Record<string, string>> = {
  queued: "in progress - a recompute was triggered, it has not landed yet",
  done: "complete - the match was recomputed",
  skipped_not_computed:
    "not recomputed - nothing addressable was found for this claim to recompute against",
  failed: "failed - the recompute did not run to the end; the earlier match result still stands",
};

/**
 * Render one rescore-evidence value. Returns `null` only when there is
 * nothing to say (the key was never set on this claim in the first place -
 * checked by the caller, not here). Any value this build does not
 * recognise is still shown, flagged as unrecognised and explicitly told
 * apart from "done" - an unknown word from a newer server is a state this
 * build cannot vouch for finishing, not a state it can silently treat as
 * complete.
 */
export function formatRescoreLine(value: unknown): string {
  const key = typeof value === "string" ? value : String(value);
  const known = RESCORE_RENDER[key];
  if (known) return known;
  return `unrecognised state (${key}) - not shown as finished until this build knows what it means`;
}

/**
 * Render the lodged claim. The reference leads, because it is the only
 * thing the person needs to keep. `member_next_lever` is the server's own
 * sentence and is printed as it arrives; when it is absent, the absence is
 * stated rather than filled with an invented next step.
 */
export function formatLodged(resp: ContestResponse): string {
  const receipt = resp.receipt ?? {};
  const ref = resp.receipt_ref ?? receipt.receipt_ref;
  const hash = resp.receipt_hash ?? receipt.receipt_hash;
  const type = receipt.claim_type;
  const target = receipt.target ?? {};
  const spec = type ? specFor(type) : undefined;
  // The pair the receipt actually names. Falls back to the type's one
  // target when the response is a minimal fixture carrying no `target.kind`
  // - never falls back for a type with more than one target, since guessing
  // which pair's onReceipt to show would risk showing the wrong one.
  const targetSpec =
    spec?.targets.find((t) => t.target === target.kind) ??
    (spec && spec.targets.length === 1 ? spec.targets[0] : undefined);

  const lines: string[] = [];
  lines.push("");
  lines.push("  Your claim is lodged.");
  lines.push("");
  lines.push(`  Reference   ${ref ?? "(not returned)"}`);
  if (hash) lines.push(`  Receipt     ${hash}`);
  if (resp.disposition ?? receipt.disposition) {
    lines.push(`  Standing    ${resp.disposition ?? receipt.disposition}`);
  }
  lines.push("");
  if (spec) {
    lines.push(`  You said    ${spec.grievance.toLowerCase()}`);
  } else if (type) {
    lines.push(`  Claim type  ${type}`);
  }
  if (target.kind) {
    lines.push(`  About       ${targetSpec?.label ?? target.kind}`);
    if (target.row_id) lines.push(`  Record      ${target.row_id}`);
    if (target.field) lines.push(`  Part        ${target.field}`);
  }

  lines.push("");
  lines.push("  What happens now");
  if (targetSpec) {
    for (const line of wrap(targetSpec.onReceipt, 72)) lines.push(`    ${line}`);
    lines.push("");
  }
  lines.push("  Your next move");
  const lever = receipt.member_next_lever;
  if (lever && lever.trim()) {
    for (const line of wrap(lever.trim(), 72)) lines.push(`    ${line}`);
  } else {
    lines.push("    Alter returned no next step with this claim. The reference above is");
    lines.push("    your record that it was lodged.");
  }
  lines.push("");
  lines.push("  Keep the reference. Every step from here is mechanical: no one at Alter");
  lines.push("  reads your claim and decides whether you are right.");
  lines.push("");
  return lines.join("\n");
}

/**
 * Render `GET /api/v1/contests/{receipt_ref}`. Same shape as `formatLodged`
 * for the fields both responses carry, plus `resolved_at` and the resolver
 * evidence. `resolved_at` absent is stated plainly rather than left blank,
 * because "not yet resolved" and "resolved a moment ago" read identically
 * on a blank line otherwise.
 */
export function formatClaimStatus(resp: ContestStatusResponse): string {
  const receipt = resp.receipt ?? {};
  const ref = resp.receipt_ref ?? receipt.receipt_ref;
  const type = receipt.claim_type;
  const target = receipt.target ?? {};
  const spec = type ? specFor(type) : undefined;
  const disposition = resp.disposition ?? receipt.disposition;

  const lines: string[] = [];
  lines.push("");
  lines.push("  Your claim.");
  lines.push("");
  lines.push(`  Reference   ${ref ?? "(not returned)"}`);
  if (disposition) lines.push(`  Standing    ${disposition}`);
  if (resp.resolved_at) {
    lines.push(`  Resolved    ${resp.resolved_at}`);
  } else {
    lines.push("  Resolved    not yet - the mechanical check has not reached an answer");
  }
  lines.push("");
  if (spec) {
    lines.push(`  You said    ${spec.grievance.toLowerCase()}`);
  } else if (type) {
    lines.push(`  Claim type  ${type}`);
  }
  if (target.kind) {
    const targetSpec = spec?.targets.find((t) => t.target === target.kind);
    lines.push(`  About       ${targetSpec?.label ?? target.kind}`);
    if (target.row_id) lines.push(`  Record      ${target.row_id}`);
    if (target.field) lines.push(`  Part        ${target.field}`);
  }

  // Your next move. Once a claim has resolved, `resolver_evidence.
  // member_next_lever` is the resolver's own POST-RESOLUTION fact - what
  // actually happened, on the branch that actually fired - and it
  // supersedes the receipt's pre-lodge promise (`receipt.member_next_lever`,
  // fixed at lodge time, before any resolver ran). Unresolved, nothing has
  // run yet to supersede that promise, so it still stands and is shown.
  // Resolved with the key absent is the resolver's own deliberate "this
  // disposition is terminal, no further lever" signal (see `ResolverOutcome`
  // server-side) - stated plainly, never left blank and never backfilled
  // from the now-superseded pre-lodge sentence, which could read as a lever
  // that no longer exists.
  const evidence = resp.resolver_evidence;
  const resolved = Boolean(resp.resolved_at);
  const dynamicLever =
    evidence && typeof evidence.member_next_lever === "string"
      ? evidence.member_next_lever
      : undefined;

  lines.push("");
  lines.push("  Your next move");
  if (resolved && dynamicLever && dynamicLever.trim()) {
    for (const line of wrap(dynamicLever.trim(), 72)) lines.push(`    ${line}`);
  } else if (resolved) {
    lines.push("    Nothing further is required of you. This disposition is terminal and");
    lines.push("    carries no further lever.");
  } else {
    const lever = receipt.member_next_lever;
    if (lever && lever.trim()) {
      for (const line of wrap(lever.trim(), 72)) lines.push(`    ${line}`);
    } else {
      lines.push("    Alter returned no next step with this claim. The reference above is");
      lines.push("    your record that it was lodged.");
    }
  }

  // The rescore state - present only on the one claim shape that dispatches
  // one (see the module-level comment). `hasOwnProperty` rather than a
  // truthy check: an explicit `null` would still mean "the key is there",
  // and only its literal absence means "no recompute was ever triggered".
  if (evidence && Object.prototype.hasOwnProperty.call(evidence, "rescore")) {
    lines.push("");
    lines.push(`  Recompute   ${formatRescoreLine(evidence.rescore)}`);
  }

  lines.push("");
  lines.push("  Every step here is mechanical: no one at Alter reads your claim and");
  lines.push("  decides whether you are right.");
  lines.push("");
  return lines.join("\n");
}

/** Greedy word wrap, so long server sentences stay inside a narrow pane. */
function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line.length === 0) {
      line = w;
    } else if (line.length + 1 + w.length <= width) {
      line += ` ${w}`;
    } else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The derived claim, shown back before anything is lodged. This is the
 * whole point of the interactive path: the mapping from what the person
 * said to what the system will store is put in front of them, in their
 * words and in the system's, and they get to say no.
 */
export function formatDerived(
  spec: ClaimTypeSpec,
  target: ResolvedTarget,
  ref: string,
  detail?: string,
): string {
  const targetSpec = spec.targets.find((t) => t.target === target.name);
  const fieldLabel = targetSpec?.fieldLabels?.[target.field.split(".")[0]];
  const lines: string[] = [];
  lines.push("");
  lines.push("  Here is what will be lodged. Nothing has been sent yet.");
  lines.push("");
  lines.push(`  You said    ${spec.grievance.toLowerCase()}`);
  lines.push(`  About       ${targetSpec?.label ?? target.name}`);
  lines.push(`  Record      ${ref}`);
  lines.push(`  Part        ${fieldLabel ? `${fieldLabel} (${target.field})` : target.field}`);
  if (detail) lines.push(`  Your note   ${detail}`);
  lines.push("");
  lines.push(`  Lodged as   ${spec.id}`);
  lines.push("");
  lines.push("  What happens if you lodge it");
  if (targetSpec) {
    for (const line of wrap(targetSpec.onReceipt, 72)) lines.push(`    ${line}`);
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// types listing
// ---------------------------------------------------------------------------

export function formatTypes(): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("What you can contest");
  lines.push("");
  for (const lane of ["decision", "gate"] as Lane[]) {
    lines.push(`  ${LANE_LABEL[lane]}`);
    for (const spec of grievancesFor(lane)) {
      lines.push(`    ${spec.grievance}`);
      lines.push(`      ${spec.detail}`);
      lines.push(`      lodge with: --type ${spec.id}`);
    }
    lines.push("");
  }
  lines.push("  Run 'alter contest' and you will be asked these in order, with the");
  lines.push("  claim shown back to you before anything is lodged.");
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface LodgeOutcome {
  status: number;
  body: unknown;
}

/** The exact shape `POST /api/v1/contests` requires. No more, no fewer keys. */
export interface ContestPayload {
  claim_type: string;
  target: string;
  target_row_id: string;
  target_field: string;
  detail?: string;
}

/**
 * Build the wire payload from a gathered claim. Pure and exported so the
 * shape actually sent - the field names and the fact that `target` always
 * carries a public vocabulary name - is testable without a network call.
 */
export function buildContestPayload(gathered: Gathered): ContestPayload {
  return {
    claim_type: gathered.spec.id,
    target: gathered.target.name,
    target_row_id: gathered.ref,
    target_field: gathered.target.field,
    ...(gathered.detail ? { detail: gathered.detail } : {}),
  };
}

async function postContest(payload: ContestPayload): Promise<LodgeOutcome | null> {
  const wait = await withLoadingCancel(
    (signal) =>
      apiCall(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      }),
    "lodging your claim",
  );
  if (wait.cancelled) return null;
  const resp = wait.result;
  if (!resp) return { status: 0, body: null };
  const body = await resp.json().catch(() => null);
  return { status: resp.status, body };
}

/**
 * GET one claim back by its reference. `ref` is URL-encoded, not
 * interpolated raw: a receipt reference is member-supplied input on a path
 * segment.
 */
async function getContestStatus(ref: string): Promise<LodgeOutcome | null> {
  const wait = await withLoadingCancel(
    (signal) => apiCall(`${ENDPOINT}/${encodeURIComponent(ref)}`, { signal }),
    "reading your claim back",
  );
  if (wait.cancelled) return null;
  const resp = wait.result;
  if (!resp) return { status: 0, body: null };
  const body = await resp.json().catch(() => null);
  return { status: resp.status, body };
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(
    "Usage: alter contest\n" +
      "       alter contest types [--json]\n" +
      "       alter contest --type <claim-type> --ref <record> [--target <t>]\n" +
      "                     [--field <f>] [--detail \"<text>\"] [--json]\n" +
      "       alter contest status <reference> [--json]\n" +
      "\n" +
      "Dispute a decision, score or restriction Alter recorded about you.\n" +
      "\n" +
      "Run it with no flags and you are asked what is wrong in plain words.\n" +
      "The typed claim is worked out from your answers and SHOWN BACK to you\n" +
      "before anything is lodged, so you can correct it first.\n" +
      "\n" +
      "Every resolver behind this is mechanical. No one at Alter reads your\n" +
      "claim and decides whether you are right, so nothing here waits on a\n" +
      "person. Where a machine cannot settle it, the next move is yours.\n" +
      "\n" +
      "'alter contest status <reference>' reads a claim you already lodged\n" +
      "back - its current standing, and whether any recompute it triggered\n" +
      "has actually finished, rather than merely started.\n" +
      "\n" +
      "Options:\n" +
      "  --type <t>    Claim type, for scripts and agents. Skips the questions.\n" +
      "                Run 'alter contest types' for the list.\n" +
      "  --ref <id>    The record you are contesting, or (with 'status') the\n" +
      "                reference of the claim to read back.\n" +
      "  --target <t>  Which kind of record. Only needed when the claim type\n" +
      "                can attach to more than one.\n" +
      "  --field <f>   Which part of the record. Only needed when the claim\n" +
      "                type can attach to more than one part.\n" +
      "  --detail      Free text kept with the claim. It is stored as written\n" +
      "                and is never read to decide anything.\n" +
      "  --json        Emit the raw response, including the full receipt.\n" +
      "  --help        Show this message.\n",
  );
}

// ---------------------------------------------------------------------------
// Interactive walk
// ---------------------------------------------------------------------------

export interface Gathered {
  spec: ClaimTypeSpec;
  target: ResolvedTarget;
  ref: string;
  detail?: string;
}

async function walk(): Promise<Gathered | null> {
  console.log("");
  console.log("  Contest something Alter recorded about you.");
  console.log("");
  console.log("  You do not need to know any of Alter's words for this. Say what is");
  console.log("  wrong and the claim is worked out from that, then shown to you before");
  console.log("  anything is lodged.");
  console.log("");

  const lane = await pickOne<Lane>({
    message: "What is this about?",
    options: [
      { value: "decision", label: LANE_LABEL.decision },
      { value: "gate", label: LANE_LABEL.gate },
    ],
  });
  if (!lane) return null;

  const candidates = grievancesFor(lane);
  const typeId = await pickOne<ClaimType>({
    message: "What is wrong with it?",
    options: candidates.map((c) => ({
      value: c.id,
      label: c.grievance,
      hint: c.detail,
    })),
  });
  if (!typeId) return null;
  const spec = specFor(typeId)!;

  // Which record. Only asked when the claim type admits more than one.
  let targetSpec: TargetSpec;
  if (spec.targets.length === 1) {
    targetSpec = spec.targets[0];
  } else {
    const target = await pickOne<string>({
      message: "Which of these is it?",
      options: spec.targets.map((t) => ({
        value: t.target,
        label: t.label,
        // A target that can never mechanically resolve for this claim type
        // says so right here, at the point of choice, rather than only
        // after it has already been picked and lodged.
        hint: t.neverResolves,
      })),
    });
    if (!target) return null;
    targetSpec = spec.targets.find((t) => t.target === target)!;
  }

  // Which part of the record.
  let field: string;
  if (targetSpec.fields.length === 1) {
    field = targetSpec.fields[0];
  } else if (targetSpec.fields.length === 0) {
    const typed = await textInput({
      message: targetSpec.fieldPrompt ?? "Which part of the record are you contesting?",
      validate: (v) => (v.trim() ? undefined : "Name the part you are contesting."),
    });
    if (typed === null) return null;
    field = typed.trim();
  } else {
    const picked = await pickOne<string>({
      message: "Which part of it?",
      options: targetSpec.fields.map((f) => ({
        value: f,
        label: targetSpec.fieldLabels?.[f] ?? f,
        hint: f,
      })),
    });
    if (!picked) return null;
    field = picked;
  }

  // The reference. Alter does not yet list a person's own decision records
  // from this CLI, so this is the one thing they have to bring. Saying so is
  // better than a prompt that pretends the reference is obvious.
  console.log("");
  console.log("  The reference is the id of the record you are contesting. It comes with");
  console.log("  the decision or the restriction itself. This CLI cannot list your records");
  console.log("  back to you yet, so if you do not have the reference to hand, stop here");
  console.log("  rather than guessing: a wrong reference is refused, not corrected.");
  console.log("");

  const ref = await textInput({
    message: "Reference of the record",
    validate: (v) => (v.trim() ? undefined : "A reference is required."),
  });
  if (ref === null) return null;

  const note = await textInput({
    message: "Anything you want on the record? (optional, press enter to skip)",
    allowEmpty: true,
    placeholder: "kept with your claim, never read to decide anything",
  });
  if (note === null) return null;

  return {
    spec,
    target: { name: targetSpec.target, field },
    ref: ref.trim(),
    detail: note.trim() ? note.trim() : undefined,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function contest(args: string[] = []): Promise<void> {
  const parsed = parseContestArgs(args);

  if (parsed.mode === "help") {
    printHelp();
    return;
  }

  if (parsed.mode === "types") {
    if (parsed.json) {
      process.stdout.write(
        JSON.stringify(
          CLAIM_TYPES.map((c) => ({
            claim_type: c.id,
            lane: c.lane,
            grievance: c.grievance,
            detail: c.detail,
            targets: c.targets.map((t) => ({
              target: t.target,
              label: t.label,
              target_fields: t.fields,
              on_receipt: t.onReceipt,
              ...(t.neverResolves ? { never_resolves: t.neverResolves } : {}),
            })),
          })),
          null,
          2,
        ) + "\n",
      );
      return;
    }
    console.log(formatTypes());
    return;
  }

  if (parsed.unknown.length > 0) {
    console.error(
      `alter contest: unknown option ${parsed.unknown.join(", ")}.\n` +
        "Run 'alter contest --help' for the options.",
    );
    process.exitCode = 1;
    return;
  }

  try {
    emitSessionHeartbeat({
      sessionId: String(process.pid),
      workingOn: "alter contest",
    });
  } catch {
    /* silent - must not block command */
  }

  if (!getSession()) {
    failNotLoggedIn();
    return;
  }

  if (parsed.mode === "status") {
    const ref = parsed.ref;
    if (!ref) {
      console.error(
        "alter contest: a reference is required.\n" +
          "  alter contest status <reference>",
      );
      process.exitCode = 1;
      return;
    }

    const outcome = await getContestStatus(ref);
    if (outcome === null) {
      console.log("  Cancelled.");
      return;
    }
    if (outcome.status === 0) {
      failNotLoggedIn();
      return;
    }

    if (parsed.json) {
      process.stdout.write(JSON.stringify(outcome.body, null, 2) + "\n");
      if (outcome.status < 200 || outcome.status >= 300) process.exitCode = 1;
      return;
    }

    if (outcome.status >= 200 && outcome.status < 300) {
      console.log(formatClaimStatus((outcome.body ?? {}) as ContestStatusResponse));
      return;
    }

    const refusal = readRefusal(outcome.body);
    console.error(`  ${explainStatusRefusal(outcome.status, refusal, ref)}`);
    process.exitCode = 1;
    return;
  }

  let gathered: Gathered | null;

  if (parsed.nonInteractive) {
    const resolution = resolveTarget(parsed.type!, parsed.target, parsed.field);
    if (!resolution.ok) {
      console.error(`alter contest: ${resolution.error}`);
      process.exitCode = 1;
      return;
    }
    if (!parsed.ref) {
      console.error(
        "alter contest: --ref is required. It is the id of the record you are contesting.",
      );
      process.exitCode = 1;
      return;
    }
    gathered = {
      spec: specFor(parsed.type!)!,
      target: resolution.target,
      ref: parsed.ref,
      detail: parsed.detail,
    };
  } else {
    if (!process.stdin.isTTY) {
      console.error(
        "alter contest: no terminal to ask questions in.\n" +
          "  Pass the claim directly: alter contest --type <claim-type> --ref <record>\n" +
          "  Run 'alter contest types' for the list of claim types.",
      );
      process.exitCode = 1;
      return;
    }
    gathered = await walk();
    if (!gathered) {
      console.log("  Nothing was lodged.");
      return;
    }

    console.log(formatDerived(gathered.spec, gathered.target, gathered.ref, gathered.detail));
    const ok = await confirmYesNo({
      message: "  Lodge this claim?",
      initialValue: false,
    });
    if (ok !== true) {
      console.log("  Nothing was lodged.");
      return;
    }
  }

  await lodge(gathered, parsed.json, true);
}

/**
 * POST the claim and render whatever comes back.
 *
 * `allowReroute` is spent on the first attempt: a `CLAIM_TYPE_ROUTED`
 * refusal names the type the grievance actually belongs to, and in a
 * terminal the person is offered that lodgement rather than being handed a
 * command to retype. It is never followed twice, so a server that reroutes
 * in a circle cannot loop this command.
 */
async function lodge(
  gathered: Gathered,
  json: boolean,
  allowReroute: boolean,
): Promise<void> {
  const outcome = await postContest(buildContestPayload(gathered));

  if (outcome === null) {
    console.log("  Cancelled. Nothing was lodged.");
    return;
  }
  if (outcome.status === 0) {
    failNotLoggedIn();
    return;
  }

  if (json) {
    process.stdout.write(JSON.stringify(outcome.body, null, 2) + "\n");
    if (outcome.status < 200 || outcome.status >= 300) process.exitCode = 1;
    return;
  }

  if (outcome.status >= 200 && outcome.status < 300) {
    console.log(formatLodged((outcome.body ?? {}) as ContestResponse));
    return;
  }

  const refusal = readRefusal(outcome.body);
  const ctx = {
    type: gathered.spec.id,
    target: gathered.target.name,
    field: gathered.target.field,
    ref: gathered.ref,
  };

  // A reroute is not the person's failure. In a terminal, offer the move
  // rather than printing a command for them to retype.
  if (
    refusal.code === "CLAIM_TYPE_ROUTED" &&
    allowReroute &&
    refusal.reroute_to &&
    specFor(refusal.reroute_to) &&
    process.stdin.isTTY
  ) {
    const to = specFor(refusal.reroute_to)!;
    const retarget = resolveTarget(to.id, gathered.target.name, gathered.target.field);
    console.log("");
    console.log(`  ${explainRefusal(outcome.status, refusal, ctx)}`);
    console.log("");
    if (retarget.ok) {
      const again = await confirmYesNo({
        message: `  Lodge it as "${to.grievance.toLowerCase()}" instead?`,
        initialValue: true,
      });
      if (again === true) {
        await lodge({ ...gathered, spec: to, target: retarget.target }, json, false);
        return;
      }
    }
    console.log("  Nothing was lodged.");
    return;
  }

  console.error(`  ${explainRefusal(outcome.status, refusal, ctx)}`);
  process.exitCode = 1;
}
