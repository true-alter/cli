/**
 * Muted-gold palette family - the brand floor for ALTER CLI surfaces.
 *
 * Three variants, all built from the same accent range so every
 * customised session still reads unmistakably as ALTER (the
 * brand-signature acceptance test). Users choose one of
 * the three; the palette structure itself is not user-composable.
 *
 * The six core roles (border, title, accent, text, dim, marker) match the
 * slots the bios-menu panel already uses - these supersede those
 * hardcoded values.
 *
 * The six derived roles (borderDim, titleDim, accent, muted, faint, cream)
 * complete the 1:1 mapping onto the `brand` object so a
 * palette can re-tint the whole room at runtime (setBrandPalette). The
 * signature variant's derived values reproduce the original hardcoded
 * brand exactly - applying it is a visual no-op.
 */

import type {
  CustomPaletteColors,
  PaletteRoleKey,
  PaletteSelection,
  PaletteVariant,
} from "../config/schema.js";
import { CUSTOM_PALETTE, PALETTE_ROLE_KEYS } from "../config/schema.js";

export interface Palette {
  /** The variant identifier as persisted in config.toml. */
  readonly variant: PaletteVariant;
  /** One-line human label for `alter config get palette`. */
  readonly label: string;
  /** 6-hex border colour (frames, rules, panel outlines). */
  readonly border: string;
  /** 6-hex accent-deep colour (emphasis, hovered items). */
  readonly accentDeep: string;
  /** 6-hex title colour (prompt binding, brand title). */
  readonly title: string;
  /** 6-hex body text. */
  readonly text: string;
  /** 6-hex dim text (hints, coda lines, muted metadata). */
  readonly dim: string;
  /** 6-hex marker (cursor, selection indicator). */
  readonly marker: string;
  /** 6-hex quiet border (inner rules, dividers). */
  readonly borderDim: string;
  /** 6-hex quiet title (the dim wordmark register). */
  readonly titleDim: string;
  /** 6-hex mid accent (links, breadcrumbs, saved-state notices). */
  readonly accent: string;
  /** 6-hex muted metadata (hints, key legends). */
  readonly muted: string;
  /** 6-hex faintest text (decorative, near-background). */
  readonly faint: string;
  /** 6-hex warm body-text alternate. */
  readonly cream: string;
}

export const PALETTES: Record<PaletteVariant, Palette> = {
  "gold-on-charcoal": {
    variant: "gold-on-charcoal",
    label: "muted gold on deep charcoal - the signature",
    border: "#A89060",
    accentDeep: "#E09D2F",
    title: "#F9BE4A",
    text: "#F5F0E8",
    dim: "#8A847E",
    marker: "#F9BE4A",
    // Derived roles.
    // accent + titleDim lifted from #C9A84C → #E0B84C so selected rows
    // and mid-accent links read clearly against charcoal without washing
    // out the muted hierarchy (border/muted/faint are unchanged).
    borderDim: "#544E48",
    titleDim: "#E0B84C",
    accent: "#E0B84C",
    muted: "#A89060",
    faint: "#544E48",
    cream: "#FAF5EF",
  },
  "gold-on-ivory": {
    variant: "gold-on-ivory",
    label: "muted gold on warm ivory - legible in daylight",
    border: "#8A6F2E",
    accentDeep: "#A8801C",
    title: "#6E5617",
    text: "#2B2721",
    dim: "#70695F",
    marker: "#A8801C",
    // Light-ground derivations: "dim" recedes toward the ivory paper,
    // accents stay in the same gold range as the signature.
    borderDim: "#C4B68C",
    titleDim: "#8A6F2E",
    accent: "#8A6F2E",
    muted: "#8A7A4E",
    faint: "#B0A88F",
    cream: "#3A352D",
  },
  "gold-on-oxblood": {
    variant: "gold-on-oxblood",
    label: "muted gold on oxblood - evening register",
    border: "#C9A84C",
    accentDeep: "#F9BE4A",
    title: "#F9D576",
    text: "#F5E8D4",
    dim: "#A67A75",
    marker: "#F9D576",
    // Evening derivations: quiet roles lean into the oxblood ground,
    // bright roles keep the warmer candle-gold register.
    borderDim: "#6B4540",
    titleDim: "#D9B65A",
    accent: "#D9B65A",
    muted: "#C9A84C",
    faint: "#7A534D",
    cream: "#FAF0DC",
  },
};

export function getPalette(variant: PaletteVariant): Palette {
  return PALETTES[variant];
}

/**
 * Human labels + one-line descriptions for the twelve editable colour
 * roles, in the order the DIY editor presents them - brightest/most
 * structural first. Drives the custom-colour menu; the keys are the
 * `CustomPaletteColors` fields, identical to the brand slots.
 */
export interface PaletteRoleSpec {
  readonly key: PaletteRoleKey;
  readonly label: string;
  readonly hint: string;
}

export const PALETTE_ROLE_SPECS: readonly PaletteRoleSpec[] = [
  { key: "title", label: "Title", hint: "headings + the selected row" },
  { key: "accent", label: "Accent", hint: "links, breadcrumbs, saved notices" },
  { key: "accentDeep", label: "Accent (deep)", hint: "emphasis + hovered items" },
  { key: "marker", label: "Marker", hint: "the cursor / selection arrow" },
  { key: "text", label: "Text", hint: "body text" },
  { key: "cream", label: "Text (warm)", hint: "warm body-text alternate" },
  { key: "dim", label: "Dim", hint: "hints + muted metadata" },
  { key: "muted", label: "Muted", hint: "key legends + quiet labels" },
  { key: "faint", label: "Faint", hint: "the faintest decorative text" },
  { key: "border", label: "Border", hint: "frames + panel outlines" },
  { key: "borderDim", label: "Border (dim)", hint: "inner rules + dividers" },
  { key: "titleDim", label: "Title (dim)", hint: "the quiet wordmark register" },
];

/**
 * Build a full Palette from a per-role hex map. The `variant` slot is
 * stamped "custom" and `label` is fixed - those two fields are metadata,
 * never rendered as colour.
 */
export function buildCustomPalette(colors: CustomPaletteColors): Palette {
  return {
    variant: CUSTOM_PALETTE as unknown as PaletteVariant,
    label: "your own colours",
    border: colors.border,
    accentDeep: colors.accentDeep,
    title: colors.title,
    text: colors.text,
    dim: colors.dim,
    marker: colors.marker,
    borderDim: colors.borderDim,
    titleDim: colors.titleDim,
    accent: colors.accent,
    muted: colors.muted,
    faint: colors.faint,
    cream: colors.cream,
  };
}

/** Extract the twelve role colours from a Palette into a plain hex map. */
export function paletteToColors(p: Palette): CustomPaletteColors {
  const out = {} as CustomPaletteColors;
  for (const k of PALETTE_ROLE_KEYS) out[k] = p[k];
  return out;
}

/**
 * Resolve a config selection into the Palette the room should wear:
 * the per-role custom map when `selection === "custom"` AND a valid
 * map is present, otherwise the named preset, otherwise the signature
 * floor. The single read site every renderer should route through so
 * "custom" is honoured everywhere a preset would be.
 */
export function resolvePalette(
  selection: PaletteSelection | undefined,
  custom: CustomPaletteColors | undefined,
): Palette {
  if (selection === CUSTOM_PALETTE && custom) {
    return buildCustomPalette(custom);
  }
  if (selection && selection !== CUSTOM_PALETTE) {
    return PALETTES[selection];
  }
  return PALETTES["gold-on-charcoal"];
}
