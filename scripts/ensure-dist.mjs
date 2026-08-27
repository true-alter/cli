#!/usr/bin/env node
/**
 * Build `dist/` before the unit suite when, and only when, it is stale.
 *
 * Several specs spawn the SHIPPED public binary `dist/index.js` directly
 * (`tests/test_cli_flags.ts`, `tests/test_ops_tokens.ts`) so they exercise
 * the real flag/exit/usage contract a member sees, not a tsc-only copy of
 * the source. But `npm test` compiles to `test-out/` only - it never runs
 * `npm run build`, so on a clean checkout (or any tree where nobody has
 * built yet) `dist/index.js` is absent and every spawn fails with
 * MODULE_NOT_FOUND. CI papers over this by running `npm run build` before
 * `npm test`; a developer running `npm test` locally gets 49 red specs.
 *
 * This guard closes that gap hermetically: `npm test` now builds `dist/`
 * itself when it is missing or older than the newest `src/` input, so the
 * suite is self-contained from a clean checkout with no manual pre-build.
 * When `dist/` is already fresh (the CI path, or a warm local tree) it is a
 * near-instant no-op - no redundant rebuild on every unrelated unit run.
 *
 * The real `npm run build` is reused verbatim, so the spawned binary is the
 * genuine shipped artefact (asset copy, strip-testing-exports, chmod), never
 * a divergent stand-in. The embedded Obsidian plugin is irrelevant to the
 * flag/help/version contract these specs check, so the build runs with
 * ALTER_EMBED_ALLOW_DIRTY=1: a developer who happens to keep a dirty
 * `alter-obsidian-plugin` sibling does not get a hard embed-pin failure on
 * an ordinary `npm test`. (A clean checkout has no sibling at all, where
 * embed-plugin already fail-softs.) Release builds set ALTER_REQUIRE_EMBED=1,
 * which refuses the dirty escape, so the publish path is unaffected.
 *
 * Pure Node fs/child_process - no shell globs, no GNU-only flags - so it
 * runs identically on Linux, macOS, and Windows (npm's cmd.exe/PowerShell
 * script shell).
 */
import { existsSync, statSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const distEntry = join(repoRoot, "dist", "index.js");
const srcRoot = join(repoRoot, "src");

/** Newest mtime (ms) of any file under `dir`, recursively. 0 if dir absent. */
function newestMtimeMs(dir) {
  let newest = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = newestMtimeMs(p);
      if (sub > newest) newest = sub;
    } else if (entry.isFile()) {
      const m = statSync(p).mtimeMs;
      if (m > newest) newest = m;
    }
  }
  return newest;
}

function isStale() {
  if (!existsSync(distEntry)) return true;
  const distMtime = statSync(distEntry).mtimeMs;
  const srcMtime = newestMtimeMs(srcRoot);
  // Rebuild when any source file is newer than the built entry point.
  return srcMtime > distMtime;
}

if (!isStale()) {
  process.stdout.write("ensure-dist: dist/index.js is fresh - skipping build.\n");
  process.exit(0);
}

process.stdout.write(
  "ensure-dist: dist/index.js missing or stale - building before tests.\n",
);

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const res = spawnSync(npm, ["run", "build"], {
  cwd: repoRoot,
  stdio: "inherit",
  env: { ...process.env, ALTER_EMBED_ALLOW_DIRTY: "1" },
});

if (res.error) {
  process.stderr.write(`ensure-dist: build failed to start: ${res.error.message}\n`);
  process.exit(1);
}
process.exit(res.status ?? 1);
