#!/usr/bin/env node
// strip-testing-exports.mjs — remove test-seam exports from the public dist.
//
// Each command/lib module exports a flat `__testing` / `__testing__` object so
// the unit tests (which compile from src/ to test-out/, NOT from dist/) can
// reach module-private helpers. Those exports have no consumer inside dist/ —
// only the test build imports them — so shipping them in the published
// artefact only widens its reverse-engineering surface (Public Package
// Pentester finding against 0.8.8: `__testing__.activeCfAccessEnvFile()` et al
// were importable from the shipped package). This strips them from the built
// .js after tsc emits dist/.
//
// Safe by construction: every `__testing` object across the 7 call sites is a
// flat shorthand object with no nested braces, so the no-nested-brace match
// cannot over-run into surrounding code. Runtime `.js` only — the `.d.ts` type
// declarations are types, not a runtime import surface, and are left as-is.

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST = "dist";
// `export const __testing[__] = { ...no braces... };`  (single- or multi-line)
const PATTERN =
  /^[ \t]*export const __testing(?:__)?\s*=\s*\{[^{}]*?\};[ \t]*\r?\n?/gm;

let filesStripped = 0;
let exportsStripped = 0;

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      // The embedded plugin bundle is a separate artefact built by its own
      // repo; leave it untouched. Only strip the CLI's own emitted modules.
      if (entry === "embedded-plugins") continue;
      walk(p);
    } else if (entry.endsWith(".js")) {
      const src = readFileSync(p, "utf8");
      const matches = src.match(PATTERN);
      if (matches) {
        writeFileSync(p, src.replace(PATTERN, ""), "utf8");
        filesStripped += 1;
        exportsStripped += matches.length;
      }
    }
  }
}

try {
  statSync(DIST);
} catch {
  console.error("strip-testing-exports: dist/ not found — run after build");
  process.exit(1);
}

walk(DIST);
console.log(
  `strip-testing-exports: removed ${exportsStripped} __testing export(s) from ${filesStripped} file(s)`,
);
