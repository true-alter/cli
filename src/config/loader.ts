/**
 * Layered TOML config loader.
 *
 * Precedence (lowest → highest): defaults → system → user → session.
 * Absent layers fall through silently. The returned `ConfigV1` always
 * has `version = SCHEMA_VERSION`; user-layer files on an older version
 * are migrated in memory (see `migrations/`).
 *
 * Async + lazy by design: `smol-toml` is dynamically imported so commands
 * that never touch config (`alter whoami`, `alter login`, …) do not pay
 * its startup cost. Cold-start budget for `alter` → first render is the
 * measurement the loader must not perturb.
 *
 */

import * as fs from "fs";

import {
  SYSTEM_CONFIG_FILE,
  USER_CONFIG_FILE,
  sessionConfigFile,
} from "./paths.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import {
  SCHEMA_VERSION,
  isCustomPaletteColors,
  isPaletteSelection,
  isSigilAccentGlyph,
  isSigilBorderSet,
  isSigilWordmark,
  type ConfigV1,
  type CustomPaletteColors,
  type HomepageConfig,
  type OpenerConfig,
  type PaletteSelection,
  type SigilConfig,
} from "./schema.js";
import { applyMigrations } from "./migrations/index.js";

type RawTable = Record<string, unknown>;

/**
 * Read and parse a TOML file if it exists. Returns `null` for an
 * absent file; throws on parse errors so the caller can surface a
 * readable error pointing at the offending path.
 */
async function readLayer(filePath: string): Promise<RawTable | null> {
  let contents: string;
  try {
    contents = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw new Error(`failed to read ${filePath}: ${e.message}`);
  }

  const { parse } = await import("smol-toml");
  try {
    return parse(contents) as RawTable;
  } catch (err) {
    const e = err as Error;
    throw new Error(`failed to parse ${filePath}: ${e.message}`);
  }
}

function pickOpener(raw: unknown): OpenerConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as RawTable;
  if (typeof t.line === "string" && t.line.length > 0) {
    return { line: t.line };
  }
  if (typeof t.library === "string" && t.library.length > 0) {
    return { library: t.library };
  }
  return undefined;
}

function pickHomepage(raw: unknown): HomepageConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as RawTable;
  const out: HomepageConfig = {};
  if (typeof t.contact_email === "string" && t.contact_email.length > 0) {
    out.contact_email = t.contact_email;
  }
  if (
    typeof t.contact_email_verified_at === "string" &&
    t.contact_email_verified_at.length > 0
  ) {
    out.contact_email_verified_at = t.contact_email_verified_at;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function pickSigil(raw: unknown): SigilConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const t = raw as RawTable;
  const out: SigilConfig = {};
  if (isSigilBorderSet(t.border_set)) out.border_set = t.border_set;
  if (isSigilWordmark(t.wordmark)) out.wordmark = t.wordmark;
  if (isSigilAccentGlyph(t.accent_glyph)) out.accent_glyph = t.accent_glyph;
  if (
    out.border_set === undefined &&
    out.wordmark === undefined &&
    out.accent_glyph === undefined
  ) {
    return undefined;
  }
  return out;
}

/**
 * Project a migrated raw table onto the typed ConfigV1 surface,
 * discarding fields the schema does not recognise at the top level
 * (unknown tables go into `_passthrough` for round-tripping). Invalid
 * values fall through to defaults rather than throwing - TOML files
 * edited by hand are the primary write path and should fail soft.
 */
function project(raw: RawTable): ConfigV1 {
  const known = new Set([
    "version",
    "palette",
    "custom_palette",
    "opener",
    "sigil",
    "homepage",
  ]);
  const passthrough: RawTable = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!known.has(k)) passthrough[k] = v;
  }

  const palette: PaletteSelection | undefined = isPaletteSelection(raw.palette)
    ? raw.palette
    : undefined;

  const customPalette: CustomPaletteColors | undefined =
    isCustomPaletteColors(raw.custom_palette) ? raw.custom_palette : undefined;

  const out: ConfigV1 = {
    version: SCHEMA_VERSION,
    ...(palette !== undefined ? { palette } : {}),
    ...(customPalette !== undefined ? { custom_palette: customPalette } : {}),
  };

  const opener = pickOpener(raw.opener);
  if (opener !== undefined) out.opener = opener;

  const sigil = pickSigil(raw.sigil);
  if (sigil !== undefined) out.sigil = sigil;

  const homepage = pickHomepage(raw.homepage);
  if (homepage !== undefined) out.homepage = homepage;

  // Subkeys of [homepage] the schema doesn't type yet (whoami, opener,
  // pronouns, sigil - rendered via the legacy passthrough path) round-trip
  // under `_passthrough.homepage`; `serialiseUserConfig` re-merges them
  // with the typed fields on write.
  if (raw.homepage && typeof raw.homepage === "object") {
    const typedKeys = new Set(["contact_email", "contact_email_verified_at"]);
    const untyped: RawTable = {};
    for (const [k, v] of Object.entries(raw.homepage as RawTable)) {
      if (!typedKeys.has(k)) untyped[k] = v;
    }
    if (Object.keys(untyped).length > 0) passthrough.homepage = untyped;
  }

  if (Object.keys(passthrough).length > 0) out._passthrough = passthrough;

  return out;
}

