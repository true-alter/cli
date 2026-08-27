/**
 * alter identity-income - unified Identity Income zone within the
 * interactive menu.
 *
 * Surfaces: quota status, peer alignment queries, grant management,
 * earnings, and profile-completeness nudges (get-queried). All leaves
 * are async functions intended to be dispatched from the menu switch.
 *
 * Backend endpoints:
 *   GET /api/v1/members/me/quota          quota/remaining/limit/resets_at
 *   GET /api/v1/income                    total/last_30d/pending/by_source
 *   GET /api/v1/members/me/grants         alignment grant list
 *   POST /api/v1/members/me/grants        create a grant
 *   DELETE /api/v1/members/me/grants/:id  revoke a grant
 *   POST /api/v1/members/me/alignment-query   peer alignment query
 *   GET /api/v1/members/me/profile-completeness  discovery/pairings/traits
 *
 * Where an endpoint does not yet exist, the command renders a graceful
 * stub message (never crashes). Endpoints that DO exist are wired live.
 */

import chalk from "chalk";
import { pickOne, pickMany, confirmYesNo, textInput, BACK_OPTION, isBack } from "../ui/picker.js";
import { apiCall, getSession } from "../auth.js";
import { brand, withLoadingCancel } from "../ui/biosMenu.js";
import { readWireState } from "@truealter/sdk";
import { wire } from "./wire.js";
import { pairInteractive } from "./discover.js";
import { fetchMergedConsent } from "./consent.js";
import { ensureTilde, isValidHandle } from "./handle.js";
import { INDICATIVE_PRICING, fetchLivePricing } from "../lib/pricing-reference.js";
import { runFieldQuery, prettyPrint } from "./ask.js";
import {
  CANONICAL_TRAITS,
  TRAIT_BY_CODE,
  TRAIT_CATEGORIES,
  EMPHASIS_WEIGHT,
  emphasisFor,
  emphasisDisplay,
  matchScenario,
  SCENARIOS,
  type Emphasis,
  type FieldContext,
} from "../lib/field-scenarios.js";

// Subject's cooperative-split share of every billable query. This mirrors the
// server-authoritative member earning share (display-only; the split is
// computed server-side) and is used for the estimated-return preview only.
// It is NOT a price and never sets one.
const SUBJECT_EARNING_SHARE = 0.75;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QuotaResponse {
  used: number;
  remaining: number;
  limit: number;
  resets_at: string | null;
  email_verified: boolean;
}

interface IncomeResponse {
  total_cents: number;
  last_30d_cents: number;
  pending_cents: number;
  by_source: Record<string, number>;
}

interface GrantEntry {
  id: string;
  peer_handle: string;
  direction: "inbound" | "outbound";
  granted_at: string;
  status: string;
}

interface GrantsResponse {
  grants: GrantEntry[];
}

interface ProfileCompleteness {
  discovery_complete: boolean;
  pairings_count: number;
  traits_loaded: boolean;
  completeness_pct: number;
}

