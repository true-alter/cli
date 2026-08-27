/**
 * doctor/registry.ts -- aggregates all category check arrays into one registry.
 *
 * Adding a new check: add it to the appropriate category module's `checks`
 * export. No changes needed here unless a new category module is added.
 */

import { checks as identityChecks } from "./checks/identity.js";
import { checks as configChecks } from "./checks/config.js";
import { checks as mcpChecks } from "./checks/mcp.js";
import { checks as runtimeChecks } from "./checks/runtime.js";
import { checks as pairingChecks } from "./checks/pairing.js";
import { checks as repoChecks } from "./checks/repo.js";
import type { Check, Category } from "../lib/check-report.js";

export function buildRegistry(): Check[] {
  return [
    ...identityChecks,
    ...configChecks,
    ...mcpChecks,
    ...runtimeChecks,
    ...pairingChecks,
    ...repoChecks,
  ];
}

/**
 * Filter checks by a category list.
 * Returns all checks when `only` is null.
 */
export function filterByCategory(
  checks: Check[],
  only: Category[] | null,
): Check[] {
  if (!only) return checks;
  return checks.filter((c) => only.includes(c.category));
}
