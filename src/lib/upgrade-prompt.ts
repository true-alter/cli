/**
 * upgrade-prompt - build the channel-correct upgrade prompt rendered when
 * the client is below floor.
 *
 * Build the channel-correct upgrade prompt (brew re-tap, AUR helpers,
 * scoop/winget/nix).
 *
 * Returns BOTH a human-readable multi-line string (for stderr) AND the
 * canonical envelope (for stdout JSON when headless). The envelope shape is
 * identical to the server reject body - single canonical envelope across
 * HTTP 426 / MCP tools/call / WS close-4426 / CLI stdout JSON.
 */

import {
  detectAurHelper,
  type AurHelper,
  type InstallChannel,
} from "./install-channel.js";

export interface UpgradePromptInput {
  channel: InstallChannel;
  currentVersion: string;
  minVersion: string;
  /** Override AUR helper detection (tests). */
  aurHelper?: AurHelper;
}

export interface UpgradePromptOutput {
  /** Multi-line, human-readable, for stderr. */
  human: string;
  /** Channel-specific upgrade command (single line - embedded in envelope.upgrade_cmd). */
  upgradeCmd: string;
}

/**
 * Build the upgrade prompt for a given channel. Pure function - no IO except
 * the optional AUR helper detection (which itself runs `which yay/paru/pamac`
 * via spawnSync; pass `aurHelper` to skip detection in tests).
 */
export function buildUpgradePrompt(
  input: UpgradePromptInput,
): UpgradePromptOutput {
  const upgradeCmd = upgradeCmdForChannel(input);
  const human = renderHuman(input, upgradeCmd);
  return { human, upgradeCmd };
}

/**
 * Return only the upgrade_cmd string. Used by the canonical envelope, where
 * we want the channel's primary upgrade verb - for AUR this is the first-
 * preference helper (yay > paru > pamac > makepkg).
 */
export function upgradeCmdForChannel(input: UpgradePromptInput): string {
  switch (input.channel) {
    case "brew":
      // Re-tap idempotent so a fresh machine that never tapped survives.
      return "brew tap truealter/tap && brew update && brew upgrade truealter/tap/alter";
    case "aur":
      return aurUpgradeCmd(input.aurHelper ?? detectAurHelper());
    case "npm":
      return "npm install -g @truealter/cli";
    case "binary":
      return "alter update";
    case "pipx":
      return "pipx upgrade truealter";
    case "scoop":
      return "scoop bucket add truealter <bucket-url> ; scoop update alter";
    case "winget":
      return "winget upgrade truealter.alter";
    case "nix":
      return "nix profile upgrade alter  # or: nix-env -u alter (legacy)";
    case "unknown":
    default:
      return "alter update  # (install-channel could not be auto-detected - consult your package manager)";
  }
}

function aurUpgradeCmd(helper: AurHelper): string {
  switch (helper) {
    case "yay":
      return "yay -S truealter-cli  # or: paru -S truealter-cli  # or: pamac upgrade truealter-cli (Manjaro)";
    case "paru":
      return "paru -S truealter-cli  # or: yay -S truealter-cli  # or: pamac upgrade truealter-cli (Manjaro)";
    case "pamac":
      return "pamac upgrade truealter-cli  # or: yay -S truealter-cli  # or: paru -S truealter-cli";
    case "makepkg-only":
      return "git clone https://aur.archlinux.org/truealter-cli.git && cd truealter-cli && makepkg -si  # install yay or paru for a faster path";
    case null:
    default:
      // No helper detected and pacman not found either - print the full
      // chain so the user can pick whatever they have.
      return "yay -S truealter-cli  # or: paru -S truealter-cli  # or: pamac upgrade truealter-cli (Manjaro)  # without helper: git clone https://aur.archlinux.org/truealter-cli.git && cd truealter-cli && makepkg -si";
  }
}

function renderHuman(
  input: UpgradePromptInput,
  upgradeCmd: string,
): string {
  const header = `alter-cli ${input.currentVersion} is below the minimum required version ${input.minVersion}.`;
  const detector = `Detected install channel: ${input.channel}`;
  const action = `Upgrade with:\n  ${upgradeCmd}`;
  const tail =
    "After upgrading, re-run the command. Run `alter update channel` to see the current channel binding.";
  return [header, detector, "", action, "", tail].join("\n");
}
