/**
 * alter wire - install ALTER into your MCP clients in one go.
 *
 * Walks over detected MCP clients (Claude Code, Cursor, Claude
 * Desktop, VS Code) and merges the ALTER entry into each client's
 * config. A provenance artefact is written so `alter unwire` can
 * reverse every target deterministically.
 *
 * Thin UX wrapper around @truealter/sdk's `wire()` pipeline - the
 * SDK owns JSON merge, atomic write, synced-volume refusal, and
 * per-client adapter logic. This command adds the Clack UX and
 * flag parsing.
 *
 * Flags:
 *   --endpoint <url>   override the MCP endpoint written into each target
 *   --api-key          attach X-ALTER-API-Key header to every target, read
 *                      from a masked prompt (never from argv)
 *   --only <ids>       comma-separated client ids (claude-code,cursor,
 *                      claude-desktop,vscode,openclaw)
 *   --json             emit the wire report as JSON and exit
 *   --yes, -y          skip the confirmation prompt (non-interactive)
 */

import * as fs from "fs";
import * as path from "path";

import {
  intro,
  outro,
  spinner,
  cancel,
  log,
  password as clackPassword,
  isCancel,
} from "@clack/prompts";
import { pickMany, pickOne, confirmYesNo } from "../ui/picker.js";
import chalk from "chalk";
import {
  wire as sdkWire,
  probeAll,
  type ClientId,
  type WireTarget,
} from "@truealter/sdk";

import { ALTER_CONFIG_DIR, getSessionInfo } from "../auth.js";
import { loadConfig } from "../config/loader.js";
import { getPalette, resolvePalette } from "../theme/palette.js";
import { probeCosmetics, type DetectedSurface } from "../lib/cosmetics/detect.js";
import { inscribeMany, type InscribeResult } from "../lib/cosmetics/inscribe.js";
import {
  renderBody,
  commentChar,
  type StatuslineVariant,
} from "../lib/cosmetics/snippets.js";

const COSMETICS_OPTOUT_SENTINEL = path.join(
  ALTER_CONFIG_DIR,
  "cosmetics.skip",
);

function resolveSessionApiKey(): string | null {
  const session = getSessionInfo();
  return session?.member_api_key ?? null;
}

interface ParsedArgs {
  endpoint: string | null;
  /**
   * True when the caller asked to supply a member key. The value itself is
   * never carried here, because it is never read from argv. See parseArgs.
   */
  apiKeyPrompt: boolean;
  only: ClientId[] | null;
  json: boolean;
  yes: boolean;
}

// Mirrors the SDK's own ALL_CLIENTS. This list stayed at four for the eight
// days between the SDK gaining OpenClaw as a fifth target and 0.5.10 actually
// reaching npm, because the published runtime carried no such target and a
// fifth id here would have named a client the SDK could not wire.
export const KNOWN_CLIENTS: readonly ClientId[] = [
  "claude-code",
  "cursor",
  "claude-desktop",
  "vscode",
  "openclaw",
];

function parseArgs(argv: string[]): ParsedArgs {
  let endpoint: string | null = null;
  let apiKeyPrompt = false;
  let only: ClientId[] | null = null;
  let json = false;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--endpoint") {
      endpoint = argv[++i] ?? null;
      if (!endpoint) throw new Error("--endpoint requires a url");
    } else if (a === "--api-key") {
      // A member key is a secret, so it is never taken from argv. Anything
      // passed on the command line is visible in the process table and tends
      // to land in shell history. Same refusal as `alter login --token` and
      // `alter key seed import`.
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        throw new Error(
          "--api-key: refusing to read the key from argv.\n" +
            "A key passed on the command line is exposed to /proc/<pid>/cmdline\n" +
            "and tends to land in shell history.\n" +
            "Re-run as `alter wire --api-key` and type it at the masked prompt.",
        );
      }
      apiKeyPrompt = true;
    } else if (a === "--only") {
      const raw = argv[++i] ?? "";
      const ids = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const id of ids) {
        if (!KNOWN_CLIENTS.includes(id as ClientId)) {
          throw new Error(
            `--only: unknown client id "${id}". Known: ${KNOWN_CLIENTS.join(
              ", ",
            )}`,
          );
        }
      }
      only = ids as ClientId[];
    } else throw new Error(`Unknown flag: ${a}`);
  }
  return { endpoint, apiKeyPrompt, only, json, yes };
}

