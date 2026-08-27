/**
 * `alter pair obsidian` and `alter unpair obsidian`.
 *
 * Implements the zero-friction Obsidian pairing flow. The CLI
 * orchestrates the entire setup:
 *
 *   1. Detect Obsidian + enumerate vaults via `obsidian.json`.
 *   2. Sideload `alter-obsidian-plugin` into
 *      `<vault>/.obsidian/plugins/alter-obsidian-plugin/` and mark it
 *      enabled.
 *   3. Ensure `obsidian-local-rest-api` is sideloaded + enabled.
 *   4. Open Obsidian (or hint the user to) so the plugin's
 *      pairing ceremony can run inside the app.
 *   5. Poll for `<vault>/~Alter/PAIRING.md` for ~60s and copy the
 *      tokens into `~/.config/alter/obsidian/<hash>/tokens.json`.
 *
 * Re-running the command after a vault is paired surfaces an
 * arrow-key picker for granting / revoking subtags - per the
 * "no new CLI commands; customisation goes in the menu" rule.
 *
 * Unpairing reads the persisted tokens (or prompts) and asks the
 * daemon - via the alter-runtime MCP fallback path the plugin
 * also uses - to revoke the grant. The CLI then nukes the
 * plugin's `data.json` so the in-app consent state matches.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { openBrowser } from "../browser.js";

import {
  intro,
  outro,
  log,
  cancel,
  spinner,
} from "@clack/prompts";
import { pickOne, confirmYesNo, BACK_OPTION, isBack } from "../ui/picker.js";
import { withKeyListenerCancel } from "../ui/biosMenu.js";
import chalk from "chalk";

import { apiCall, getSession } from "../auth.js";
import {
  detectObsidian,
  ObsidianVault,
  vaultHash,
} from "../lib/obsidian/detect.js";
import {
  ALTER_PLUGIN,
  LOCAL_REST_API_PLUGIN,
  enableCommunityPlugin,
  pluginInstalled,
  removePluginFolder,
  sideloadPlugin,
  wipePluginData,
} from "../lib/obsidian/sideload.js";
import {
  deleteTokens,
  readPairingMarker,
  readTokens,
  tokensPath,
  writeTokens,
} from "../lib/obsidian/tokens.js";

const POLL_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;
const DEFAULT_SUBTAGS = ["journal", "manual-note"] as const;

interface PairOptions {
  /** When set, use this vault path without prompting. */
  vault?: string;
  /** Subtags to grant. Defaults to journal + manual-note. */
  subtags?: string[];
}

interface UnpairOptions {
  /** Restrict revoke to a single subtag. */
  subtag?: string;
  /** Remove the plugin folder after revoke. */
  removePlugin?: boolean;
  /** Skip token-revoke prompt (non-interactive). */
  yes?: boolean;
}

function platformIsTty(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

function printNotInstalled(): void {
  console.log("");
  console.log("  Obsidian doesn't appear to be installed on this device.");
  console.log("");
  console.log("  Install it from https://obsidian.md and re-run");
  console.log("  'alter pair obsidian' once the app is open.");
  console.log("");
}

async function pickVault(vaults: ObsidianVault[]): Promise<ObsidianVault | null> {
  if (vaults.length === 1) return vaults[0];
  const options = vaults.map((v, idx) => {
    const tag = v.open ? " (currently open)" : idx === 0 ? " (most recent)" : "";
    return {
      value: v.id,
      label: `${path.basename(v.path)}${tag}`,
      hint: v.path,
    };
  });
  const picked = await pickOne({
    message: "Which vault would you like to pair?",
    options: [...options, BACK_OPTION],
  });
  if (isBack(picked)) {
    cancel("Nothing paired.");
    return null;
  }
  return vaults.find((v) => v.id === picked) ?? null;
}

/**
 * Poll the vault for the pairing marker. Returns null on timeout or
 * abort. The optional `signal` lets a TUI surface cancel the poll on
 * q/Esc - the loop checks it both before each disk read and during the
 * inter-poll sleep, so cancellation is felt within one POLL_INTERVAL_MS
 * tick rather than at the next deadline.
 */
async function waitForPairingMarker(
  vaultPath: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ReturnType<typeof readPairingMarker>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return null;
    const marker = readPairingMarker(vaultPath);
    if (marker) return marker;
    const remaining = Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()));
    if (remaining === 0) break;
    const sleepInterrupted = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), remaining);
      if (signal) {
        const onAbort = () => {
          clearTimeout(t);
          resolve(true);
        };
        if (signal.aborted) {
          clearTimeout(t);
          resolve(true);
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }
    });
    if (sleepInterrupted) return null;
  }
  return null;
}

