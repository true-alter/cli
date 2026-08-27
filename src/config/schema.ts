/**
 * ALTER CLI config schema - version 1.
 *
 * Version is the ONLY field guaranteed to be present on disk and in
 * memory; every other field is optional and falls through to the
 * defaults layer. The version is stamped by the writer and read by the
 * migration runner (see `migrations/index.ts`).
 *
 * Additions require a SCHEMA_VERSION bump and a numbered migration
 * scaffold.
 */

export const SCHEMA_VERSION = 2 as const;

export type PaletteVariant =
  | "gold-on-charcoal"
  | "gold-on-ivory"
  | "gold-on-oxblood";

export const PALETTE_VARIANTS: readonly PaletteVariant[] = [
  "gold-on-charcoal",
  "gold-on-ivory",
  "gold-on-oxblood",
] as const;

export function isPaletteVariant(value: unknown): value is PaletteVariant {
  return (
    typeof value === "string" &&
    (PALETTE_VARIANTS as readonly string[]).includes(value)
  );
}

/**
 * The `palette` selection: one of the three brand presets, or the
 * literal `"custom"` sentinel meaning "use the per-role hex map in
 * `custom_palette`". Kept distinct from PaletteVariant so the preset
 * enum (and every validator built on it) stays a closed brand set.
 */
export const CUSTOM_PALETTE = "custom" as const;
export type PaletteSelection = PaletteVariant | typeof CUSTOM_PALETTE;

export function isPaletteSelection(value: unknown): value is PaletteSelection {
  return value === CUSTOM_PALETTE || isPaletteVariant(value);
}

/**
 * The twelve colour roles a palette fills. A custom palette is a full
 * map of these to 6-hex strings (`#RRGGBB`). The names mirror the
 * `brand` object slots 1:1 (handle is derived from
 * title, so it is not an editable role).
 */
export const PALETTE_ROLE_KEYS = [
  "title",
  "accent",
  "accentDeep",
  "marker",
  "text",
  "cream",
  "dim",
  "muted",
  "faint",
  "border",
  "borderDim",
  "titleDim",
] as const;

export type PaletteRoleKey = (typeof PALETTE_ROLE_KEYS)[number];

export type CustomPaletteColors = Record<PaletteRoleKey, string>;

/** A 6-hex colour string, `#` followed by exactly six hex digits. */
export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

/** True when every role key is present and carries a valid 6-hex value. */
export function isCustomPaletteColors(
  value: unknown,
): value is CustomPaletteColors {
  if (value === null || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return PALETTE_ROLE_KEYS.every((k) => isHexColor(rec[k]));
}

/**
 * Opener block. Exactly one of `library` or `line` is set.
 *
 *   [opener]
 *   library = "default"          # rotate through the bundled library
 *
 *   [opener]
 *   line = "your authored line"  # authored override, rendered verbatim
 */
export type OpenerConfig =
  | { library: string }
  | { line: string };

/**
 * Sigil composition - three typed primitive slots.
 *
 * The user picks one value per slot via `alter sigil compose`; the
 * composed sigil is then rendered in `alter room`, the opt-in starship
 * block, and the `alter_portfolio` MCP tool response. Every valid
 * combination is ALTER-coherent by construction - no slot accepts an
 * off-brand value. Expanding the primitive catalog requires a CLI
 * version bump to discourage local drift and keep the substrate small
 * (resist shipping "official themes"; the tweak is where authorship
 * lives).
 *
 * An earlier version shipped this interface as a reserved stub with
 * `primitives?: string[]` so the schema could be forward-compatible
 * without a migration. That shape had no writer; this version replaces it
 * outright.
 */
export type SigilBorderSet = "thin" | "thick" | "double" | "ascii";
export type SigilWordmark = "~alter" | "~Alter" | "ALTER";
export type SigilAccentGlyph = "·" | "◇" | "◦" | "∴" | "✦";

export const SIGIL_BORDER_SETS: readonly SigilBorderSet[] = [
  "thin",
  "thick",
  "double",
  "ascii",
] as const;

export const SIGIL_WORDMARKS: readonly SigilWordmark[] = [
  "~alter",
  "~Alter",
  "ALTER",
] as const;

export const SIGIL_ACCENT_GLYPHS: readonly SigilAccentGlyph[] = [
  "·",
  "◇",
  "◦",
  "∴",
  "✦",
] as const;

export function isSigilBorderSet(value: unknown): value is SigilBorderSet {
  return (
    typeof value === "string" &&
    (SIGIL_BORDER_SETS as readonly string[]).includes(value)
  );
}

export function isSigilWordmark(value: unknown): value is SigilWordmark {
  return (
    typeof value === "string" &&
    (SIGIL_WORDMARKS as readonly string[]).includes(value)
  );
}

export function isSigilAccentGlyph(value: unknown): value is SigilAccentGlyph {
  return (
    typeof value === "string" &&
    (SIGIL_ACCENT_GLYPHS as readonly string[]).includes(value)
  );
}

export interface SigilConfig {
  border_set?: SigilBorderSet;
  wordmark?: SigilWordmark;
  accent_glyph?: SigilAccentGlyph;
}

/**
 * Homepage block - fields shown on your handle.
 *
 * The `contact_email` here is DISTINCT from the private auth login email
 * (`Member.email_hash` / `email_encrypted`). It is the email peers see
 * when they query your handle (via `alter_homepage`), not the credential
 * used to log in. Setting it here does not change your login email.
 *
 * `contact_email` is a local DISPLAY CACHE of the backend-verified value:
 * it is written only by the menu's OTP verify ceremony (Account › Contact
 * email), never by `config set` - the address must prove control before
 * it is shown anywhere.
 */
export interface HomepageConfig {
  /**
   * Public contact email - shown on your handle profile.
   * Distinct from the private auth credential email used for login.
   * Managed by the verify ceremony; the backend record is the source
   * of truth and this field is its local cache.
   */
  contact_email?: string;
  /** ISO timestamp of when the OTP verify ceremony completed. */
  contact_email_verified_at?: string;
}

export interface ConfigV1 {
  version: typeof SCHEMA_VERSION;
  /** Preset variant, or "custom" to use `custom_palette`. */
  palette?: PaletteSelection;
  /**
   * Per-role hex map, honoured only when `palette === "custom"`. A
   * preset selection leaves this on disk but unused, so switching back
   * to custom restores the last hand-built colours.
   */
  custom_palette?: CustomPaletteColors;
  opener?: OpenerConfig;
  sigil?: SigilConfig;
  /** Homepage fields - declared-provenance data shown on your handle. */
  homepage?: HomepageConfig;
  /**
   * Unknown-but-preserved keys. The loader round-trips any table the
   * current schema doesn't understand so a newer CLI writing forward-
   * compatible keys doesn't lose them when an older CLI reads and
   * rewrites the file. Consumers must treat this as opaque.
   */
  _passthrough?: Record<string, unknown>;
}

export type PartialConfigV1 = Partial<Omit<ConfigV1, "version">> & {
  version?: number;
};
