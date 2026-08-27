/**
 * Per-surface snippet rendering. Pure functions: (handle, palette) →
 * string. The string is everything BETWEEN the markers; the inscribe
 * layer wraps with `# BEGIN ALTER ~handle cosmetics` / `# END`.
 *
 * Style invariants (so every cosmetic insert reads as ALTER):
 *   - Muted-gold colour from the active palette (title role)
 *   - Reads ~/.cache/alter/identity.json directly via portable sed -
 *     never re-invokes the alter binary on render. (The CLI moved auth
 *     into the OS secure store + encrypted mirror; plaintext session.json
 *     is no longer written, so identity.json is the cheap read surface.)
 *   - Falls back silently when identity.json is missing (so a logged-out
 *     terminal stays quiet, not error-y)
 *
 * Snippets are intentionally minimal. The user's existing config
 * (their starship format string, their tmux status-right, their
 * shell prompt) is the substrate; we add one segment, never replace.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import type { SurfaceId } from "./state.js";
import type { Palette } from "../../theme/palette.js";

const SED_HANDLE_EXTRACT =
  `sed -n 's/.*"handle"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' ` +
  `"$HOME/.cache/alter/identity.json" 2>/dev/null`;

/** Statusline richness. minimal = identity-only shim; full = the rich
 *  multi-segment statusline bundled under assets/statusline/. */
export type StatuslineVariant = "minimal" | "full";

export interface SnippetCtx {
  handle: string;
  palette: Palette;
  /** Which CC statusline to inscribe. Defaults to "minimal". */
  statuslineVariant?: StatuslineVariant;
}

/**
 * Marker pair, namespaced by handle so multi-user machines don't
 * collide. Format is identical across surfaces - only the comment
 * character differs (handled per renderer).
 *
 * Optional `tag` lets a single file host multiple handle-scoped blocks
 * (e.g. the shellrc hosts both the prompt `__alter_handle` block and
 * the pfetch wrapper block). The default tag "cosmetics" preserves the
 * original marker shape for backward compatibility with blocks written
 * before tagging landed.
 */
export function makeMarkers(
  handle: string,
  comment: "#" | "//" | "--" | ";",
  tag: string = "cosmetics",
): { start: string; end: string } {
  const ts = new Date().toISOString();
  return {
    start: `${comment} BEGIN ~Alter ${handle} ${tag} (inscribed ${ts})`,
    end: `${comment} END ~Alter ${handle} ${tag}`,
  };
}

/**
 * Marker word as it may appear in a file we are asked to find or remove a
 * block from. New inscriptions write `~Alter`; versions up to 0.8.40 wrote a
 * bare wordmark. Both must still be findable, or an upgrade would strand every
 * block a member already has in their dotfiles with nothing able to remove it.
 */
const MARKER_NAME = "(?:~Alter|ALTER)";

/**
 * Detect an existing namespaced marker block for `handle` in `body`.
 * Returns null when not present. Used for idempotency (skip if
 * already inscribed) and for unwire (locate the block to remove).
 */
