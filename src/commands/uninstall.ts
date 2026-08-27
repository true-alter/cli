/**
 * `alter uninstall` - full ALTER CLI uninstall.
 *
 * Composes:
 *   - sdkUnwire()         remove personal MCP from all client configs
 *   - uninscribeAll()     remove cosmetic inscriptions
 *   - remove ~/.config/alter/substrate-active
 *   - remove ~/.claude/<hooks>/doctrine-sync.sh (lazy refresh hook)
 *   - remove ~/.local/share/alter/doctrine/ (doctrine cache + etag + log)
 *
 * Tier-3 type-the-noun confirm (reuse confirmTypeNoun from picker.ts).
 * Non-interactive: --yes skips the confirm.
 *
 * Does NOT remove session.json or credentials - that is `alter logout`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  intro,
  outro,
  spinner,
  cancel,
  log,
} from "@clack/prompts";
import chalk from "chalk";

import { unwire as sdkUnwire } from "@truealter/sdk";
import { uninscribeAll } from "../lib/cosmetics/inscribe.js";
import { clearCosmeticState } from "../lib/cosmetics/state.js";
import { confirmTypeNoun } from "../ui/picker.js";
import { ALTER_CONFIG_DIR } from "../auth.js";
import { DOCTRINE_DIR } from "./doctrine.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SUBSTRATE_MARKER = path.join(ALTER_CONFIG_DIR, "substrate-active");

const XDG_DATA =
  process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");

/** Claude Code global hooks directory where the lazy doctrine-sync hook lives. */
function claudeHooksDir(): string {
  return path.join(os.homedir(), ".claude");
}
const DOCTRINE_SYNC_HOOK = path.join(claudeHooksDir(), "doctrine-sync.sh");

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  yes: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  let yes = false;
  for (const a of argv) {
    if (a === "--yes" || a === "-y") yes = true;
    else throw new Error(`Unknown flag: ${a}`);
  }
  return { yes };
}

function printHelp(): void {
  console.log(
    "Usage: alter uninstall [--yes|-y]\n" +
      "\n" +
      "Fully uninstall ~Alter from this machine:\n" +
      "  - Remove ~Alter from all MCP client configs\n" +
      "  - Remove cosmetic inscriptions\n" +
      "  - Remove the substrate-active marker\n" +
      "  - Remove the lazy doctrine-sync.sh hook from ~/.claude/\n" +
      "  - Remove the local doctrine cache (~/.local/share/alter/doctrine/)\n" +
      "\n" +
      "Session credentials and login state are NOT removed.\n" +
      "Run `alter logout` to revoke your session.\n" +
      "\n" +
      "Flags:\n" +
      "  --yes, -y    skip interactive confirmation\n",
  );
}

// ---------------------------------------------------------------------------
// Remove helpers
// ---------------------------------------------------------------------------

function removeFileIfExists(p: string): { path: string; status: "removed" | "absent" | "failed"; reason?: string } {
  try {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      return { path: p, status: "removed" };
    }
    return { path: p, status: "absent" };
  } catch (err) {
    return { path: p, status: "failed", reason: (err as Error).message };
  }
}

function removeDirIfExists(p: string): { path: string; status: "removed" | "absent" | "failed"; reason?: string } {
  try {
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
      return { path: p, status: "removed" };
    }
    return { path: p, status: "absent" };
  } catch (err) {
    return { path: p, status: "failed", reason: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export async function uninstall(argv: string[] = []): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(`alter uninstall: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const interactive =
    process.stdout.isTTY && process.stdin.isTTY && !parsed.yes;

  if (interactive) {
    intro("alter  --  uninstall ~Alter from this machine");
    log.warn(
      "This removes ~Alter from all MCP clients, removes the doctrine\n" +
        "cache, and removes the lazy doctrine-sync hook from ~/.claude/.\n" +
        "It does NOT remove your session or credentials.\n" +
        "Run `alter logout` separately to revoke your session.",
    );

    // Tier-3 type-the-noun confirm: user must type "uninstall" to proceed.
    const go = await confirmTypeNoun({
      message: "Uninstall ~Alter from this machine?",
      noun: "uninstall",
    });
    if (!go) {
      cancel("Cancelled - nothing changed.");
      return;
    }
  }

  const s = interactive ? spinner() : null;
  s?.start("Uninstalling...");

  const failures: string[] = [];
  const done: string[] = [];

  // 1. Unwire personal MCP.
  try {
    const report = sdkUnwire();
    for (const u of report.undone) {
      if (u.action === "failed") {
        failures.push(`MCP unwire ${u.client}: ${u.reason ?? "failed"}`);
      } else {
        done.push(`MCP unwired: ${u.client}`);
      }
    }
  } catch (err) {
    failures.push(`MCP unwire: ${(err as Error).message}`);
  }

  // 2. Uninscribe cosmetics.
  try {
    const results = uninscribeAll();
    clearCosmeticState();
    for (const c of results) {
      if (c.status === "failed") {
        failures.push(`cosmetic uninscribe ${c.surface}: ${c.reason ?? "failed"}`);
      } else {
        done.push(`cosmetic uninscribed: ${c.surface}`);
      }
    }
  } catch (err) {
    failures.push(`cosmetic uninscribe: ${(err as Error).message}`);
  }

  // 3. Remove substrate-active marker.
  const markerResult = removeFileIfExists(SUBSTRATE_MARKER);
  if (markerResult.status === "removed") done.push("substrate-active marker removed");
  else if (markerResult.status === "failed") failures.push(`substrate-active: ${markerResult.reason}`);

  // 4. Remove lazy doctrine-sync.sh hook.
  const hookResult = removeFileIfExists(DOCTRINE_SYNC_HOOK);
  if (hookResult.status === "removed") done.push("doctrine-sync.sh hook removed");
  else if (hookResult.status === "failed") failures.push(`doctrine-sync.sh: ${hookResult.reason}`);

  // 5. Remove doctrine cache directory.
  const cacheResult = removeDirIfExists(DOCTRINE_DIR);
  if (cacheResult.status === "removed") done.push("doctrine cache removed");
  else if (cacheResult.status === "failed") failures.push(`doctrine cache: ${cacheResult.reason}`);

  s?.stop("Done.");

  if (interactive) {
    for (const d of done) {
      console.log("  " + chalk.green("OK") + "  " + chalk.dim(d));
    }
    for (const f of failures) {
      console.log("  " + chalk.red("!!") + "  " + f);
    }

    if (failures.length === 0) {
      outro(chalk.green("Uninstalled.") + chalk.dim(" Run `alter login` to reinstall."));
    } else {
      outro(chalk.red(`Uninstalled with ${failures.length} failure${failures.length === 1 ? "" : "s"}.`));
      process.exitCode = 1;
      return;
    }
  } else {
    for (const d of done) {
      console.log("alter uninstall: " + d);
    }
    for (const f of failures) {
      console.error("alter uninstall: " + f);
    }
    if (failures.length > 0) process.exitCode = 1;
  }
}