/**
 * Merge a higher layer on top of a lower one. Top-level scalars and
 * leaf objects (opener) replace wholesale; `_passthrough` accumulates
 * so a user layer can add forward-compatible tables without the system
 * layer clobbering them.
 */
function overlay(base: ConfigV1, above: ConfigV1): ConfigV1 {
  const merged: ConfigV1 = { ...base };
  if (above.palette !== undefined) merged.palette = above.palette;
  if (above.custom_palette !== undefined) merged.custom_palette = above.custom_palette;
  if (above.opener !== undefined) merged.opener = above.opener;
  if (above.sigil !== undefined) merged.sigil = above.sigil;
  if (above.homepage !== undefined) merged.homepage = above.homepage;
  if (above._passthrough) {
    merged._passthrough = { ...(base._passthrough ?? {}), ...above._passthrough };
  }
  return merged;
}

/**
 * Load and merge all layers. The user layer is the only one subject to
 * version migration - the system layer is operator-authored and the
 * session layer is ephemeral. Both must already be on the current
 * version; stale values are treated as absent.
 */
export async function loadConfig(): Promise<ConfigV1> {
  const [systemRaw, userRaw, sessionRaw] = await Promise.all([
    readLayer(SYSTEM_CONFIG_FILE),
    readLayer(USER_CONFIG_FILE),
    (async () => {
      const sess = sessionConfigFile();
      return sess ? readLayer(sess) : null;
    })(),
  ]);

  let merged: ConfigV1 = DEFAULT_CONFIG;

  if (systemRaw) {
    merged = overlay(merged, project(systemRaw));
  }

  if (userRaw) {
    const rawVersion =
      typeof userRaw.version === "number" ? userRaw.version : SCHEMA_VERSION;
    const migrated = applyMigrations(userRaw, rawVersion, SCHEMA_VERSION);
    merged = overlay(merged, project(migrated));
  }

  if (sessionRaw) {
    merged = overlay(merged, project(sessionRaw));
  }

  return merged;
}

/**
 * Serialise a user-layer `ConfigV1` back to TOML for `alter config set`.
 * Preserves `_passthrough` tables so keys from newer CLIs survive an
 * older CLI's round-trip - never silently strip what the user
 * committed.
 */
export async function serialiseUserConfig(config: ConfigV1): Promise<string> {
  const { stringify } = await import("smol-toml");
  const out: RawTable = {
    version: config.version,
  };
  if (config.palette !== undefined) out.palette = config.palette;
  if (config.custom_palette !== undefined) {
    out.custom_palette = config.custom_palette as unknown as Record<
      string,
      unknown
    >;
  }
  if (config.opener !== undefined) {
    out.opener = config.opener as unknown as Record<string, unknown>;
  }
  if (config.sigil !== undefined) {
    const sigilOut: RawTable = {};
    if (config.sigil.border_set !== undefined) sigilOut.border_set = config.sigil.border_set;
    if (config.sigil.wordmark !== undefined) sigilOut.wordmark = config.sigil.wordmark;
    if (config.sigil.accent_glyph !== undefined) sigilOut.accent_glyph = config.sigil.accent_glyph;
    if (Object.keys(sigilOut).length > 0) out.sigil = sigilOut;
  }

  // Re-merge the [homepage] table: untyped legacy subkeys (whoami, opener,
  // pronouns, sigil) ride in `_passthrough.homepage`; typed fields win on
  // key collision.
  const passthroughHomepage = config._passthrough?.homepage;
  const homepageOut: RawTable = {
    ...(passthroughHomepage && typeof passthroughHomepage === "object"
      ? (passthroughHomepage as RawTable)
      : {}),
  };
  if (config.homepage?.contact_email !== undefined) {
    homepageOut.contact_email = config.homepage.contact_email;
  }
  if (config.homepage?.contact_email_verified_at !== undefined) {
    homepageOut.contact_email_verified_at =
      config.homepage.contact_email_verified_at;
  }
  if (Object.keys(homepageOut).length > 0) out.homepage = homepageOut;

  if (config._passthrough) {
    for (const [k, v] of Object.entries(config._passthrough)) {
      if (!(k in out) && k !== "homepage") out[k] = v;
    }
  }
  return stringify(out);
}

// Re-exported for tests and migration-specific tooling.
export { project as projectRawConfig, overlay as overlayConfig };
