/**
 * doctor/checks/runtime.ts -- alter-runtime daemon diagnostic checks.
 *
 * All checks are LIVE (socket/process probes) and DIAGNOSE-ONLY. The daemon
 * is optional -- every missing-or-not-installed state degrades to WARN rather
 * than FAIL.
 *
 * Verified paths (the runtime daemon's documented config):
 *   Unix socket  Linux:  $XDG_RUNTIME_DIR/alter.sock  (fallback: /tmp/alter-$UID.sock)
 *                macOS:  ~/Library/Application Support/alter/runtime.sock
 *   Identity cache:      $XDG_CACHE_HOME/alter/identity.json  (default ~/.cache/alter/identity.json)
 *   Presence feed JSONL: $XDG_DATA_HOME/alter-runtime/presence.jsonl
 *                        (default ~/.local/share/alter-runtime/presence.jsonl)
 *   Systemd unit:        alter-runtime.service  (--user)
 *   Launchd label:       com.alter.runtime
 *
 * git_watcher active/idle status is derived from the systemd journal: active
 * means at least one kind=git_commit line in recent journal output, idle means
 * the daemon is running but no git_commit events have been logged yet.
 * (Mirrors the daemon journal.)
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  Check,
  CheckResult,
  DoctorCtx,
} from "../../lib/check-report.js";

const execFile = promisify(_execFile);

// ---------------------------------------------------------------------------
// Path helpers (honour XDG env vars, matching the runtime daemon's config)
// ---------------------------------------------------------------------------

/** $XDG_RUNTIME_DIR/alter.sock on Linux; ~/Library/Application Support/alter/runtime.sock on macOS. */
function runtimeSocketPath(platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "alter", "runtime.sock");
  }
  // Linux (and everything else): prefer $XDG_RUNTIME_DIR, fall back to /tmp/alter-$UID.
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (runtimeDir) {
    return path.join(runtimeDir, "alter.sock");
  }
  const uid = process.getuid ? process.getuid() : 0;
  return `/tmp/alter-${uid}.sock`;
}

/** $XDG_CACHE_HOME/alter/identity.json (default ~/.cache/alter/identity.json). */
function identityCachePath(): string {
  const cacheBase = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  return path.join(cacheBase, "alter", "identity.json");
}

/** $XDG_DATA_HOME/alter-runtime/presence.jsonl (default ~/.local/share/alter-runtime/presence.jsonl). */
function presenceFeedPath(): string {
  const dataBase =
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(dataBase, "alter-runtime", "presence.jsonl");
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function fileExists(filePath: string): boolean {
  try {
    fs.statSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function fileMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function fileWritable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Attempt a TCP-style connect to a Unix socket with a timeout.
 * Returns true if the connection succeeded before the deadline.
 */
async function canConnectSocket(socketPath: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

// ---------------------------------------------------------------------------
// runtime.process
// ---------------------------------------------------------------------------

const processCheck: Check = {
  id: "runtime.process",
  category: "runtime",
  label: "alter-runtime daemon process running",
  healClass: "DIAGNOSE-ONLY",
  live: true,
  async run(ctx: DoctorCtx): Promise<CheckResult> {
    if (ctx.platform === "linux") {
      // systemd --user is-active alter-runtime.service
      try {
        const { stdout } = await Promise.race([
          execFile("systemctl", ["--user", "is-active", "alter-runtime.service"]),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), ctx.timeoutMs),
          ),
        ]);
        const state = (stdout as string).trim();
        if (state === "active") {
          return { status: "OK", detail: "alter-runtime.service is active" };
        }
        // installed but not running
        return {
          status: "WARN",
          detail: `alter-runtime.service state: ${state || "unknown"}`,
          remedy: "run `systemctl --user start alter-runtime.service`",
        };
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (msg === "timeout") {
          return {
            status: "WARN",
            detail: "timed out querying systemctl -- daemon state unknown",
            remedy: "run `alter-runtime status` to check manually",
          };
        }
        // Non-zero exit from is-active means not active or unit absent.
        // Distinguish "unit not found" from "inactive".
        const stderr = (err as { stderr?: string }).stderr ?? "";
        if (stderr.includes("not found") || stderr.includes("No such file")) {
          return {
            status: "WARN",
            detail: "alter-runtime.service not installed",
            remedy: "run `alter-runtime init` to install the service unit",
          };
        }
        return {
          status: "WARN",
          detail: `alter-runtime.service not active (${(err as Error).message.split("\n")[0]})`,
          remedy: "run `systemctl --user start alter-runtime.service`",
        };
      }
    }

    if (ctx.platform === "darwin") {
      // launchctl print gui/$UID/com.alter.runtime
      const uid = process.getuid ? process.getuid() : 0;
      const label = `gui/${uid}/com.alter.runtime`;
      try {
        const { stdout } = await Promise.race([
          execFile("launchctl", ["print", label]),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), ctx.timeoutMs),
          ),
        ]);
        const running = (stdout as string).includes("state = running");
        if (running) {
          return { status: "OK", detail: "com.alter.runtime is running" };
        }
        return {
          status: "WARN",
          detail: "com.alter.runtime not running",
          remedy: "run `launchctl kickstart -k gui/$UID/com.alter.runtime` or `alter-runtime start`",
        };
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (msg === "timeout") {
          return {
            status: "WARN",
            detail: "timed out querying launchctl -- daemon state unknown",
            remedy: "run `alter-runtime status` to check manually",
          };
        }
        return {
          status: "WARN",
          detail: "com.alter.runtime not installed",
          remedy: "run `alter-runtime init` to install the launchd plist",
        };
      }
    }

    // Unsupported platform.
    return {
      status: "WARN",
      detail: `daemon process check not supported on platform ${ctx.platform}`,
    };
  },
};

