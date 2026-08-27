/**
 * `alter prompt install` - emit a starship TOML snippet that binds
 * the caller's `~handle` into their shell prompt.
 *
 * The prompt line is the single highest-frequency identity event in
 * any TTY. Binding `~handle` there publishes a
 * recognition event to the user, to themselves, at every shell
 * interaction - the Day-1 attunement lever without further ceremony.
 *
 * The emitted snippet reads `~/.cache/alter/identity.json` directly
 * via `sed` - NOT by re-invoking `alter` - so the prompt does not
 * cold-start the CLI on every render. Falls back silently when the
 * session file is absent.
 *
 * Verbs:
 *   alter prompt install          print the snippet to stdout
 *   alter prompt install --append append to ~/.config/starship.toml
 *                                 (creates the file if absent)
 *   alter prompt install --show   alias of `install` (stdout only)
 *
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { loadConfig } from "../config/loader.js";
import { getPalette, resolvePalette } from "../theme/palette.js";
import { composeSigil } from "../theme/sigil.js";
import { which } from "../lib/which.js";

export async function prompt(args: string[]): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    case "install":
      await cmdInstall(args.slice(1));
      return;
    default:
      console.error(`Unknown: alter prompt ${sub}`);
      printHelp();
      process.exitCode = 1;
      return;
  }
}

function printHelp(): void {
  console.log(`
alter prompt -- bind your ~handle into your shell prompt.

Verbs:
  alter prompt install             Print the starship snippet to stdout
  alter prompt install --append    Append to ~/.config/starship.toml
                                   (creates the file if absent)
  alter prompt install --show      Alias of 'install' (stdout only)

The snippet reads ~/.cache/alter/identity.json directly; it does not
re-invoke 'alter' on each prompt render, so cold-start stays quiet.
`);
}

async function cmdInstall(args: string[]): Promise<void> {
  const append = args.includes("--append");

  // Guard: starship must be installed for the snippet to render.
  if (!which("starship")) {
    console.error(
      "alter prompt: starship is not installed or not on $PATH.\n" +
        "Install it first: https://starship.rs/#🚀-installation",
    );
    if (append) {
      // In --append mode, exit with an error code so the caller knows.
      process.exitCode = 1;
      return;
    }
    // In print-only mode, still emit the snippet so the user can install
    // it manually once starship is available.
    console.error("(emitting snippet anyway for manual installation)");
  }

  const snippet = await renderSnippet();

  if (!append) {
    process.stdout.write(snippet);
    if (!snippet.endsWith("\n")) process.stdout.write("\n");
    process.stderr.write(
      "\n# paste the block above into your ~/.config/starship.toml,\n" +
        "# then add  $custom.alter_handle  to the 'format' string.\n" +
        "# (or rerun with --append to land it automatically.)\n",
    );
    return;
  }

  const starshipFile = starshipConfigPath();
  const starshipDir = path.dirname(starshipFile);
  fs.mkdirSync(starshipDir, { recursive: true, mode: 0o700 });

  const existing = fs.existsSync(starshipFile)
    ? fs.readFileSync(starshipFile, "utf8")
    : "";

  if (existing.includes("[custom.alter_handle]")) {
    console.error(
      `alter prompt: ${starshipFile} already has a [custom.alter_handle] ` +
        "block. Remove the existing block before re-running --append.",
    );
    process.exitCode = 1;
    return;
  }

  const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  fs.writeFileSync(starshipFile, existing + sep + snippet);
  console.log(`alter prompt: appended to ${starshipFile}`);
  console.log(
    `alter prompt: add  $custom.alter_handle  to the 'format' string ` +
      "in that file so it renders.",
  );
}

/**
 * Build the snippet from the current palette + sigil. Exported for tests.
 *
 * Emits two starship blocks:
 *   - [custom.alter_handle] - always; reads identity.json at render time.
 *   - [custom.alter_sigil]  - only when a complete sigil is configured.
 *                             Embeds the composed string literally so
 *                             the prompt doesn't spawn a shell pipeline
 *                             per render.
 *
 * Re-run `alter prompt install` after customising the sigil to refresh
 * the embedded value.
 */
export async function renderSnippet(): Promise<string> {
  let palette;
  let sigilString: string | null = null;
  try {
    const cfg = await loadConfig();
    palette = resolvePalette(cfg.palette, cfg.custom_palette);
    sigilString = composeSigil(cfg.sigil);
  } catch {
    palette = getPalette("gold-on-charcoal");
  }

  // POSIX-portable sed extraction: GNU sed + BSD sed (macOS) both
  // support this basic-regex form. No jq or python dependency, so the
  // snippet works on a minimal shell. Falls back to empty string when
  // the identity cache is missing or the handle is absent. (Auth moved
  // into the OS secure store + encrypted mirror; the CLI no longer writes
  // plaintext session.json, so identity.json is the cheap read surface.)
  const extractor =
    `sed -n 's/.*"handle"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' ` +
    `"$HOME/.cache/alter/identity.json" 2>/dev/null`;

  // TOML triple-single-quoted strings allow embedded single quotes
  // (sed patterns are full of them) without escape sequences. Starship
  // accepts any valid TOML string for `command`.
  const handleBlock = [
    `# === ~Alter ~handle binding (generated by 'alter prompt install') ===`,
    `# Reads $HOME/.cache/alter/identity.json directly. No 'alter'`,
    `# invocation per prompt render, so no cold-start cost.`,
    `[custom.alter_handle]`,
    `command = '''${extractor}'''`,
    `when = '''test -s "$HOME/.cache/alter/identity.json"'''`,
    `format = "[~$output]($style) "`,
    `style = "bold ${palette.title}"`,
    `description = "Alter ~handle"`,
    `# === end ~Alter ~handle binding ===`,
    ``,
  ].join("\n");

  if (!sigilString) return handleBlock;

  // The sigil is a static render-time constant from the user's
  // Customise-menu pick. Emit it via starship's `format` directly -
  // no command execution, so no per-render cost at all.
  // Starship custom modules require a `command`. Echoing the composed
  // sigil to stdout lets starship's `$output` substitute the literal
  // string at render time - still one exec per prompt, but the
  // payload is a single echo, not an `alter` cold-start. TOML triple-
  // single-quoted string preserves the sigil characters verbatim.
  const sigilBlock = [
    `# === ~Alter sigil (generated by 'alter prompt install') ===`,
    `# Re-run after changing your sigil in the Customise menu.`,
    `[custom.alter_sigil]`,
    `command = '''printf %s '${sigilString}' '''`,
    `when = '''true'''`,
    `format = "[$output]($style) "`,
    `style = "${palette.title}"`,
    `description = "Alter sigil"`,
    `# === end ~Alter sigil ===`,
    ``,
  ].join("\n");

  return handleBlock + sigilBlock;
}

function starshipConfigPath(): string {
  const xdg =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdg, "starship.toml");
}

// Exported for unit tests.
export const __testing = { starshipConfigPath };