function statusGlyph(status: WireTarget["status"]): string {
  switch (status) {
    case "written":
      return chalk.green("OK");
    case "already-wired":
      return chalk.cyan("==");
    case "skipped":
      return chalk.dim("--");
    case "failed":
      return chalk.red("!!");
  }
}

function renderTarget(t: WireTarget): string {
  const glyph = statusGlyph(t.status);
  const label = chalk.bold(t.client);
  const detail =
    t.status === "failed"
      ? chalk.red(` (${t.reason ?? "unknown error"})`)
      : t.status === "skipped"
        ? chalk.dim(` (${t.reason ?? "skipped"})`)
        : t.status === "already-wired"
          ? chalk.dim(" (already wired)")
          : "";
  return `  ${glyph} ${label}${detail}`;
}

function printHelp(): void {
  console.log(
    "Usage: alter wire [--endpoint <url>] [--api-key] [--only <ids>]\n" +
      "                 [--json] [--yes|-y]\n" +
      "\n" +
      "Install ~Alter into your MCP clients (Claude Code, Cursor, Claude\n" +
      "Desktop, VS Code).\n" +
      "\n" +
      "Flags:\n" +
      "  --endpoint <url>   override the MCP server endpoint\n" +
      "  --api-key          type a member key at a masked prompt, instead of\n" +
      "                     the one on your session. Never read from argv\n" +
      "  --only <ids>       comma-separated subset of clients to wire\n" +
      "                     (claude-code, cursor, claude-desktop, vscode,\n" +
      "                     openclaw)\n" +
      "  --json             emit the wire report as JSON\n" +
      "  --yes, -y          skip interactive confirmation\n",
  );
}