interface AlignmentQueryResult {
  alignment_tier?: string;
  drivers?: string[];
  complementarity_tier?: string;
  confidence_band?: string;
  peer?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDollars(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toFixed(2)}`;
}

/**
 * Humanise an ISO timestamp to the shared "YYYY-MM-DD HH:MM" convention
 * (matches status.ts / consent.ts / pair-status). No raw ISO /
 * microsecond offsets in user-facing output.
 */
function humaniseStamp(iso?: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toISOString().slice(0, 16).replace("T", " ");
  } catch {
    return iso.slice(0, 16);
  }
}

function remainingColor(remaining: number): (s: string) => string {
  if (remaining > 50) return chalk.green;
  if (remaining >= 20) return chalk.yellow;
  return chalk.red;
}

function normaliseHandle(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed.startsWith("~")) return normaliseHandle("~" + raw);
  if (!/^~[a-z][a-z0-9_-]{0,62}$/.test(trimmed)) return null;
  return trimmed;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export async function identityIncomeStatus(): Promise<void> {
  // Fetch quota + income in parallel. Either may 404 if endpoint not shipped.
  // Cancellable: esc aborts both in-flight calls and returns to the menu.
  const wait = await withLoadingCancel((signal) =>
    Promise.all([
      apiCall("/api/v1/members/me/quota", { signal }).catch(() => null),
      apiCall("/api/v1/income", { signal }).catch(() => null),
    ]),
  );
  if (wait.cancelled) return;
  const [quotaResp, incomeResp] = wait.result!;

  let quota: QuotaResponse | null = null;
  let income: IncomeResponse | null = null;

  if (quotaResp && quotaResp.ok) {
    quota = (await quotaResp.json()) as QuotaResponse;
  }
  if (incomeResp && incomeResp.ok) {
    income = (await incomeResp.json()) as IncomeResponse;
  }

  process.stdout.write("\n");

  if (!quota && !income) {
    // Both endpoints absent - show stub
    process.stdout.write(
      "  " + brand.titleDim("Identity Income") + "\n\n" +
      "  " + brand.text("100 free queries to start: a one-time grant, never refills") + "\n" +
      "  " + brand.text("Earn when external agents query your identity") + "\n\n" +
      "  " + brand.faint("Quota and income tracking endpoints launching soon.") + "\n\n",
    );
    return;
  }

  // Quota line
  if (quota) {
    const color = remainingColor(quota.remaining);
    // The free tier is a FLAT, ONE-TIME STARTER grant (the quota never
    // replenishes). No resets, no refills, no windows. We never render copy implying a reset,
    // and we never print a reset date even if a backend populates resets_at
    // (the field stays in the API types as backend contract, but it is not a
    // replenishment promise and is not rendered).
    const quotaLine =
      color(`${quota.limit}`) +
      brand.dim(" free queries to start") +
      brand.dim("  ·  ") +
      color(`${quota.remaining}`) +
      brand.dim(" remaining") +
      brand.dim("  ·  ") +
      brand.dim("starter allocation, never refills");
    process.stdout.write("  " + quotaLine + "\n");
  }

  // Earnings line
  if (income) {
    const earned = formatDollars(income.last_30d_cents);
    process.stdout.write(
      "  " + brand.accent(earned) + brand.dim(" earned in the last 30 days") + "\n",
    );
    if (income.last_30d_cents > 0) {
      const sourceCount = Object.keys(income.by_source).length;
      process.stdout.write(
        "  " +
          brand.text("Your identity is earning.") +
          brand.dim(` ${sourceCount} querier${sourceCount === 1 ? "" : "s"} queried you in the last 30 days.`) +
          "\n",
      );
    }
    if (income.pending_cents > 0) {
      process.stdout.write(
        "  " + brand.dim(`${formatDollars(income.pending_cents)} pending settlement`) + "\n",
      );
    }
  } else if (quota) {
    // Quota is live but income endpoint is not
    process.stdout.write(
      "  " + brand.dim("$0.00 earned this month") + "\n",
    );
  }

  process.stdout.write("\n");
}

// ---------------------------------------------------------------------------
// Query the identity field (general query - the subject is NOT known)
// ---------------------------------------------------------------------------

/**
 * A confirmed field-query profile: weighted trait emphasis over the
 * canonical 30 trait codes, the discovery context to query under, and the
 * plain scenario label (when one matched) for the reading header.
 */
interface FieldProfile {
  traits: Record<string, number>;
  context: FieldContext;
  label: string | null;
}

/**
 * Manual trait picker - the "none of these" fallthrough. Builds the picker
 * from the canonical 30 traits grouped by category (plain labels, never
 * snake_case codes). Every picked trait starts at medium emphasis; the
 * reading step lets the member adjust. Returns null on back/cancel.
 */
async function pickTraitsManually(): Promise<Record<string, number> | null> {
  const options = TRAIT_CATEGORIES.flatMap((category) =>
    CANONICAL_TRAITS.filter((t) => t.category === category).map((t) => ({
      value: t.code,
      label: t.label,
      hint: `${category} - ${t.reason}`,
    })),
  );
  const chosen = await pickMany({
    message: "What matters in this person? (space to pick, enter to confirm)",
    options,
  });
  if (chosen === null) return null;
  if (chosen.length === 0) {
    process.stdout.write(
      "\n  " + brand.dim("Pick at least one quality to shape the query. Cancelled.") + "\n\n",
    );
    return null;
  }
  const traits: Record<string, number> = {};
  for (const code of chosen) traits[code] = EMPHASIS_WEIGHT.medium;
  return traits;
}

/**
 * Step 1 + 2: free-text prose, then deterministic translation against the
 * scenario-template table (no model anywhere in this path). Below the
 * confidence floor, offer the closest scenario labels plus a manual trait
 * picker. Returns the draft profile, "start-over", or null on back.
 */
async function captureFieldProfile(): Promise<FieldProfile | null> {
  process.stdout.write("\n");
  process.stdout.write("  " + brand.titleDim("Query the Identity Field") + "\n\n");
  process.stdout.write(
    "  " + brand.dim("Say it in plain words. You don't name anyone:") + "\n" +
    "  " + brand.dim("the opted-in field is read and someone may surface.") + "\n",
  );

  const prose = await textInput({
    message: "Describe who you're looking for",
    placeholder: "I need a reliable flatmate",
    validate: (v) =>
      v.trim() ? undefined : "Say a few words about who you need, or press esc to go back.",
  });
  if (prose === null) return null;

  const match = matchScenario(prose);
  if (match.best) {
    return {
      traits: { ...match.best.traits },
      context: match.best.context,
      label: match.best.label,
    };
  }

  // Below the confidence floor: closest fits, then the manual picker.
  const closest = (
    match.ranked.length > 0
      ? match.ranked.map((r) => r.scenario)
      : SCENARIOS.slice()
  ).slice(0, 4);

  const pick = await pickOne({
    message: "I couldn't quite place that. Closest fits:",
    options: [
      ...closest.map((s) => ({ value: s.id, label: s.label })),
      { value: "custom", label: "None of these: choose the qualities yourself" },
      BACK_OPTION,
    ],
  });
  if (isBack(pick)) return null;

  if (pick === "custom") {
    const traits = await pickTraitsManually();
    if (!traits) return null;
    return { traits, context: "peer_recognition", label: null };
  }

  const scenario = SCENARIOS.find((s) => s.id === pick);
  if (!scenario) return null;
  return {
    traits: { ...scenario.traits },
    context: scenario.context,
    label: scenario.label,
  };
}

/** Render the "Here's how I read that" listing for the current profile. */
function renderReading(profile: FieldProfile): void {
  process.stdout.write("\n");
  process.stdout.write(
    "  " + brand.text("Here's how I read that:") +
      (profile.label ? brand.dim(`  (${profile.label.toLowerCase()})`) : "") +
      "\n\n",
  );
  const entries = Object.entries(profile.traits).sort((a, b) => b[1] - a[1]);
  for (const [code, weight] of entries) {
    const info = TRAIT_BY_CODE.get(code);
    const label = info?.label ?? code;
    const reason = info?.reason ?? "";
    const band = emphasisDisplay(emphasisFor(weight));
    process.stdout.write(
      "  " +
        brand.accent(band.padEnd(5)) +
        brand.text(label.padEnd(28)) +
        brand.dim(reason) +
        "\n",
    );
  }
  process.stdout.write("\n");
}

/**
 * The adjust loop: change emphasis, add or remove traits. Mutates the
 * profile in place. Returns false on back/cancel, true when done.
 */
async function adjustProfile(profile: FieldProfile): Promise<boolean> {
  for (;;) {
    const action = await pickOne({
      message: "Adjust the reading",
      options: [
        { value: "emphasis", label: "Change how much a quality matters" },
        { value: "add", label: "Add a quality" },
        { value: "remove", label: "Remove a quality" },
        { value: "done", label: "Done adjusting" },
      ],
    });
    if (action === null || action === "done") return true;

    if (action === "emphasis") {
      const codes = Object.keys(profile.traits);
      const target = await pickOne({
        message: "Which quality?",
        options: [
          ...codes.map((c) => ({
            value: c,
            label: TRAIT_BY_CODE.get(c)?.label ?? c,
            hint: emphasisDisplay(emphasisFor(profile.traits[c])),
          })),
          BACK_OPTION,
        ],
      });
      if (isBack(target)) continue;
      const level = await pickOne({
        message: `How much does "${TRAIT_BY_CODE.get(target)?.label ?? target}" matter?`,
        options: [
          { value: "high", label: "High", hint: "weighs heavily in the reading" },
          { value: "medium", label: "Medium", hint: "a meaningful factor" },
          { value: "low", label: "Low", hint: "a light preference" },
          BACK_OPTION,
        ],
      });
      if (isBack(level)) continue;
      profile.traits[target] = EMPHASIS_WEIGHT[level as Emphasis];
      renderReading(profile);
      continue;
    }

    if (action === "add") {
      const present = new Set(Object.keys(profile.traits));
      const options = TRAIT_CATEGORIES.flatMap((category) =>
        CANONICAL_TRAITS.filter(
          (t) => t.category === category && !present.has(t.code),
        ).map((t) => ({
          value: t.code,
          label: t.label,
          hint: `${category} - ${t.reason}`,
        })),
      );
      if (options.length === 0) continue;
      const added = await pickMany({
        message: "Add qualities (space to pick, enter to confirm)",
        options,
      });
      if (added === null) continue;
      for (const code of added) profile.traits[code] = EMPHASIS_WEIGHT.medium;
      if (added.length > 0) renderReading(profile);
      continue;
    }

    if (action === "remove") {
      const codes = Object.keys(profile.traits);
      if (codes.length <= 1) {
        process.stdout.write(
          "\n  " + brand.dim("At least one quality has to stay, or there is nothing to ask.") + "\n\n",
        );
        continue;
      }
      const target = await pickOne({
        message: "Remove which quality?",
        options: [
          ...codes.map((c) => ({
            value: c,
            label: TRAIT_BY_CODE.get(c)?.label ?? c,
          })),
          BACK_OPTION,
        ],
      });
      if (isBack(target)) continue;
      delete profile.traits[target];
      renderReading(profile);
      continue;
    }
  }
}

/**
 * Step 3: the reading. Always shown before anything is priced; the member
 * can reach a confirmed profile without paying anything. Returns
 * "confirmed", "start-over", or null on back.
 */
async function reviewFieldProfile(
  profile: FieldProfile,
): Promise<"confirmed" | "start-over" | null> {
  for (;;) {
    renderReading(profile);
    const verdict = await pickOne({
      message: "Does that read right?",
      options: [
        { value: "confirm", label: "Looks right" },
        { value: "adjust", label: "Adjust", hint: "change emphasis, add or remove qualities" },
        { value: "restart", label: "Start over", hint: "describe it again" },
        BACK_OPTION,
      ],
    });
    if (isBack(verdict)) return null;
    if (verdict === "confirm") return "confirmed";
    if (verdict === "restart") return "start-over";
    if (verdict === "adjust") {
      const done = await adjustProfile(profile);
      if (!done) return null;
    }
  }
}

/** Ask-once path: confirm, POST the field query, render the outcome. */
async function runAskOnce(
  profile: FieldProfile,
  priceStr: string,
  subjectEarns: number,
): Promise<void> {
  process.stdout.write(
    "\n  " +
      brand.dim(
        `If someone fits, the person revealed earns $${subjectEarns.toFixed(2)}: 75% of what you pay.`,
      ) +
      "\n",
  );
  const ok = await confirmYesNo({
    message: `Ask the field once? (${priceStr}; you pay nothing if no one surfaces)`,
    initialValue: false,
  });
  if (!ok) {
    process.stdout.write(
      "\n  " + brand.dim("Cancelled. No query was made, nothing was charged.") + "\n\n",
    );
    return;
  }

  const askWait = await withLoadingCancel(
    (signal) => runFieldQuery(profile.traits, profile.context, 1, signal),
    "asking the field",
  );
  if (askWait.cancelled) {
    process.stdout.write(
      "\n  " + brand.dim("Cancelled. If the query had already reached the field it may") + "\n" +
      "  " + brand.dim("still settle - run 'alter queries' to check.") + "\n\n",
    );
    return;
  }
  const outcome = askWait.result!;

  switch (outcome.kind) {
    case "unreachable":
      process.stdout.write(
        "\n  " + brand.accentDeep("Could not reach the Identity Field.") + "\n\n",
      );
      return;
    case "dormant":
      process.stdout.write(
        "\n  " + brand.text("The field query isn't enabled yet.") + "\n" +
        "  " + brand.dim("Your query was validated but no field was read.") + "\n\n",
      );
      return;
    case "bad-request":
      process.stdout.write(
        "\n  " + brand.accentDeep(`Query rejected: ${outcome.detail}`) + "\n\n",
      );
      return;
    case "unauthorized":
      process.stdout.write(
        "\n  " + brand.accentDeep("Session expired. Run 'alter login'.") + "\n\n",
      );
      return;
    case "rate-limited":
      process.stdout.write(
        "\n  " + brand.text("Rate limit reached.") + "\n" +
        "  " + brand.dim("Repeated narrow queries are throttled - try again later.") + "\n\n",
      );
      return;
    case "error":
      process.stdout.write(
        "\n  " + brand.accentDeep(`Query failed (${outcome.status}).`) + "\n\n",
      );
      return;
    case "ok":
      prettyPrint(outcome.data);
      return;
  }
}

/**
 * Rest-it path. The CLI has no callable standing-requirement surface yet
 * (the orderbook's create_requirement tool is MCP-only), so this renders
 * honest coming-soon copy and points agent users at the MCP tool.
 */
function renderRestIt(checkPriceStr: string): void {
  process.stdout.write(
    "\n  " + brand.text("Resting a search isn't in the CLI yet. It's coming soon.") + "\n" +
    "  " + brand.dim("If you use ~alter through an AI assistant, ask it to post a") + "\n" +
    "  " + brand.dim("standing requirement with the create_requirement tool. Each") + "\n" +
    "  " + brand.dim(`check that reveals someone costs ${checkPriceStr}.`) + "\n\n",
  );
}

/**
 * Step 5: one-line nudge toward standing-match opt-in. The CLI has no
 * standing-match opt-in surface yet, so this is guidance only (the
 * alter_standing_match MCP tool is the live opt-in path for agent users).
 */
function renderOptInNudge(): void {
  process.stdout.write(
    "  " + brand.dim("Want to be findable the same way? You can opt in to standing") + "\n" +
    "  " + brand.dim("matches: ask your AI assistant to use the alter_standing_match tool.") + "\n\n",
  );
}

/**
 * identityFieldQueryInteractive - the GENERAL field query.
 *
 * Unlike peer alignment (which queries a KNOWN ~handle), the field query is
 * for the case where you do NOT know who you are looking for. You type a
 * plain situation ("I need a reliable flatmate"); the CLI translates it
 * deterministically against a curated scenario table onto the canonical 30
 * trait codes (no model runs anywhere in this path), shows you the reading
 * for confirmation, and only then prices the ask. The person revealed earns
 * 75% of what you pay.
 *
 * Alt-screen-native: it uses the same textInput / pickOne / pickMany /
 * confirmYesNo components the rest of the menu uses, so it runs inside the
 * menu's shared alt-screen with no exitAlt (matching identityIncomeQuery).
 *
 * Wraps POST /api/v1/identity/field via the shared runFieldQuery helper.
 * The field is default-closed: only members who opted into discovery are
 * searchable, so an empty result is indistinguishable from "no match".
 */
export async function identityFieldQueryInteractive(): Promise<void> {
  const session = getSession();
  if (!session) {
    process.stdout.write(
      "\n  " + brand.accentDeep("Run 'alter login' first.") + "\n\n",
    );
    return;
  }

  // Steps 1-3 loop: describe, translate, confirm the reading. The member
  // can always reach a confirmed profile without paying anything.
  let profile: FieldProfile | null = null;
  for (;;) {
    const draft = await captureFieldProfile();
    if (draft === null) return;
    const verdict = await reviewFieldProfile(draft);
    if (verdict === null) return;
    if (verdict === "start-over") continue;
    profile = draft;
    break;
  }

  // Step 4: the fork. Live prices from the field's tool-pricing catalogue;
  // reference fallback when unreachable, marked as such. esc backs out of
  // the flow before anything is priced or charged.
  const pricingWait = await withLoadingCancel(
    (signal) => fetchLivePricing(signal),
    "fetching prices",
  );
  if (pricingWait.cancelled) return;
  const pricing = pricingWait.result!;
  const priceStr = `$${pricing.queryFieldPrice.toFixed(2)}`;
  const checkPriceStr = `$${pricing.requirementCheckPrice.toFixed(2)}`;
  const indicator = pricing.live ? "" : " (reference rate, field unreachable)";
  const subjectEarns = pricing.queryFieldPrice * pricing.cooperativePoolShare;

  process.stdout.write(
    "\n  " + brand.dim(`Prices${indicator}:`) + "\n",
  );
  const fork = await pickOne({
    message: "How do you want to ask?",
    options: [
      {
        value: "once",
        label: `Ask the field once: ${priceStr}`,
        hint: "one person surfaces if someone fits; you pay nothing if no one does",
      },
      {
        value: "rest",
        label: "Rest it",
        hint: `post what you're looking for and check back; each check that reveals someone costs ${checkPriceStr}`,
      },
      BACK_OPTION,
    ],
  });
  if (isBack(fork)) return;

  if (fork === "once") {
    await runAskOnce(profile, priceStr, subjectEarns);
  } else {
    renderRestIt(checkPriceStr);
  }

  // Step 5: the opt-in nudge after either path completes.
  renderOptInNudge();
}

