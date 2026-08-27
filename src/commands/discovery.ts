/**
 * alter discovery - choose, on your terms, what an identity-field caller
 * can see of you.
 *
 * The companion write-surface to `alter ask` (which queries the field).
 * Discovery is graduated, per-attribute consent: for each attribute you
 * pick how much a `query_field` caller may resolve, from `hidden` (not
 * surfaced at all) up to `exact` (the literal value). Alter is identity
 * infrastructure; your identity record stays yours - discovery is you
 * deciding which parts of it are legible to a paying caller, and earning
 * a share of the query when they read you.
 *
 * Wraps two member-authenticated endpoints (same Bearer-JWT base the rest
 * of the CLI uses):
 *   GET /me/field-discovery  -> { enabled, contexts, grants }
 *   PUT /me/field-discovery  -> accepts the same shape (partial); returns
 *                               the updated config.
 *
 * Subcommands:
 *   alter discovery status                  GET + render config
 *   alter discovery enable [--context <c>]  PUT { enabled:true, contexts }
 *   alter discovery disable                 PUT { enabled:false }
 *   alter discovery set <attr> <level>      PUT a single grant
 *   alter discovery preset <name>           bulk-apply a documented recipe
 *   alter discovery preview                 what a caller sees + your income
 *   alter discovery --help                  usage
 *
 * Levels are ordinal: hidden < match_only < tier_label < exact. The CLI
 * validates a requested level against the attribute's documented maximum
 * client-side (so you get a friendly error before a round-trip) - but the
 * backend remains the final authority.
 *
 * Requires `alter login`. The query_field tool a caller pays for is priced
 * at L5 ($1.00 USD/call); members who surface for a query share the
 * cooperative pool - see `alter discovery preview`.
 */

import { apiCall, failNotLoggedIn, getSession } from "../auth.js";
import { confirmYesNo } from "../ui/picker.js";
import { fetchLivePricing } from "../lib/pricing-reference.js";

// ---------------------------------------------------------------------------
// Levels + attribute model
// ---------------------------------------------------------------------------

/** Ordinal disclosure levels, weakest -> strongest. */
export const LEVELS = ["hidden", "match_only", "tier_label", "exact"] as const;
export type Level = (typeof LEVELS)[number];

export const LEVEL_RANK: Record<Level, number> = {
  hidden: 0,
  match_only: 1,
  tier_label: 2,
  exact: 3,
};

/** One-line, member-facing gloss for each level. */
const LEVEL_GLOSS: Record<Level, string> = {
  hidden: "not surfaced at all",
  match_only: "counts toward ranking; value never shown",
  tier_label: "a banded label (e.g. high / established), never the raw value",
  exact: "the literal value",
};

/** Discovery contexts a member can opt into. */
export const CONTEXTS = [
  "peer_recognition",
  "collaboration_fit",
  "co_founder_signal",
] as const;
export type Context = (typeof CONTEXTS)[number];

/** Attribute groups for rendering + their per-attribute level ceilings. */
interface AttrDef {
  key: string;
  /** Maximum level this attribute may be raised to. */
  max: Level;
  /**
   * For attributes that aren't a plain hidden..max ladder. `contact`
   * (email) is hidden-or-exact only - there is no useful banded form of
   * an email address.
   */
  allowed?: Level[];
  label: string;
}

interface AttrGroup {
  group: string;
  attrs: AttrDef[];
}

/**
 * The configurable surface. Mirrors the pinned PUT/GET contract. Economic
 * attributes (wallet / earnings) are deliberately ABSENT - they are never
 * field-discoverable and must never appear as an option here.
 */
