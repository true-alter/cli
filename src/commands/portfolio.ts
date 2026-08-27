/**
 * alter portfolio - your verified identity record (member self-read).
 *
 * Wraps `GET /api/v1/members/me/portfolio`. This is the ACHIEVEMENTS /
 * ATTESTATIONS view: category trait tiers, data completeness, and the
 * (future) attested surfaces. It answers "what has been verified about
 * me". No x402, no consent gateway - member self-read.
 *
 * Sibling view: `alter style` (style.ts) answers a different question -
 * "HOW do I think and communicate" (cognitive/communication style). The
 * two are deliberately distinct. `alter portfolio` does NOT print the
 * cognitive-style block, and `alter style` does NOT print the trait
 * portfolio. Only the consolidated menu entry (identityProfile) shows
 * both together.
 *
 * Belonging probability is org-anchored by construction and is NOT
 * surfaced here; it stays on the x402 path that takes an org_id.
 *
 * Future surfaces (no producer code yet on the backend): org-attested
 * achievements, protocol-observed recognitions, skill verifications,
 * contribution history, side-quest completions.
 *
 * identityProfile() is the consolidated entry point (used by the
 * interactive menu) that merges the portfolio view with the style view.
 * The shared render helpers (renderPortfolio, renderStyle,
 * renderIdentityProfile) all live here; style.ts imports renderStyle and
 * renderIdentityProfile.
 */

import {
  apiCall,
  failNotLoggedIn,
  getSession,
  getSessionInfo,
  NOT_LOGGED_IN_MESSAGE,
} from "../auth.js";
import { emitSessionHeartbeat } from "../lib/active-sessions-emit.js";
import { confidenceTier } from "../lib/cosmetics/confidence-tier.js";
import { withLoadingCancel } from "../ui/biosMenu.js";

interface TraitProfile {
  trait_tiers?: Record<string, string>;
  archetype?: string | null;
  data_completeness?: string;
  [key: string]: unknown;
}

interface PortfolioResponse {
  member_pseudonym?: string;
  trait_profile?: TraitProfile | null;
  archetype?: string | null;
  stripped_traits?: string[];
  portfolio_type?: string;
  status?: string;
  message?: string;
  [key: string]: unknown;
}

interface StyleResponse {
  member_pseudonym?: string;
  style_profile?: Record<string, string>;
  archetype?: string | null;
  archetype_family?: string | null;
  confidence?: number | null;
  phase?: string | null;
  status?: string;
  message?: string;
  [key: string]: unknown;
}

const PORTFOLIO_ENDPOINT = "/api/v1/members/me/portfolio";
const STYLE_ENDPOINT = "/api/v1/members/me/style";

function printHelp(): void {
  console.log(
    "Usage: alter portfolio [--json]\n" +
      "\n" +
      "Your verified identity record: data completeness and category trait\n" +
      "tiers - what has been assessed and attested about you.\n" +
      "\n" +
      "For how you think and communicate, see 'alter style'.\n" +
      "\n" +
      "Options:\n" +
      "  --json     Emit the raw response as JSON for scripting.\n" +
      "  --help     Show this message.\n",
  );
}

function resolveTitle(data: PortfolioResponse | StyleResponse): string {
  // Prefer the bound ~handle over member_pseudonym (which was
  // carrying the raw UUID fragment). Fallback chain: handle → pseudonym → "you".
  // PENDING PRODUCT DECISION (member_pseudonym fallback): leave intact.
  const session = getSessionInfo();
  if (session?.handle) return session.handle;
  return data.member_pseudonym ?? "you";
}