/**
 * Surface the backend's view of the obsidian connector. We do not
 * fail when the backend returns `available: false` (the gate is
 * server-side ingestion; the plugin still installs fine and idles
 * until the flag flips). When the backend is unreachable - which
 * happens when the user has no session, or the API is down - we
 * skip the check rather than crashing.
 */
async function backendAvailability(): Promise<boolean | null> {
  try {
    const resp = await apiCall("/api/v1/connectors");
    if (!resp || !resp.ok) return null;
    const body = (await resp.json()) as {
      connectors?: { id: string; available?: boolean }[];
    };
    const obsidian = body.connectors?.find((c) => c.id === "obsidian");
    if (!obsidian) return null;
    return obsidian.available === true;
  } catch {
    return null;
  }
}

interface SubtagToggle {
  subtag: string;
  action: "grant" | "revoke" | "noop";
}

/**
 * Re-run on an already-paired vault: arrow-key picker that lets
 * the user grant or revoke individual subtags. Anything more
 * intricate goes through the existing plugin UI inside Obsidian.
 */
async function customiseSubtags(
  vaultPath: string,
  current: string[],
): Promise<SubtagToggle | null> {
  const known = Array.from(new Set([...DEFAULT_SUBTAGS, ...current]));
  const options = known.map((s) => ({
    value: s,
    label: current.includes(s)
      ? `${s} - granted (pick to revoke)`
      : `${s} - not granted (pick to grant)`,
    hint: vaultPath,
  }));
  options.push({ value: "__cancel__", label: "Leave subtags unchanged", hint: "" });

  const picked = await pickOne({
    message: "Which subtag would you like to toggle?",
    options,
  });
  if (picked === null || picked === "__cancel__") return null;
  const subtag = picked;
  const action: "grant" | "revoke" = current.includes(subtag) ? "revoke" : "grant";
  return { subtag, action };
}

/**
 * `alter pair obsidian` end-to-end.
 */
