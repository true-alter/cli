/**
 * Cosmetic surface detection - probe the user's machine for safe
 * insta-embed targets in ≤200ms total.
 *
 * Three-phase strategy:
 *   1. command -v batch + env vars (0–30ms)
 *   2. Config-file existsSync (30–50ms)
 *   3. --version probes only on hits (50–200ms; currently skipped -
 *      we don't gate on version yet)
 *
 * Supported surfaces shipped:
 *   cc-statusline   Claude Code statusline command
 *   starship        ~/.config/starship.toml [custom.alter_handle]
 *   tmux            ~/.config/tmux/alter.conf sourced from main
 *   shellrc         ~/.zshrc | ~/.bashrc | ~/.config/fish/conf.d/alter.fish
 *   fastfetch       ~/.config/fastfetch/config.jsonc command module
 *   pfetch          ~/.config/alter/pfetch-extras.sh + shellrc wrapper
 *   neofetch        ~/.config/alter/neofetch-info.sh + paste-snippet
 *
 * Intentionally NOT supported (and why):
 *   screenfetch     legacy; no custom module system, no env-var extension
 *   macchina        TOML theme system is a rewrite of what we already do
 *   onefetch        git-repo-specific, wrong context for an identity row
 *   uwufetch        minimal customisation surface, not worth the shim
 *
 * Detection is read-only. No writes; no spawn fan-out beyond
 * `command -v`. Synced-volume refusal happens at the *write* layer
 * (inscribe.ts), not here - detection still surfaces the surface so
 * the user sees why nothing landed.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { which as whichBin } from "../which.js";
import type { SurfaceId } from "./state.js";

export interface DetectedSurface {
  id: SurfaceId;
  /** Human-readable label for the multiselect. */
  label: string;
  /** Absolute path that will receive the inscription. */
  targetPath: string;
  /** Detection signal that fired (for debug/verbose). */
  via: string;
}

/**
 * Thin re-export of the shared shell-free `which()` so the rest of
 * this module's call sites stay readable. Replaces the prior
 * `execSync(\`command -v ${bin}\`)` shape, which interpolated the
 * binary name into a shell command - a foot-gun the moment any
 * caller passed env-derived input through.
 */
function which(bin: string): boolean {
  return whichBin(bin);
}

function home(): string {
  return os.homedir();
}

function xdgConfig(): string {
  return process.env.XDG_CONFIG_HOME ?? path.join(home(), ".config");
}

/**
 * Probe all supported surfaces. Pure function over the filesystem +
 * environment; no side effects.
 *
 * Budget: should complete in ≤50ms on warm cache. The five
 * `command -v` calls dominate; each is a few ms.
 */