// ---------------------------------------------------------------------------
// Peer alignment (menu label; runs the L3 alignment query against a known ~handle)
// ---------------------------------------------------------------------------

/**
 * Resolve whether the peer has already granted the caller inbound alignment
 * access. Querying someone is "more than typing a handle" - for an L3+
 * consent-gated subject the caller needs a standing grant before the backend
 * will compute alignment (otherwise it returns 403). We read the same
 * /me/grants ledger the grants screen uses and look for an INBOUND grant from
 * this peer (a grant they authored giving us access). Returns the grant's
 * status when present, or null when no inbound grant exists.
 */
async function resolveInboundGrant(
  peer: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const resp = await apiCall("/api/v1/members/me/grants", { signal });
    if (!resp || !resp.ok) return null;
    const data = (await resp.json()) as GrantsResponse;
    const inbound = (data.grants ?? []).find(
      (g) => g.direction === "inbound" && g.peer_handle === peer,
    );
    return inbound ? inbound.status : null;
  } catch {
    return null;
  }
}

export async function identityIncomeQuery(): Promise<void> {
  const session = getSession();
  if (!session) {
    process.stdout.write(
      "\n  " + brand.accentDeep("Run 'alter login' first.") + "\n\n",
    );
    return;
  }

  // Fetch quota first so we can show free-quota remaining BEFORE the user
  // commits. The quota response is server-authoritative.
  let quota: QuotaResponse | null = null;
  const quotaWait = await withLoadingCancel(async (signal) => {
    try {
      const resp = await apiCall("/api/v1/members/me/quota", { signal });
      if (resp && resp.ok) {
        return (await resp.json()) as QuotaResponse;
      }
    } catch {
      // Continue without quota info
    }
    return null;
  }, "checking quota");
  if (quotaWait.cancelled) return;
  quota = quotaWait.result;

  // Prompt for the peer handle. The trill (~) renders as a LOCKED prefix the
  // cursor can never delete, and the input's footer shows the way out
  // (`⏎ confirm  esc back`); ensureTilde is the single canonical normaliser.
  const handleInput = await textInput({
    message: "Peer alignment - whose ~handle?",
    lockedPrefix: "~",
    placeholder: "handle",
    validate: (v) => {
      const s = v.trim();
      if (!s || s === "~") return "Type a handle after the ~, or press esc to go back.";
      if (!isValidHandle(ensureTilde(s))) {
        return "Invalid handle - letters, digits and hyphens only.";
      }
      return undefined;
    },
  });

  if (handleInput === null) return;
  const handle = ensureTilde(handleInput);

  // Pick the query context. peer_recognition is the default mutual reading;
  // collaboration_fit and co_founder_signal are the workforce-vertical
  // framings (the backend drops emotional_granularity for those per EU AI
  // Act Art 5). The endpoint accepts all three; this picker was previously
  // only on the Room "Query peer alignment" leaf, now consolidated here.
  const context = await pickOne({
    message: "Query context",
    options: [
      { value: "peer_recognition", label: "Peer recognition", hint: "default - mutual reading" },
      { value: "collaboration_fit", label: "Collaboration fit", hint: "shared work potential" },
      { value: "co_founder_signal", label: "Co-founder signal", hint: "long-arc partnership" },
      BACK_OPTION,
    ],
  });
  if (isBack(context)) return;

  // --- Resolve consent FIRST -------------------------------------------------
  // Querying someone is more than typing a handle: surface whether a grant is
  // required and whether the peer has already granted us access. L0–L2 follow
  // payment-is-auth (free quota or x402 pays); L3+ is consent-gated and needs a
  // standing inbound grant. We can only observe the grant ledger client-side;
  // the backend remains the authority and will 403 if its gate disagrees.
  const grantWait = await withLoadingCancel(
    (signal) => resolveInboundGrant(handle, signal),
    "resolving consent",
  );
  if (grantWait.cancelled) return;
  const grantStatus = grantWait.result;
  const hasGrant = grantStatus === "active";

  // --- Price preview (per type, BEFORE confirm) ------------------------------
  // Prices are SERVER-AUTHORITATIVE. The backend settles the actual amount at
  // query time (and quotes it in its 402 detail when quota is exhausted). The
  // table below is sourced from the INDICATIVE pricing reference and is
  // explicitly labelled "indicative" - the client NEVER sets or edits a price,
  // it only previews what each query TYPE is expected to cost so the user can
  // decide before committing. (Prices are indicative and subject to change.)
  const free = quota !== null && quota.remaining > 0;
  const remaining = quota?.remaining ?? 0;
  const limit = quota?.limit ?? 0;

  process.stdout.write("\n");
  process.stdout.write("  " + brand.titleDim(`Query ${handle}`) + "\n\n");

  // Consent state
  process.stdout.write(
    "  " + brand.text("Consent:        ") +
      (hasGrant
        ? brand.accent("granted") + brand.dim(`  ${handle} has authorised you`)
        : grantStatus
          ? brand.accentDeep(grantStatus) + brand.dim(`  grant exists but is ${grantStatus}`)
          : brand.accentDeep("required") +
            brand.dim(`  ask ${handle} to run: alter alignment grant ${session.handle}`)) +
      "\n",
  );

  // Per-type indicative price preview. Each priced query TYPE is shown with its
  // indicative cost; the backend quotes the authoritative figure at settlement.
  process.stdout.write("\n  " + brand.dim("Indicative price by query type (server-authoritative at settlement):") + "\n");
  const priceRows: Array<[string, number]> = [
    ["Identity signal (L1)", INDICATIVE_PRICING.L1],
    ["Enriched identity (L2)", INDICATIVE_PRICING.L2],
    ["Full alignment vector (L3)", INDICATIVE_PRICING.L3],
  ];
  for (const [label, price] of priceRows) {
    const priceStr = price === 0 ? "free" : `$${price.toFixed(3)}`;
    process.stdout.write(
      "    " + brand.text(label.padEnd(30)) + brand.faint(`${priceStr} indicative`) + "\n",
    );
  }

  // This menu flow runs the L3 peer_recognition alignment query.
  const thisQueryPrice = INDICATIVE_PRICING.L3;
  const subjectEarns = thisQueryPrice * SUBJECT_EARNING_SHARE;

  process.stdout.write("\n");
  if (free) {
    const color = remainingColor(remaining);
    process.stdout.write(
      "  " + brand.text("This query:     ") + color("Free") +
        brand.dim("  (covered by your free quota)") + "\n",
    );
    process.stdout.write(
      "  " + brand.text("Free quota:     ") +
        color(`${remaining}/${limit}`) + brand.dim(" lifetime queries remaining") + "\n",
    );
  } else {
    // Quota exhausted (or unknown) - x402 pays. Show the indicative charge and
    // the estimated return to the subject. The backend computes the real split.
    process.stdout.write(
      "  " + brand.text("This query:     ") +
        brand.text(`$${thisQueryPrice.toFixed(3)}`) + brand.dim(" (L3 alignment, indicative)") + "\n",
    );
    process.stdout.write(
      "  " + brand.text("Free quota:     ") +
        brand.faint(`${remaining}/${limit} remaining`) + "\n",
    );
  }
  process.stdout.write(
    "  " + brand.text("Subject earns:  ") +
      brand.accent(`$${subjectEarns.toFixed(3)}`) +
      brand.dim(`  (${handle} keeps 75% of the query fee)`) + "\n\n",
  );

  // --- Confirm [y/N] ---------------------------------------------------------
  const ok = await confirmYesNo({
    message: free
      ? `Query alignment with ${handle}? (free - ${remaining} remaining)`
      : `Query alignment with ${handle}? ($${thisQueryPrice.toFixed(3)} indicative, ${handle} earns $${subjectEarns.toFixed(3)})`,
    initialValue: false,
  });
  if (!ok) return;

  // --- Run the query ---------------------------------------------------------
  const queriedAt = new Date();

  const queryWait = await withLoadingCancel(
    (signal) =>
      apiCall("/api/v1/members/me/alignment-query", {
        method: "POST",
        body: { peer: handle, context },
        signal,
      }),
    "querying",
  );
  if (queryWait.cancelled) {
    process.stdout.write(
      "\n  " + brand.dim("Cancelled. If the query had already reached the server it") + "\n" +
      "  " + brand.dim("may still settle - run 'alter queries' to check.") + "\n\n",
    );
    return;
  }
  const resp = queryWait.result;

  if (!resp) {
    process.stdout.write(
      "  " + brand.accentDeep("Session expired. Run 'alter login'.") + "\n\n",
    );
    return;
  }

  if (resp.status === 404) {
    // Endpoint not yet shipped
    process.stdout.write(
      "\n" +
      "  " + brand.titleDim("Alignment query") + "\n\n" +
      "  " + brand.text("Not available in the menu yet. Use the command line:") + "\n" +
      "  " + brand.accent("alter alignment query " + handle) + "\n\n",
    );
    return;
  }

  if (resp.status === 403) {
    process.stdout.write(
      "\n  " + brand.text("Consent required.") + "\n" +
      "  " + brand.dim(`Ask ${handle} to grant you access first:`) + "\n" +
      "  " + brand.accent(`alter alignment grant ${session.handle}`) + "\n\n",
    );
    return;
  }

  if (resp.status === 402) {
    // Quota exhausted and payment required - surface the backend's
    // server-authoritative price quote verbatim (never a client price).
    const body = await resp.text().catch(() => "");
    process.stdout.write(
      "\n  " + brand.accentDeep("Payment required.") +
      (body ? "\n  " + brand.dim(body.slice(0, 160)) : "") + "\n\n",
    );
    return;
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    process.stdout.write(
      "\n  " + brand.accentDeep(`Query failed (${resp.status}).`) +
      (body ? "\n  " + brand.dim(body.slice(0, 120)) : "") + "\n\n",
    );
    return;
  }

  const result = (await resp.json()) as AlignmentQueryResult & {
    query_id?: string;
  };
  process.stdout.write("\n");
  process.stdout.write(
    "  " + brand.titleDim(`Alignment with ${result.peer ?? handle}`) + "\n\n",
  );
  process.stdout.write(
    "  " + brand.text("Alignment tier:       ") + brand.accent(result.alignment_tier ?? "-") + "\n",
  );
  process.stdout.write(
    "  " + brand.text("Complementarity tier: ") + brand.accent(result.complementarity_tier ?? "-") + "\n",
  );
  process.stdout.write(
    "  " + brand.text("Confidence band:      ") + brand.accent(result.confidence_band ?? "-") + "\n",
  );
  if (result.drivers && result.drivers.length > 0) {
    process.stdout.write("\n  " + brand.dim("Top driver traits:") + "\n");
    for (const d of result.drivers.slice(0, 3)) {
      process.stdout.write("    " + brand.text("- " + d) + "\n");
    }
  }

  // --- Receipt ---------------------------------------------------------------
  // A transparent record of what just happened. Amounts are framed as the
  // free-quota draw when free, else the indicative charge + subject earning.
  // The backend is the source of truth for the settled figures.
  process.stdout.write("\n  " + brand.faint("─".repeat(40)) + "\n");
  process.stdout.write("  " + brand.dim("Receipt") + "\n");
  const queryId = result.query_id ?? "-";
  process.stdout.write("  " + brand.text("Query id:      ") + brand.faint(queryId) + "\n");
  process.stdout.write("  " + brand.text("Subject:       ") + brand.handle(result.peer ?? handle) + "\n");
  process.stdout.write("  " + brand.text("Type:          ") + brand.faint(`L3 alignment (${context})`) + "\n");
  if (free) {
    process.stdout.write(
      "  " + brand.text("Amount paid:   ") + brand.faint("free quota draw (1 query)") + "\n",
    );
    process.stdout.write(
      "  " + brand.text("Subject earns: ") + brand.faint("$0.000 (free-tier query)") + "\n",
    );
  } else {
    process.stdout.write(
      "  " + brand.text("Amount paid:   ") + brand.faint(`$${thisQueryPrice.toFixed(3)} indicative`) + "\n",
    );
    process.stdout.write(
      "  " + brand.text("Subject earns: ") + brand.faint(`$${subjectEarns.toFixed(3)} (75% to ${result.peer ?? handle})`) + "\n",
    );
  }
  process.stdout.write("  " + brand.text("Timestamp:     ") + brand.faint(humaniseStamp(queriedAt.toISOString())) + "\n");
  process.stdout.write("\n");
}