export async function pairObsidian(options: PairOptions = {}): Promise<void> {
  if (!getSession()) {
    throw new Error("not logged in. Run 'alter login' first.");
  }

  const detection = detectObsidian();
  if (!detection.installed) {
    printNotInstalled();
    return;
  }
  if (detection.vaults.length === 0) {
    console.log("");
    console.log("  Obsidian is installed, but no vaults are registered yet.");
    console.log("  Open Obsidian and create or open a vault, then re-run");
    console.log("  'alter pair obsidian'.");
    console.log("");
    return;
  }

  const interactive = platformIsTty();
  if (interactive) intro("alter pair obsidian - sideload + pairing ceremony");

  const vault = options.vault
    ? detection.vaults.find((v) => path.resolve(v.path) === path.resolve(options.vault!))
    : await pickVault(detection.vaults);
  if (!vault) {
    if (options.vault) {
      throw new Error(
        `vault path '${options.vault}' is not registered with Obsidian. ` +
          `Open it in Obsidian once and re-run.`,
      );
    }
    return;
  }

  // Already paired? Surface the customisation picker instead of
  // re-running the whole sideload.
  const existing = readTokens(vault.path);
  if (existing && interactive) {
    log.info(`Vault is already paired to ${chalk.bold(existing.handle)}.`);
    const toggle = await customiseSubtags(vault.path, existing.subtags);
    if (!toggle) {
      outro("No changes.");
      return;
    }
    if (toggle.action === "revoke") {
      await unpairObsidian({ subtag: toggle.subtag, yes: true });
    } else {
      log.warn(
        `Granting additional subtags is handled inside the Obsidian plugin ` +
          `(Settings → Alter → Subtags). Re-running 'alter pair obsidian' ` +
          `does not currently grant new subtags from the CLI.`,
      );
    }
    return;
  }

  // Surface the backend gate so the user knows what to expect, but
  // proceed regardless - sideload is purely local.
  const backendAvailable = await backendAvailability();
  if (backendAvailable === false && interactive) {
    log.info(
      "Backend ingestion gate is off - plugin will be sideloaded and " +
        "ready, ingestion will start once the gate flips.",
    );
  }

  const s = interactive ? spinner() : null;

  // 1. Install the Alter plugin from the assets bundled in this CLI.
  // No network: the plugin ships inside the package and is written
  // straight into the vault. The withKeyListenerCancel wrapper keeps a
  // consistent q/Esc interface with the network-fetched plugin below.
  s?.start("Installing the Alter vault plugin…");
  let alterResult;
  try {
    const alterWait = await withKeyListenerCancel((signal) =>
      sideloadPlugin(vault.path, ALTER_PLUGIN, { signal }),
    );
    if (alterWait.cancelled) {
      s?.stop("Sideload cancelled.");
      return;
    }
    alterResult = alterWait.result!;
    s?.stop(`Installed the Alter plugin ${alterResult.tag} into ${vault.path}.`);
  } catch (err) {
    s?.stop(chalk.red(`Alter plugin install failed: ${(err as Error).message}`));
    throw err;
  }
  enableCommunityPlugin(vault.path, ALTER_PLUGIN.pluginId);

  // 2. Ensure Local REST API is in place.
  if (!pluginInstalled(vault.path, LOCAL_REST_API_PLUGIN.pluginId)) {
    s?.start(`Sideloading ${LOCAL_REST_API_PLUGIN.repo}…`);
    try {
      const restWait = await withKeyListenerCancel((signal) =>
        sideloadPlugin(vault.path, LOCAL_REST_API_PLUGIN, { signal }),
      );
      if (restWait.cancelled) {
        s?.stop("Sideload cancelled.");
        return;
      }
      const restResult = restWait.result!;
      s?.stop(`Installed Local REST API ${restResult.tag}.`);
    } catch (err) {
      s?.stop(
        chalk.yellow(
          `Local REST API install failed: ${(err as Error).message}. ` +
            `Install it manually from Settings → Community plugins if pairing stalls.`,
        ),
      );
    }
  }
  enableCommunityPlugin(vault.path, LOCAL_REST_API_PLUGIN.pluginId);

  console.log("");
  console.log(
    `  Alter plugin sideloaded into ${chalk.bold(vault.path)}. Open Obsidian ` +
      `and the pairing ceremony will start automatically.`,
  );
  console.log("");

  // 3. Best-effort: bring Obsidian to the foreground.
  openBrowser("obsidian://");

  // 4. Poll for the pairing marker. q/Esc cancels the wait - the user
  // can retry later from the menu without leaving alter or having to
  // wait the full POLL_TIMEOUT_MS deadline.
  s?.start(`Waiting for the pairing ceremony (up to ${POLL_TIMEOUT_MS / 1000}s · press q to cancel)…`);
  const { result: marker, cancelled } = await withKeyListenerCancel(
    (signal) => waitForPairingMarker(vault.path, POLL_TIMEOUT_MS, signal),
  );
  if (cancelled) {
    s?.stop(chalk.yellow("Pairing wait cancelled."));
    if (interactive) outro("Run 'alter pair obsidian' again when you're ready.");
    return;
  }
  if (!marker) {
    s?.stop(
      chalk.yellow(
        "Plugin sideloaded but pairing not yet detected. Open Obsidian → " +
          "Alter → Pair vault to complete.",
      ),
    );
    if (interactive) outro("Sideload complete. Run 'alter pair obsidian' again to retry.");
    return;
  }
  // PAIRING.md is a vault-local file anything-with-disk-access can
  // scribble. Refuse to import its
  // tokens unless the marker's handle matches the locally
  // authenticated session - otherwise a malicious vault (or a vault
  // synced from another user's machine) could trick the CLI into
  // writing someone else's grants under our config.
  const session = getSession();
  if (!session) {
    throw new Error("not logged in. Run 'alter login' first.");
  }
  if (marker.handle !== session.handle) {
    throw new Error(
      `PAIRING.md handle (${marker.handle}) does not match authenticated ` +
        `session (${session.handle}) - refusing to import. ` +
        `If this is intentional, log in as ${marker.handle} first.`,
    );
  }
  s?.stop(`Paired ${chalk.bold(marker.handle)} to ${vault.path}.`);

  // Filter to the requested subtags, if any. Default keeps every
  // subtag the marker advertised.
  const requested = options.subtags && options.subtags.length > 0
    ? options.subtags
    : marker.subtags;

  writeTokens({
    handle: marker.handle,
    subtags: marker.subtags.filter((s) => requested.includes(s)),
    subtagTokenHashes: Object.fromEntries(
      Object.entries(marker.subtagTokenHashes).filter(([k]) =>
        requested.includes(k),
      ),
    ),
    vaultPath: vault.path,
    pairedAt: marker.pairedAt,
  });

  if (interactive) {
    outro(`Stored grant tokens at ${tokensPath(vault.path)} (mode 0o600).`);
  } else {
    console.log(`  Tokens persisted at ${tokensPath(vault.path)} (0600).`);
  }
}

