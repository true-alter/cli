/**
 * Defaults layer - lowest precedence, in-memory only.
 *
 * Everything here represents ALTER's brand floor. Changing these
 * values is a brand decision, not a code decision. The founders'
 * reference dotfiles are the canonical "here's what a customised
 * ALTER looks like"; the defaults layer is the unbranded substrate
 * beneath that.
 */

import { SCHEMA_VERSION, type ConfigV1 } from "./schema.js";

export const DEFAULT_CONFIG: ConfigV1 = {
  version: SCHEMA_VERSION,
  palette: "gold-on-charcoal",
  opener: { library: "default" },
};