// ---------------------------------------------------------------------------
// Who can query me (grants management)
// ---------------------------------------------------------------------------

export async function identityIncomeGrants(): Promise<void> {
  const session = getSession();
  if (!session) {
    process.stdout.write(
      "\n  " + brand.accentDeep("Run 'alter login' first.") + "\n\n",
    );
    return;
  }

  // Fetch grants list
  const listWait = await withLoadingCancel(
    (signal) => apiCall("/api/v1/members/me/grants", { signal }),
    "loading grants",
  );
  if (listWait.cancelled) return;
  const resp = listWait.result;

  if (!resp) {
    process.stdout.write(
      "\n  " + brand.accentDeep("Session expired. Run 'alter login'.") + "\n\n",
    );
    return;
  }

  if (resp.status === 404) {
    // Endpoint not yet shipped - show stub with alternative
    process.stdout.write(
      "\n" +
      "  " + brand.titleDim("Alignment grants") + "\n\n" +
      "  " + brand.text("Not available in the menu yet. Use the command line:") + "\n\n" +
      "  " + brand.accent("alter alignment grant ~handle") + brand.dim("   - let someone query you") + "\n" +
      "  " + brand.accent("alter alignment revoke ~handle") + brand.dim("  - revoke access") + "\n\n",
    );
    return;
  }

  if (!resp.ok) {
    process.stdout.write(
      "\n  " + brand.accentDeep(`Could not fetch grants (${resp.status}).`) + "\n\n",
    );
    return;
  }

  const data = (await resp.json()) as GrantsResponse;
  const grants = data.grants ?? [];

  process.stdout.write("\n");
  process.stdout.write("  " + brand.titleDim("Who can query me") + "\n\n");

  if (grants.length === 0) {
    process.stdout.write(
      "  " + brand.faint("No active grants. Your identity is private.") + "\n" +
      "  " + brand.dim("Grant access to earn from alignment queries.") + "\n\n",
    );
  } else {
    // "Who can query me" is specifically the OUTBOUND grants - grants I have
    // authored that let a peer query my vector (the backend labels these
    // direction="outbound": "peers who can query your vector"). Inbound grants
    // (access peers gave ME) belong to the query flow, not this screen, so they
    // are excluded here - showing both was the source of the apparent
    // duplicate/confusing rows.
    //
    // Aggregate to ONE row per peer: the backend can return several grant rows
    // for the same peer (re-grants, historical or differently-scoped rows). We
    // keep the most recent active grant per peer (or the most recent row if
    // none is active) and count the rest, so a peer holding several grant
    // rows renders on one line rather than once per grant.
    const byPeer = new Map<
      string,
      { latest: GrantEntry; count: number; anyActive: boolean }
    >();
    for (const g of grants) {
      if (g.direction !== "outbound") continue; // who can query ME = outbound
      const existing = byPeer.get(g.peer_handle);
      const isActive = g.status === "active";
      if (!existing) {
        byPeer.set(g.peer_handle, {
          latest: g,
          count: 1,
          anyActive: isActive,
        });
        continue;
      }
      existing.count += 1;
      existing.anyActive = existing.anyActive || isActive;
      // Prefer the most recently granted row as the representative.
      const newer =
        (g.granted_at ?? "") > (existing.latest.granted_at ?? "");
      if (newer) existing.latest = g;
    }

    if (byPeer.size === 0) {
      process.stdout.write(
        "  " + brand.faint("No one can query you yet.") + "\n" +
        "  " + brand.dim("Grant access to earn from alignment queries.") + "\n\n",
      );
    } else {
      // Table header - one row per peer: who, the grant scope/tier, and when.
      const colPeer  = "Peer";
      const colScope = "Grant scope";
      const colWhen  = "Granted";
      process.stdout.write(
        "  " +
          brand.dim(colPeer.padEnd(24)) + "  " +
          brand.dim(colScope.padEnd(24)) + "  " +
          brand.dim(colWhen) +
          "\n",
      );
      process.stdout.write(
        "  " + brand.faint("─".repeat(64)) + "\n",
      );

      // Sort peers by most-recent grant first for a stable, readable order.
      const rows = [...byPeer.entries()].sort(
        (a, b) =>
          (b[1].latest.granted_at ?? "").localeCompare(a[1].latest.granted_at ?? ""),
      );

      for (const [peer, { latest, count, anyActive }] of rows) {
        // Grant scope/tier: the alignment grant is tier "alignment.query".
        // Annotate when a peer holds more than one grant row so the
        // aggregation is transparent rather than hidden.
        const scope = anyActive ? "alignment query" : `${latest.status}`;
        const scopeLabel = count > 1 ? `${scope} (×${count})` : scope;
        const grantedAt = humaniseStamp(latest.granted_at);

        // Pad the plain strings BEFORE applying colour; chalk ANSI bytes inflate
        // .length so post-colour padding silently breaks column alignment.
        process.stdout.write(
          "  " +
            brand.handle(peer.padEnd(24)) + "  " +
            brand.text(scopeLabel.padEnd(24)) + "  " +
            brand.faint(grantedAt) +
            "\n",
        );
      }
      process.stdout.write("\n");
    }
  }

  // Action picker
  const choice = await pickOne({
    message: "Manage grants",
    options: [
      { value: "grant", label: "Grant access to someone", hint: "let a peer query your vector" },
      { value: "revoke", label: "Revoke access", hint: "remove an existing grant" },
      { value: "back", label: "Back" },
    ],
  });

  if (choice === null || choice === "back") return;

  if (choice === "grant") {
    const handleInput = await textInput({
      message: "~handle to grant",
      lockedPrefix: "~",
      placeholder: "alice",
      validate: (v) => {
        if (!v.trim() || v.trim() === "~") return "Type a handle after the ~, or press esc to go back.";
        const h = normaliseHandle(v);
        if (!h) return "Invalid handle format";
        return undefined;
      },
    });
    if (handleInput === null) return;
    const handle = normaliseHandle(handleInput);
    if (!handle) return;

    const grantWait = await withLoadingCancel(
      (signal) =>
        apiCall("/api/v1/members/me/grants", {
          method: "POST",
          body: { peer: handle },
          signal,
        }),
      "granting",
    );
    if (grantWait.cancelled) {
      process.stdout.write(
        "\n  " + brand.dim("Cancelled. Run 'alter alignment' to check whether the grant landed.") + "\n\n",
      );
      return;
    }
    const grantResp = grantWait.result;

    if (grantResp && grantResp.status === 404) {
      // Endpoint not shipped - fall back to CLI verb guidance
      process.stdout.write(
        "\n  " + brand.dim("Not available in the menu yet. Use the command line:") + "\n" +
        "  " + brand.accent(`alter alignment grant ${handle}`) + "\n\n",
      );
      return;
    }
    if (grantResp && grantResp.ok) {
      process.stdout.write(
        "\n  " + brand.accent("Granted.") +
        brand.dim(` ${handle} can now query alignment with you.`) + "\n\n",
      );
    } else {
      process.stdout.write(
        "\n  " + brand.accentDeep("Grant failed.") +
        brand.dim(` Try: alter alignment grant ${handle}`) + "\n\n",
      );
    }
    return;
  }

  if (choice === "revoke") {
    // Only outbound grants can be revoked by the caller (grantor==caller).
    // Inbound grants were authored by the peer - DELETE /me/grants/:id
    // requires grantor==caller and will 404 on inbound grants.
    const outboundGrants = grants.filter((g) => g.direction === "outbound");
    if (outboundGrants.length === 0) {
      process.stdout.write(
        "\n  " + brand.faint("Nothing to revoke.") + "\n\n",
      );
      return;
    }
    const revokeChoice = await pickOne({
      message: "Revoke which grant?",
      options: outboundGrants.map((g) => ({
        value: g.id,
        label: g.peer_handle,
        hint: `${humaniseStamp(g.granted_at)}`,
      })),
    });
    if (revokeChoice === null) return;

    const revokeWait = await withLoadingCancel(
      (signal) =>
        apiCall(`/api/v1/members/me/grants/${revokeChoice}`, {
          method: "DELETE",
          signal,
        }),
      "revoking",
    );
    if (revokeWait.cancelled) {
      process.stdout.write(
        "\n  " + brand.dim("Cancelled. Run 'alter alignment' to check whether the revoke landed.") + "\n\n",
      );
      return;
    }
    const revokeResp = revokeWait.result;
    if (revokeResp && revokeResp.status === 404) {
      const grant = outboundGrants.find((g) => g.id === revokeChoice);
      const peerHandle = grant?.peer_handle ?? "~peer";
      process.stdout.write(
        "\n  " + brand.dim("Not available in the menu yet. Use the command line:") + "\n" +
        "  " + brand.accent(`alter alignment revoke ${peerHandle}`) + "\n\n",
      );
      return;
    }
    if (revokeResp && revokeResp.ok) {
      process.stdout.write(
        "\n  " + brand.accent("Revoked.") + "\n\n",
      );
    } else {
      process.stdout.write(
        "\n  " + brand.accentDeep("Revoke failed.") + "\n\n",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Discovery - interactive setup walkthrough
// ---------------------------------------------------------------------------

interface DiscoveryStep {
  key: string;
  label: string;
  done: boolean;
  detail: string;
}

export async function identityIncomeGetQueried(): Promise<void> {
  const session = getSession();
  if (!session) {
    process.stdout.write(
      "\n  " + brand.accentDeep("Run 'alter login' first.") + "\n\n",
    );
    return;
  }

  const stepsWait = await withLoadingCancel(
    (signal) =>
      Promise.all([
        apiCall("/api/v1/members/me/quota", { signal }).catch(() => null),
        apiCall("/api/v1/members/me/profile-completeness", { signal }).catch(() => null),
        // Sourcing paired connector count from the canonical connections/status
        // endpoint (paired_count field), not profile-completeness.pairings_count
        // which counts stream consents rather than paired connectors.
        apiCall("/api/v1/me/connections/status", { signal }).catch(() => null),
      ]),
  );
  if (stepsWait.cancelled) return;
  const [quotaResp, profileResp, connectionsResp] = stepsWait.result!;

  let emailVerified = false;
  if (quotaResp?.ok) {
    const quota = (await quotaResp.json()) as QuotaResponse;
    emailVerified = quota.email_verified ?? false;
  }

  let profile: ProfileCompleteness | null = null;
  if (profileResp?.ok) {
    profile = (await profileResp.json()) as ProfileCompleteness;
  }

  // Source count must reconcile with what `alter pair status` reports as live.
  // The connections/status summary exposes TWO counts:
  //   paired_count = ALL connection rows, INCLUDING disconnected ones
  //   active_count = only rows with disconnected_at == null (currently live)
  // The previous code read paired_count, so a member with one live GitHub
  // connector plus a stale/disconnected row saw "2 sources connected" while
  // pair status showed "1 active connection" - the reported mismatch. We read
  // active_count so the Discovery tally matches the live paired-connector count
  // pair status surfaces. Fall back to profile.pairings_count only when the
  // connections endpoint is unavailable.
  let pairingsCount = profile?.pairings_count ?? 0;
  if (connectionsResp?.ok) {
    type ConnectionsSummaryWrapper = {
      summary?: { active_count?: number; paired_count?: number };
    };
    const connData = (await connectionsResp.json()) as ConnectionsSummaryWrapper;
    // Prefer active_count (live connectors); fall back to paired_count, then to
    // the profile-completeness value, so the count never silently degrades.
    pairingsCount =
      connData?.summary?.active_count ??
      connData?.summary?.paired_count ??
      pairingsCount;
  }

  const wireState = readWireState();
  const wiredCount =
    wireState?.targets?.filter(
      (t) => t.status === "written" || t.status === "already-wired",
    ).length ?? 0;
  const toolsWired = wiredCount > 0;

  let streamConsentCount = 0;
  const consentWait = await withLoadingCancel(async (signal) => {
    try {
      const merged = await fetchMergedConsent(signal);
      return merged.stream_consents?.length ?? 0;
    } catch {
      // consent fetch failed - show as incomplete
      return 0;
    }
  });
  if (consentWait.cancelled) return;
  streamConsentCount = consentWait.result ?? 0;

  const steps: DiscoveryStep[] = [
    {
      key: "email",
      label: "Email verified",
      done: emailVerified,
      detail: emailVerified
        ? "verified"
        : "unverified; blocks query earnings",
    },
    {
      key: "tools",
      label: "~Alter in your workflow",
      done: toolsWired,
      detail: toolsWired
        ? `${wiredCount} client${wiredCount === 1 ? "" : "s"} wired`
        : "no MCP clients connected",
    },
    {
      key: "sources",
      label: "Identity sources paired",
      done: pairingsCount > 0,
      detail:
        pairingsCount > 0
          ? `${pairingsCount} source${pairingsCount === 1 ? "" : "s"} connected`
          : "pair sources to substantiate traits",
    },
    {
      key: "consent",
      label: "Stream consent",
      done: streamConsentCount > 0,
      detail:
        streamConsentCount > 0
          ? `${streamConsentCount} stream${streamConsentCount === 1 ? "" : "s"} consented`
          : "grant consent so paired data flows",
    },
  ];

  const doneCount = steps.filter((s) => s.done).length;
  const allDone = doneCount === steps.length;

  process.stdout.write("\n");
  process.stdout.write("  " + brand.titleDim("Discovery") + "\n\n");

  const pct = Math.round((doneCount / steps.length) * 100);
  const barLen = 20;
  const filled = Math.round((pct / 100) * barLen);
  const bar =
    brand.accent("█".repeat(filled)) +
    brand.faint("░".repeat(barLen - filled));

  process.stdout.write(
    "  " + bar + "  " + brand.text(`${pct}%`) + "\n\n",
  );

  for (const step of steps) {
    const icon = step.done ? brand.accent("done") : brand.dim("todo");
    process.stdout.write(
      "  " +
        icon +
        "  " +
        brand.text(step.label) +
        "  " +
        brand.faint(step.detail) +
        "\n",
    );
  }
  process.stdout.write("\n");

  if (allDone) {
    process.stdout.write(
      "  " +
        brand.accent("You're set.") +
        " " +
        brand.text(
          "~Alter is in your workflow. Your traits build as you work.",
        ) +
        "\n\n",
    );
    return;
  }

  const incomplete = steps.filter((s) => !s.done);
  const choice = await pickOne({
    message: "Complete a step",
    options: [
      ...incomplete.map((s) => ({
        value: s.key,
        label: s.label,
        hint: s.detail,
      })),
      { value: "back", label: "Back" },
    ],
  });

  if (choice === null || choice === "back") return;

  switch (choice) {
    case "email":
      await _verifyEmail();
      break;
    case "tools":
      await wire([]);
      break;
    case "sources":
      await pairInteractive(null);
      break;
    case "consent": {
      process.stdout.write(
        "\n  " +
          brand.text("Stream consent controls which paired sources feed your trait vector.") +
          "\n" +
          "  " +
          brand.dim("Navigate to Devs & agents > Source sharing to manage per-stream grants.") +
          "\n\n",
      );
      break;
    }
  }
}

async function _verifyEmail(): Promise<void> {
  const reqWait = await withLoadingCancel(
    (signal) =>
      apiCall("/api/v1/auth/verify-email/request", {
        method: "POST",
        signal,
      }),
    "requesting code",
  );
  if (reqWait.cancelled) return;
  const reqResp = reqWait.result;

  if (!reqResp) {
    process.stdout.write(
      "\n  " + brand.accentDeep("Session expired. Run 'alter login'.") + "\n\n",
    );
    return;
  }

  if (reqResp.ok) {
    const body = (await reqResp.json()) as Record<string, string>;
    if (body.status === "already_verified") {
      process.stdout.write(
        "\n  " + brand.accent("Already verified.") + "\n\n",
      );
      return;
    }
  } else if (reqResp.status === 429) {
    process.stdout.write(
      "\n  " +
        brand.accentDeep("Rate limited - try again in a few minutes.") +
        "\n\n",
    );
    return;
  } else if (reqResp.status === 404) {
    process.stdout.write(
      "\n  " +
        brand.faint("Email verification endpoint not available yet.") +
        "\n\n",
    );
    return;
  }

  process.stdout.write(
    "\n  " + brand.text("A 6-digit code has been sent to your email.") + "\n\n",
  );

  const codeInput = await textInput({
    message: "Enter verification code",
    placeholder: "123456",
    validate: (v) => {
      if (!/^\d{6}$/.test(v.trim())) return "Enter the 6-digit code";
      return undefined;
    },
  });

  if (codeInput === null) return;

  const confirmWait = await withLoadingCancel(
    (signal) =>
      apiCall("/api/v1/auth/verify-email/confirm", {
        method: "POST",
        body: { code: codeInput.trim() },
        signal,
      }),
    "verifying",
  );
  if (confirmWait.cancelled) {
    process.stdout.write(
      "\n  " + brand.dim("Cancelled. Run 'alter status' to check whether the email verified.") + "\n\n",
    );
    return;
  }
  const confirmResp = confirmWait.result;

  if (confirmResp?.ok) {
    process.stdout.write(
      "\n  " + brand.accent("Email verified.") + "\n\n",
    );
  } else {
    const detail =
      confirmResp?.status === 403
        ? "Invalid code. Check your email and try again."
        : `Verification failed (${confirmResp?.status ?? "?"}).`;
    process.stdout.write(
      "\n  " + brand.accentDeep(detail) + "\n\n",
    );
  }
}
