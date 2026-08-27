/**
 * PTY adapter -- isolates `node-pty` behind a small interface so the
 * wrapper compiles + tests pass even when the native binding fails to
 * build (sandbox / cross-compile / Windows-without-VS-Build-Tools).
 *
 * In production the adapter dynamically imports `node-pty` at runtime
 * and spawns the wrapped CC binary inside a real PTY. When the import
 * fails the adapter falls back to a child_process pipe -- the user
 * still gets a working `alter cc` invocation, just without true PTY
 * semantics (no terminal resize forwarding, no raw-mode line editing
 * inside CC itself). The fallback is documented in the README so the
 * user knows what they lose.
 *
 * STUB: native node-pty load is best-effort. The fallback path uses
 * `child_process.spawn` with `stdio: "inherit"` which is adequate for
 * smoke-testing but lacks the ANSI-resize + winsize propagation that
 * full CC interactive use requires. End-to-end testing with the real
 * `claude` binary must be done in a node-pty-enabled environment.
 */

import * as childProcess from "node:child_process";

/**
 * Local structural type for the slice of `node-pty` we touch.
 *
 * Declared here instead of relying on `@types/node-pty` so the wrapper
 * type-checks even when the optional native dependency is absent from
 * the install tree (the import is deferred to runtime).
 */
interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: NodeJS.ProcessEnv;
    },
  ): PtyProcess;
}

interface PtyProcess {
  write(data: string): void;
  onData(listener: (chunk: string) => void): void;
  onExit(listener: (event: { exitCode: number }) => void): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

/**
 * Minimal surface area of an IPty instance we depend on.
 *
 * Modelled on the `IPty` interface from `node-pty` v1.x but kept
 * deliberately narrow so the fallback child_process adapter can
 * implement it without dragging in the rest of the node-pty API.
 */
export interface PtyHandle {
  /** Write a chunk to the child's stdin. */
  write(data: string): void;
  /** Subscribe to the child's stdout/stderr stream. */
  onData(listener: (chunk: string) => void): void;
  /** Subscribe to child exit. */
  onExit(listener: (event: { exitCode: number }) => void): void;
  /** Forward a terminal resize event. */
  resize(cols: number, rows: number): void;
  /** Send a termination signal. */
  kill(signal?: string): void;
}

/** Spawn options for the wrapped CC binary. */
export interface PtySpawnOptions {
  /** Executable -- typically "claude". */
  file: string;
  /** argv tail forwarded to the child. */
  args: string[];
  /** Initial cols/rows derived from the user's terminal. */
  cols: number;
  rows: number;
  /** Working directory + environment for the child. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Spawn the wrapped CC binary. Tries `node-pty` first; on failure
 * (e.g. native binding missing in the current environment) falls back
 * to `child_process.spawn`. The caller cannot tell the difference at
 * the type level -- both paths return a `PtyHandle`.
 *
 * Returns a tuple of `[handle, mode]` where `mode` is "pty" when the
 * native binding loaded successfully and "pipe" when the fallback is
 * in use. The wrapper logs the mode at startup so operators have a
 * one-line cue if ghost-text rendering looks broken.
 */
export async function spawnCcUnderPty(
  opts: PtySpawnOptions,
): Promise<{ handle: PtyHandle; mode: "pty" | "pipe" }> {
  // Dynamic import keeps node-pty out of the static dependency graph.
  // `npm install` is expected to install it; if it failed to compile
  // (no toolchain present) we drop to the pipe fallback at this catch.
  //
  // The specifier is hidden behind a runtime expression so TypeScript
  // does not attempt to resolve the module at compile time. This is
  // essential: the wrapper must compile + ship without node-pty in
  // the dependency tree (the native binding gets installed at deploy).
  try {
    const moduleId = "node-pty";
    const pty = (await import(moduleId)) as PtyModule;
    const proc = pty.spawn(opts.file, opts.args, {
      name: "xterm-256color",
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd ?? process.cwd(),
      env: opts.env ?? process.env,
    });
    const handle: PtyHandle = {
      write: (data: string) => proc.write(data),
      onData: (listener: (chunk: string) => void) => proc.onData(listener),
      onExit: (listener: (event: { exitCode: number }) => void) =>
        proc.onExit(listener),
      resize: (cols: number, rows: number) => proc.resize(cols, rows),
      kill: (signal?: string) => proc.kill(signal),
    };
    return { handle, mode: "pty" };
  } catch {
    // Fallback path -- node-pty missing or its native binding failed
    // to load. Spawn via child_process with piped stdio so the
    // wrapper's stdin/stdout hooks still work. ANSI resize forwarding
    // is a no-op in this mode.
    const proc = childProcess.spawn(opts.file, opts.args, {
      cwd: opts.cwd ?? process.cwd(),
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const dataListeners: Array<(chunk: string) => void> = [];
    const exitListeners: Array<(event: { exitCode: number }) => void> = [];
    proc.stdout?.on("data", (buf: Buffer) => {
      const s = buf.toString("utf8");
      for (const l of dataListeners) l(s);
    });
    proc.stderr?.on("data", (buf: Buffer) => {
      const s = buf.toString("utf8");
      for (const l of dataListeners) l(s);
    });
    proc.on("exit", (code) => {
      for (const l of exitListeners) l({ exitCode: code ?? 0 });
    });
    const handle: PtyHandle = {
      write: (data) => {
        proc.stdin?.write(data);
      },
      onData: (listener) => {
        dataListeners.push(listener);
      },
      onExit: (listener) => {
        exitListeners.push(listener);
      },
      // Pipe mode has no winsize concept; ignore.
      resize: () => undefined,
      kill: (signal) => proc.kill((signal as NodeJS.Signals) ?? "SIGTERM"),
    };
    return { handle, mode: "pipe" };
  }
}
