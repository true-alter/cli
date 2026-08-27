/**
 * loom-ci-config.ts -- declared check list for `alter doctor loom --ci`.
 *
 * Deliberately dumb: this module reads a small JSON file the repository
 * owner writes themselves and validates its shape. It does not look at
 * package.json, pyproject.toml, Cargo.toml, or anything else to guess what
 * a repository "probably" wants to run - a declared list is the whole
 * contract. The ship-default is zero checks; the config file need not
 * exist at all, and the runner's job when it is absent is to say so
 * plainly and point at how to add one, not to invent something to run.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { reservedCompareForm, hasUnprintable, safeField } from "../lib/unprintable.js";

/** One declared check. */
export interface LoomCiCheck {
  /** Short stable id, used only in output (e.g. "lint", "unit-tests"). */
  id: string;
  /** Shell command line, run via the platform shell (same as `sh -c`/`cmd /c`). */
  command: string;
  /**
   * Working directory, relative to the repo root, and inside it. Defaults to
   * the repo root. An absolute path, or one that climbs out with `..`, is
   * refused: a check declared by a repository runs in that repository.
   */
  cwd?: string;
  /** Per-check timeout in milliseconds. Defaults to DEFAULT_CHECK_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** The whole declared config. */
export interface LoomCiConfig {
  /**
   * The GitHub commit-status `context` string this run posts under.
   * User-chosen; defaults to DEFAULT_CONTEXT. Must never collide with
   * ALTER's own branch-protection context.
   */
  context?: string;
  checks: LoomCiCheck[];
}

/** Path a config is read from, relative to the repo root. */
export const CONFIG_RELATIVE_PATH = path.join(".alter", "loom.json");

/** Fallback commit-status context when the config doesn't set one. */
export const DEFAULT_CONTEXT = "local-checks";

/** Fallback per-check timeout: 10 minutes. */
export const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60 * 1000;

const RESERVED_CONTEXT = "Loom Tier-0 Verdict";

// `reservedCompareForm` comes from lib/unprintable.ts, and the reason it is
// imported rather than defined here is itself a finding.
//
// This module used to keep its own narrower table: zero-width and bidi
// codepoints only, no ASCII control characters. NFKC does not fold a control
// character and the non-ASCII refusal below does not catch one, so
// "Loom Tier-0 Verdict" with a DEL byte appended passed both gates while
// rendering as the reserved name wherever DEL is dropped rather than shown.
// A publish gate execution-verified five such bypasses (DEL, NUL, BEL, SO,
// ESC) plus TAB-for-space, against a build where the correct table already
// existed two modules away and simply had not crossed the boundary.
//
// One table, one import, no second copy to drift.

export type LoadConfigResult =
  | { kind: "absent"; path: string }
  | { kind: "ok"; path: string; config: LoomCiConfig }
  | { kind: "error"; path: string; message: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate a parsed JSON value against the LoomCiConfig shape. Returns a
 * human-readable error string on the first problem found, or null when the
 * value is well-formed.
 */
function validate(raw: unknown): string | null {
  if (!isPlainObject(raw)) return "config must be a JSON object";
  if ("context" in raw && typeof raw.context !== "string") {
    return "`context` must be a string";
  }
  if (typeof raw.context === "string") {
    // Refuse outright before comparing. A commit-status label is a name a
    // human reads; a control character in one is never legitimate and only
    // ever serves to make two different strings render the same. Refusing the
    // class is stronger than any comparison that has to reason about how each
    // control renders on each terminal, and it fails closed.
    // Trimmed, because the value that is USED is trimmed: the loader takes
    // `context.trim()`, so surrounding whitespace is not part of the label and
    // a trailing newline in hand-written JSON is not a control character
    // anybody chose. Refusing it made a behaviour change nobody claimed.
    if (hasUnprintable(raw.context.trim())) {
      return (
        "`context` must not contain control or invisible characters - they " +
        "render as nothing or move the cursor, so two different labels can " +
        "look identical on screen."
      );
    }
    const compareForm = reservedCompareForm(raw.context.trim());
    if (compareForm === RESERVED_CONTEXT) {
      return `\`context\` must not be "${RESERVED_CONTEXT}" - that value is reserved.`;
    }
    // A script-mixing homoglyph (a Cyrillic "о" standing in for a Latin "o")
    // was execution-verified to slip past the check above too, and this
    // package carries no confusables table to catch a specific look-alike
    // precisely. `context` is only ever a GitHub commit-status label, which
    // is conventionally ASCII and never needs to be anything else, so the
    // fix that is actually sound without one is narrower: refuse non-ASCII
    // outright. That closes the whole class the reserved-string comparison
    // exists to protect, not only the one Cyrillic instance that was found.
    if (/[^\x00-\x7F]/.test(compareForm)) {
      return (
        "`context` must be plain ASCII - a look-alike character in a " +
        "different script can render identically to a reserved value on " +
        "screen while comparing unequal to it."
      );
    }
  }
  if (!("checks" in raw) || !Array.isArray(raw.checks)) {
    return "`checks` must be an array";
  }
  const seenIds = new Set<string>();
  for (let i = 0; i < raw.checks.length; i++) {
    const c = raw.checks[i];
    if (!isPlainObject(c)) return `checks[${i}] must be an object`;
    if (typeof c.id !== "string" || c.id.trim() === "") {
      return `checks[${i}].id must be a non-empty string`;
    }
    if (seenIds.has(c.id)) return `checks[${i}].id "${safeField(c.id, 80)}" is duplicated`;
    seenIds.add(c.id);
    if (typeof c.command !== "string" || c.command.trim() === "") {
      return `checks[${i}].command must be a non-empty string`;
    }
    if ("cwd" in c && typeof c.cwd !== "string") {
      return `checks[${i}].cwd must be a string`;
    }
    // A declared working directory names a place INSIDE the repository that
    // declared it. `path.resolve` returns an absolute second argument
    // unchanged, so an absolute `cwd` silently ran the check wherever it
    // pointed, and `../` climbed out the same way. Rejected here, at the
    // declaration, so the message names the file and the index; the runner
    // re-checks the resolved path as well, because a lexical test cannot see
    // a symlinked subdirectory.
    if (typeof c.cwd === "string" && c.cwd !== "") {
      const declared = c.cwd;
      const normalised = path.normalize(declared).replace(/[\\/]+$/, "");
      if (
        path.isAbsolute(declared) ||
        /^[A-Za-z]:/.test(declared) ||
        normalised === ".." ||
        normalised.startsWith(`..${path.sep}`) ||
        normalised.startsWith("../")
      ) {
        return (
          `checks[${i}].cwd must be a relative path inside the repository ` +
          `(got "${safeField(declared, 200)}")`
        );
      }
    }
    if (
      "timeoutMs" in c &&
      (typeof c.timeoutMs !== "number" ||
        !Number.isFinite(c.timeoutMs) ||
        c.timeoutMs <= 0)
    ) {
      return `checks[${i}].timeoutMs must be a positive number`;
    }
  }
  return null;
}

/**
 * Load and validate the declared check list for `repoRoot`.
 *
 * `overridePath`, when given, is used verbatim instead of the default
 * `.alter/loom.json` location (absolute, or resolved relative to
 * `repoRoot`).
 */
export function loadLoomCiConfig(
  repoRoot: string,
  overridePath?: string,
): LoadConfigResult {
  const configPath = overridePath
    ? path.isAbsolute(overridePath)
      ? overridePath
      : path.resolve(repoRoot, overridePath)
    : path.join(repoRoot, CONFIG_RELATIVE_PATH);

  let contents: string;
  try {
    contents = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { kind: "absent", path: configPath };
    return {
      kind: "error",
      path: configPath,
      message: `could not read ${configPath}: ${e.message}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (err) {
    return {
      kind: "error",
      path: configPath,
      message: `${configPath} is not valid JSON: ${(err as Error).message}`,
    };
  }

  const problem = validate(parsed);
  if (problem) {
    return { kind: "error", path: configPath, message: `${configPath}: ${problem}` };
  }

  return { kind: "ok", path: configPath, config: parsed as LoomCiConfig };
}

/** Help text shown when no config file exists (the bare default). */
export function noConfigHelp(repoRoot: string): string {
  const rel = CONFIG_RELATIVE_PATH;
  return (
    // `repoRoot` is repository-influenced: a shipped directory name may carry
    // an ESC byte, and this is the most reachable path in the whole command --
    // it needs no config file, no approval, and exits 0, so nothing about the
    // outcome tells the operator their screen was just rewritten.
    `alter doctor loom --ci: no ${rel} found under ${safeField(repoRoot, 200)}.\n\n` +
    "There is no default check list - a repository declares its own. " +
    `Create ${rel} with a checks array, for example:\n\n` +
    "{\n" +
    '  "context": "local-checks",\n' +
    '  "checks": [\n' +
    '    { "id": "lint", "command": "npm run lint" },\n' +
    '    { "id": "test", "command": "npm test" }\n' +
    "  ]\n" +
    "}\n\n" +
    "Each check runs as an ordinary subprocess in the repo root (or its " +
    "own `cwd`, if set). `context` is the GitHub commit-status context " +
    "this run posts under; it defaults to " +
    `"${DEFAULT_CONTEXT}" when omitted.\n` +
    "No checks were run and no commit status was posted.\n"
  );
}
