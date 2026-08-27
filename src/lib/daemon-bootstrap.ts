/**
 * alter-runtime daemon bootstrap - post-`alter login` nudge.
 *
 * After `alter login` finishes, the user's session is authenticated but the
 * field is silent: nothing on the local box is subscribed to the per-`~handle`
 * DO SSE stream, so peers can't see the session and `alter coord status` has
 * no local state to consult. The alter-runtime daemon (separate repo) owns
 * that subscription; this module is the CLI-side bridge that nudges users
 * to install / start it without spawning a privileged subprocess from the
 * login flow.
 *
 * Three states, three responses:
 *   missing  → print a short brand-styled install one-liner and return.
 *   stopped  → @clack/prompts confirm "Start it now?"; on yes, print the
 *              two-line start command (don't spawn). On no/cancel, dim line.
 *   running  → silent no-op (the happy path).
 *
 * Detection is shell-free: `src/lib/which.ts` locates the binary, then we
 * `execFile('alter-runtime', ['status'])` with a 2s timeout. No exec via
 * shell, no command interpolation, no PATH-spoofing surface.
 *
 * Per the post-login flow contract: this never blocks past the confirm
 * prompt, never throws, and never spawns alter-runtime itself. The user
 * runs the printed commands at their own privilege level.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

import { confirm, isCancel } from "@clack/prompts";

import { brand } from "../ui/biosMenu.js";
import { which } from "./which.js";

const execFileAsync = promisify(execFile);

/** Detection states for the alter-runtime daemon. */
export type DaemonState = "missing" | "stopped" | "running" | "unknown";

/** Result of detectDaemon. `bin` is the absolute path when found. */
export interface DaemonDetection {
  state: DaemonState;
  bin: string | null;
}

/** Caller controls for promptDaemonBootstrap. */
export interface PromptOptions {
  /** Override stdout TTY detection. Default: process.stdout.isTTY. */
  isTTY?: boolean;
  /** Honour the caller's --no-beats flag. When true, skip silently. */
  noBeats?: boolean;
}

/** Status-call timeout. Generous enough for a healthy daemon to reply. */
const STATUS_TIMEOUT_MS = 2000;

/**
 * Walk `$PATH` (mirroring `which.ts`) and return the first absolute path
 * for `binary`, or null. `which()` itself only returns boolean - we want
 * the absolute path here so the caller knows where the binary lives and
 * `execFile` resolves deterministically against a known location.
 */
function resolveBinPath(binary: string): string | null {
  if (!/^[a-zA-Z0-9._+-]+$/.test(binary)) return null;
  const pathEnv = process.env.PATH ?? "";
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, binary + ext);
      try {
        fs.accessSync(candidate, fs.constants.F_OK);
        return candidate;
      } catch {
        // try next
      }
    }
  }
  return null;
}

/**
 * Detect alter-runtime presence + run-state.
 *
 * Three observable outcomes:
 *   missing  → binary not on $PATH.
 *   running  → `alter-runtime status` exits 0 within the timeout.
 *   stopped  → binary exists, but `status` exits non-zero.
 *   unknown  → spawn error / timeout - surface ambiguity rather than
 *              guessing "stopped" (which would falsely advise the user
 *              to start a daemon that may already be running).
 *
 * Never throws. Any unexpected error collapses to {state: "unknown"}.
 */