export const ATTRIBUTE_GROUPS: AttrGroup[] = [
  {
    group: "Identity",
    attrs: [
      { key: "handle", max: "exact", label: "~handle" },
      { key: "display_name", max: "exact", label: "Display name" },
      { key: "pronouns", max: "exact", label: "Pronouns" },
    ],
  },
  {
    group: "Contact",
    attrs: [
      {
        key: "email",
        max: "exact",
        allowed: ["hidden", "exact"],
        label: "Email",
      },
    ],
  },
  {
    group: "Location & eligibility",
    attrs: [
      { key: "location_country", max: "exact", label: "Country" },
      { key: "location_state", max: "exact", label: "State / region" },
      { key: "work_authorization", max: "exact", label: "Work authorisation" },
      { key: "security_clearance", max: "exact", label: "Security clearance" },
    ],
  },
  {
    group: "Professional",
    attrs: [
      { key: "current_role", max: "exact", label: "Current role" },
      { key: "current_industry", max: "exact", label: "Current industry" },
      { key: "years_experience", max: "exact", label: "Years of experience" },
      { key: "education_level", max: "exact", label: "Education level" },
    ],
  },
  {
    group: "Traits (the five categories)",
    attrs: [
      { key: "adaptive_capacity", max: "tier_label", label: "Adaptive capacity" },
      { key: "cognitive_style", max: "tier_label", label: "Cognitive style" },
      {
        key: "interpersonal_orientation",
        max: "tier_label",
        label: "Interpersonal orientation",
      },
      { key: "drive_architecture", max: "tier_label", label: "Drive architecture" },
      { key: "integrity_trust", max: "tier_label", label: "Integrity & trust" },
    ],
  },
  {
    group: "Derived",
    attrs: [
      { key: "github_username", max: "exact", label: "GitHub username" },
      { key: "skills", max: "exact", label: "Skills" },
      { key: "portfolio", max: "exact", label: "Portfolio" },
      { key: "seats", max: "exact", label: "Seats" },
    ],
  },
];

/** Flat index: attribute key -> its definition. */
const ATTR_INDEX: Map<string, AttrDef> = (() => {
  const m = new Map<string, AttrDef>();
  for (const g of ATTRIBUTE_GROUPS) for (const a of g.attrs) m.set(a.key, a);
  return m;
})();

/** Allowed level ladder for an attribute (hidden..max, minus gaps). */
export function allowedLevelsFor(def: AttrDef): Level[] {
  if (def.allowed) return def.allowed;
  const ceil = LEVEL_RANK[def.max];
  return LEVELS.filter((l) => LEVEL_RANK[l] <= ceil);
}

// ---------------------------------------------------------------------------
// Wire types (mirror the GET/PUT contract)
// ---------------------------------------------------------------------------

interface Grant {
  level: string;
  provenance?: string[];
}

export interface DiscoveryConfig {
  enabled: boolean;
  contexts: string[];
  grants: Record<string, Grant>;
}

const ENDPOINT = "/api/v1/members/me/field-discovery";


// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

function isLevel(v: unknown): v is Level {
  return typeof v === "string" && (LEVELS as readonly string[]).includes(v);
}

