#!/usr/bin/env node
/**
 * check-loom-provenance.mjs -- verify src/assets/loom/folder_loom.py's
 * sha256 still matches what src/assets/loom/PROVENANCE records.
 *
 * PROVENANCE is a dev-only maintenance note: it names the upstream repo,
 * source path and commit the vendored copy was refreshed from, plus the
 * sha256 that copy should carry. It is never shipped - the build script
 * copies only folder_loom.py into dist/assets/loom, not the whole
 * src/assets/loom directory - so this check runs against the source tree,
 * not the published artefact.
 *
 * This is a mechanical consistency check, nothing more: it confirms the
 * bytes on disk still match the hash PROVENANCE records, so a hand-edit to
 * either one without updating the other is caught before it ships silently.
 * It does not reach the network and does not read the upstream repository.
 *
 * Exit 0: recorded sha256 matches the file on disk.
 * Exit 1: mismatch, or PROVENANCE/folder_loom.py is missing or malformed.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const ASSET_DIR = path.resolve(process.cwd(), "src", "assets", "loom");
const PROVENANCE_PATH = path.join(ASSET_DIR, "PROVENANCE");
const VENDORED_PATH = path.join(ASSET_DIR, "folder_loom.py");

function fail(message) {
  console.error(`check-loom-provenance: ${message}`);
  process.exitCode = 1;
}

let provenanceText;
try {
  provenanceText = readFileSync(PROVENANCE_PATH, "utf8");
} catch (err) {
  fail(`could not read ${PROVENANCE_PATH}: ${err.message}`);
  process.exit(process.exitCode);
}

const match = provenanceText.match(/^sha256:\s*([0-9a-f]{64})\s*$/m);
if (!match) {
  fail(`${PROVENANCE_PATH} has no \`sha256: <64 hex chars>\` field to check against`);
  process.exit(process.exitCode);
}
const recorded = match[1];

let vendoredBytes;
try {
  vendoredBytes = readFileSync(VENDORED_PATH);
} catch (err) {
  fail(`could not read ${VENDORED_PATH}: ${err.message}`);
  process.exit(process.exitCode);
}
const actual = createHash("sha256").update(vendoredBytes).digest("hex");

if (actual !== recorded) {
  fail(
    `${VENDORED_PATH} sha256 does not match ${PROVENANCE_PATH}.\n` +
      `  recorded: ${recorded}\n` +
      `  actual:   ${actual}\n` +
      "The vendored copy was refreshed without updating PROVENANCE (or the reverse).",
  );
  process.exit(process.exitCode);
}

console.log("check-loom-provenance: OK - folder_loom.py matches PROVENANCE.");
