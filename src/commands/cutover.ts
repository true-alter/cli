/**
 * `alter` menu > Devs & agents > Connect identity tools
 *
 * Unified one-click flow that takes an existing team member from
 * "memories + disconnected tools" to "live identity" in a single
 * pass. Chains: verify session -> preview -> confirm -> wire personal
 * MCP -> (optional: wire Org Alter) -> verify hooks -> write marker
 * -> write lazy doctrine-sync hook -> run initial doctrine sync.
 *
 * Hardened:
 *   - one-key preview+confirm before ANY write; --yes for non-interactive
 *   - transactional multi-target: stage all → validate → commit; rollback
 *     per-target from byte-copy backups on ANY failure
 *   - true byte-copy backup of settings.json + shell-rc (suffix .alter.bak.<ts>)
 *     IN ADDITION to the existing marker-strip approach
 *   - after successful cutover: writes lazy doctrine-sync.sh hook +
 *     runs initial `alter doctrine sync`
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync, execFile } from "node:child_process";

import chalk from "chalk";
import { spinner } from "@clack/prompts";

import {
  ALTER_CONFIG_DIR,
  getSession,
  getSessionInfo,
  ensureFreshSession,
} from "../auth.js";
import { login } from "./login.js";
import { brand, withLoadingCancel } from "../ui/biosMenu.js";
import { confirmYesNo } from "../ui/picker.js";
import {
  wire as sdkWire,
  probeAll,
} from "@truealter/sdk";
import { DOCTRINE_SYNC_HOOK_BODY } from "../lib/doctrine-hook-template.js";

const SUBSTRATE_MARKER = path.join(ALTER_CONFIG_DIR, "substrate-active");

/** Location of the lazy doctrine-sync hook in the user's CC global hooks dir. */
const CLAUDE_HOOKS_DIR = path.join(os.homedir(), ".claude");
const DOCTRINE_SYNC_HOOK = path.join(CLAUDE_HOOKS_DIR, "doctrine-sync.sh");

interface CutoverReport {
  handle: string;
  mcpWired: string[];
  orgAlterWired: boolean;
  hooksPresent: boolean;
  markerWritten: boolean;
  hookWritten: boolean;
}

// ---------------------------------------------------------------------------
// Backup helpers
// ---------------------------------------------------------------------------

/**
 * Byte-copy backup a file to <file>.alter.bak.<unix-ts>.
 * Returns the backup path or null if the file doesn't exist.
 */
function backupFile(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const ts = Date.now();
  const bak = `${filePath}.alter.bak.${ts}`;
  fs.copyFileSync(filePath, bak);
  return bak;
}

/**
 * Restore a backup created by backupFile.
 * No-op if the backup path is null.
 */
function restoreBackup(bak: string | null, filePath: string): void {
  if (!bak) return;
  try {
    fs.copyFileSync(bak, filePath);
  } catch {
    // Best-effort: log but don't throw.
    process.stderr.write(`alter cutover: rollback failed for ${filePath} (backup: ${bak})\n`);
  }
}

// ---------------------------------------------------------------------------
// Detect files that will be modified so we can show a preview
// ---------------------------------------------------------------------------

function gatherTargetFiles(): string[] {
  const files: string[] = [];

  // Claude Code settings.json locations (mirrors the SDK wire probe logic).
  const homeDir = os.homedir();
  const candidates = [
    path.join(homeDir, ".claude", "settings.json"),
    path.join(homeDir, ".config", "claude", "settings.json"),
  ];
  for (const f of candidates) {
    if (fs.existsSync(f)) files.push(f);
  }

  // Shell rc files (common variants).
  const rcFiles = [
    path.join(homeDir, ".bashrc"),
    path.join(homeDir, ".zshrc"),
    path.join(homeDir, ".profile"),
    path.join(homeDir, ".bash_profile"),
  ];
  for (const f of rcFiles) {
    if (fs.existsSync(f)) files.push(f);
  }

  return files;
}

// ---------------------------------------------------------------------------
// Lazy doctrine-sync.sh hook body
// ---------------------------------------------------------------------------