export function findExistingBlock(
  body: string,
  handle: string,
  comment: "#" | "//" | "--" | ";",
  tag: string = "cosmetics",
): { startIdx: number; endIdx: number } | null {
  const startRe = new RegExp(
    `^${escapeRe(comment)}\\s*BEGIN ${MARKER_NAME} ${escapeRe(handle)} ${escapeRe(tag)}`,
    "m",
  );
  const endRe = new RegExp(
    `^${escapeRe(comment)}\\s*END ${MARKER_NAME} ${escapeRe(handle)} ${escapeRe(tag)}`,
    "m",
  );
  const startMatch = startRe.exec(body);
  if (!startMatch) return null;
  const endMatch = endRe.exec(body.slice(startMatch.index));
  if (!endMatch) return null;
  return {
    startIdx: startMatch.index,
    endIdx: startMatch.index + endMatch.index + endMatch[0].length,
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ----------------------------------------------------------------------------
// Per-surface body renderers. Return only the inner content; the
// inscribe layer wraps with markers + a leading newline if needed.
// ----------------------------------------------------------------------------

export function renderStarshipBody({ palette }: SnippetCtx): string {
  return [
    `[custom.alter_handle]`,
    `command = '''${SED_HANDLE_EXTRACT}'''`,
    `when = '''test -s "$HOME/.cache/alter/identity.json"'''`,
    `format = "[~$output]($style) "`,
    `style = "bold ${palette.title}"`,
    `description = "Alter ~handle"`,
    `# Add  $custom.alter_handle  to your 'format' string above to render.`,
  ].join("\n");
}

export function renderTmuxBody({ palette }: SnippetCtx): string {
  // tmux can shell-out per status-interval. Cheap because sed reads a
  // small file. status-interval defaults to 15s - fine for a TTY name.
  return [
    `# Add this to your status-right (or status-left) in tmux.conf:`,
    `#   set -g status-right '#(${SED_HANDLE_EXTRACT.replace(/'/g, "\\'")} | sed "s/^/~/")  %H:%M'`,
    `set -g @alter-handle-cmd '${SED_HANDLE_EXTRACT}'`,
    `# Style hint (terminal-256 nearest to ${palette.title}):`,
    `# set -g status-style "fg=colour179"`,
  ].join("\n");
}

export function renderZshrcBody({ palette }: SnippetCtx): string {
  // Define a function the user can drop into PROMPT/RPROMPT.
  // Don't auto-mutate PROMPT - that's hostile to hand-curated prompts.
  return [
    `# Defines __alter_handle for your prompt. Add  \\$(__alter_handle)`,
    `# to PROMPT or RPROMPT to render. Quiet when logged out.`,
    `__alter_handle() {`,
    `  local h`,
    `  h=$(${SED_HANDLE_EXTRACT})`,
    `  [[ -n "$h" ]] && print -n "%F{179}~$h%f"`,
    `}`,
    `# Suggested: RPROMPT='%F{179}$(__alter_handle)%f \${RPROMPT}'`,
  ].join("\n");
}

export function renderBashrcBody({ palette }: SnippetCtx): string {
  return [
    `# Defines __alter_handle for your prompt. Add  \\$(__alter_handle)`,
    `# to PS1 to render. Quiet when logged out.`,
    `__alter_handle() {`,
    `  local h`,
    `  h=$(${SED_HANDLE_EXTRACT})`,
    `  [[ -n "$h" ]] && printf '\\[\\e[38;5;179m\\]~%s\\[\\e[0m\\]' "$h"`,
    `}`,
    `# Suggested: PS1='\\[\\e[38;5;179m\\]$(__alter_handle)\\[\\e[0m\\] '"\\$PS1"`,
  ].join("\n");
}

export function renderFishBody({ palette }: SnippetCtx): string {
  // fish auto-sources ~/.config/fish/conf.d/*.fish - full file, not a
  // marker block. The whole file is the cosmetic.
  return [
    `# Auto-sourced by fish. Defines __alter_handle for fish_prompt.`,
    `function __alter_handle`,
    `  set -l h (${SED_HANDLE_EXTRACT})`,
    `  if test -n "$h"`,
    `    set_color -o brmagenta`,
    `    echo -n "~$h"`,
    `    set_color normal`,
    `  end`,
    `end`,
    `# Drop  (__alter_handle)  into your fish_prompt to render.`,
  ].join("\n");
}

export function renderFastfetchBody(_: SnippetCtx): string {
  // Fastfetch config is JSONC - comment-style is //. We surface the
  // exact module the user can paste into their config.jsonc "modules".
  //
  // Format matches the rest of the suite: `~handle / Lx`, sourced from
  // the same identity cache pfetch and the CC statusline read.
  return [
    `// Add this object to the "modules" array in your fastfetch config.`,
    `// Reads ~handle and engagement level from ~/.cache/alter/identity.json`,
    `// (written by 'alter login'); emits "~handle / Lx" or "~handle" if no level.`,
    `// {`,
    `//   "type": "command",`,
    `//   "key": "alter",`,
    `//   "text": "bash ${ALTER_HELPER_SCRIPT_PATH}"`,
    `// }`,
  ].join("\n");
}

/**
 * Content of the standalone helper script at ALTER_HELPER_SCRIPT_PATH.
 * Used by fastfetch and neofetch to print the one-line identity row
 * ("~handle / Lx") without depending on jq or the alter binary.
 *
 * Format invariant across every cosmetic surface:
 *   with level:    `~handle / Lx`
 *   without level: `~handle`
 */
export function renderIdentityRowScript(): string {
  return [
    `#!/usr/bin/env bash`,
    `# Emits one line: "~handle / Lx" (or "~handle" with no level).`,
    `# Source: ~/.cache/alter/identity.json (written by 'alter login').`,
    `# Silent when the cache is missing - consumers render nothing.`,
    `set -eu`,
    `f="$HOME/.cache/alter/identity.json"`,
    `[ -r "$f" ] || exit 0`,
    `if command -v jq >/dev/null 2>&1; then`,
    `  h=$(jq -r '.handle // empty' "$f" 2>/dev/null)`,
    `  l=$(jq -r '.level // empty'  "$f" 2>/dev/null)`,
    `else`,
    `  h=$(sed -n 's/.*"handle"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$f" 2>/dev/null)`,
    `  l=$(sed -n 's/.*"level"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p'  "$f" 2>/dev/null)`,
    `fi`,
    `[ -n "$h" ] || exit 0`,
    `if [ -n "$l" ]; then`,
    `  printf '~%s / L%s\\n' "$h" "$l"`,
    `else`,
    `  printf '~%s\\n' "$h"`,
    `fi`,
  ].join("\n");
}

/**
 * Path of the shared helper script, written once on first inscription
 * of a surface that uses it (fastfetch, neofetch).
 */
export const ALTER_HELPER_SCRIPT_PATH =
  "$HOME/.config/alter/identity-row.sh";

/**
 * Path of the pfetch extras script - ALTER-owned, so we never write
 * into pfetch's own ~/.config/pfetch/ directory (that would conflict
 * with any extras the user already curates).
 */
export const PFETCH_EXTRAS_PATH = "$HOME/.config/alter/pfetch-extras.sh";

/**
 * Content of the pfetch extras script. Mirrors the pattern pfetch
 * expects (a get_<name> function that calls pfetch's own log() on
 * file descriptor 6) and reads identity from ~/.cache/alter/identity.json.
 *
 * Invoked by pfetch when PF_SOURCE points at this file and PF_INFO
 * includes "alter" - both set by the shellrc wrapper.
 */
export function renderPfetchExtrasScript(): string {
  return [
    `# pfetch extras - sourced via PF_SOURCE by the ~Alter shellrc wrapper.`,
    `#`,
    `# Adds 'alter' as a first-class info row (alongside os/host/kernel/etc.)`,
    `# rendered by pfetch's own log() function so alignment + colour match`,
    `# the built-in rows exactly. Emits: alter     ~<handle> / L<level>`,
    `# Silent when ~/.cache/alter/identity.json is missing.`,
    `get_alter() {`,
    `    _f="$HOME/.cache/alter/identity.json"`,
    `    [ -r "$_f" ] || return`,
    `    if command -v jq >/dev/null 2>&1; then`,
    `        _h=$(jq -r '.handle // empty' "$_f" 2>/dev/null)`,
    `        _l=$(jq -r '.level // empty'  "$_f" 2>/dev/null)`,
    `    else`,
    `        _h=$(sed -n 's/.*"handle"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$_f" 2>/dev/null)`,
    `        _l=$(sed -n 's/.*"level"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p'  "$_f" 2>/dev/null)`,
    `    fi`,
    `    [ -n "$_h" ] || return`,
    `    if [ -n "$_l" ]; then`,
    `        log alter "~$_h / L$_l" >&6`,
    `    else`,
    `        log alter "~$_h" >&6`,
    `    fi`,
    `    unset _f _h _l`,
    `}`,
  ].join("\n");
}

/**
 * Shellrc-side body for the pfetch wrapper. Defines a pfetch() shell
 * function that sets PF_SOURCE + augments PF_INFO, then invokes the
 * real pfetch via `command pfetch` (bash/zsh) or `command pfetch`
 * (fish uses a different syntax - see renderPfetchFishBody).
 *
 * Net effect: the user keeps typing `pfetch` and gets the ALTER row
 * automatically, without polluting the global environment.
 */
export function renderPfetchShellrcBody(shell: "bash" | "zsh"): string {
  void shell;
  return [
    `# Wraps pfetch so 'alter' renders as a native info row. No env vars`,
    `# leak to other processes; the wrapper scopes them to each invocation.`,
    `pfetch() {`,
    `  local _src="${PFETCH_EXTRAS_PATH}"`,
    `  local _info="\${PF_INFO:-ascii title os host kernel uptime pkgs memory}"`,
    `  case " $_info " in`,
    `    *" alter "*) ;;`,
    `    *) _info="$_info alter" ;;`,
    `  esac`,
    `  PF_SOURCE="$_src" PF_INFO="$_info" command pfetch "$@"`,
    `}`,
  ].join("\n");
}

export function renderPfetchFishBody(): string {
  return [
    `# Wraps pfetch so 'alter' renders as a native info row. No env vars`,
    `# leak to other processes; the wrapper scopes them to each invocation.`,
    `function pfetch`,
    `  set -l _src (set -q XDG_CONFIG_HOME; and echo $XDG_CONFIG_HOME; or echo $HOME/.config)/alter/pfetch-extras.sh`,
    `  set -l _info (set -q PF_INFO; and echo $PF_INFO; or echo "ascii title os host kernel uptime pkgs memory")`,
    `  if not string match -q "* alter *" " $_info "`,
    `    set _info "$_info alter"`,
    `  end`,
    `  env PF_SOURCE=$_src PF_INFO=$_info command pfetch $argv`,
    `end`,
  ].join("\n");
}

export function renderNeofetchBody(_: SnippetCtx): string {
  // neofetch's config.conf hosts print_info() as a bash function; we
  // can't reliably inject inside a function body, so we follow the
  // fastfetch pattern: emit a one-line snippet the user pastes into
  // their own print_info(). The helper script we write alongside
  // handles the handle-to-identity-row rendering.
  return [
    `# Add this line to your print_info() function in ~/.config/neofetch/config.conf`,
    `# (paste below  info title  or wherever you want the ~Alter row to appear):`,
    `#`,
    `#   info "alter" "$(bash ${ALTER_HELPER_SCRIPT_PATH})"`,
    `#`,
    `# The helper script at ${ALTER_HELPER_SCRIPT_PATH} was written by`,
    `# 'alter wire' and prints "~handle / Lx" when you're logged in.`,
  ].join("\n");
}

/**
 * Render the CC statusline shim. Unlike the others this writes a
 * dedicated script file (~/.claude/alter-statusline.sh) and registers
 * it via .claude/settings.json's statusLine.command. The 'body' here
 * is the JSON merge instruction the inscribe layer applies.
 *
 * Standard behaviour:
 *   - Logged in: muted-gold "~handle / Lx" with the slash + level dim.
 *   - Expired: whole "~handle / Lx" in red. No parenthetical hint -
 *     the colour is the signal. User runs `alter login` knowing why.
 *   - Logged out (no session.json): nothing emitted (silent).
 *
 * Note: the statusLine.command merge into settings.json is handled by
 * the inscribe layer (JSON, not text); this returns the shell script
 * content to write to the dedicated file.
 */
export function renderCcStatuslineScript(): string {
  // Engagement level via base64url-decoded id_token, falls back to
  // consent_tier from session.json. All-bash, no jq dependency on the
  // hot path (jq used only in the JWT decode branch and tolerated to
  // fail silently - the shim must never crash).
  return [
    `#!/usr/bin/env bash`,
    `# ~Alter statusline shim - emits ~handle [Lx] for Claude Code's statusLine.`,
    `# Generated by alter wire. Reverse with: alter unwire.`,
    `# Behaviour: gold when logged in, red when expired, silent when no session.`,
    `cat >/dev/null  # consume Claude Code's JSON, we don't use it`,
    `S="\${XDG_CONFIG_HOME:-$HOME/.config}/alter/session.json"`,
    `[ -r "$S" ] || exit 0`,
    `_handle=$(sed -n 's/.*"handle"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$S" 2>/dev/null)`,
    `[ -z "$_handle" ] && exit 0`,
    `# Stored handle already includes the leading '~' (e.g. "~yourname").`,
    `_exp=$(sed -n 's/.*"jwt_expires_at"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$S" 2>/dev/null)`,
    `_lvl=""`,
    `if command -v jq >/dev/null 2>&1; then`,
    `  _id=$(jq -r '.id_token // ""' "$S" 2>/dev/null)`,
    `  if [ -n "$_id" ]; then`,
    `    _p=$(echo "$_id" | cut -d. -f2)`,
    `    while [ $((\${#_p} % 4)) -ne 0 ]; do _p="\${_p}="; done`,
    `    _d=$(echo "$_p" | tr '_-' '/+' | base64 -d 2>/dev/null)`,
    `    if [ -n "$_d" ]; then`,
    `      _n=$(echo "$_d" | jq -r '.["https://truealter.com/claims/engagement_level"] // empty' 2>/dev/null)`,
    `      [ -n "$_n" ] && _lvl="L\${_n}"`,
    `    fi`,
    `  fi`,
    `  [ -z "$_lvl" ] && _lvl=$(jq -r '.consent_tier // ""' "$S" 2>/dev/null)`,
    `fi`,
    `_exp_ts=$(date -d "$_exp" +%s 2>/dev/null || echo 0)`,
    `if [ "$(date +%s)" -ge "$_exp_ts" ]; then`,
    `  # Expired - whole identity goes red. No decoration.`,
    `  printf '\\033[91m%s' "$_handle"`,
    `  [ -n "$_lvl" ] && printf ' / %s' "$_lvl"`,
    `  printf '\\033[0m\\n'`,
    `else`,
    `  # Healthy - muted gold handle + slash + dim level.`,
    `  printf '\\033[38;5;179m%s\\033[0m' "$_handle"`,
    `  [ -n "$_lvl" ] && printf ' \\033[90m/ %s\\033[0m' "$_lvl"`,
    `  printf '\\n'`,
    `fi`,
  ].join("\n");
}

// ----------------------------------------------------------------------------
// Full statusline preset - the rich, multi-segment statusline bundled as a
// shipped asset (assets/statusline/statusline.sh) + its default wardrobe
// config (assets/statusline/wardrobe.default.json). Unlike the minimal shim
// above (generated inline), the full preset is a hand-maintained snapshot we
// read off disk and write verbatim. It degrades gracefully on machines
// without ALTER's local substrates: ALTER-only segments hide when their
// data is absent, and the session-label descriptor falls back from a
// local-model summary to a cleaned prompt-head (written by the bundled
// broadcast hook, no model required) to hidden.
// ----------------------------------------------------------------------------

/** Resolve the bundled statusline asset dir (dist/assets/statusline)
 *  relative to this module (dist/lib/cosmetics/snippets.js → ../../assets). */
function statuslineAssetDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "assets", "statusline");
}