export async function detectDaemon(): Promise<DaemonDetection> {
  try {
    if (!which("alter-runtime")) {
      return { state: "missing", bin: null };
    }
    const bin = resolveBinPath("alter-runtime");
    if (!bin) {
      // which() said yes but PATH walk missed it - race or odd FS state.
      // Treat as unknown rather than missing; the binary is reachable
      // somewhere, just not where we expect.
      return { state: "unknown", bin: null };
    }
    try {
      await execFileAsync(bin, ["status"], {
        timeout: STATUS_TIMEOUT_MS,
        windowsHide: true,
      });
      return { state: "running", bin };
    } catch (err: unknown) {
      // execFile rejects on non-zero exit, timeout, or spawn failure.
      // Disambiguate by inspecting the error shape: a clean non-zero
      // exit carries a numeric `code`; timeout carries `killed: true`
      // and `signal: 'SIGTERM'`; spawn failure carries an errno.
      const e = err as { code?: number | string; killed?: boolean; signal?: string };
      if (typeof e.code === "number") {
        // Process exited with a non-zero status - daemon not running.
        return { state: "stopped", bin };
      }
      if (e.killed || e.signal) {
        // Timed out (we killed it) - inconclusive.
        return { state: "unknown", bin };
      }
      // Spawn error (ENOENT, EACCES, etc.) - inconclusive.
      return { state: "unknown", bin };
    }
  } catch {
    // Defensive: any throw from which/resolveBinPath collapses to unknown
    // with no path. The login flow continues - this nudge is non-fatal.
    return { state: "unknown", bin: null };
  }
}

/**
 * Post-login bootstrap nudge.
 *
 * Never throws. Returns after the user dismisses the prompt (or
 * immediately when silent). All output goes to process.stdout via
 * brand-styled lines so the post-login screen reads as one piece.
 */
export async function promptDaemonBootstrap(
  opts: PromptOptions = {},
): Promise<void> {
  const isTTY = opts.isTTY ?? !!process.stdout.isTTY;
  if (opts.noBeats === true) return;
  if (!isTTY) return;

  let detection: DaemonDetection;
  try {
    detection = await detectDaemon();
  } catch {
    // detectDaemon should never throw - but if it does, the nudge fails
    // silent. The login flow stays whole.
    return;
  }

  switch (detection.state) {
    case "running":
      // Happy path - the daemon is alive, nothing to surface.
      return;

    case "missing": {
      process.stdout.write("\n");
      process.stdout.write(
        "  " +
          brand.text(
            "Your alter-runtime daemon isn't installed. It's the local",
          ) +
          "\n",
      );
      process.stdout.write(
        "  " +
          brand.text(
            "service that subscribes to your identity field and keeps",
          ) +
          "\n",
      );
      process.stdout.write(
        "  " +
          brand.text("`alter coord status` honest. Without it, your sessions") +
          "\n",
      );
      process.stdout.write(
        "  " + brand.text("don't surface to peers.") + "\n",
      );
      process.stdout.write("\n");
      process.stdout.write(
        "  " +
          brand.accent("pip install 'alter-runtime[dbus,systemd]'") +
          "    " +
          brand.dim("# Linux") +
          "\n",
      );
      process.stdout.write(
        "  " +
          brand.accent("alter-runtime init && alter-runtime start") +
          "\n",
      );
      process.stdout.write("\n");
      process.stdout.write(
        "  " +
          brand.muted("Re-run `alter login` once running and you're in.") +
          "\n",
      );
      return;
    }

    case "stopped": {
      let answer: boolean | symbol;
      try {
        answer = await confirm({
          message:
            "alter-runtime is installed but not running. Start it now?",
          initialValue: false,
        });
      } catch {
        // Clack throws on TTY teardown - fall through to the dim line.
        process.stdout.write(
          "\n  " +
            brand.dim("Start it later with `alter-runtime start`.") +
            "\n",
        );
        return;
      }
      if (isCancel(answer) || answer !== true) {
        process.stdout.write(
          "\n  " +
            brand.dim("Start it later with `alter-runtime start`.") +
            "\n",
        );
        return;
      }
      // User said yes - print the commands rather than spawning. The
      // login flow refuses to invoke a long-lived privileged subprocess
      // on the user's behalf; they run it themselves at their own
      // privilege level.
      process.stdout.write("\n");
      process.stdout.write(
        "  " + brand.accent("alter-runtime init") + "\n",
      );
      process.stdout.write(
        "  " + brand.accent("alter-runtime start") + "\n",
      );
      return;
    }

    case "unknown":
    default:
      process.stdout.write(
        "\n  " +
          brand.dim(
            "alter-runtime detection inconclusive - `alter-runtime status` timed out.",
          ) +
          "\n",
      );
      return;
  }
}