/**
 * Revoke (some or all) Obsidian grants. The daemon-side revoke is
 * routed through the same backend the plugin uses; we hit
 * `DELETE /api/v1/me/connections/obsidian` (the connector unpair
 * endpoint mounted by `enrichment.router` under prefix `/me`) and
 * pass the subtag scope as a query-string filter when one is
 * supplied.
 *
 * On success we (a) wipe the plugin's `data.json` so the in-app
 * consent state matches the backend, (b) drop the persisted token
 * file, and (c) optionally remove the plugin folder.
 */
export async function unpairObsidian(
  options: UnpairOptions = {},
): Promise<void> {
  if (!getSession()) {
    throw new Error("not logged in. Run 'alter login' first.");
  }

  const detection = detectObsidian();
  if (detection.vaults.length === 0) {
    console.log("");
    console.log("  No Obsidian vault on record. Nothing to unpair.");
    console.log("");
    return;
  }

  // For now the CLI assumes one paired vault per machine - if
  // multiple vaults have stored tokens, prompt the user to pick.
  const paired = detection.vaults
    .map((v) => ({ vault: v, tokens: readTokens(v.path) }))
    .filter((p) => p.tokens !== null) as {
    vault: ObsidianVault;
    tokens: NonNullable<ReturnType<typeof readTokens>>;
  }[];

  if (paired.length === 0) {
    console.log("");
    console.log("  No paired Obsidian vault found in the local token store.");
    console.log("");
    return;
  }

  const interactive = platformIsTty();
  let target: { vault: ObsidianVault; tokens: NonNullable<ReturnType<typeof readTokens>> };
  if (paired.length === 1) {
    target = paired[0];
  } else if (!interactive) {
    throw new Error(
      "multiple paired vaults; rerun in an interactive shell to pick one.",
    );
  } else {
    const picked = await pickOne({
      message: "Which vault would you like to unpair?",
      options: [
        ...paired.map((p) => ({
          value: p.vault.id,
          label: path.basename(p.vault.path),
          hint: p.vault.path,
        })),
        BACK_OPTION,
      ],
    });
    if (isBack(picked)) {
      cancel("Nothing unpaired.");
      return;
    }
    target = paired.find((p) => p.vault.id === picked)!;
  }

  if (interactive && !options.yes) {
    const scope = options.subtag
      ? `subtag '${options.subtag}'`
      : "every grant on this vault";
    const go = await confirmYesNo({
      message: `Revoke ${scope} for ${target.tokens.handle}?`,
      initialValue: true,
    });
    if (!go) {
      cancel("Nothing unpaired.");
      return;
    }
  }

  // Hit the backend.
  const query = options.subtag
    ? `?subtag=${encodeURIComponent(options.subtag)}&vault=${encodeURIComponent(vaultHash(target.vault.path))}`
    : `?vault=${encodeURIComponent(vaultHash(target.vault.path))}`;
  // The legacy `/candidates/me/...` 404s against the live backend
  // (no such router mounted). Live route is
  // `/me/connections/{platform}` with prefix `/me`.
  // The /candidates/ route is also retired going forward.
  const resp = await apiCall(
    `/api/v1/me/connections/obsidian${query}`,
    { method: "DELETE" },
  );
  if (!resp) {
    throw new Error("not logged in. Run 'alter login' first.");
  }
  if (!resp.ok && resp.status !== 404) {
    const text = await resp.text();
    throw new Error(
      `revoke failed (${resp.status})${text ? `: ${text}` : ""}`,
    );
  }

  // Update local state.
  if (options.subtag) {
    const remainingSubtags = target.tokens.subtags.filter(
      (s) => s !== options.subtag,
    );
    if (remainingSubtags.length === 0) {
      deleteTokens(target.vault.path);
      wipePluginData(target.vault.path, ALTER_PLUGIN.pluginId);
    } else {
      const remainingHashes = { ...target.tokens.subtagTokenHashes };
      delete remainingHashes[options.subtag];
      writeTokens({
        ...target.tokens,
        subtags: remainingSubtags,
        subtagTokenHashes: remainingHashes,
      });
    }
  } else {
    deleteTokens(target.vault.path);
    wipePluginData(target.vault.path, ALTER_PLUGIN.pluginId);
  }

  if (options.removePlugin) {
    removePluginFolder(target.vault.path, ALTER_PLUGIN.pluginId);
  }

  console.log("");
  if (options.subtag) {
    console.log(`  Revoked '${options.subtag}' for ${target.tokens.handle}.`);
  } else {
    console.log(`  Unpaired ${target.tokens.handle} from ${target.vault.path}.`);
  }
  if (options.removePlugin) {
    console.log("  Removed the Alter plugin folder from the vault.");
  }
  console.log("");
}

/**
 * Argv front-door for `alter unpair obsidian [...]`. Routed from
 * `src/index.ts`. Accepts `--subtag <name>` and `--remove-plugin`.
 */
export async function unpairObsidianFromArgs(argv: string[]): Promise<void> {
  let subtag: string | undefined;
  let removePlugin = false;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--subtag") {
      subtag = argv[++i];
      if (!subtag) throw new Error("--subtag requires a value");
    } else if (a === "--remove-plugin") {
      removePlugin = true;
    } else if (a === "--yes" || a === "-y") {
      yes = true;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: alter unpair obsidian [--subtag <name>] [--remove-plugin] [--yes|-y]\n" +
          "\n" +
          "Revoke Alter's grant on a paired Obsidian vault. Without\n" +
          "--subtag, every grant on the vault is revoked. With\n" +
          "--remove-plugin, the plugin folder is also deleted from the\n" +
          "vault (default: leave the plugin in place).\n",
      );
      return;
    } else {
      throw new Error(`Unknown flag: ${a}`);
    }
  }
  await unpairObsidian({ subtag, removePlugin, yes });
}