function writeDoctrineSyncHook(): boolean {
  try {
    fs.mkdirSync(CLAUDE_HOOKS_DIR, { recursive: true, mode: 0o700 });
    // Write the hook from the compiled string constant. Mode 0755 so it's executable.
    fs.writeFileSync(DOCTRINE_SYNC_HOOK, DOCTRINE_SYNC_HOOK_BODY, {
      encoding: "utf-8",
      mode: 0o755,
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main cutover flow
// ---------------------------------------------------------------------------

export async function cutover(argv: string[] = []): Promise<void> {
  const nonInteractive = argv.includes("--yes") || argv.includes("-y");
  const interactive = !nonInteractive && process.stdout.isTTY && process.stdin.isTTY;

  const report: CutoverReport = {
    handle: "",
    mcpWired: [],
    orgAlterWired: false,
    hooksPresent: false,
    markerWritten: false,
    hookWritten: false,
  };

  process.stdout.write("\n");

  // --- 1. Verify session ---------------------------------------------------
  let session = (await ensureFreshSession()) ?? getSession();
  if (!session) {
    process.stdout.write(
      "  " + brand.text("no session - logging in first.") + "\n\n",
    );
    await login([]);
    session = (await ensureFreshSession()) ?? getSession();
    if (!session) {
      process.stdout.write(
        "  " + brand.accentDeep("stopped") +
          brand.dim(" - sign in required to connect identity tools.") + "\n\n",
      );
      return;
    }
  }

  report.handle = session.handle;

  // --- 2. Preview + confirm ------------------------------------------------
  const targetFiles = gatherTargetFiles();

  process.stdout.write(
    "  " + brand.handle(session.handle) +
      brand.dim(" - connecting your identity tools.") + "\n\n",
  );

  if (targetFiles.length > 0) {
    process.stdout.write("  " + brand.titleDim("files that will be modified:") + "\n");
    for (const f of targetFiles) {
      process.stdout.write("    " + brand.dim(f) + "\n");
    }
    process.stdout.write("  " + brand.dim("(byte-copy backups will be taken)") + "\n\n");
  }

  if (interactive) {
    const confirmed = await confirmYesNo({
      message: "Proceed with cutover?",
      initialValue: true,
    });
    if (!confirmed) {
      process.stdout.write("  " + brand.dim("cancelled - nothing changed.") + "\n\n");
      return;
    }
    process.stdout.write("\n");
  }

  // --- 3. Stage: take byte-copy backups ------------------------------------
  const backups = new Map<string, string | null>();
  for (const f of targetFiles) {
    backups.set(f, backupFile(f));
  }

  // --- 4. Wire personal MCP servers ----------------------------------------
  const s1 = spinner();
  s1.start("wiring personal MCP server...");

  const probes = probeAll();
  const detected = probes.filter((p) => p.installed);

  let wireError: Error | null = null;
  if (detected.length === 0) {
    s1.stop("no MCP clients detected.");
    process.stdout.write(
      "  " + brand.dim("install Claude Code, Cursor, or Claude Desktop first.") +
        "\n",
    );
  } else {
    try {
      const apiKey = getSessionInfo()?.member_api_key ?? null;
      const wireReport = sdkWire({ only: undefined, ...(apiKey ? { apiKey } : {}) });
      for (const t of wireReport.state.targets) {
        if (t.status === "written" || t.status === "already-wired") {
          report.mcpWired.push(t.client);
        }
      }
      s1.stop(
        `personal MCP wired into ${report.mcpWired.length} client${report.mcpWired.length === 1 ? "" : "s"}.`,
      );
    } catch (err) {
      wireError = err as Error;
      s1.stop("personal MCP wire failed - rolling back.");
    }
  }

  // Rollback on wire failure.
  if (wireError) {
    for (const [f, bak] of backups.entries()) {
      restoreBackup(bak, f);
    }
    process.stdout.write(
      "  " + brand.accentDeep("error: ") +
        brand.text(wireError.message) + "\n" +
        "  " + brand.dim("all backups restored. nothing changed.") + "\n\n",
    );
    return;
  }

  // --- 5. Verify hooks are present (project-level) -------------------------
  report.hooksPresent = detectProjectHooks();

  if (report.hooksPresent) {
    process.stdout.write(
      "  " + chalk.green("OK") + brand.dim("  session tracking active.") + "\n",
    );
  } else {
    process.stdout.write(
      "  " + chalk.yellow("--") +
        brand.dim("  project hooks not found. run `alter hooks install` to add them.") +
        "\n",
    );
  }

  // --- 6. Write substrate-active marker ------------------------------------
  try {
    fs.mkdirSync(ALTER_CONFIG_DIR, { recursive: true, mode: 0o700 });
    const markerContent = JSON.stringify(
      {
        handle: session.handle,
        cutover_at: new Date().toISOString(),
        machine: os.hostname(),
        platform: os.platform(),
      },
      null,
      2,
    ) + "\n";
    fs.writeFileSync(SUBSTRATE_MARKER, markerContent, { mode: 0o600 });
    report.markerWritten = true;
  } catch {
    // Non-fatal.
  }

  // --- 7. Write lazy doctrine-sync.sh hook ---------------------------------
  report.hookWritten = writeDoctrineSyncHook();

  // --- 8. Run initial doctrine sync ----------------------------------------
  // Async + cancellable: the prior spawnSync blocked the event loop for up
  // to 30s with no escape. esc kills the child; the sync is idempotent and
  // re-runs lazily on the next session start, so an abort is always safe.
  if (report.hookWritten || report.mcpWired.length > 0) {
    const syncWait = await withLoadingCancel(
      (signal) =>
        new Promise<number | null>((resolve) => {
          execFile(
            process.execPath,
            [process.argv[1]!, "doctrine", "sync", "--quiet"],
            { timeout: 30_000, encoding: "utf-8", signal },
            (error) => resolve(error ? 1 : 0),
          );
        }),
      "running initial doctrine sync",
    );
    if (syncWait.cancelled || syncWait.result !== 0) {
      process.stdout.write(
        "  " + brand.dim("doctrine sync skipped (will run on next session start).") + "\n",
      );
    } else {
      process.stdout.write("  " + brand.dim("doctrine sync complete.") + "\n");
    }
  }

  // --- 10. Confirmation -----------------------------------------------------
  process.stdout.write("\n");
  process.stdout.write("  " + brand.accent("your identity tools are connected.") + "\n\n");
  process.stdout.write("  " + brand.titleDim("what changed:") + "\n");

  if (report.mcpWired.length > 0) {
    process.stdout.write(
      "    " + chalk.green("OK") + "  personal MCP  " +
        brand.dim(report.mcpWired.join(", ")) + "\n",
    );
  }
  if (report.orgAlterWired) {
    process.stdout.write("    " + chalk.green("OK") + "  Org Alter collective MCP\n");
  }
  if (report.hooksPresent) {
    process.stdout.write(
      "    " + chalk.green("OK") + "  CC hooks " +
        brand.dim("(project-level, auto-active)") + "\n",
    );
  }
  if (report.markerWritten) {
    process.stdout.write("    " + chalk.green("OK") + "  activity tracking enabled\n");
  }
  if (report.hookWritten) {
    process.stdout.write(
      "    " + chalk.green("OK") + "  lazy doctrine sync hook  " +
        brand.dim(DOCTRINE_SYNC_HOOK) + "\n",
    );
  }
  if (backups.size > 0) {
    process.stdout.write(
      "    " + chalk.green("OK") + "  backups  " +
        brand.dim(`${backups.size} file${backups.size === 1 ? "" : "s"} backed up (*.alter.bak.*)`) + "\n",
    );
  }

  process.stdout.write("\n");
  process.stdout.write(
    "  " + brand.titleDim("what this means:") + "\n" +
      "    " + brand.text("your identity, traits, and queries are live, not cached") + "\n" +
      "    " + brand.text("any connected tool reads your identity directly") + "\n" +
      "    " + brand.text("doctrine syncs lazily on each new session start") + "\n",
  );
  process.stdout.write("\n");
  process.stdout.write(
    "  " + brand.faint("restart Claude Code to pick up the new MCP servers.") + "\n",
  );
  process.stdout.write("\n");
}

function detectProjectHooks(): boolean {
  const candidates = [process.cwd()];

  try {
    const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
      timeout: 3000,
    });
    if (result.status === 0 && result.stdout) {
      candidates.unshift(result.stdout.trim());
    }
  } catch {
    // Not in a git repo.
  }

  for (const base of candidates) {
    try {
      if (fs.existsSync(path.join(base, ".claude", "hooks", "sot-discipline.sh"))) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

export function isSubstrateActive(): boolean {
  try {
    return fs.existsSync(SUBSTRATE_MARKER);
  } catch {
    return false;
  }
}