/** Read the bundled rich statusline script. Throws (caught by the inscribe
 *  layer) if the build did not copy the asset into dist. */
export function renderCcStatuslineFullScript(): string {
  const p = path.join(statuslineAssetDir(), "statusline.sh");
  return fs.readFileSync(p, "utf-8").replace(/\n$/, "");
}

/** Read the bundled default wardrobe config (segment order/visibility).
 *  Returned verbatim so the on-disk artefact and the shipped default stay
 *  byte-identical (a build check pins this). */
export function readDefaultStatuslineWardrobe(): string {
  const p = path.join(statuslineAssetDir(), "wardrobe.default.json");
  return fs.readFileSync(p, "utf-8");
}

// ----------------------------------------------------------------------------
// Wardrobe-palette include surfaces (kitty / alacritty / polybar)
//
// Each surface gets a one-line include directive pointing at the
// canonical wardrobe-generated palette file under
// ~/.config/alter/surfaces/. The wardrobe (~/.config/alter/surfaces/
// apply.sh) regenerates those files from ~/.config/alter/palette.json,
// so the surface inherits the IaI colour grammar - sovereign, coupling,
// collective - on next reload. The bodies are intentionally minimal:
// one line, fully reversible, idempotent across re-inscriptions.
// ----------------------------------------------------------------------------

