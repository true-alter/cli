/**
 * output-format - detect whether the CLI is running headless and which output
 * format the caller wants.
 *
 * Detect headless mode and the requested output format:
 *   - TTY/headless detection for the below-floor stdout JSON envelope.
 *     When headless, emit the canonical {"error": {...}} JSON to stdout
 *     in addition to the human prompt on stderr.
 *   - explicit `--output-format json` CLI flag and
 *     `X-Alter-Output-Format: json` request header. Either forces JSON
 *     regardless of TTY state - agent callers shouldn't rely on the
 *     heuristic.
 *   - Windows ConPTY / PowerShell 5.1 fourth signal. On win32 the
 *     absence of `WT_SESSION` (set by Windows Terminal where ANSI is
 *     reliable) is treated as headless.
 *
 * Pure module modulo `process.env` / `process.stdout.isTTY` / `process.platform`
 * - every input is injectable via `Deps` so tests don't poke globals.
 */

export interface OutputFormatDeps {
  env?: NodeJS.ProcessEnv;
  isStdoutTTY?: boolean;
  platform?: NodeJS.Platform;
}

interface RequiredDeps extends Required<OutputFormatDeps> {}

/**
 * Headless signals - return true if ANY of:
 *   1. stdout is not a TTY (piped / redirected).
 *   2. CI env var is set to "true".
 *   3. TERM env var equals "dumb".
 *   4. Windows + no WT_SESSION (ConPTY-less console host - ANSI unreliable).
 *   5. ALTER_OUTPUT_FORMAT env var equals "json" (explicit override).
 */
export function isHeadless(deps?: OutputFormatDeps): boolean {
  const d = withDefaults(deps);
  if (!d.isStdoutTTY) return true;
  if (d.env.CI === "true") return true;
  if (d.env.TERM === "dumb") return true;
  if (d.platform === "win32" && !d.env.WT_SESSION) return true;
  if (d.env.ALTER_OUTPUT_FORMAT === "json") return true;
  return false;
}

/**
 * Parse `--output-format <value>` from the args list. Mutates a copy of the
 * args, returning both the parsed format and the args with the flag stripped.
 *
 * Recognises:
 *   --output-format json
 *   --output-format=json
 *   --output-format text
 *
 * Returns `null` for `format` when the flag is absent. Unknown values are
 * passed through verbatim so the dispatcher can warn; the floor-preflight
 * path only checks for `"json"` explicitly.
 */
export function parseOutputFormatFlag(args: readonly string[]): {
  format: string | null;
  args: string[];
} {
  const out: string[] = [];
  let format: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--output-format") {
      const next = args[i + 1];
      if (next !== undefined) {
        format = next;
        i++; // consume value
      }
      continue;
    }
    if (arg.startsWith("--output-format=")) {
      format = arg.slice("--output-format=".length);
      continue;
    }
    out.push(arg);
  }
  return { format, args: out };
}

/**
 * Decide whether the canonical JSON envelope should additionally be emitted to
 * stdout. Returns true when:
 *   - `--output-format json` was passed on the command line, OR
 *   - any headless signal fires.
 */
export function shouldEmitJsonEnvelope(opts: {
  outputFormatFlag: string | null;
  deps?: OutputFormatDeps;
}): boolean {
  if (opts.outputFormatFlag === "json") return true;
  return isHeadless(opts.deps);
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function withDefaults(deps?: OutputFormatDeps): RequiredDeps {
  return {
    env: deps?.env ?? process.env,
    isStdoutTTY:
      deps?.isStdoutTTY ?? Boolean(process.stdout.isTTY),
    platform: deps?.platform ?? process.platform,
  };
}
