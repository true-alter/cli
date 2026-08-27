/**
 * alter unwire -- reverse every target captured by the last wire().
 *
 * Reads the provenance artefact written by `alter wire`, restores
 * each client config from the per-target backup (or removes the
 * ALTER entry when no prior config existed), and invokes
 * `claude mcp remove` for the claude-code CLI target. Clears the
 * provenance state on success so subsequent runs are no-ops.
 *
 * Flags:
 *   --json        emit the undo report as JSON and exit
 *   --yes, -y     skip the confirmation prompt (non-interactive)
 */

import {
  intro,
  outro,
  spinner,
  cancel,
  log,
} from "@clack/prompts";
import { confirmTypeNoun } from "../ui/picker.js";
import chalk from "chalk";
import { unwire as sdkUnwire, readWireState } from "@truealter/sdk";

import { uninscribeAll } from "../lib/cosmetics/inscribe.js";
import { clearCosmeticState, readCosmeticState } from "../lib/cosmetics/state.js";

interface ParsedArgs {
  json: boolean;
  yes: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  let json = false;
  let yes = false;
  for (const a of argv) {
    if (a === "--json") json = true;
    else if (a === "--yes" || a === "-y") yes = true;
    else throw new Error(`Unknown flag: ${a}`);
  }
  return { json, yes };
}

function printHelp(): void {
  console.log(
    "Usage: alter unwire [--json] [--yes|-y]\n" +
      "\n" +
      "Reverse a previous `alter wire` - remove ~Alter from every MCP\n" +
      "client config the CLI knows about.\n" +
      "\n" +
      "Flags:\n" +
      "  --json       emit the unwire report as JSON\n" +
      "  --yes, -y    skip interactive confirmation\n",
  );
}

export async function unwire(argv: string[] = []): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(`alter unwire: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  if (parsed.json) {
    const report = sdkUnwire();
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const interactive =
    process.stdout.isTTY && process.stdin.isTTY && !parsed.yes;

  const state = readWireState();
  const cosmeticState = readCosmeticState();
  const hasMcp = state && state.targets.length > 0;
  const hasCosmetics =
    cosmeticState && cosmeticState.inscriptions.length > 0;

  if (!hasMcp && !hasCosmetics) {
    if (interactive) {
      log.info("Nothing to unwire -- no wire state on disk.");
    } else {
      console.log("alter unwire: nothing to unwire.");
    }
    return;
  }

  if (interactive) {
    intro("alter  --  remove ~Alter from your MCP clients");
    if (hasMcp) {
      log.info("Currently wired:");
      for (const t of state.targets) {
        console.log(`  - ${chalk.bold(t.client)}  ${chalk.dim(`(${t.status})`)}`);
      }
    }
    if (hasCosmetics) {
      log.info(`Cosmetic inscriptions for ${cosmeticState.handle}:`);
      for (const i of cosmeticState.inscriptions) {
        console.log(`  - ${chalk.bold(i.surface)}  ${chalk.dim(i.path)}`);
      }
    }

    // Tier 3 type-the-noun - plural-destructive (every target). The noun
    // must be typed verbatim because friction is the design; uninstalling
    // every tool at once is the friction-by-design path.
    const go = await confirmTypeNoun({
      message: "Reverse every target?",
      noun: "uninstall",
    });
    if (!go) {
      cancel("Cancelled -- nothing changed.");
      return;
    }
  }

  const s = interactive ? spinner() : null;
  s?.start("Restoring configs...");
  const report = hasMcp ? sdkUnwire() : { undone: [] as Array<{ client: string; action: string; reason?: string }> };
  const cosmeticResults = hasCosmetics ? uninscribeAll() : [];
  if (hasCosmetics) clearCosmeticState();
  s?.stop("Done.");

  for (const u of report.undone) {
    const glyph =
      u.action === "failed"
        ? chalk.red("!!")
        : u.action === "skipped"
          ? chalk.dim("--")
          : chalk.green("OK");
    const label = chalk.bold(u.client);
    const detail = u.reason
      ? chalk.dim(` (${u.reason})`)
      : chalk.dim(` (${u.action})`);
    console.log(`  ${glyph} ${label}${detail}`);
  }
  for (const c of cosmeticResults) {
    const glyph =
      c.status === "failed"
        ? chalk.red("!!")
        : c.status === "skipped"
          ? chalk.dim("--")
          : chalk.green("OK");
    const label = chalk.bold(c.surface);
    const detail = c.reason
      ? chalk.dim(` (${c.reason})`)
      : chalk.dim(` (${c.status})`);
    console.log(`  ${glyph} ${label}${detail}`);
  }

  const failed = [
    ...report.undone.filter((u) => u.action === "failed"),
    ...cosmeticResults.filter((c) => c.status === "failed"),
  ];

  if (interactive) {
    if (failed.length === 0) {
      outro(chalk.green("Unwired.") + chalk.dim(" Provenance state cleared."));
    } else {
      outro(
        chalk.red(
          `Unwired with ${failed.length} failure${
            failed.length === 1 ? "" : "s"
          }.`,
        ),
      );
      process.exitCode = 1;
      return;
    }
  } else if (failed.length > 0) {
    process.exitCode = 1;
  }
}
