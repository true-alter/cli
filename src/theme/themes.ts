/**
 * The signature preset - the founders' reference dotfile shape. It is
 * *not* a theme library; that posture is intentional. It exists for
 * one purpose only: a "restore" affordance the user can fall back to
 * after customising, so the customise menu has a coherent inverse.
 *
 * The brand floor in `defaults.ts` ships no sigil - a vanilla user
 * has no glyph wrapping at all. The signature preset is the
 * authored-shape that goes one step beyond the unbranded substrate:
 * thin border, lowercase Trill, lozenge accent. It is the same shape
 * that ships in the founders' personal dotfiles, made addressable
 * inside the CLI so a user who has wandered can return.
 *
 * No second preset exists. Adding one is a brand decision.
 */

import chalk from "chalk";

import type { PaletteVariant, SigilConfig } from "../config/schema.js";
import { PALETTES } from "./palette.js";
import { composeSigil } from "./sigil.js";

export interface Preset {
  readonly palette: PaletteVariant;
  readonly sigil: Required<SigilConfig>;
}

export const SIGNATURE: Preset = {
  palette: "gold-on-charcoal",
  sigil: { border_set: "thin", wordmark: "~alter", accent_glyph: "◇" },
} as const;

/**
 * Render the signature in its own title-gold so the user sees the
 * shape they're about to restore.
 */
export function previewSignature(): string {
  const palette = PALETTES[SIGNATURE.palette];
  const composed = composeSigil(SIGNATURE.sigil);
  return composed ? chalk.hex(palette.title)(composed) : "";
}

/**
 * True iff the user's current on-disk palette + sigil exactly match
 * the signature preset.
 */
export function isSignature(
  palette: PaletteVariant | undefined,
  sigil: SigilConfig | undefined,
): boolean {
  if (palette !== SIGNATURE.palette) return false;
  if (!sigil) return false;
  return (
    sigil.border_set === SIGNATURE.sigil.border_set &&
    sigil.wordmark === SIGNATURE.sigil.wordmark &&
    sigil.accent_glyph === SIGNATURE.sigil.accent_glyph
  );
}
