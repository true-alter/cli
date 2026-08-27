/**
 * doctor/checks/config.ts -- TOML configuration diagnostic checks.
 *
 * Reads from:
 *   src/config/paths.ts   -- USER_CONFIG_FILE, SYSTEM_CONFIG_FILE, sessionConfigFile
 *   src/config/schema.ts  -- SCHEMA_VERSION, isPaletteVariant, isSigilBorderSet,
 *                            isSigilWordmark, isSigilAccentGlyph
 *
 * All checks are local (no network).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  SYSTEM_CONFIG_FILE,
  sessionConfigFile,
} from "../../config/paths.js";
import {
  SCHEMA_VERSION,
  isPaletteVariant,
  isPaletteSelection,
  isCustomPaletteColors,
  isSigilBorderSet,
  isSigilWordmark,
  isSigilAccentGlyph,
  CUSTOM_PALETTE,
  PALETTE_VARIANTS,
  SIGIL_BORDER_SETS,
  SIGIL_WORDMARKS,
  SIGIL_ACCENT_GLYPHS,
} from "../../config/schema.js";

import type {
  Check,
  CheckResult,
  HealResult,
  DoctorCtx,
} from "../../lib/check-report.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function activeUserConfigFile(): string {
  const xdg =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdg, "alter", "config.toml");
}

type RawTable = Record<string, unknown>;

/**
 * Attempt to parse a TOML file. Returns {ok, table, error}.
 * Does not throw.
 */
