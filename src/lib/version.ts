/**
 * version - single source of truth for the running CLI's version string.
 *
 * Every surface that needs the version (the `--version` print, the
 * self-update channel check, the `X-Agent-Version-Hash` derivation, the
 * identity trailer the messenger commands emit) reads it from
 * `package.json` at runtime via this helper - never from a hand-maintained
 * literal. Earlier hard-coded version literals had drifted behind
 * `package.json`, so the wrong release identifier was stamped and hashed
 * into the non-stationary-agent gate header. Reading the manifest removes
 * the drift class entirely.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";

let cached: string | null = null;

/**
 * Resolve the `@truealter/cli` version from the nearest `package.json`.
 *
 * Candidates are resolved from this module's own compiled location
 * (`dist/lib/version.js` after build), so the lookup is stable
 * regardless of which command imported it and survives `npm install -g`
 * (where `dist/` sits directly under the package root). The manifest
 * `name` is checked so a stray `package.json` higher up the tree can't
 * shadow ours. Falls back to `"0.0.0-unknown"` only if every candidate
 * fails to parse - callers treat that as "version unavailable" rather
 * than crashing.
 */
export function getCliVersion(): string {
  if (cached !== null) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    pathResolve(here, "..", "package.json"),
    pathResolve(here, "..", "..", "package.json"),
    pathResolve(here, "..", "..", "..", "package.json"),
  ]) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
        name?: string;
        version?: string;
      };
      if (parsed.version && (parsed.name === "@truealter/cli" || parsed.name === undefined)) {
        cached = parsed.version;
        return cached;
      }
    } catch {
      // Try the next candidate.
    }
  }
  cached = "0.0.0-unknown";
  return cached;
}
