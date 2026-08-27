/**
 * v1 → v2 migration.
 *
 * v2 added two OPTIONAL fields - `palette` may now be the literal
 * "custom", and `custom_palette` holds a per-role hex map (see
 * `../schema.ts`). Both are additive: a v1 table is a valid v2 table
 * with neither field set, so the transform is a structural no-op and
 * the runner stamps `version = 2`. No existing key is touched, so a
 * hand-edited v1 config round-trips losslessly.
 *
 * The runner in `index.ts` walks numbered migration files in order.
 * Each migration receives the prior version's raw table and returns
 * the next version's raw table; the runner stamps `version = N`.
 */

import type { MigrationStep } from "./index.js";

export const MIGRATION_001_TO_002: MigrationStep = {
  from: 1,
  to: 2,
  migrate(raw: Record<string, unknown>): Record<string, unknown> {
    return raw;
  },
};