// ---------------------------------------------------------------------------
// runtime.socket
// ---------------------------------------------------------------------------

const socketCheck: Check = {
  id: "runtime.socket",
  category: "runtime",
  label: "alter-runtime Unix socket present and connectable",
  healClass: "DIAGNOSE-ONLY",
  live: true,
  async run(ctx: DoctorCtx): Promise<CheckResult> {
    const sockPath = runtimeSocketPath(ctx.platform);

    if (!fileExists(sockPath)) {
      return {
        status: "WARN",
        detail: `socket not found: ${sockPath}`,
        remedy:
          "start the daemon (`alter-runtime start`) or check that XDG_RUNTIME_DIR is set correctly",
      };
    }

    // Socket file present -- attempt connection.
    const connectable = await canConnectSocket(sockPath, ctx.timeoutMs);
    if (!connectable) {
      return {
        status: "WARN",
        detail: `socket present but not connectable (${sockPath})`,
        remedy:
          "the daemon may be wedged -- try `alter-runtime stop && alter-runtime start`",
      };
    }

    return { status: "OK", detail: sockPath };
  },
};

// ---------------------------------------------------------------------------
// runtime.identity-cache
// ---------------------------------------------------------------------------

/** Threshold in milliseconds beyond which the identity cache is considered stale. */
const IDENTITY_CACHE_STALE_MS = 60 * 60 * 1000; // 1 hour

const identityCacheCheck: Check = {
  id: "runtime.identity-cache",
  category: "runtime",
  label: "identity cache present and recent",
  healClass: "DIAGNOSE-ONLY",
  live: true,
  async run(ctx: DoctorCtx): Promise<CheckResult> {
    const cachePath = identityCachePath();

    if (!fileExists(cachePath)) {
      return {
        status: "WARN",
        detail: `identity cache not found: ${cachePath}`,
        remedy:
          "start the daemon (`alter-runtime start`) -- it will populate the cache on first sync",
      };
    }

    const mtimeMs = fileMtimeMs(cachePath);
    if (mtimeMs === null) {
      return {
        status: "WARN",
        detail: `cannot stat identity cache: ${cachePath}`,
      };
    }

    const ageMs = ctx.now - mtimeMs;
    if (ageMs > IDENTITY_CACHE_STALE_MS) {
      const ageMin = Math.round(ageMs / 60_000);
      return {
        status: "WARN",
        detail: `identity cache stale (${ageMin}min old): ${cachePath}`,
        remedy:
          "verify the daemon is running and reachable (`alter-runtime status`)",
      };
    }

    const ageSec = Math.round(ageMs / 1000);
    return {
      status: "OK",
      detail: `${cachePath} (${ageSec}s ago)`,
    };
  },
};

// ---------------------------------------------------------------------------
// runtime.presence-feed
// ---------------------------------------------------------------------------