/** Convert snake_case to Title Case for human-readable category labels. */
function humaniseKey(key: string): string {
  return key
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Render an aligned two-column tier list under a given header.
 *
 * Shared by the portfolio trait-tier block and the style block so both
 * align identically. The label column is padded to the widest humanised
 * key, and the tier value sits in a second column with a consistent
 * two-space gutter - this is the alignment fix for the trait-tier line
 * that previously read as misaligned.
 *
 * Returns true if any rows were printed.
 */
function renderTierList(
  header: string,
  entries: [string, string][],
): boolean {
  if (entries.length === 0) return false;

  const humanised = entries.map(
    ([k, v]) => [humaniseKey(k), v] as [string, string],
  );
  const widest = humanised.reduce((max, [k]) => Math.max(max, k.length), 0);

  console.log(`${header}:`);
  for (const [label, tier] of humanised) {
    console.log(`  ${label.padEnd(widest, " ")}  ${tier}`);
  }
  console.log("");
  return true;
}

/**
 * Render the archetype line.
 *
 * PRODUCT DECISION (archetype, 2026-06-03): show only when the backend
 * provides a genuine archetype. When it's null / empty / a "-" placeholder,
 * render nothing rather than a hollow "Archetype: -" line.
 */
function renderArchetype(
  archetype: string | null | undefined,
  archetypeFamily: string | null | undefined,
): void {
  const label = (archetype ?? "").trim();
  if (label === "" || label === "-") return; // no real archetype → hide the line
  const familyLabel = archetypeFamily ? ` (${archetypeFamily})` : "";
  console.log(`Archetype: ${label}${familyLabel}`);
}

/**
 * PORTFOLIO renderer - the verified-record view.
 *
 * Distinct purpose: what has been assessed/attested about the member.
 * Shows data completeness + category trait tiers (+ archetype, pending).
 * Deliberately does NOT print the cognitive/communication style block -
 * that belongs to `alter style`.
 */
export function renderPortfolio(portfolioData: PortfolioResponse | null): void {
  const title = resolveTitle(portfolioData ?? {});
  const incomplete = !portfolioData || portfolioData.status === "incomplete";

  console.log("");
  console.log(`Portfolio - ${title}`);
  console.log("Your verified record: what has been assessed and attested.");
  console.log("");

  // Archetype (pending product decision - left intact).
  const tp = portfolioData?.trait_profile ?? {};
  const archetype = portfolioData?.archetype ?? (tp as TraitProfile).archetype;
  renderArchetype(archetype, null);

  // Data completeness.
  const completeness = (tp as TraitProfile).data_completeness;
  if (completeness) {
    console.log(`Data completeness: ${completeness}`);
  }
  console.log("");

  // Empty-state.
  if (incomplete) {
    const msg =
      portfolioData?.message ??
      "Your portfolio accrues as you act - through Discovery, peer\n" +
        "recognition, side quests, and agents querying you. Nothing to show yet.";
    console.log(msg);
    console.log("");
    return;
  }

  // Category trait tiers (the verified assessment record).
  const traitEntries = Object.entries(
    (tp as TraitProfile).trait_tiers ?? {},
  );
  if (!renderTierList("Category traits", traitEntries)) {
    console.log("Category traits: none assessed yet.");
    console.log("");
  }
}

/**
 * STYLE renderer - the cognitive/communication style view.
 *
 * Distinct purpose: HOW the member thinks and communicates. Shows the
 * archetype + family, assignment confidence, and the style tier dict.
 * Deliberately does NOT print data completeness or the verified-record
 * framing - that belongs to `alter portfolio`.
 */
export function renderStyle(styleData: StyleResponse | null): void {
  const title = resolveTitle(styleData ?? {});
  const incomplete = !styleData || styleData.status === "incomplete";

  console.log("");
  console.log(`Style profile - ${title}`);
  console.log("How you think and communicate.");
  console.log("");

  // Archetype + family (pending product decision - left intact).
  renderArchetype(styleData?.archetype, styleData?.archetype_family);

  // Assignment confidence (tier label, never the raw float).
  const conf = styleData?.confidence;
  if (typeof conf === "number") {
    console.log(`Assignment confidence: ${confidenceTier(conf)}`);
  }
  console.log("");

  // Empty-state.
  if (incomplete) {
    const msg =
      styleData?.message ??
      "Your style profile accrues from what ~Alter reads about how you think and\n" +
        "communicate. Nothing to show yet.";
    console.log(msg);
    console.log("");
    return;
  }

  // Cognitive and communication style tiers.
  const styleEntries = Object.entries(styleData?.style_profile ?? {});
  if (!renderTierList("Cognitive and communication style", styleEntries)) {
    console.log("Cognitive and communication style: none assessed yet.");
    console.log("");
  }
}

/**
 * Consolidated identity-profile renderer (interactive menu only).
 * Accepts the portfolio and style payloads independently; either may be
 * null if the endpoint failed or returned no data (graceful degradation).
 *
 * This view intentionally merges BOTH the portfolio (verified record) and
 * the style (how you think) into one screen for the menu's combined entry.
 * The standalone `alter portfolio` and `alter style` commands render only
 * their own half (renderPortfolio / renderStyle) so they read as distinct.
 *
 * MUST NOT emit "%", "progress", "until", "to next",
 * "to_next", "distance", or "percent" in rendered output.
 */
export function renderIdentityProfile(
  portfolioData: PortfolioResponse | null,
  styleData: StyleResponse | null,
): void {
  // Resolve the display name from whichever payload we have.
  const titleSource: PortfolioResponse | StyleResponse =
    portfolioData ?? styleData ?? {};
  const title = resolveTitle(titleSource);

  const portfolioIncomplete =
    !portfolioData || portfolioData.status === "incomplete";
  const styleIncomplete = !styleData || styleData.status === "incomplete";

  console.log("");
  console.log(`Identity profile - ${title}`);
  console.log("");

  // Archetype (from style, with family; fall back to portfolio).
  // PENDING PRODUCT DECISION (archetype): left intact.
  let archetype: string | null | undefined = styleData?.archetype;
  const archetypeFamily: string | null | undefined =
    styleData?.archetype_family;
  if (!archetype) {
    const tp = portfolioData?.trait_profile ?? {};
    archetype = portfolioData?.archetype ?? (tp as TraitProfile).archetype;
  }
  renderArchetype(archetype, archetypeFamily);

  // Assignment confidence (style only; tier label, not float).
  const conf = styleData?.confidence;
  if (typeof conf === "number") {
    console.log(`Assignment confidence: ${confidenceTier(conf)}`);
  }

  // Data completeness (portfolio only).
  const tp = portfolioData?.trait_profile ?? {};
  const completeness = (tp as TraitProfile).data_completeness;
  if (completeness) {
    console.log(`Data completeness: ${completeness}`);
  }

  console.log("");

  // Empty-state: both endpoints incomplete.
  if (portfolioIncomplete && styleIncomplete) {
    const msg =
      portfolioData?.message ??
      styleData?.message ??
      "Your identity profile accrues as you act - through Discovery, peer\n" +
        "recognition, side quests, and agents querying you. Nothing to show yet.";
    console.log(msg);
    console.log("");
    return;
  }

  // Category trait tiers (portfolio).
  const traitTiers = (tp as TraitProfile).trait_tiers ?? {};
  const traitEntries = Object.entries(traitTiers);
  if (!renderTierList("Category traits", traitEntries) && !portfolioIncomplete) {
    console.log("Category traits: none assessed yet.");
    console.log("");
  }

  // Cognitive and communication style tiers (style endpoint).
  // The /style endpoint can return the same five-category dict as /portfolio
  // when it duplicates the category tiers above, suppress the block
  // rather than echo it verbatim.
  const styleEntries = Object.entries(styleData?.style_profile ?? {});
  const duplicatesCategoryTiers =
    styleEntries.length > 0 &&
    styleEntries.length === traitEntries.length &&
    styleEntries.every(([k, v]) => traitTiers[k] === v);

  if (!duplicatesCategoryTiers) {
    renderTierList("Cognitive and communication style", styleEntries);
  }
}

/**
 * Fetch a single endpoint, returning parsed data or null. On an explicit
 * auth failure (401/403) delegates to the caller-supplied `fail` so that
 * interactive callers can throw instead of exiting.
 */
async function fetchOne<T>(endpoint: string, fail: (msg: string) => void): Promise<{
  data: T | null;
  resp: Response | null;
}> {
  const wait = await withLoadingCancel((signal) =>
    apiCall(endpoint, { signal }).catch(() => null),
  );
  if (wait.cancelled) return { data: null, resp: null };
  const resp = wait.result;
  if (resp && resp.ok) {
    const data = (await resp.json().catch(() => null)) as T | null;
    return { data, resp };
  }
  if (resp && (resp.status === 401 || resp.status === 403)) {
    fail("alter: session not authenticated. Run 'alter login'.");
    return { data: null, resp: null };
  }
  return { data: null, resp };
}

/**
 * Fetch the portfolio endpoint and render the verified-record view.
 * Logged-out gating happens in the entry points (portfolio /
 * identityProfile) via the canonical soft-exit guard, not here.
 */
async function fetchAndRenderPortfolio(jsonMode: boolean, fail: (msg: string) => void): Promise<void> {
  const { data, resp } = await fetchOne<PortfolioResponse>(PORTFOLIO_ENDPOINT, fail);

  if (!data) {
    const portfolioStatus = resp
      ? `${resp.status} ${resp.statusText}`
      : "no response";
    return fail(`alter: could not fetch portfolio (${portfolioStatus}).`);
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    return;
  }

  renderPortfolio(data);
}

/**
 * Fetch the style endpoint and render the cognitive/communication view.
 */
async function fetchAndRenderStyle(jsonMode: boolean, fail: (msg: string) => void): Promise<void> {
  const { data, resp } = await fetchOne<StyleResponse>(STYLE_ENDPOINT, fail);

  if (!data) {
    const styleStatus = resp ? `${resp.status} ${resp.statusText}` : "no response";
    return fail(`alter: could not fetch style profile (${styleStatus}).`);
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    return;
  }

  renderStyle(data);
}

/**
 * Fetch both endpoints and render the consolidated identity profile.
 * Used by the interactive menu's combined entry. Graceful degradation:
 * a failure on one endpoint still renders the other.
 */
async function fetchAndRenderProfile(jsonMode: boolean, fail: (msg: string) => void): Promise<void> {
  // Fetch both endpoints in parallel - one cancellable wait, one spinner,
  // the shared signal aborts both fetches on esc.
  const wait = await withLoadingCancel((signal) =>
    Promise.all([
      apiCall(PORTFOLIO_ENDPOINT, { signal }).catch(() => null),
      apiCall(STYLE_ENDPOINT, { signal }).catch(() => null),
    ]),
  );
  const [portfolioResp, styleResp] = wait.result ?? [null, null];

  // Parse portfolio.
  let portfolioData: PortfolioResponse | null = null;
  if (portfolioResp && portfolioResp.ok) {
    portfolioData = await portfolioResp.json().catch(() => null) as PortfolioResponse | null;
  } else if (portfolioResp && (portfolioResp.status === 401 || portfolioResp.status === 403)) {
    return fail("alter: session not authenticated. Run 'alter login'.");
  }

  // Parse style.
  let styleData: StyleResponse | null = null;
  if (styleResp && styleResp.ok) {
    styleData = await styleResp.json().catch(() => null) as StyleResponse | null;
  } else if (styleResp && (styleResp.status === 401 || styleResp.status === 403)) {
    return fail("alter: session not authenticated. Run 'alter login'.");
  }

  // If both completely failed (non-auth), report and exit.
  if (!portfolioData && !styleData) {
    const portfolioStatus = portfolioResp ? `${portfolioResp.status} ${portfolioResp.statusText}` : "no response";
    const styleStatus = styleResp ? `${styleResp.status} ${styleResp.statusText}` : "no response";
    return fail(
      `alter: could not fetch identity profile (portfolio: ${portfolioStatus}; style: ${styleStatus}).`,
    );
  }

  if (jsonMode) {
    const merged = {
      portfolio: portfolioData,
      style: styleData,
    };
    process.stdout.write(JSON.stringify(merged, null, 2) + "\n");
    return;
  }

  renderIdentityProfile(portfolioData, styleData);
}

/**
 * Consolidated identity-profile entry point consumed by the interactive menu
 * (Unit U2 imports this symbol exactly). Renders BOTH the portfolio and style
 * views in one combined screen.
 */
export async function identityProfile(
  args: string[] = [],
  opts: { interactive?: boolean } = {},
): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  try {
    emitSessionHeartbeat({
      sessionId: String(process.pid),
      workingOn: "alter identity-profile",
    });
  } catch { /* silent - must not block command */ }

  const fail = (message: string): void => {
    if (opts.interactive) throw new Error(message);
    console.error(message);
    process.exitCode = 1;
  };

  // Canonical logged-out guard: soft exit (exit code 1, loop drains) in
  // CLI mode; throw in interactive (menu) mode so the alt-screen survives.
  if (!getSession()) {
    if (opts.interactive) throw new Error(NOT_LOGGED_IN_MESSAGE);
    failNotLoggedIn();
    return;
  }

  const json = args.includes("--json");
  await fetchAndRenderProfile(json, fail);
}

export async function portfolio(
  args: string[] = [],
  opts: { interactive?: boolean } = {},
): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  try {
    emitSessionHeartbeat({
      sessionId: String(process.pid),
      workingOn: "alter portfolio",
    });
  } catch { /* silent - must not block command */ }

  const fail = (message: string): void => {
    if (opts.interactive) throw new Error(message);
    console.error(message);
    process.exitCode = 1;
  };

  // Canonical logged-out guard: soft exit (exit code 1, loop drains) in
  // CLI mode; throw in interactive (menu) mode so the alt-screen survives.
  if (!getSession()) {
    if (opts.interactive) throw new Error(NOT_LOGGED_IN_MESSAGE);
    failNotLoggedIn();
    return;
  }

  const json = args.includes("--json");
  await fetchAndRenderPortfolio(json, fail);
}
