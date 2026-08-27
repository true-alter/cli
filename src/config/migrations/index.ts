/**
 * Migration runner for `~/.config/alter/config.toml`.
 *
 * On load, the loader inspects the file's `version` key. If it is less
 * than `SCHEMA_VERSION`, the runner walks the registered migrations in
 * order (v_n → v_n+1) until the table reaches the current version. If
 * it is greater than `SCHEMA_VERSION`, the loader refuses to read - a
 * newer CLI wrote the file, and silently stripping keys the user
 * committed to is not acceptable.
 *
 * The runner is pure: it operates on plain objects, never touches disk,
 * never logs. The caller writes the migrated table back with
 * `writeConfig` only after the runner returns.
 */

import { MIGRATION_001_TO_002 } from "./001_to_002.js";

export interface MigrationStep {
  from: number;
  to: number;
  migrate(raw: Record<string, unknown>): Record<string, unknown>;
}

/**
 * Registered migrations in ascending order. Each `from` must equal the
 * previous entry's `to`. Add new entries AFTER existing ones; never
 * reorder or mutate a published migration.
 */
export const MIGRATIONS: readonly MigrationStep[] = [MIGRATION_001_TO_002];

/**
 * Apply migrations from `fromVersion` up to `toVersion` inclusive.
 * Returns the migrated table (with `version` stamped to `toVersion`).
 * Throws if no migration path exists - that indicates schema drift the
 * caller must handle by surfacing a readable error to the user.
 */
export function applyMigrations(
  raw: Record<string, unknown>,
  fromVersion: number,
  toVersion: number,
): Record<string, unknown> {
  if (fromVersion === toVersion) {
    return { ...raw, version: toVersion };
  }
  if (fromVersion > toVersion) {
    throw new Error(
      `config.toml version ${fromVersion} is newer than this CLI ` +
        `supports (${toVersion}). Upgrade the CLI or roll the config back.`,
    );
  }

  let current = raw;
  let v = fromVersion;
  while (v < toVersion) {
    const step = MIGRATIONS.find((m) => m.from === v);
    if (!step) {
      throw new Error(
        `no migration registered for config.toml version ${v} → ${v + 1}. ` +
          "This is a CLI bug; please report.",
      );
    }
    current = step.migrate(current);
    v = step.to;
  }
  return { ...current, version: toVersion };
}