const presenceFeedCheck: Check = {
  id: "runtime.presence-feed",
  category: "runtime",
  label: "presence feed JSONL present and writable",
  healClass: "DIAGNOSE-ONLY",
  live: true,
  async run(_ctx: DoctorCtx): Promise<CheckResult> {
    const feedPath = presenceFeedPath();

    if (!fileExists(feedPath)) {
      // Not a hard failure -- the daemon only creates this file when the first
      // presence_set event arrives; it may legitimately be absent on a fresh install.
      return {
        status: "WARN",
        detail: `presence feed not found: ${feedPath}`,
        remedy:
          "file is created by the daemon on the first presence event; start the daemon if it is not running",
      };
    }

    if (!fileWritable(feedPath)) {
      return {
        status: "WARN",
        detail: `presence feed not writable: ${feedPath}`,
        remedy: `check file permissions: chmod 600 ${feedPath}`,
      };
    }

    return { status: "OK", detail: feedPath };
  },
};

// ---------------------------------------------------------------------------
// runtime.git-watcher
// ---------------------------------------------------------------------------

/**
 * Derive git_watcher status from the systemd journal (Linux) or the macOS
 * socket presence (darwin, where journalctl is unavailable).
 *
 * Logic mirrors the daemon journal (substrate-verified):
 *   - scan recent journal for "kind=git_commit" lines
 *   - present sha → git_watcher is actively firing (OK)
 *   - no sha but daemon running → git_watcher idle (WARN, advisory)
 */
const gitWatcherCheck: Check = {
  id: "runtime.git-watcher",
  category: "runtime",
  label: "git_watcher active or idle status",
  healClass: "DIAGNOSE-ONLY",
  live: true,
  async run(ctx: DoctorCtx): Promise<CheckResult> {
    if (ctx.platform === "linux") {
      // First check the daemon is running at all.
      try {
        await Promise.race([
          execFile("systemctl", ["--user", "is-active", "--quiet", "alter-runtime.service"]),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), ctx.timeoutMs),
          ),
        ]);
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (msg === "timeout") {
          return {
            status: "WARN",
            detail: "timed out checking daemon status for git_watcher",
          };
        }
        return {
          status: "WARN",
          detail: "alter-runtime not running -- git_watcher cannot be checked",
          remedy: "run `alter-runtime start` to start the daemon",
        };
      }

      // Daemon running: scan recent journal for git_commit events.
      try {
        const { stdout } = await Promise.race([
          execFile("journalctl", [
            "--user",
            "-u", "alter-runtime.service",
            "-n", "300",
            "--no-pager",
            "--output", "cat",
          ]),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), ctx.timeoutMs),
          ),
        ]);
        const match = (stdout as string).match(/kind=git_commit.*sha=([a-f0-9]+)/);
        if (match) {
          const sha = match[1].slice(0, 7);
          return { status: "OK", detail: `git_watcher active -- last commit sha=${sha}` };
        }
        return {
          status: "WARN",
          detail: "git_watcher idle -- no git_commit events in recent journal",
          remedy:
            "normal if no commits have occurred since the daemon started; watchdog requires a git repo in the working directory",
        };
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (msg === "timeout") {
          return {
            status: "WARN",
            detail: "timed out reading journalctl for git_watcher status",
          };
        }
        return {
          status: "WARN",
          detail: `could not read journal: ${(err as Error).message.split("\n")[0]}`,
          remedy: "run `journalctl --user -u alter-runtime.service -n 50` to inspect manually",
        };
      }
    }

    if (ctx.platform === "darwin") {
      // On macOS journalctl is unavailable. Proxy via socket presence: if the
      // socket is connectable the daemon is running; we cannot distinguish
      // active/idle without a journal, so report informational WARN.
      const sockPath = runtimeSocketPath(ctx.platform);
      if (!fileExists(sockPath)) {
        return {
          status: "WARN",
          detail: "alter-runtime socket absent -- git_watcher status unknown",
          remedy: "start the daemon (`alter-runtime start`)",
        };
      }
      return {
        status: "WARN",
        detail: "git_watcher status cannot be determined on macOS (no journalctl)",
        remedy:
          "run `log show --predicate 'process == \"alter-runtime\"' --last 5m` to inspect manually",
      };
    }

    return {
      status: "WARN",
      detail: `git_watcher check not supported on platform ${ctx.platform}`,
    };
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const checks: Check[] = [
  processCheck,
  socketCheck,
  identityCacheCheck,
  presenceFeedCheck,
  gitWatcherCheck,
];
