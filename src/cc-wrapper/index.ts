/**
 * `alter cc` -- PTY passthrough wrapper for the Claude Code binary.
 *
 * Spawns `claude` as a subprocess inside a PTY and pipes the user's
 * terminal stdin/stdout/stderr through transparently. The verb is a
 * thin orchestrator: the PTY adapter isolates `node-pty` and this
 * module wires the child to the user's terminal and forwards bytes.
 *
 * Notes on the scaffold:
 *   - PTY adapter falls back to child_process when node-pty's native
 *     binding fails to load -- end-to-end interactive testing
 *     requires a node-pty-enabled environment.
 *
 * See `src/cc-wrapper/README.md` for details.
 */

import { spawnCcUnderPty, type PtyHandle } from "./pty-adapter.js";

/** Default child binary if the user doesn't override via --bin. */
const DEFAULT_CC_BINARY = "claude";

/**
 * Runtime options for the wrapper. Public so tests + future callers can
 * compose the wrapper without going through the CLI verb path.
 */
export interface CcWrapperOptions {
  /** Executable to wrap; defaults to "claude". */
  binary?: string;
  /** argv forwarded to the child. */
  childArgs?: string[];
}

function printHelp(): void {
  console.log(
    "Usage: alter cc [--bin <path>] [-- <claude args>]\n" +
      "\n" +
      "Run the Claude Code binary under the ~Alter wrapper.\n" +
      "Stdin/stdout/stderr are piped through transparently.\n" +
      "\n" +
      "Flags:\n" +
      "  --bin <path>      Override the wrapped binary (default: claude).\n" +
      "  -- <args>         All args after `--` are forwarded to the child.\n",
  );
}

/**
 * Parse argv specific to `alter cc`. Anything after `--` is forwarded
 * verbatim to the wrapped binary.
 */
export function parseCcArgs(argv: string[]): {
  binary: string;
  childArgs: string[];
  help: boolean;
} {
  let binary = DEFAULT_CC_BINARY;
  const childArgs: string[] = [];
  let i = 0;
  let inForward = false;
  while (i < argv.length) {
    const arg = argv[i];
    if (inForward) {
      childArgs.push(arg);
      i++;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { binary, childArgs, help: true };
    }
    if (arg === "--") {
      inForward = true;
      i++;
      continue;
    }
    if (arg === "--bin") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("alter cc: --bin requires a path argument");
      }
      binary = next;
      i += 2;
      continue;
    }
    // Unknown flag before `--` -- treat as a forwarded child arg so
    // we don't surprise users running `alter cc --resume <id>` etc.
    childArgs.push(arg);
    i++;
  }
  return { binary, childArgs, help: false };
}

/**
 * Main entry point for the `alter cc` verb. Spawns CC under a PTY and
 * pipes the user's terminal to the child transparently.
 *
 * Resolves when the child exits.
 */
export async function runCcWrapper(
  argv: string[],
  opts: CcWrapperOptions = {},
): Promise<number> {
  const parsed = parseCcArgs(argv);
  if (parsed.help) {
    printHelp();
    return 0;
  }

  const binary = opts.binary ?? parsed.binary;
  const childArgs = opts.childArgs ?? parsed.childArgs;

  // Snapshot the user's terminal size for the initial PTY winsize.
  // process.stdout.columns / .rows are undefined when stdout is not
  // a TTY -- fall back to a reasonable default in that case.
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;

  const { handle, mode } = await spawnCcUnderPty({
    file: binary,
    args: childArgs,
    cols,
    rows,
  });

  if (mode === "pipe") {
    // One-line operator cue -- passthrough still works, but without
    // true PTY semantics. Logged to stderr so the child's stdout isn't
    // polluted.
    process.stderr.write(
      "alter cc: node-pty native binding unavailable, " +
        "running in pipe-fallback mode.\n",
    );
  }

  // Wire CC stdout -> user's terminal (passthrough).
  handle.onData((chunk) => {
    process.stdout.write(chunk);
  });

  // Wire user's stdin -> CC stdin (passthrough).
  // Set raw mode so we forward every keystroke byte-by-byte.
  const stdin = process.stdin;
  const wasRaw = stdin.isTTY ? stdin.isRaw : false;
  if (stdin.isTTY) {
    stdin.setRawMode(true);
  }
  stdin.resume();
  stdin.setEncoding("utf8");

  const onStdinData = (chunk: string) => {
    handle.write(chunk);
  };
  stdin.on("data", onStdinData);

  // Forward terminal resize -> PTY winsize.
  const onResize = () => {
    handle.resize(process.stdout.columns ?? cols, process.stdout.rows ?? rows);
  };
  process.stdout.on("resize", onResize);

  /** Restore terminal state on any exit path (normal teardown or signal). */
  const teardownTty = (): void => {
    stdin.off("data", onStdinData);
    process.stdout.off("resize", onResize);
    if (stdin.isTTY) {
      try { stdin.setRawMode(wasRaw); } catch { /* already destroyed */ }
    }
    // Always restore cursor visibility so the terminal is usable after exit.
    process.stdout.write("\x1b[?25h");
    stdin.pause();
  };

  // SIGINT: restore TTY before the process unwinds.
  // Without this, Ctrl-C while the wrapper holds raw mode leaves the
  // terminal in raw mode and with a hidden cursor.
  const onSigint = (): void => {
    teardownTty();
    process.exitCode = 130;
    // Do not call process.exit() -- let the event loop drain (same
    // convention as biosMenu.ts SIGINT handler).
  };
  process.on("SIGINT", onSigint);

  // Wait for the child to exit.
  const exitCode = await new Promise<number>((resolve) => {
    handle.onExit((event) => resolve(event.exitCode));
  });

  process.off("SIGINT", onSigint);

  // Tear down cleanly (normal exit path).
  teardownTty();

  return exitCode;
}

// Convenience re-export so callers can `import { ... } from "./cc-wrapper"`.
export type { PtyHandle } from "./pty-adapter.js";