export const KITTY_INCLUDE_PATH = "~/.config/alter/surfaces/kitty-palette.conf";
export const ALACRITTY_INCLUDE_PATH = "~/.config/alter/surfaces/alacritty-palette.toml";
export const POLYBAR_INCLUDE_PATH = "~/.config/alter/surfaces/polybar-palette.ini";

export function renderKittyBody(_ctx: SnippetCtx): string {
  return `include ${KITTY_INCLUDE_PATH}`;
}

export function renderAlacrittyBody(_ctx: SnippetCtx): string {
  return [
    `[general]`,
    `import = ["${ALACRITTY_INCLUDE_PATH}"]`,
  ].join("\n");
}

export function renderPolybarBody(_ctx: SnippetCtx): string {
  return `include-file = ${POLYBAR_INCLUDE_PATH}`;
}

// ----------------------------------------------------------------------------
// Dispatch
// ----------------------------------------------------------------------------

export function renderBody(id: SurfaceId, ctx: SnippetCtx): string {
  switch (id) {
    case "starship":
      return renderStarshipBody(ctx);
    case "tmux":
      return renderTmuxBody(ctx);
    case "shellrc": {
      // Pick by file extension / target.
      // The detect layer pre-chose the shell; it'd be cleaner to pass
      // through, but we infer here to keep the contract narrow.
      // Default to zsh-shape; bash/fish are similar enough that the
      // body is meant for documentation, not auto-execute.
      return renderZshrcBody(ctx);
    }
    case "fastfetch":
      return renderFastfetchBody(ctx);
    case "pfetch":
      // Preview shape only - the real inscription writes two files
      // (extras script + shellrc wrapper). Shell is inferred by the
      // inscribe layer from the detected target path.
      return renderPfetchShellrcBody("zsh");
    case "neofetch":
      return renderNeofetchBody(ctx);
    case "cc-statusline":
      // Special-case: the JSON merge happens in inscribe; this text is
      // a placeholder used only for the dry-run preview.
      return [
        `// Will write ~/.claude/alter-statusline.sh and register it as`,
        `// statusLine.command in ~/.claude/settings.json.`,
      ].join("\n");
    case "kitty":
      return renderKittyBody(ctx);
    case "alacritty":
      return renderAlacrittyBody(ctx);
    case "polybar":
      return renderPolybarBody(ctx);
  }
}

export function commentChar(id: SurfaceId): "#" | "//" | "--" | ";" {
  switch (id) {
    case "starship":
    case "tmux":
    case "shellrc":
    case "pfetch":
    case "neofetch":
    case "kitty":
    case "alacritty":
      return "#";
    case "fastfetch":
      return "//";
    case "polybar":
      return ";";
    case "cc-statusline":
      // Not used - CC inscription writes a separate file.
      return "#";
  }
}

/**
 * Marker tag for a surface - used to namespace multiple ALTER blocks
 * within the same file (e.g. shellrc hosts both the prompt-helper
 * block and the pfetch-wrapper block). The default "cosmetics" tag
 * matches pre-tagging inscriptions so `findExistingBlock` still
 * locates older blocks on re-inscribe/unwire.
 */
export function markerTag(id: SurfaceId): string {
  switch (id) {
    case "pfetch":
      return "pfetch";
    case "neofetch":
      return "neofetch";
    default:
      return "cosmetics";
  }
}

export const __testing = { SED_HANDLE_EXTRACT, escapeRe };
