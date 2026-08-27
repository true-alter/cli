/**
 * alter about - build and install details.
 *
 * A plain, member-facing card: which version is installed, how it was
 * installed and whether it keeps itself up to date, where it lives on
 * disk, and the host runtime. No internal vocabulary - this is a public
 * surface, reached from the top-level menu or `alter about`.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { brand } from "../ui/biosMenu.js";
import { getCliVersion } from "../lib/version.js";
import {
  detectInstallChannel,
  channelToInstallMethod,
  type InstallChannel,
} from "../lib/install-channel.js";
import { ALTER_CONFIG_DIR } from "../auth.js";

/** Human-readable label for each install channel. */
const CHANNEL_LABELS: Readonly<Record<InstallChannel, string>> = {
  // A local build from the CLI's own checkout. Named plainly so `alter about`
  // says which of the two you are running: a source build and a published
  // release are separate classes, and confusing them is how a dev build gets
  // quietly replaced by a public one.
  dev: "local build (source checkout)",
  brew: "Homebrew",
  aur: "AUR (Arch)",
  npm: "npm",
  binary: "install script",
  pipx: "pipx",
  scoop: "Scoop",
  winget: "winget",
  nix: "Nix",
  unknown: "unknown",
};

/**
 * Best-effort resolve of the installed package root from this module's
 * compiled location (`dist/commands/about.js` -> two levels up to the
 * package root). Returns "unknown" rather than throwing if the URL can't
 * be resolved.
 */
function resolveInstallRoot(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, "..", "..");
  } catch {
    return "unknown";
  }
}

/**
 * Return true when running from a dev worktree via `node dist/...` rather
 * than an installed binary. The heuristic is: process.argv[1] ends with
 * `dist/index.js` (or uses a platform path separator equivalent). This is
 * the canonical dev-run pattern and does not fire for any real install
 * channel because none of them invoke node with a `dist/index.js` entry-point.
 *
 * Conservative: only applied in about.ts to override the channel label -
 * all other channel detection (Nix, npm, brew…) is left intact.
 */
function isDevBuild(): boolean {
  const entry = process.argv[1] ?? "";
  return entry.endsWith(`dist${path.sep}index.js`) ||
    entry.endsWith("dist/index.js");
}

/**
 * Auto-update defaults on; only an explicit off value disables it. Mirrors
 * the `ALTER_CLI_AUTO_UPDATE` gate the self-update path reads.
 */
function autoUpdateEnabled(): boolean {
  const v = process.env.ALTER_CLI_AUTO_UPDATE;
  if (v === undefined) return true;
  const n = v.trim().toLowerCase();
  return !(n === "0" || n === "false" || n === "off" || n === "no");
}

/**
 * The About card's label/value rows, computed once. Shared by the `alter
 * about` CLI command and the menu's on-focus right-pane preview (biosMenu)
 * so both render identical version / install / runtime / config data. Kept
 * as plain `[label, value]` strings (no brand styling) so each caller can
 * style and lay them out for its own surface.
 *
 * MEMOISED at first call: detectInstallChannel() can shell out to `npm`
 * (spawnSync) to classify the install, and the biosMenu right-pane preview
 * calls this inside render() - spawning a process per paint froze the menu
 * on every keystroke while About was focused. Every row is static for the
 * life of the process, so one computation serves all callers.
 */
let _aboutStatRowsMemo: [string, string][] | null = null;

export function aboutStatRows(): [string, string][] {
  if (_aboutStatRowsMemo) return _aboutStatRowsMemo;
  const version = getCliVersion();
  const devBuild = isDevBuild();
  const channel = detectInstallChannel();
  const channelLabel = devBuild ? "Development build" : (CHANNEL_LABELS[channel] ?? channel);
  const selfUpdates =
    !devBuild && channelToInstallMethod(channel) === "npm" && autoUpdateEnabled();
  const root = resolveInstallRoot();

  _aboutStatRowsMemo = [
    ["Version", `alter ${version}`],
    [
      "Installed via",
      selfUpdates ? `${channelLabel} (updates itself)` : channelLabel,
    ],
    ["Installed at", root],
    [
      "Runtime",
      `Node ${process.version} on ${process.platform}/${process.arch}`,
    ],
    ["Config", ALTER_CONFIG_DIR],
  ];
  return _aboutStatRowsMemo;
}

export async function about(args: string[] = []): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: alter about [--json]\n\n" +
        "Show the installed version, how it was installed, where it\n" +
        "lives on disk, and the host runtime.\n",
    );
    return;
  }

  const version = getCliVersion();
  const devBuild = isDevBuild();
  const channel = detectInstallChannel();
  const channelLabel = devBuild ? "Development build" : (CHANNEL_LABELS[channel] ?? channel);
  const selfUpdates =
    !devBuild && channelToInstallMethod(channel) === "npm" && autoUpdateEnabled();
  const root = resolveInstallRoot();

  if (args.includes("--json")) {
    process.stdout.write(
      JSON.stringify(
        {
          version,
          channel,
          auto_update: selfUpdates,
          install_path: root,
          executable: process.execPath,
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          config_dir: ALTER_CONFIG_DIR,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  const rows = aboutStatRows();

  const labelWidth = Math.max(...rows.map(([k]) => k.length));
  process.stdout.write("\n");
  process.stdout.write("  " + brand.title("About alter") + "\n\n");
  for (const [k, v] of rows) {
    process.stdout.write(
      "  " + brand.dim(k.padEnd(labelWidth)) + "  " + brand.text(v) + "\n",
    );
  }
  process.stdout.write("\n");
  process.stdout.write(
    "  " +
      brand.faint(
        "alter is identity infrastructure. Where your identity earns.",
      ) +
      "\n\n",
  );
}
