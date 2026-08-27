#!/usr/bin/env node
/**
 * Copy the ALTER Obsidian plugin's built artefacts into the alter-cli
 * package's `dist/embedded-plugins/alter-obsidian-plugin/` so the
 * sideload path can read them at runtime without a GitHub fetch.
 *
 * Same distribution carveout as shipping a single static binary, applied to
 * plugin distribution. The npm publish boundary is the trust envelope - which
 * is exactly why the embedded bytes are PINNED: `embedded-plugins.lock.json`
 * names the plugin commit and the sha256 of every built artefact, and this
 * script asserts each artefact against the lock BEFORE copying anything.
 * Without the pin, the embed is whatever `../alter-obsidian-plugin` happens
 * to hold - desk and CI silently diverge (v0.8.10, 2026-06-05: desk gates
 * scanned a stale 23.5KB bundle while CI published a 34.2KB bundle built
 * from unpinned plugin HEAD).
 *
 * Source: `vendor/embedded-plugins/alter-obsidian-plugin/` - the pinned
 * artefacts committed IN THIS REPO, verified against the lock on every build.
 * The build therefore no longer depends on a sibling plugin checkout. The old
 * default (`../alter-obsidian-plugin`) always tracked plugin HEAD, never the
 * pinned commit, so every desk build off a worktree hard-failed the lock check
 * until ALTER_EMBED_PLUGIN_ROOT was hand-pointed at a clean pinned build; the
 * vendored copy removes that recurring failure for good. ALTER_EMBED_PLUGIN_ROOT
 * still overrides the source, used only when bumping the plugin: build the new
 * pinned commit, point the env var at it, copy the three artefacts into vendor/
 * and update the lock hashes, all in one reviewed alter-cli PR.
 * ALTER_EMBED_LOCK_PATH / ALTER_EMBED_DEST_ROOT exist for test isolation.
 *
 * Behaviour:
 *   - vendored copy absent     → fail-soft notice (exit 0), unless
 *                                ALTER_REQUIRE_EMBED=1 (release builds) → fail.
 *   - lock hash mismatch       → HARD FAIL before any copy, desk and CI alike.
 *                                The desk-only escape is ALTER_EMBED_ALLOW_DIRTY=1
 *                                (plugin-dev iteration); it is refused outright
 *                                under ALTER_REQUIRE_EMBED=1, so no env var can
 *                                weaken the release path.
 *   - lock entry/file missing  → fail under ALTER_REQUIRE_EMBED=1; notice
 *                                otherwise (a new plugin must be pinned before
 *                                it can ship).
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, "..");
const pluginRoot = process.env.ALTER_EMBED_PLUGIN_ROOT
  ? resolve(process.env.ALTER_EMBED_PLUGIN_ROOT)
  : resolve(cliRoot, "vendor", "embedded-plugins", "alter-obsidian-plugin");
const destRoot = process.env.ALTER_EMBED_DEST_ROOT
  ? resolve(process.env.ALTER_EMBED_DEST_ROOT)
  : resolve(cliRoot, "dist", "embedded-plugins", "alter-obsidian-plugin");
const lockPath = process.env.ALTER_EMBED_LOCK_PATH
  ? resolve(process.env.ALTER_EMBED_LOCK_PATH)
  : resolve(cliRoot, "embedded-plugins.lock.json");

const PLUGIN_NAME = "alter-obsidian-plugin";
const ASSETS = ["main.js", "manifest.json", "styles.css"];
const REQUIRED = new Set(["main.js", "manifest.json"]);

const requireEmbed = process.env.ALTER_REQUIRE_EMBED === "1";
// Desk-only escape for plugin-dev iteration. Refused under ALTER_REQUIRE_EMBED=1
// so a leaked env var cannot weaken the release path.
const allowDirty = process.env.ALTER_EMBED_ALLOW_DIRTY === "1" && !requireEmbed;

function notice(msg) {
  process.stdout.write(`embed-plugin: ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`embed-plugin: ${msg}\n`);
  process.exit(1);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function loadLock() {
  if (!existsSync(lockPath)) {
    if (requireEmbed) {
      fail(
        `embedded-plugins.lock.json missing at ${lockPath}; ` +
          `ALTER_REQUIRE_EMBED=1 forbids an unpinned embed.`,
      );
    }
    notice(`no embedded-plugins.lock.json - embedding UNPINNED (dev only).`);
    return null;
  }
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (err) {
    fail(`embedded-plugins.lock.json unparseable: ${err.message}`);
  }
  const entry = lock[PLUGIN_NAME];
  if (!entry || typeof entry !== "object" || !entry.artefacts) {
    if (requireEmbed) {
      fail(`lock has no '${PLUGIN_NAME}' entry with artefacts; pin it before release.`);
    }
    notice(`lock has no '${PLUGIN_NAME}' entry - embedding UNPINNED (dev only).`);
    return null;
  }
  return entry;
}

if (!existsSync(pluginRoot)) {
  if (requireEmbed) {
    fail(
      `vendored alter-obsidian-plugin missing at ${pluginRoot}; ` +
        `ALTER_REQUIRE_EMBED=1 forbids fall-through.`,
    );
  }
  notice(
    `vendored alter-obsidian-plugin not found at ${pluginRoot} - ` +
      `skipping embed (this build cannot sideload the ALTER plugin; ` +
      `sideload at runtime will throw a clear error). The pinned artefacts ` +
      `should be committed under vendor/embedded-plugins/.`,
  );
  process.exit(0);
}

if (!existsSync(join(pluginRoot, "main.js"))) {
  fail(
    `alter-obsidian-plugin found at ${pluginRoot} but main.js is missing. ` +
      `Re-vendor the pinned artefacts (or point ALTER_EMBED_PLUGIN_ROOT at a ` +
      `clean pinned build when bumping the plugin).`,
  );
}

const lockEntry = loadLock();

// Pass 1 - validate every present asset against the lock BEFORE any copy,
// so a failed pin never leaves mismatched bytes in dist.
const toCopy = [];
const mismatches = [];
for (const f of ASSETS) {
  const src = join(pluginRoot, f);
  if (!existsSync(src)) {
    if (REQUIRED.has(f)) {
      fail(`required asset ${f} missing at ${src}`);
    }
    notice(`skipping optional asset ${f} (not present in plugin source)`);
    continue;
  }
  if (lockEntry) {
    const expected = lockEntry.artefacts[f];
    if (!expected) {
      if (requireEmbed) {
        fail(`asset ${f} present but not pinned in embedded-plugins.lock.json.`);
      }
      notice(`asset ${f} not pinned in lock - embedding UNPINNED (dev only).`);
    } else {
      const actual = sha256(src);
      if (actual !== expected) {
        mismatches.push(
          `  ${f}: expected ${expected}\n${" ".repeat(f.length + 4)}got      ${actual}`,
        );
      }
    }
  }
  toCopy.push(f);
}

if (mismatches.length > 0) {
  const detail =
    `built plugin artefacts do not match embedded-plugins.lock.json ` +
    `(pinned commit ${lockEntry.commit ?? "?"}):\n${mismatches.join("\n")}\n` +
    `The plugin at ${pluginRoot} is not a clean build of the pinned commit. ` +
    `Either rebuild it at the pin, point ALTER_EMBED_PLUGIN_ROOT at a clean ` +
    `pinned-commit build, or - if the plugin is being deliberately updated - ` +
    `bump the lock in a reviewed alter-cli PR.`;
  if (allowDirty) {
    notice(`WARNING (ALTER_EMBED_ALLOW_DIRTY=1, dev only): ${detail}`);
    notice(`this build's embedded plugin is NOT the pinned artefact - do not publish it.`);
  } else {
    fail(detail);
  }
}

// Pass 2 - copy (only reached when the pin held, or dev explicitly allowed dirty).
mkdirSync(destRoot, { recursive: true });
let copied = 0;
for (const f of toCopy) {
  copyFileSync(join(pluginRoot, f), join(destRoot, f));
  copied++;
  notice(`embedded ${f}`);
}
notice(`done - ${copied}/${ASSETS.length} assets at ${destRoot}`);