export async function wire(argv: string[] = []): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(`alter wire: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  let apiKey = resolveSessionApiKey();

  if (parsed.apiKeyPrompt) {
    if (parsed.json) {
      console.error(
        "alter wire: --api-key needs a masked prompt, which cannot run with --json.\n" +
          "Run `alter login` so the key comes from your session instead.",
      );
      process.exitCode = 1;
      return;
    }
    const entered = await clackPassword({
      message: "Type your member key",
      mask: "•",
    });
    if (isCancel(entered)) {
      cancel("Cancelled.");
      process.exitCode = 1;
      return;
    }
    const typed = String(entered).trim();
    if (!typed) {
      console.error("alter wire: no key entered.");
      process.exitCode = 1;
      return;
    }
    apiKey = typed;
  }

  if (parsed.json) {
    const report = sdkWire({
      endpoint: parsed.endpoint ?? undefined,
      apiKey: apiKey ?? undefined,
      only: parsed.only ?? undefined,
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const interactive =
    process.stdout.isTTY && process.stdin.isTTY && !parsed.yes;

  if (interactive) intro("alter  --  install into your MCP clients");

  const probes = probeAll();
  const detected = probes.filter((p) => p.installed);

  if (detected.length === 0) {
    if (interactive) {
      log.warn("No supported MCP clients detected on this machine.");
      outro("Install Claude Code, Cursor, Claude Desktop, or VS Code first.");
    } else {
      console.log("alter wire: no supported MCP clients detected.");
    }
    return;
  }

  if (interactive) {
    log.info("Detected:");
    for (const p of detected) {
      console.log(
        `  - ${chalk.bold(p.client.label)}  ${chalk.dim(`(${p.client.id})`)}`,
      );
    }

    const go = await confirmYesNo({
      message: `Wire Alter into ${detected.length} client${
        detected.length === 1 ? "" : "s"
      }?`,
      initialValue: true,
    });
    if (!go) {
      cancel("Cancelled -- nothing written.");
      return;
    }
  }

  const s = interactive ? spinner() : null;
  s?.start("Writing configs...");
  let report;
  try {
    report = sdkWire({
      endpoint: parsed.endpoint ?? undefined,
      apiKey: apiKey ?? undefined,
      only: parsed.only ?? undefined,
    });
  } catch (err) {
    s?.stop("Failed.");
    console.error(`alter wire: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  s?.stop("Done.");

  for (const target of report.state.targets) {
    console.log(renderTarget(target));
  }

  const failed = report.state.targets.filter((t) => t.status === "failed");

  // Cosmetic phase: only when interactive, MCP wire didn't fully fail,
  // and the user hasn't opted out via the sentinel file.
  if (interactive && failed.length < report.state.targets.length) {
    await maybeRunCosmeticPhase();
  }

  if (interactive) {
    const written = report.state.targets.filter((t) => t.status === "written");
    const alreadyWired = report.state.targets.filter(
      (t) => t.status === "already-wired",
    );
    if (failed.length === 0) {
      if (written.length === 0 && alreadyWired.length > 0) {
        // All targets were already wired - skip the "Wired." outro so it
        // doesn't fire as a false positive on a complete no-op.
        outro(chalk.dim("Already wired. No changes written."));
      } else {
        outro(
          chalk.green("Wired.") +
            chalk.dim(
              " Restart the client if it was already running so it picks up the new server.",
            ),
        );
      }
    } else {
      outro(
        chalk.red(
          `Wired with ${failed.length} failure${
            failed.length === 1 ? "" : "s"
          }.`,
        ) + " Re-run with --json for details.",
      );
      process.exitCode = 1;
      return;
    }
  } else if (failed.length > 0) {
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Cosmetic phase - extends wire with surface insta-embed.
//
// One continuous flow from binding your ~handle to seeing yourself across
// surfaces. Skipped silently when no session, no surfaces, or user opted out.
// ---------------------------------------------------------------------------

async function maybeRunCosmeticPhase(): Promise<void> {
  // Opt-out: any user who's said "no thanks" before never gets asked again.
  if (fs.existsSync(COSMETICS_OPTOUT_SENTINEL)) return;

  const session = getSessionInfo();
  if (!session) return;
  const handle = session.handle;

  // ---- Headline question ---------------------------------------------------
  console.log("");
  const wantsCosmetics = await confirmYesNo({
    message: `Add ${handle} to your prompt and Claude Code?`,
    initialValue: true,
  });
  if (wantsCosmetics === null) return;
  if (!wantsCosmetics) {
    log.info("Cosmetics skipped. Run `alter wire` again anytime.");
    log.info(
      `(Opt out forever: touch ${COSMETICS_OPTOUT_SENTINEL.replace(process.env.HOME ?? "~", "~")})`,
    );
    return;
  }

  await runWardrobeCore(handle);
}

/**
 * The terminal wardrobe, invoked directly (Customise › Terminal wardrobe).
 * Same detect → pick → preview → inscribe pipeline the wire cosmetic phase
 * runs, WITHOUT the opt-out sentinel or the headline question - reaching
 * for the wardrobe from the menu IS the consent.
 */
export async function runWardrobe(): Promise<void> {
  const session = getSessionInfo();
  if (!session) {
    log.warn("Not signed in. Run `alter login` first.");
    return;
  }
  await runWardrobeCore(session.handle);
}

async function runWardrobeCore(handle: string): Promise<void> {
  // ---- Detect --------------------------------------------------------------
  const s = spinner();
  s.start("Scanning for shells, prompts, and statuslines...");
  const surfaces = probeCosmetics();
  s.stop("Done.");

  if (surfaces.length === 0) {
    log.warn("No detectable surfaces. Run `alter prompt install` to bind starship later.");
    return;
  }

  // ---- Multiselect ---------------------------------------------------------
  const picked = await pickMany({
    message: "Inscribe which surfaces?",
    options: surfaces.map((sf) => ({
      label: `${chalk.bold(sf.label)}  ${chalk.dim(prettyPath(sf.targetPath))}`,
      value: sf.id,
      hint: chalk.dim(sf.via),
    })),
    initialValues: surfaces.map((sf) => sf.id),
    allowEmpty: true,
  });
  if (picked === null || picked.length === 0) {
    log.info("Cosmetics skipped.");
    return;
  }

  const chosen = surfaces.filter((sf) => picked.includes(sf.id));

  // ---- Statusline richness -------------------------------------------------
  // When the CC statusline is among the chosen surfaces, offer the full rich
  // preset vs minimal. Full is the default: a full statusline with
  // branch / context / model+effort / mail / scope and a session-label
  // descriptor, hardened to render on Linux, macOS and Windows Git Bash (it
  // re-execs or degrades to an identity-only line on stock macOS bash 3.2).
  // Minimal stays available as the quiet identity-only fallback.
  let statuslineVariant: StatuslineVariant = "full";
  if (chosen.some((sf) => sf.id === "cc-statusline")) {
    const pickedVariant = await pickOne<StatuslineVariant>({
      message: "Claude Code statusline style?",
      options: [
        {
          label: "Full",
          value: "full",
          hint: "rich: branch, context, model+effort, mail, scope + session label - the default",
        },
        {
          label: "Minimal",
          value: "minimal",
          hint: "just ~handle / level - quiet identity-only fallback",
        },
      ],
      initialValue: "full",
    });
    if (pickedVariant === null) {
      log.info("Cosmetics skipped.");
      return;
    }
    statuslineVariant = pickedVariant;
  }

  // ---- Dry-run preview -----------------------------------------------------
  const palette = await loadActivePalette();
  log.info("Preview:");
  for (const sf of chosen) {
    console.log("");
    console.log(`  ${chalk.bold(sf.label)}  ${chalk.dim(prettyPath(sf.targetPath))}`);
    const preview =
      sf.id === "cc-statusline"
        ? `  // writes alter-statusline.sh (${statuslineVariant}) + sets statusLine.command in settings.json` +
          (statuslineVariant === "full"
            ? "\n  // + seeds ~/.config/alter/statusline-wardrobe.json (if absent)"
            : "")
        : indent(renderBody(sf.id, { handle, palette }), "  " + chalk.cyan(commentChar(sf.id) + " "));
    console.log(chalk.cyan(preview));
  }
  console.log("");

  const ok = await confirmYesNo({
    message: "Write these changes?",
    initialValue: true,
  });
  if (!ok) {
    log.info("Cosmetics skipped.");
    return;
  }

  // ---- Inscribe ------------------------------------------------------------
  const s2 = spinner();
  s2.start("Inscribing...");
  const report = await inscribeMany(chosen, { handle, palette, statuslineVariant });
  s2.stop("Done.");

  for (const r of report.results) {
    console.log(renderInscribeResult(r));
  }

  // Honest one-liner about the full statusline's session-label descriptor:
  // it upgrades to a local-model summary when ollama is present, otherwise
  // shows a cleaned prompt-head. Probe is best-effort and never blocks.
  if (
    statuslineVariant === "full" &&
    report.results.some((r) => r.surface === "cc-statusline" && r.status !== "failed")
  ) {
    if (await ollamaReachable()) {
      log.info("Statusline session labels will use your local model (ollama).");
    } else {
      log.info(
        "No local model found - the statusline shows a cleaned prompt summary. " +
          "Install ollama + a small model (e.g. hermes3:8b) to upgrade it.",
      );
    }
  }

  const cosmeticFailures = report.results.filter((r) => r.status === "failed");
  if (cosmeticFailures.length === 0) {
    log.success(
      `Inscribed. Restart your shell or run \`source ~/.zshrc\` (or your equivalent) to render.`,
    );
  } else {
    log.warn(
      `${cosmeticFailures.length} cosmetic surface${cosmeticFailures.length === 1 ? "" : "s"} failed; the rest were inscribed.`,
    );
  }
}

async function loadActivePalette() {
  try {
    const cfg = await loadConfig();
    return resolvePalette(cfg.palette, cfg.custom_palette);
  } catch {
    return getPalette("gold-on-charcoal");
  }
}

/** Best-effort liveness probe for a local ollama instance (1s budget).
 *  Used only to print an honest message about the full statusline's
 *  session-label descriptor; never throws, never blocks the flow. */
async function ollamaReachable(): Promise<boolean> {
  const base = process.env.OLLAMA_HOST || "http://localhost:11434";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1000);
    const res = await fetch(`${base}/api/tags`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

function prettyPath(p: string): string {
  const home = process.env.HOME;
  if (home && p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

function renderInscribeResult(r: InscribeResult): string {
  let glyph: string;
  switch (r.status) {
    case "written":
      glyph = chalk.green("OK");
      break;
    case "replaced":
      glyph = chalk.cyan("==");
      break;
    case "skipped":
      glyph = chalk.dim("--");
      break;
    case "failed":
      glyph = chalk.red("!!");
      break;
  }
  const label = chalk.bold(r.surface);
  const detail = r.reason ? chalk.dim(` (${r.reason})`) : "";
  return `  ${glyph} ${label}  ${chalk.dim(prettyPath(r.path))}${detail}`;
}