export function probeCosmetics(): DetectedSurface[] {
  const surfaces: DetectedSurface[] = [];

  // 1. Claude Code statusline - detected by either the binary in PATH
  //    or the settings file existing. Both signals are common.
  const ccSettings = path.join(home(), ".claude", "settings.json");
  if (which("claude") || fs.existsSync(ccSettings)) {
    surfaces.push({
      id: "cc-statusline",
      label: "Claude Code statusline",
      targetPath: ccSettings,
      via: which("claude") ? "command -v claude" : "settings.json exists",
    });
  }

  // 2. Starship - only land if user already has a starship config so we
  //    don't create one for someone who doesn't use the prompt.
  const starshipCfg = path.join(xdgConfig(), "starship.toml");
  if (which("starship") && fs.existsSync(starshipCfg)) {
    surfaces.push({
      id: "starship",
      label: "starship prompt",
      targetPath: starshipCfg,
      via: "command -v starship + config exists",
    });
  } else if (which("starship")) {
    // Starship installed but no config - still offer; alter prompt
    // install will create the file.
    surfaces.push({
      id: "starship",
      label: "starship prompt (will create config)",
      targetPath: starshipCfg,
      via: "command -v starship",
    });
  }

  // 3. tmux - env var is the high-confidence in-session signal; binary
  //    presence is the persistence signal.
  const tmuxAlterCfg = path.join(xdgConfig(), "tmux", "alter.conf");
  if (process.env.TMUX || which("tmux")) {
    surfaces.push({
      id: "tmux",
      label: "tmux status-right",
      targetPath: tmuxAlterCfg,
      via: process.env.TMUX ? "$TMUX set" : "command -v tmux",
    });
  }

  // 4. Active shell rc - pick exactly one, prefer SHELL env var.
  const shell = (process.env.SHELL ?? "").split("/").pop() ?? "";
  const shellChoice = chooseShell(shell);
  if (shellChoice) surfaces.push(shellChoice);

  // 5. fastfetch - single binary check; config is created on demand.
  if (which("fastfetch")) {
    surfaces.push({
      id: "fastfetch",
      label: "fastfetch identity module",
      targetPath: path.join(xdgConfig(), "fastfetch", "config.jsonc"),
      via: "command -v fastfetch",
    });
  }

  // 6. pfetch - inscribes a wrapper function into the active shellrc +
  //    writes the get_alter() extras script at a stable ALTER path.
  //    Target is the shellrc (where the wrapper lives); the extras
  //    script is written at an ALTER-owned path by the inscribe layer.
  if (which("pfetch")) {
    const shellChoice = chooseShell(
      (process.env.SHELL ?? "").split("/").pop() ?? "",
    );
    if (shellChoice) {
      surfaces.push({
        id: "pfetch",
        label: "pfetch identity row",
        targetPath: shellChoice.targetPath,
        via: "command -v pfetch",
      });
    }
  }

  // 7. neofetch - paste-snippet surface (like fastfetch). print_info()
  //    is a bash function in the user's config.conf; automated injection
  //    inside a function body is fragile, so we target the config file
  //    and let the user paste one `info` line.
  if (which("neofetch")) {
    surfaces.push({
      id: "neofetch",
      label: "neofetch identity row",
      targetPath: path.join(xdgConfig(), "neofetch", "config.conf"),
      via: "command -v neofetch",
    });
  }

  // 8. kitty - one-line `include` directive pointing at the wardrobe-
  //    generated palette file at ~/.config/alter/surfaces/kitty-palette.conf.
  //    Only land when a kitty.conf already exists; we never create one for
  //    someone who doesn't use kitty.
  const kittyCfg = path.join(xdgConfig(), "kitty", "kitty.conf");
  if (which("kitty") && fs.existsSync(kittyCfg)) {
    surfaces.push({
      id: "kitty",
      label: "kitty terminal palette",
      targetPath: kittyCfg,
      via: "command -v kitty + config exists",
    });
  }

  // 9. alacritty - TOML import directive. Same containment rule as kitty.
  const alacrittyCfg = path.join(xdgConfig(), "alacritty", "alacritty.toml");
  if (which("alacritty") && fs.existsSync(alacrittyCfg)) {
    surfaces.push({
      id: "alacritty",
      label: "alacritty terminal palette",
      targetPath: alacrittyCfg,
      via: "command -v alacritty + config exists",
    });
  }

  // 10. polybar - INI include-file directive. Older installs use the bare
  //     `config` filename (no extension); newer convention is `config.ini`.
  const polybarCfgIni = path.join(xdgConfig(), "polybar", "config.ini");
  const polybarCfgBare = path.join(xdgConfig(), "polybar", "config");
  const polybarCfg = fs.existsSync(polybarCfgIni)
    ? polybarCfgIni
    : fs.existsSync(polybarCfgBare)
      ? polybarCfgBare
      : null;
  if (which("polybar") && polybarCfg) {
    surfaces.push({
      id: "polybar",
      label: "polybar palette include",
      targetPath: polybarCfg,
      via: "command -v polybar + config exists",
    });
  }

  return surfaces;
}

function chooseShell(shell: string): DetectedSurface | null {
  // fish: dropping a file in conf.d auto-sources, no rc edit needed.
  if (shell === "fish") {
    return {
      id: "shellrc",
      label: "fish shell prompt",
      targetPath: path.join(xdgConfig(), "fish", "conf.d", "alter.fish"),
      via: "$SHELL = fish",
    };
  }
  // zsh: prefer XDG-zsh layout if ZDOTDIR set, else ~/.zshrc.
  if (shell === "zsh") {
    const zdotdir = process.env.ZDOTDIR ?? home();
    return {
      id: "shellrc",
      label: "zsh shell prompt",
      targetPath: path.join(zdotdir, ".zshrc"),
      via: "$SHELL = zsh",
    };
  }
  // bash: ~/.bashrc on Linux, ~/.bash_profile on macOS login shells -
  // we land on .bashrc for both since it's the prompt-rendering one.
  if (shell === "bash") {
    return {
      id: "shellrc",
      label: "bash shell prompt",
      targetPath: path.join(home(), ".bashrc"),
      via: "$SHELL = bash",
    };
  }
  return null;
}

// Exported for tests.
export const __testing = { which, chooseShell };