async function tryParseToml(
  filePath: string,
): Promise<{ ok: true; table: RawTable } | { ok: false; error: string } | null> {
  let contents: string;
  try {
    contents = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    return { ok: false, error: `cannot read: ${e.message}` };
  }
  const { parse } = await import("smol-toml");
  try {
    const table = parse(contents) as RawTable;
    return { ok: true, table };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// config.user-toml
// ---------------------------------------------------------------------------

const userToml: Check = {
  id: "config.user-toml",
  category: "config",
  label: "user config.toml absent or valid TOML",
  healClass: "DIAGNOSE-ONLY",
  async run(_ctx: DoctorCtx): Promise<CheckResult> {
    const file = activeUserConfigFile();
    const result = await tryParseToml(file);
    if (result === null) {
      // Absent is OK.
      return { status: "OK", detail: `${file} (absent -- using defaults)` };
    }
    if (!result.ok) {
      return {
        status: "FAIL",
        detail: `parse error: ${result.error}`,
        remedy: "run `alter config edit` to fix or delete the file",
      };
    }
    const version = result.table.version;
    if (version !== undefined && version !== SCHEMA_VERSION) {
      return {
        status: "WARN",
        detail: `version field is ${version}, expected ${SCHEMA_VERSION}`,
        remedy: "run `alter config edit` to update the version field",
      };
    }
    return { status: "OK", detail: file };
  },
};

// ---------------------------------------------------------------------------
// config.system-toml
// ---------------------------------------------------------------------------

const systemToml: Check = {
  id: "config.system-toml",
  category: "config",
  label: "system config.toml absent or valid TOML",
  healClass: "DIAGNOSE-ONLY",
  async run(_ctx: DoctorCtx): Promise<CheckResult> {
    // Also respect the session-layer override path for testability.
    const sessionFile = sessionConfigFile();
    const fileToCheck = sessionFile ?? SYSTEM_CONFIG_FILE;
    const result = await tryParseToml(fileToCheck);
    if (result === null) {
      return { status: "OK", detail: `${fileToCheck} (absent -- skipped)` };
    }
    if (!result.ok) {
      return {
        status: "FAIL",
        detail: `parse error in ${fileToCheck}: ${result.error}`,
        remedy: "ask your system administrator to fix or remove the file",
      };
    }
    return { status: "OK", detail: fileToCheck };
  },
};

// ---------------------------------------------------------------------------
// config.palette
// ---------------------------------------------------------------------------

const paletteCheck: Check = {
  id: "config.palette",
  category: "config",
  label: "palette value is a valid variant",
  healClass: "SAFE-AUTOHEAL",
  async run(_ctx: DoctorCtx): Promise<CheckResult> {
    const file = activeUserConfigFile();
    const result = await tryParseToml(file);
    if (result === null || !result.ok) {
      // If the file is absent or unparseable, the user-toml check handles it.
      return { status: "OK", detail: "no user config -- defaults apply" };
    }
    const palette = result.table.palette;
    if (palette === undefined) {
      return { status: "OK", detail: "palette unset (defaults apply)" };
    }
    if (!isPaletteSelection(palette)) {
      return {
        status: "FAIL",
        detail: `palette "${String(palette)}" is not a valid variant`,
        remedy: `run \`alter config set palette <value>\` with one of: ${PALETTE_VARIANTS.join(", ")}`,
      };
    }
    // "custom" requires a complete per-role hex map to render.
    if (palette === CUSTOM_PALETTE && !isCustomPaletteColors(result.table.custom_palette)) {
      return {
        status: "FAIL",
        detail: `palette is "custom" but custom_palette is missing or incomplete`,
        remedy: `rebuild it in the menu: Me -> Customise -> Custom colours, or set a preset with \`alter config set palette gold-on-charcoal\``,
      };
    }
    return { status: "OK", detail: `palette = ${palette}` };
  },
  async heal(_ctx: DoctorCtx): Promise<HealResult> {
    // Auto-heal: reset palette to the default (gold-on-charcoal).
    const file = activeUserConfigFile();
    const result = await tryParseToml(file);
    if (!result || !result.ok) {
      return { applied: false, status: "WARN", detail: "cannot read config to auto-fix" };
    }
    const palette = result.table.palette;
    // A preset, or a complete "custom" palette, needs no fix.
    const validCustom =
      palette === CUSTOM_PALETTE &&
      isCustomPaletteColors(result.table.custom_palette);
    if (!palette || isPaletteVariant(palette) || validCustom) {
      return { applied: false, status: "OK", detail: "no fix needed" };
    }
    // We do not have a full serialiser here; route to `alter config set`.
    // The check will still show the remedy in non-fix mode.
    return {
      applied: false,
      status: "WARN",
      detail: `run \`alter config set palette gold-on-charcoal\` to reset`,
    };
  },
};

// ---------------------------------------------------------------------------
// config.sigil
// ---------------------------------------------------------------------------

const sigilCheck: Check = {
  id: "config.sigil",
  category: "config",
  label: "sigil enums valid (border_set, wordmark, accent_glyph)",
  healClass: "SAFE-AUTOHEAL",
  async run(_ctx: DoctorCtx): Promise<CheckResult> {
    const file = activeUserConfigFile();
    const result = await tryParseToml(file);
    if (result === null || !result.ok) {
      return { status: "OK", detail: "no user config -- defaults apply" };
    }
    const sigil = result.table.sigil;
    if (!sigil || typeof sigil !== "object") {
      return { status: "OK", detail: "no [sigil] section -- defaults apply" };
    }
    const s = sigil as Record<string, unknown>;
    const errors: string[] = [];

    if (s.border_set !== undefined && !isSigilBorderSet(s.border_set)) {
      errors.push(
        `border_set "${String(s.border_set)}" invalid (valid: ${SIGIL_BORDER_SETS.join(", ")})`,
      );
    }
    if (s.wordmark !== undefined && !isSigilWordmark(s.wordmark)) {
      errors.push(
        `wordmark "${String(s.wordmark)}" invalid (valid: ${SIGIL_WORDMARKS.join(", ")})`,
      );
    }
    if (s.accent_glyph !== undefined && !isSigilAccentGlyph(s.accent_glyph)) {
      errors.push(
        `accent_glyph "${String(s.accent_glyph)}" invalid (valid: ${SIGIL_ACCENT_GLYPHS.join(", ")})`,
      );
    }

    if (errors.length > 0) {
      return {
        status: "FAIL",
        detail: errors.join("; "),
        remedy: "run `alter config set sigil.<field> <value>` to fix each",
      };
    }
    return { status: "OK", detail: "sigil enums valid" };
  },
  async heal(_ctx: DoctorCtx): Promise<HealResult> {
    // Same limitation as palette -- route to `alter config set`.
    return {
      applied: false,
      status: "WARN",
      detail: "run `alter config set sigil.<field> <valid-value>` for each invalid field",
    };
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const checks: Check[] = [
  userToml,
  systemToml,
  paletteCheck,
  sigilCheck,
];