/** Normalise an arbitrary backend body into a DiscoveryConfig, or null. */
export function parseConfig(data: unknown): DiscoveryConfig | null {
  if (data === null || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  const enabled = o.enabled;
  if (typeof enabled !== "boolean") return null;
  const contexts = Array.isArray(o.contexts)
    ? o.contexts.filter((c): c is string => typeof c === "string")
    : [];
  const grants: Record<string, Grant> = {};
  if (o.grants && typeof o.grants === "object") {
    for (const [k, v] of Object.entries(o.grants as Record<string, unknown>)) {
      if (v && typeof v === "object") {
        const lvl = (v as Record<string, unknown>).level;
        const prov = (v as Record<string, unknown>).provenance;
        grants[k] = {
          level: typeof lvl === "string" ? lvl : "hidden",
          provenance: Array.isArray(prov)
            ? prov.filter((p): p is string => typeof p === "string")
            : undefined,
        };
      }
    }
  }
  return { enabled, contexts, grants };
}

/** Map a non-ok response to a friendly stderr line and set exitCode. */
async function failResponse(resp: Response | null): Promise<void> {
  if (!resp) {
    console.error(
      "alter discovery: not authenticated. Run 'alter login' first.",
    );
    process.exitCode = 1;
    return;
  }
  if (resp.status === 401 || resp.status === 403) {
    console.error(
      "alter discovery: session expired or unauthorized. Run 'alter login' to re-authenticate.",
    );
    process.exitCode = 1;
    return;
  }
  if (resp.status === 400 || resp.status === 422) {
    const b = (await resp.json().catch(() => ({}))) as { detail?: string };
    console.error(`alter discovery: ${b.detail ?? "the server rejected the change."}`);
    process.exitCode = 1;
    return;
  }
  if (resp.status === 404 || resp.status === 501) {
    console.error(
      "alter discovery: field discovery isn't enabled yet server-side. Your\n" +
        "request was validated but no config was read or written.",
    );
    process.exitCode = 1;
    return;
  }
  if (resp.status >= 500) {
    console.error(`alter discovery: server error (${resp.status} ${resp.statusText}).`);
    process.exitCode = 1;
    return;
  }
  console.error(`alter discovery: request failed (${resp.status} ${resp.statusText}).`);
  process.exitCode = 1;
}

/** GET the live config, returning null (after setting exitCode) on any failure. */
async function getConfig(): Promise<DiscoveryConfig | null> {
  const resp = await apiCall(ENDPOINT, { method: "GET" });
  if (!resp || !resp.ok) {
    await failResponse(resp);
    return null;
  }
  const data = await resp.json().catch(() => null);
  const cfg = parseConfig(data);
  if (!cfg) {
    console.error("alter discovery: malformed response from backend.");
    process.exitCode = 1;
    return null;
  }
  return cfg;
}

/** PUT a (partial) config and return the backend's updated view, or null on failure. */
async function putConfig(
  patch: Partial<DiscoveryConfig> & { grants?: Record<string, Grant> },
): Promise<DiscoveryConfig | null> {
  const resp = await apiCall(ENDPOINT, { method: "PUT", body: patch });
  if (!resp || !resp.ok) {
    await failResponse(resp);
    return null;
  }
  const data = await resp.json().catch(() => null);
  const cfg = parseConfig(data);
  if (!cfg) {
    console.error("alter discovery: malformed response from backend.");
    process.exitCode = 1;
    return null;
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Effective level for an attribute given a config (default hidden). */
function effectiveLevel(cfg: DiscoveryConfig, key: string): string {
  return cfg.grants[key]?.level ?? "hidden";
}

function renderContexts(contexts: string[]): string {
  if (contexts.length === 0) return "(none - discovery has no active contexts)";
  return contexts.join(", ");
}

/** The grouped per-attribute table shown by `status`. */
function renderAttributeTable(cfg: DiscoveryConfig): void {
  // Pad the label column to the widest label across all groups.
  let widest = 0;
  for (const g of ATTRIBUTE_GROUPS)
    for (const a of g.attrs) widest = Math.max(widest, a.label.length);
  for (const g of ATTRIBUTE_GROUPS) {
    console.log(`  ${g.group}`);
    for (const a of g.attrs) {
      const lvl = effectiveLevel(cfg, a.key);
      const gloss = isLevel(lvl) ? LEVEL_GLOSS[lvl] : "";
      console.log(
        `    ${a.label.padEnd(widest)}  ${lvl.padEnd(11)}  ${gloss}`,
      );
    }
    console.log("");
  }
}

function renderStatus(cfg: DiscoveryConfig): void {
  console.log("");
  console.log("  Field discovery");
  console.log("  ===============");
  console.log("");
  console.log(`  Discoverable:  ${cfg.enabled ? "yes" : "no"}`);
  console.log(`  Contexts:      ${renderContexts(cfg.contexts)}`);
  console.log("");
  if (!cfg.enabled) {
    console.log("  You are NOT in the field. No caller can resolve any attribute");
    console.log("  of you until you run 'alter discovery enable'.");
    console.log("");
  }
  console.log("  Per-attribute disclosure");
  console.log("  ------------------------");
  console.log("  (Levels: hidden < match_only < tier_label < exact)");
  console.log("");
  renderAttributeTable(cfg);
  console.log("  Raise an attribute:   alter discovery set <attribute> <level>");
  console.log("  Apply a recipe:       alter discovery preset <minimal|recognition|open>");
  console.log("  See what a caller gets: alter discovery preview");
  console.log("");
}

// ---------------------------------------------------------------------------
// Presets (documented recipes)
// ---------------------------------------------------------------------------

interface Preset {
  name: string;
  blurb: string;
  /** Explicit per-attribute levels this recipe sets. */
  grants: Record<string, Level>;
}

/** Build a grants map setting every trait category to one level. */
function allTraits(level: Level): Record<string, Level> {
  return {
    adaptive_capacity: level,
    cognitive_style: level,
    interpersonal_orientation: level,
    drive_architecture: level,
    integrity_trust: level,
  };
}

export const PRESETS: Record<string, Preset> = {
  minimal: {
    name: "minimal",
    blurb:
      "Maximally private but still rankable: every attribute hidden, the five\n" +
      "  trait categories at match_only (they count toward ranking but are never shown).",
    grants: { ...allTraits("match_only") },
  },
  recognition: {
    name: "recognition",
    blurb:
      "Be recognisable by name with banded traits, contact stays private:\n" +
      "  ~handle exact, the five trait categories at tier_label, email hidden.",
    grants: {
      handle: "exact",
      ...allTraits("tier_label"),
      email: "hidden",
    },
  },
  open: {
    name: "open",
    blurb:
      "Open field presence - identity + professional + traits exposed,\n" +
      "  contact still private: identity & professional attributes at exact,\n" +
      "  the five trait categories at tier_label, email hidden.",
    grants: {
      handle: "exact",
      display_name: "exact",
      pronouns: "exact",
      location_country: "exact",
      location_state: "exact",
      work_authorization: "exact",
      security_clearance: "exact",
      current_role: "exact",
      current_industry: "exact",
      years_experience: "exact",
      education_level: "exact",
      ...allTraits("tier_label"),
      email: "hidden",
    },
  },
};

// ---------------------------------------------------------------------------
// Confirmation helper (mirrors the consent.ts y/N pattern)
// ---------------------------------------------------------------------------

async function askConfirm(question: string): Promise<boolean> {
  // Non-interactive (piped / CI): require an explicit --yes rather than
  // hanging on stdin that never arrives.
  if (!process.stdin.isTTY) {
    console.log(`${question} (no TTY - pass --yes to confirm) - cancelled.`);
    return false;
  }
  // Esc-aware confirm: a raw `stdin.once("data")` in cooked mode left Esc a
  // dead key from the menu (the prompt trapped the user at [y/N] until n+Enter
  // or Ctrl-C). confirmYesNo reads keys directly so Esc cancels.
  const answer = await confirmYesNo({ message: question, initialValue: false });
  return answer === true; // Esc→null and No both → false; Enter defaults No, matching [y/N]
}

// ---------------------------------------------------------------------------
// Subcommand: status
// ---------------------------------------------------------------------------

async function cmdStatus(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const cfg = await getConfig();
  if (!cfg) return;
  if (json) {
    process.stdout.write(JSON.stringify(cfg, null, 2) + "\n");
    return;
  }
  renderStatus(cfg);
}

// ---------------------------------------------------------------------------
// Subcommand: enable / disable
// ---------------------------------------------------------------------------

/** Collect repeated --context <c> flags; validate against CONTEXTS. */
export function parseContexts(args: string[]): {
  contexts: string[];
  error?: string;
} {
  const contexts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--context") {
      const v = args[++i];
      if (!v) return { contexts, error: "--context requires a value" };
      if (!(CONTEXTS as readonly string[]).includes(v)) {
        return {
          contexts,
          error: `unknown context '${v}'. Valid: ${CONTEXTS.join(", ")}`,
        };
      }
      contexts.push(v);
    } else if (a.startsWith("--context=")) {
      const v = a.slice("--context=".length);
      if (!(CONTEXTS as readonly string[]).includes(v)) {
        return {
          contexts,
          error: `unknown context '${v}'. Valid: ${CONTEXTS.join(", ")}`,
        };
      }
      contexts.push(v);
    } else if (a === "--json") {
      continue;
    } else {
      return { contexts, error: `unknown flag: ${a}` };
    }
  }
  return { contexts };
}

async function cmdEnable(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const { contexts, error } = parseContexts(args);
  if (error) {
    console.error(`alter discovery enable: ${error}`);
    process.exitCode = 1;
    return;
  }
  // Default to all contexts when none named - "enable" should mean "be
  // findable", not "be findable in zero contexts".
  const chosen = contexts.length > 0 ? contexts : [...CONTEXTS];
  const cfg = await putConfig({ enabled: true, contexts: chosen });
  if (!cfg) return;
  if (json) {
    process.stdout.write(JSON.stringify(cfg, null, 2) + "\n");
    return;
  }
  console.log("");
  console.log("  You're now discoverable in the field.");
  console.log(`  Contexts: ${renderContexts(cfg.contexts)}`);
  console.log("");
  console.log("  With no attributes raised, the server applies the");
  console.log("  max-private-but-rankable default: your trait categories are");
  console.log("  match_only (they let a query rank you) and everything else is");
  console.log("  hidden. You're rankable; nothing else is revealed until you");
  console.log("  raise an attribute with 'alter discovery set'.");
  console.log("");
  console.log("  See exactly what a caller would get: alter discovery preview");
  console.log("");
}

async function cmdDisable(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const cfg = await putConfig({ enabled: false });
  if (!cfg) return;
  if (json) {
    process.stdout.write(JSON.stringify(cfg, null, 2) + "\n");
    return;
  }
  console.log("");
  console.log("  You're out of the field. No caller can resolve any attribute");
  console.log("  of you. Your saved per-attribute levels are kept - re-enable");
  console.log("  any time with 'alter discovery enable'.");
  console.log("");
}

// ---------------------------------------------------------------------------
// Subcommand: set <attribute> <level>
// ---------------------------------------------------------------------------

/**
 * Validate a single set request client-side. Returns the friendly error
 * string, or null when the (attribute, level) pair is acceptable. The
 * backend remains the final authority - this is the early, friendly gate.
 */
export function validateSet(attribute: string, level: string): string | null {
  const def = ATTR_INDEX.get(attribute);
  if (!def) {
    const known = [...ATTR_INDEX.keys()].join(", ");
    return `unknown attribute '${attribute}'.\nKnown attributes: ${known}`;
  }
  if (!isLevel(level)) {
    return `unknown level '${level}'. Valid levels: ${LEVELS.join(" < ")}`;
  }
  const allowed = allowedLevelsFor(def);
  if (!allowed.includes(level)) {
    if (def.allowed) {
      return `${def.label} (${attribute}) can only be ${def.allowed.join(" or ")}.`;
    }
    return `${def.label} (${attribute}) can be raised at most to ${def.max} - '${level}' exceeds that.`;
  }
  return null;
}

async function cmdSet(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const positionals = args.filter((a) => !a.startsWith("-"));
  const [attribute, level] = positionals;
  if (!attribute || !level) {
    console.error(
      "alter discovery set: usage: alter discovery set <attribute> <level>\n" +
        `Levels: ${LEVELS.join(" < ")}\n` +
        "Run 'alter discovery status' to see attributes and their ceilings.",
    );
    process.exitCode = 1;
    return;
  }
  const err = validateSet(attribute, level);
  if (err) {
    console.error(`alter discovery set: ${err}`);
    process.exitCode = 1;
    return;
  }
  // Partial PUT: a single grant. The backend merges it into the live map.
  const cfg = await putConfig({ grants: { [attribute]: { level } } });
  if (!cfg) return;
  if (json) {
    process.stdout.write(JSON.stringify(cfg, null, 2) + "\n");
    return;
  }
  const applied = effectiveLevel(cfg, attribute);
  const def = ATTR_INDEX.get(attribute)!;
  console.log("");
  console.log(`  ${def.label} (${attribute}) is now: ${applied}`);
  if (isLevel(applied)) console.log(`    ${LEVEL_GLOSS[applied]}`);
  if (!cfg.enabled) {
    console.log("");
    console.log("  Note: you're not yet discoverable - run 'alter discovery enable'");
    console.log("  for this to take effect.");
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// Subcommand: preset <name>
// ---------------------------------------------------------------------------

function describePreset(p: Preset): void {
  console.log("");
  console.log(`  Preset: ${p.name}`);
  console.log(`  ${p.blurb}`);
  console.log("");
  console.log("  This sets:");
  // Print every attribute the preset touches; everything else stays hidden.
  for (const g of ATTRIBUTE_GROUPS) {
    const rows = g.attrs.filter((a) => p.grants[a.key] !== undefined);
    if (rows.length === 0) continue;
    for (const a of rows) {
      console.log(`    ${a.label.padEnd(22)} -> ${p.grants[a.key]}`);
    }
  }
  console.log("    (every other attribute -> hidden)");
  console.log("");
}

async function cmdPreset(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const yes = args.includes("--yes") || args.includes("-y");
  const name = args.find((a) => !a.startsWith("-"));
  if (!name || !PRESETS[name]) {
    console.error(
      "alter discovery preset: usage: alter discovery preset <minimal|recognition|open>\n" +
        "\n" +
        "  minimal      all hidden; the five trait categories at match_only\n" +
        "  recognition  ~handle exact; traits tier_label; contact hidden\n" +
        "  open         identity + professional + traits exposed; contact hidden",
    );
    process.exitCode = 1;
    return;
  }
  const preset = PRESETS[name];
  // Print exactly what it sets BEFORE applying.
  describePreset(preset);
  if (!yes) {
    const confirmed = await askConfirm(`  Apply the '${preset.name}' preset?`);
    if (!confirmed) {
      console.log("  Cancelled.");
      console.log("");
      return;
    }
  }
  // Build a full grants patch from the preset's explicit levels.
  const grants: Record<string, Grant> = {};
  for (const [k, v] of Object.entries(preset.grants)) grants[k] = { level: v };
  const cfg = await putConfig({ grants });
  if (!cfg) return;
  if (json) {
    process.stdout.write(JSON.stringify(cfg, null, 2) + "\n");
    return;
  }
  console.log(`  Applied preset '${preset.name}'.`);
  console.log("  Run 'alter discovery status' to confirm, or");
  console.log("  'alter discovery preview' to see what a caller gets.");
  console.log("");
}

// ---------------------------------------------------------------------------
// Subcommand: preview
// ---------------------------------------------------------------------------

/** Render what a caller resolves for one attribute at a given level. */
function previewValueLine(def: AttrDef, level: string): string | null {
  if (level === "hidden") return null;
  if (level === "match_only") {
    return `${def.label}: (contributes to ranking; value withheld)`;
  }
  if (level === "tier_label") {
    return `${def.label}: <banded label>`;
  }
  // exact
  return `${def.label}: <your ${def.label.toLowerCase()}>`;
}

function renderPreview(cfg: DiscoveryConfig, pricing: { queryFieldPrice: number; cooperativePoolShare: number; live: boolean }): void {
  console.log("");
  console.log("  Field preview - what an open-field caller sees");
  console.log("  ==============================================");
  console.log("");
  if (!cfg.enabled) {
    console.log("  You are not discoverable. A caller resolves nothing about you.");
    console.log("  Run 'alter discovery enable' to enter the field.");
    console.log("");
    return;
  }
  const contexts = cfg.contexts.length > 0 ? cfg.contexts : [...CONTEXTS];
  for (const ctx of contexts) {
    console.log(`  Context: ${ctx}`);
    console.log(`  ${"-".repeat(40)}`);
    let any = false;
    for (const g of ATTRIBUTE_GROUPS) {
      for (const a of g.attrs) {
        const lvl = effectiveLevel(cfg, a.key);
        const line = previewValueLine(a, lvl);
        if (line) {
          console.log(`    ${line}`);
          any = true;
        }
      }
    }
    if (!any) {
      console.log("    (nothing surfaced - you are rankable but fully private)");
    }
    console.log("");
  }
  // Identity Income transparency.
  const poolMax = (pricing.queryFieldPrice * pricing.cooperativePoolShare).toFixed(2);
  const indicator = pricing.live ? "" : " (reference rate, field unreachable)";
  console.log("  Your Identity Income per surfaced query");
  console.log("  ---------------------------------------");
  console.log(
    `  A query_field call costs the caller $${pricing.queryFieldPrice.toFixed(2)} (L5)${indicator}. When you`,
  );
  console.log(
    `  surface in a query, you share the cooperative pool - ${Math.round(
      pricing.cooperativePoolShare * 100,
    )}% of the call`,
  );
  console.log(
    `  price, split across everyone who surfaces. You earn ~$ up to ${poolMax}`,
  );
  console.log("  per query, depending on how many others surface alongside you.");
  console.log("");
}

async function cmdPreview(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const [cfg, pricing] = await Promise.all([getConfig(), fetchLivePricing()]);
  if (!cfg) return;
  if (json) {
    const contexts = cfg.contexts.length > 0 ? cfg.contexts : [...CONTEXTS];
    const surfaced: Record<string, string> = {};
    for (const g of ATTRIBUTE_GROUPS)
      for (const a of g.attrs) {
        const lvl = effectiveLevel(cfg, a.key);
        if (lvl !== "hidden") surfaced[a.key] = lvl;
      }
    process.stdout.write(
      JSON.stringify(
        {
          enabled: cfg.enabled,
          contexts,
          surfaced,
          income: {
            query_price_usd: pricing.queryFieldPrice,
            cooperative_pool_share: pricing.cooperativePoolShare,
            max_per_query_usd: Number(
              (pricing.queryFieldPrice * pricing.cooperativePoolShare).toFixed(2),
            ),
            live: pricing.live,
          },
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }
  renderPreview(cfg, pricing);
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(
    "Usage: alter discovery <subcommand>\n" +
      "\n" +
      "Choose, on your terms, what an identity-field caller can see of you.\n" +
      "Discovery is graduated per-attribute consent: for each attribute you pick\n" +
      "how much a query_field caller may resolve - from hidden up to exact.\n" +
      "\n" +
      "Levels (ordinal):  hidden < match_only < tier_label < exact\n" +
      "  hidden       not surfaced at all\n" +
      "  match_only   counts toward ranking; the value is never shown\n" +
      "  tier_label   a banded label (e.g. high), never the raw value\n" +
      "  exact        the literal value\n" +
      "\n" +
      "Subcommands:\n" +
      "  status                       Show enabled state, contexts, per-attribute levels.\n" +
      "  enable [--context <c>]...    Enter the field (default: all contexts).\n" +
      "  disable                      Leave the field (your levels are kept).\n" +
      "  set <attribute> <level>      Raise/lower one attribute.\n" +
      "  preset <name>                Apply a recipe (minimal | recognition | open).\n" +
      "  preview                      See exactly what a caller gets + your Identity Income.\n" +
      "\n" +
      `Contexts:  ${CONTEXTS.join(", ")}\n` +
      "\n" +
      "Flags:\n" +
      "  --json    Emit the resulting config as JSON (status/enable/disable/set/preset/preview).\n" +
      "  --yes     Skip the confirmation prompt (preset).\n" +
      "  --help    Show this message.\n" +
      "\n" +
      "Requires a signed-in session - run 'alter login' first. A query_field call\n" +
      "is priced at $1.00 (L5); surfaced members share the cooperative pool.\n",
  );
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function discovery(args: string[] = []): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    printHelp();
    return;
  }

  // Subcommands all hit the network, so gate on a session up front - except
  // help, handled above.
  if (!getSession()) {
    failNotLoggedIn();
    return;
  }

  const rest = args.slice(1);
  switch (sub) {
    case "status":
      await cmdStatus(rest);
      return;
    case "enable":
      await cmdEnable(rest);
      return;
    case "disable":
      await cmdDisable(rest);
      return;
    case "set":
      await cmdSet(rest);
      return;
    case "preset":
      await cmdPreset(rest);
      return;
    case "preview":
      await cmdPreview(rest);
      return;
    default:
      console.error(`alter discovery: unknown subcommand '${sub}'.`);
      printHelp();
      process.exitCode = 1;
      return;
  }
}
