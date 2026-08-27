#!/usr/bin/env node
// Cross-platform replacement for `node --test path/*.js`.
// PowerShell + cmd.exe do not expand the `*.js` glob, so the literal path
// reaches node and `--test` errors with "Could not find ...*.js".
//
// Recursive walker -- subdirs under tests/ (e.g. tests/cc-wrapper/) are
// included so we don't have to flatten test files for the runner.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Subdirs intentionally excluded from the unit-test walk.
// `e2e/` has its own outDir (test-out-e2e/) + its own `npm run test:e2e`
// runner; including its compiled JS in the unit pass would re-run e2e
// against a live backend and break offline CI.
const EXCLUDED_SUBDIRS = new Set(["e2e"]);

function walkJs(root) {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_SUBDIRS.has(entry.name)) continue;
    const p = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkJs(p));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      out.push(p);
    }
  }
  return out;
}

const dir = process.argv[2] ?? "test-out/tests";

// Unit tests must never touch the OS keychain: pin the deterministic file
// backend so secure-store specs are reproducible offline and on CI. Set here
// rather than as a `VAR=val cmd` prefix in package.json -- cmd.exe/PowerShell
// (npm's script shell on Windows) do not parse POSIX inline env, which broke
// `npm test` on windows-latest. e2e (test-out-e2e) opts out: it exercises the
// real backend on purpose. A caller-pinned backend always wins.
if (!dir.includes("test-out-e2e") && !process.env.ALTER_SECURE_STORE_BACKEND) {
  process.env.ALTER_SECURE_STORE_BACKEND = "file";
}

// Same rule as the keychain pin above, wider seed: a unit test must not reach
// the machine running it. The keychain was the member this file already knew
// about; the class is any live host state. Two layers, because one is not
// enough on its own:
//
//   ALTER_NO_DAEMON_BOUNCE  tells the code path under test to no-op, which is
//                           what a caller can opt into deliberately.
//   the loader gate         refuses a service-manager mutation outright, so a
//                           path that never learned about the env var is still
//                           caught, and caught at author time rather than by a
//                           developer noticing their daemon died hours later.
//
// e2e opts out of both: it owns its host on purpose.
if (!dir.includes("test-out-e2e")) {
  process.env.ALTER_NO_DAEMON_BOUNCE ??= "1";
  // A file URL, not a path: pathToFileURL percent-encodes spaces, and
  // NODE_OPTIONS splits on whitespace, so a checkout under "C:\My Repos\"
  // would otherwise silently mangle the flag.
  const gate = new URL("./test-guards/register.mjs", import.meta.url).href;
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import ${gate}`]
    .filter(Boolean)
    .join(" ");
}

const files = walkJs(dir);

if (files.length === 0) {
  console.error(`run-tests: no .js files in ${dir}`);
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--test", ...files],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
