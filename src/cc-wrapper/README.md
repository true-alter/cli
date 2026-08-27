# `src/cc-wrapper/` - PTY passthrough wrapper for Claude Code

`alter cc` spawns the `claude` binary inside a PTY owned by the ~alter CLI and
pipes the user's terminal stdin / stdout / stderr through transparently.

## What this module is

The wrapper is a thin, low-risk passthrough: pure terminal control, no model
loop owned by ~alter, no inspection of CC's output stream beyond forwarding it
to the user's terminal. It exists so `alter cc` can launch Claude Code under a
PTY the CLI controls, with clean terminal teardown on exit and on `Ctrl-C`.

## Module layout

| File | Role |
|------|------|
| `index.ts` | Verb entry point (`runCcWrapper`) + argv parsing + PTY passthrough wiring. |
| `pty-adapter.ts` | `node-pty` isolation. Falls back to `child_process.spawn` when the native binding is unavailable. |

## PTY native binding

`pty-adapter.ts` dynamically imports `node-pty`. When the native binding
fails to load (sandbox / no toolchain / unsupported platform), the adapter
degrades to `child_process.spawn` with piped stdio.

The pipe-fallback path:

- still gives the user a working `claude` invocation,
- forwards stdin / stdout transparently,
- but loses true PTY semantics (winsize forwarding, raw-mode line editing
  inside CC's own readline). The wrapper prints a one-line stderr cue at
  startup when this happens.

For full PTY behaviour in production we need to:

- Add `node-pty` to `dependencies` (currently NOT in `package.json` - the
  dynamic import + fallback lets the wrapper compile + ship without it, but
  full PTY behaviour requires the native binding).
- Verify the build on Windows, macOS, and Linux glibc / musl targets.
- Confirm the binding is rebuilt across the Node ABI boundary in CI.

## Usage

```
alter cc                       # wrap `claude` in cwd
alter cc --bin /path/to/claude # explicit binary
alter cc -- --resume <id>      # forward args to claude
alter cc --help                # this module's help
```
