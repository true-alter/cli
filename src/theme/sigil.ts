/**
 * Glyph-primitive sigil composition.
 *
 * A sigil is the user's private mark - composed from three typed
 * primitives (border set, wordmark, accent glyph) and rendered in
 * `alter room`, the opt-in starship block, and the `alter_portfolio`
 * MCP tool response. The primitive catalogs live here so a new
 * primitive requires a CLI version bump (discourage local drift; keep
 * the substrate small).
 *
 * Every valid (border_set, wordmark, accent_glyph) triple composes to
 * an ALTER-coherent string by construction - the brand-signature
 * floor. Three users who each pick differently still produce
 * sigils that read as ALTER.
 */

import type {
  SigilAccentGlyph,
  SigilBorderSet,
  SigilConfig,
  SigilWordmark,
} from "../config/schema.js";

export interface SigilBorderSetSpec {
  readonly variant: SigilBorderSet;
  readonly label: string;
  readonly open: string;
  readonly close: string;
}

export const SIGIL_BORDER_SET_SPECS: Record<SigilBorderSet, SigilBorderSetSpec> = {
  thin: {
    variant: "thin",
    label: "thin - the default line",
    open: "│",
    close: "│",
  },
  thick: {
    variant: "thick",
    label: "thick - the emphasised line",
    open: "┃",
    close: "┃",
  },
  double: {
    variant: "double",
    label: "double - the ceremonial line",
    open: "║",
    close: "║",
  },
  ascii: {
    variant: "ascii",
    label: "ascii - the portable line",
    open: "|",
    close: "|",
  },
};

export interface SigilWordmarkSpec {
  readonly value: SigilWordmark;
  readonly label: string;
}

export const SIGIL_WORDMARK_SPECS: Record<SigilWordmark, SigilWordmarkSpec> = {
  "~alter": {
    value: "~alter",
    label: "~alter - the default Trill",
  },
  "~Alter": {
    value: "~Alter",
    label: "~Alter - the formal Trill",
  },
  ALTER: {
    value: "ALTER",
    label: "ALTER - the wordmark",
  },
};

export interface SigilAccentGlyphSpec {
  readonly value: SigilAccentGlyph;
  readonly label: string;
}

export const SIGIL_ACCENT_GLYPH_SPECS: Record<
  SigilAccentGlyph,
  SigilAccentGlyphSpec
> = {
  "·": { value: "·", label: "·  middle dot" },
  "◇": { value: "◇", label: "◇  open diamond" },
  "◦": { value: "◦", label: "◦  open bullet" },
  "∴": { value: "∴", label: "∴  therefore" },
  "✦": { value: "✦", label: "✦  four-pointed star" },
};

/**
 * Compose the three slots into a single-line rendered sigil. Returns
 * `null` when any slot is missing - the caller is expected to fall
 * back to the homepage.sigil passthrough (legacy path) or omit the
 * sigil row entirely.
 *
 * Format: `{open} {accent} {wordmark} {accent} {close}`
 *
 * Examples:
 *   thin + ~alter + ◇    →  │ ◇ ~alter ◇ │
 *   thick + ~Alter + ·   →  ┃ · ~Alter · ┃
 *   double + ALTER + ∴   →  ║ ∴ ALTER ∴ ║
 *   ascii + ~alter + ✦   →  | ✦ ~alter ✦ |
 */
export function composeSigil(sigil: SigilConfig | undefined): string | null {
  if (!sigil) return null;
  const { border_set, wordmark, accent_glyph } = sigil;
  if (!border_set || !wordmark || !accent_glyph) return null;
  const border = SIGIL_BORDER_SET_SPECS[border_set];
  return `${border.open} ${accent_glyph} ${wordmark} ${accent_glyph} ${border.close}`;
}

/**
 * True when all three slots are present and each carries a valid
 * catalog value. Used by the composer to decide whether the current
 * on-disk state is a completed sigil.
 */
export function isCompleteSigil(
  sigil: SigilConfig | undefined,
): sigil is Required<SigilConfig> {
  if (!sigil) return false;
  return (
    sigil.border_set !== undefined &&
    sigil.wordmark !== undefined &&
    sigil.accent_glyph !== undefined
  );
}
