/**
 * alter TUI -- full-screen panel with BIOS-style tree navigation.
 *
 * Runs inside the terminal's alternate screen buffer so the session feels
 * like a contained client, not a shell spew. One branded frame; the menu
 * lives inside it; action output returns to the same frame afterwards.
 *
 * Keyboard model (locked 2026-04-27; quit-confirm dropped 2026-06-05 -
 * closing must be as fast as opening):
 *   Up / Down     move selection
 *   Right         enter submenu / activate leaf
 *   Left          up one level (in a submenu) / no-op (at root)
 *   q | Esc       quit ALTER immediately - no confirm step; the menu is
 *                 a read surface, there is nothing mid-flight to lose
 *   Enter         same as Right
 *   Ctrl+C        hard-exit safety net (never required - q/Esc is the
 *                 canonical path)
 *
 * Colours drawn from the ALTER brand palette:
 *   border / muted     A89060, 544E48
 *   title / accent     F9BE4A, E0B84C, E09D2F
 *   text               F5F0E8, FAF5EF
 */

import {
  createInputSession,
  releaseKeyboardTransport,
  type DecodedKey,
  type InputSession,
} from "./rawKeys.js";
import chalk, { type ChalkInstance } from "chalk";
import stripAnsi from "strip-ansi";
import { aboutStatRows } from "../commands/about.js";
import type { Palette } from "../theme/palette.js";

/**
 * Truecolor guard for gold roles.
 *
 * chalk.level < 3 means the terminal is not 24-bit; chalk.hex() will
 * downgrade the gold hexes to the nearest ANSI colour, which on most
 * terminals maps to ANSI yellow (code 33) - a dark, barely-legible
 * mustard. This affects Windows Terminal on older builds, VS Code
 * integrated terminal with no COLORTERM env var, and any terminal that
 * reports TERM=xterm without COLORTERM=truecolor.
 *
 * When truecolor is unavailable we use chalk.yellowBright (ANSI code 93),
 * which is the bright-yellow 16-colour slot - legible on every terminal
 * that supports chalk at all. The muted gold roles (accent/titleDim) get
 * chalk.yellow (code 33) rather than yellowBright so the brightness
 * hierarchy is preserved even in ANSI-16 mode.
 *
 * Cross-platform: chalk.level is set by the chalk/supports-color package
 * from COLORTERM, TERM, FORCE_COLOR, and Windows ConEmu/WT detection -
 * no GNU binaries, no shell calls, works identically on Linux/macOS/Windows.
 */
function goldBright(): ChalkInstance {
  return chalk.level >= 3 ? chalk.hex("#F9BE4A") : chalk.yellowBright;
}
function goldMid(): ChalkInstance {
  return chalk.level >= 3 ? chalk.hex("#E0B84C") : chalk.yellow;
}
function goldDeep(): ChalkInstance {
  return chalk.level >= 3 ? chalk.hex("#E09D2F") : chalk.yellow;
}

export const brand = {
  border: chalk.hex("#A89060"),
  borderDim: chalk.hex("#544E48"),
  title: goldBright().bold,
  titleDim: goldMid(),
  handle: goldBright().bold,
  accent: goldMid(),
  accentDeep: goldDeep(),
  text: chalk.hex("#F5F0E8"),
  cream: chalk.hex("#FAF5EF"),
  muted: chalk.hex("#A89060"),
  dim: chalk.hex("#8A847E"),
  faint: chalk.hex("#544E48"),
  marker: goldBright(),
};

/**
 * Re-tint every brand slot from a palette, in place. Every renderer
 * reads `brand.*` at paint time, so the next redraw - menu frame,
 * picker, footer - wears the new register immediately. The signature
 * palette's values reproduce the literals above exactly, so applying
 * it is a visual no-op.
 *
 * Used at menu boot (apply the saved config palette - the "reopen
 * ~alter to see the room wear it" promise, previously unkept) and by
 * the Customise > Palette live preview (re-tint as the cursor moves).
 *
 * When truecolor is unavailable, hex() calls for gold roles degrade to
 * dark ANSI yellow; callers that need legibility in ANSI-16 mode should
 * call goldBright()/goldMid() from this module instead of chalk.hex().
 * setBrandPalette is used at runtime after terminal caps are known, so
 * chalk.level is already settled - chalk.hex() degrades correctly here.
 */
export function setBrandPalette(p: Palette): void {
  brand.border = chalk.hex(p.border);
  brand.borderDim = chalk.hex(p.borderDim);
  brand.title = chalk.hex(p.title).bold;
  brand.titleDim = chalk.hex(p.titleDim);
  brand.handle = chalk.hex(p.title).bold;
  brand.accent = chalk.hex(p.accent);
  brand.accentDeep = chalk.hex(p.accentDeep);
  brand.text = chalk.hex(p.text);
  brand.cream = chalk.hex(p.cream);
  brand.muted = chalk.hex(p.muted);
  brand.dim = chalk.hex(p.dim);
  brand.faint = chalk.hex(p.faint);
  brand.marker = chalk.hex(p.marker);
}

export interface MenuNode {
  value: string;
  label: string;
  hint?: string;
  children?: MenuNode[];
}

interface Frame {
  items: MenuNode[];
  index: number;
  title: string;
}

export interface BiosMenuOptions {
  /**
   * Header lines rendered above the divider. Pass an array when the
   * header is multi-line (e.g. handle + opener) - each entry becomes
   * its own body row so the frame's left/right borders stay intact.
   * Passing a string with embedded `\n` corrupts the cursor: the
   * second visual line lands at column 0 instead of inside the frame.
   */
  header?: string | string[];
  lastSelected?: string;
}

/**
 * A row is selectable when it is a real menu node, not a decorative
 * separator. The footer rule (`{ value: "__rule__" }`) is the only
 * non-selectable row today; the predicate future-proofs any other.
 */
function isSelectable(node: MenuNode): boolean {
  return node.value !== "__rule__";
}

/**
 * Walk from `from` in `dir` (+1 down / -1 up), wrapping at the ends and
 * skipping any row where `selectable(i)` is false. Returns `from`
 * unchanged if nothing else is selectable. Keeps arrow-navigation from
 * ever resting on a divider line.
 */
function nextSelectableIndex(
  len: number,
  from: number,
  dir: 1 | -1,
  selectable: (i: number) => boolean,
): number {
  if (len === 0) return from;
  let i = (((from + dir) % len) + len) % len;
  for (let guard = 0; guard < len; guard++) {
    if (selectable(i)) return i;
    i = (((i + dir) % len) + len) % len;
  }
  return from;
}

// Whether the terminal's alternate screen buffer is physically active.
let altActive = false;
// Nesting depth. The menu enters once at launch; every interactive leaf it
// dispatches (room, messenger, verify, thread) also calls enterAlt/exitAlt
// for its standalone path. Refcounting makes those nested calls no-ops while
// the menu holds the screen, so a leaf launched from the menu never tears the
// shared alt-screen down (the "never drop to the raw terminal mid-session"
// guarantee). Standalone (depth 0 → 1 → 0) is unchanged.
let altDepth = 0;

function physicalEnterAlt(): void {
  if (altActive) return;
  process.stdout.write("\x1b[?1049h");
  process.stdout.write("\x1b[?25l");
  process.stdout.write("\x1b[2J\x1b[H");
  altActive = true;
}

function physicalExitAlt(): void {
  if (!altActive) return;
  process.stdout.write("\x1b[?25h");
  process.stdout.write("\x1b[?1049l");
  altActive = false;
}

export function enterAlt(): void {
  altDepth++;
  physicalEnterAlt();
}

export function exitAlt(): void {
  if (altDepth > 0) altDepth--;
  // Still nested inside an outer owner (e.g. the menu): keep the screen up.
  if (altDepth > 0) return;
  physicalExitAlt();
}

/**
 * Tear the alt-screen down unconditionally and reset the nesting depth.
 * For terminal-exit paths only (process exit, SIGINT/SIGTERM, the Ctrl-C
 * trap in pressEnterToReturn): on a hard exit the terminal must be restored
 * to the normal buffer regardless of how deeply leaves were nested.
 */
export function forceExitAlt(): void {
  altDepth = 0;
  physicalExitAlt();
  // Hard-exit chokepoint: tear down the held keyboard transport too, so the
  // shell is never handed a TTY still in raw mode (and the grace-window
  // release timer can't fire after the process is gone).
  releaseKeyboardTransport();
}

/**
 * Temporarily drop to the normal buffer for a full-terminal handoff (an
 * external `$EDITOR`), WITHOUT disturbing the nesting depth. Returns whether
 * the alt-screen was active so {@link resumeAlt} can restore exactly that
 * state. Use suspend/resume - never enter/exit - around a child process that
 * needs the real terminal, so the surrounding menu/leaf nesting survives.
 */
export function suspendAlt(): boolean {
  const was = altActive;
  physicalExitAlt();
  return was;
}

export function resumeAlt(was: boolean): void {
  if (was) physicalEnterAlt();
}

/** Restore raw-mode to off on any exit path so the terminal is usable. */
function restoreTty(): void {
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false);
    } catch {
      // setRawMode can throw if stdin was already destroyed (e.g. piped).
    }
  }
  process.stdout.write("\x1b[?25h");
}

process.on("exit", forceExitAlt);
process.on("SIGINT", () => {
  forceExitAlt();
  restoreTty();
  // Soft exit: set conventional SIGINT exit code (128+2) and let the event
  // loop drain rather than calling process.exit() which races libuv on Windows.
  process.exitCode = 130;
});
process.on("SIGTERM", () => {
  forceExitAlt();
  restoreTty();
  // Soft exit: set conventional SIGTERM exit code (128+15).
  process.exitCode = 143;
});

const MIN_COLS = 60;
export const MAX_COLS = 88;
const MIN_ROWS = 16;
const MAX_ROWS = 28;

/**
 * Terminal geometry for the framed panel.
 *
 * `cols` clamps to [MIN_COLS, MAX_COLS] for visual balance; the hard
 * MIN_COLS floor only applies when the real terminal is wide enough to
 * carry it. Narrower terminals collapse to the real column count so
 * lines stop overflowing the right edge (the symptom that made the
 * "Enter the room" row lose its styling when the old clamp forced a
 * 60-col draw into a 40-col terminal).
 */
export function termSize(): { cols: number; rows: number } {
  const realCols = process.stdout.columns || 80;
  const realRows = process.stdout.rows || 24;
  return {
    cols: Math.min(MAX_COLS, realCols < MIN_COLS ? realCols : Math.max(MIN_COLS, realCols)),
    rows: Math.min(MAX_ROWS, realRows < MIN_ROWS ? realRows : Math.max(MIN_ROWS, realRows)),
  };
}

function visualLen(s: string): number {
  return stripAnsi(s).length;
}

function padRight(s: string, width: number): string {
  const v = visualLen(s);
  if (v >= width) return s;
  return s + " ".repeat(width - v);
}

/**
 * ANSI-aware horizontal slice - keeps chalk escape sequences intact
 * while cutting the row down to `width` visible columns. Previously
 * `truncate` called `stripAnsi` whenever a row exceeded width, which
 * rendered every styled segment in that row as monochrome terminal
 * default (the root cause of "Enter the room" rendering in the wrong
 * colour on narrow terminals).
 */
function truncate(s: string, width: number): string {
  if (visualLen(s) <= width) return s;
  const budget = Math.max(0, width - 1);
  if (budget === 0) return "…";
  // Split on ANSI CSI sequences; pass them through verbatim, count only
  // the printable runs against the width budget.
  // eslint-disable-next-line no-control-regex
  const parts = s.split(/(\x1b\[[0-9;]*m)/);
  let out = "";
  let used = 0;
  for (const part of parts) {
    if (part.startsWith("\x1b[")) {
      // Control sequence - always emit; it has no visual width.
      out += part;
      continue;
    }
    if (used >= budget) continue;
    const remaining = budget - used;
    if (part.length <= remaining) {
      out += part;
      used += part.length;
    } else {
      out += part.slice(0, remaining);
      used = budget;
    }
  }
  // Reset any lingering SGR state before the ellipsis so the horizontal
  // ellipsis paints in the terminal default, not leaked selection colour.
  return out + "\x1b[0m" + "…";
}

export interface FrameSpec {
  title?: string;
  body: string[];
  footer?: string;
  /**
   * On-focus hint reserved row (full inner width). When defined - even
   * as an empty string - drawFrame renders a blank separator row, the
   * hint row, and a divider between body and footer. Body height stays
   * stable across focus moves because the hint row is always reserved,
   * never reflowed. Omit (`undefined`) for views that don't carry a
   * focus hint (e.g. the room TUI).
   */
  hint?: string;
}

/**
 * Draw a branded panel at the top-left of the alt screen.
 *
 * Frame hugs content vertically - body capacity = `max(MIN_ROWS - chrome,
 * body.length)` rather than the full terminal height. A short menu gets a
 * short frame, not a full-screen void below the items. The MIN_ROWS floor
 * keeps the frame from collapsing to nothing on tiny menus, which would
 * read as a glitch rather than a deliberate compact rendering.
 *
 * Erase-below (`\x1b[J`) at the end keeps the alt-screen tidy when a
 * previous render's frame was taller than the current one - without it
 * the trailing rows of the prior frame leak through.
 */
export function drawFrame(spec: FrameSpec): void {
  const { cols, rows: maxRows } = termSize();
  const w = cols;
  const inner = w - 6;
  const hasHint = spec.hint !== undefined;
  const hasFooter = spec.footer !== undefined;

  process.stdout.write("\x1b[H");

  // --- Layout ------------------------------------------------------------
  // chrome = top border + (blank + hint + divider) + (divider + footer) + bottom
  const hintRows = hasHint ? 3 : 0;
  const footerRows = hasFooter ? 2 : 0;
  const chrome = 2 + hintRows + footerRows;
  const minBody = Math.max(0, MIN_ROWS - chrome);
  const maxBody = Math.max(minBody, maxRows - chrome);
  const bodyCapacity = Math.min(
    maxBody,
    Math.max(minBody, spec.body.length),
  );
  const lines = spec.body.slice(0, bodyCapacity);
  while (lines.length < bodyCapacity) lines.push("");

  // --- Top border with centered title ------------------------------------
  const titleStr = spec.title ? ` ${spec.title} ` : "";
  const titleVis = visualLen(titleStr);
  const remaining = Math.max(0, w - 2 - titleVis);
  const leftLen = Math.floor(remaining / 2);
  const rightLen = remaining - leftLen;
  const top =
    brand.border("╭") +
    brand.border("─".repeat(leftLen)) +
    brand.title(titleStr) +
    brand.border("─".repeat(rightLen)) +
    brand.border("╮");
  process.stdout.write(top + "\x1b[K\n");

  // --- Body --------------------------------------------------------------
  for (const line of lines) {
    const fitted = padRight(truncate(line, inner), inner);
    const row = brand.border("│") + "  " + fitted + "  " + brand.border("│");
    process.stdout.write(row + "\x1b[K\n");
  }

  // --- On-focus hint reserved row ---------------------------------------
  if (hasHint) {
    // Blank separator row - keeps the hint visually distinct from the
    // last body row while the body is still tightly hugged.
    const blank = brand.border("│") + " ".repeat(w - 2) + brand.border("│");
    process.stdout.write(blank + "\x1b[K\n");
    const hintText = brand.muted(spec.hint ?? "");
    const hintFitted = padRight(truncate(hintText, inner), inner);
    const hintRow =
      brand.border("│") + "  " + hintFitted + "  " + brand.border("│");
    process.stdout.write(hintRow + "\x1b[K\n");
    const hintDivider =
      brand.border("├") + brand.borderDim("─".repeat(w - 2)) + brand.border("┤");
    process.stdout.write(hintDivider + "\x1b[K\n");
  }

  // --- Footer ------------------------------------------------------------
  if (hasFooter) {
    if (!hasHint) {
      const divider =
        brand.border("├") + brand.borderDim("─".repeat(w - 2)) + brand.border("┤");
      process.stdout.write(divider + "\x1b[K\n");
    }
    const fooFitted = padRight(truncate(spec.footer!, inner), inner);
    const fooRow =
      brand.border("│") + "  " + fooFitted + "  " + brand.border("│");
    process.stdout.write(fooRow + "\x1b[K\n");
  }

  // --- Bottom border + clear below --------------------------------------
  const bottom = brand.border("╰" + "─".repeat(w - 2) + "╯");
  // `\x1b[J` after the bottom border erases anything below - necessary
  // when a prior render left a taller frame, so the trailing rows don't
  // ghost through under the new shorter frame.
  process.stdout.write(bottom + "\x1b[K\x1b[J");
}

/**
 * Render a header strip when an action is about to run inside the alt
 * screen. Keeps brand context visible instead of raw shell spew.
 */
export function drawActionHeader(crumb: string): void {
  const { cols } = termSize();
  process.stdout.write("\x1b[2J\x1b[H");
  const line = brand.titleDim("~alter") + brand.dim("  ›  ") + brand.accent(crumb);
  const rule = brand.borderDim("─".repeat(Math.max(20, cols - 4)));
  process.stdout.write("\n  " + line + "\n  " + rule + "\n\n");
}

/**
 * Wait between an action and the menu redraw. Enter, q, Esc, and ← all
 * resume the menu - between-action prompts are NOT a quit surface.
 * The locked q/Esc-quits-ALTER contract applies to the menu itself
 * and to pickers; here the user has just finished a leaf action and
 * wants to go back to the menu, so every "back-up-a-level" key (←) and
 * every "I'm done" key (q/Esc/Enter) does the same thing. Ctrl+C is
 * kept as a hard escape but is never required.
 */
/**
 * Discard any keystrokes buffered while a leaf had the event loop blocked
 * (sync child-process probes, long renders). Without this, keys pressed
 * during the blocked stretch sit in the kernel/stream buffer and fire the
 * NEXT keypress listener the instant it attaches - which double-fired
 * pressEnterToReturn straight through the report the user wanted to read.
 * Flowing the stream for one short turn with a discard listener (no
 * keypress listener attached yet) drains the backlog harmlessly.
 */
async function drainBufferedKeys(): Promise<void> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return;
  try {
    // A short-lived input session with a no-op handler flows and discards
    // the backlog through the same lifecycle every surface uses (rawMode →
    // attach → resume → dispose), rather than a hand-rolled toggle.
    const session = createInputSession(stdin, () => {});
    await new Promise((resolve) => setTimeout(resolve, 25));
    session.dispose();
  } catch {
    // Best-effort: a drain failure must never block returning to the menu.
  }
}

export async function pressEnterToReturn(): Promise<void> {
  await drainBufferedKeys();
  const { cols } = termSize();
  const rule =
    "  " + brand.borderDim("─".repeat(Math.min(40, cols - 4)));
  const baseHint =
    "\n" +
    rule +
    "\n\n  " +
    brand.muted("↵ / ← / q / esc ") +
    brand.dim("back to menu");

  process.stdout.write(baseHint);

  // Read raw bytes directly instead of readline's keypress decoder. The
  // keypress translator desyncs on Windows/PowerShell after the leaf's
  // withLoadingCancel + drainBufferedKeys toggle setRawMode and pause/resume
  // several times, so `keypress` never fired again and every key was dead on
  // the "back to menu" line. Raw `data` is the same primitive drainBufferedKeys
  // uses reliably.
  await new Promise<void>((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      resolve();
      return;
    }
    let session: InputSession | null = null;
    const teardown = () => {
      session?.dispose();
    };
    const onKey = (key: DecodedKey) => {
      if (key.ctrl && key.name === "c") {
        // Ctrl-C: soft exit with SIGINT-convention code; drains cleanly on Windows.
        teardown();
        forceExitAlt();
        process.exitCode = 130;
        return;
      }
      // Any other key resumes the menu. q/Esc don't quit at this layer -
      // between-action prompts aren't a quit surface; the top-level menu is.
      teardown();
      resolve();
    };
    session = createInputSession(stdin, onKey);
  });
}

/**
 * Scrollable read-only viewer for a block of pre-rendered text, drawn inside
 * the persistent alt-screen with the branded frame. For long, static leaf
 * output (status, attribution log, earnings) that would otherwise scroll off
 * the top of a press-enter-to-return dump.
 *
 * Controls: ↑/↓ line, PgUp/PgDn page, Home/End jump to ends, q/Esc/←/Enter
 * back. Ctrl-C is the hard exit (soft SIGINT code, restores the terminal).
 * The footer drops the scroll controls when the whole report already fits.
 *
 * Pure presentation - it neither fetches nor mutates; the caller supplies the
 * lines. Non-TTY callers get a single plain print and an immediate return.
 */
export async function showReportPane(title: string, lines: string[]): Promise<void> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    process.stdout.write(lines.join("\n") + "\n");
    return;
  }
  // At least one row so the frame never renders an empty body.
  const content = lines.length > 0 ? lines : ["(no output)"];
  let offset = 0;

  // Chrome around the body = top border + bottom border + footer divider +
  // footer row = 4 rows. Recomputed each render so a resize is honoured.
  const layout = (): { pageRows: number; maxOffset: number } => {
    const { rows } = termSize();
    const pageRows = Math.max(1, rows - 4);
    const maxOffset = Math.max(0, content.length - pageRows);
    return { pageRows, maxOffset };
  };

  const render = (): void => {
    const { pageRows, maxOffset } = layout();
    if (offset > maxOffset) offset = maxOffset;
    if (offset < 0) offset = 0;
    const visible = content.slice(offset, offset + pageRows);
    const total = content.length;
    const fits = total <= pageRows;
    const last = Math.min(total, offset + pageRows);
    const pos = fits ? "" : `lines ${offset + 1}-${last} of ${total}   `;
    const controls = fits
      ? "q / esc / ← / ↵  back"
      : "↑↓ scroll · PgUp/PgDn page · q/esc/←/↵ back";
    drawFrame({ title, body: visible, footer: pos + controls });
  };

  await drainBufferedKeys();
  render();

  await new Promise<void>((resolve) => {
    let session: InputSession | null = null;
    const teardown = (): void => session?.dispose();
    const onKey = (key: DecodedKey): void => {
      if (key.ctrl && key.name === "c") {
        teardown();
        forceExitAlt();
        process.exitCode = 130;
        return;
      }
      const { pageRows, maxOffset } = layout();
      switch (key.name) {
        case "up":
          offset = Math.max(0, offset - 1);
          render();
          break;
        case "down":
          offset = Math.min(maxOffset, offset + 1);
          render();
          break;
        case "pageup":
          offset = Math.max(0, offset - pageRows);
          render();
          break;
        case "pagedown":
          offset = Math.min(maxOffset, offset + pageRows);
          render();
          break;
        case "home":
          offset = 0;
          render();
          break;
        case "end":
          offset = maxOffset;
          render();
          break;
        case "left":
        case "return":
        case "escape":
        case "q":
          teardown();
          resolve();
          break;
        default:
          break;
      }
    };
    session = createInputSession(stdin, onKey);
  });
}

/**
 * Scrollable, bordered pane that is ALSO an action surface. Same branded
 * frame and scroll loop as {@link showReportPane} (the posture renders inside
 * the persistent alt-screen frame, never the raw terminal), but Enter / → is
 * not "back": it resolves "act" so the caller can present an action picker
 * over the same alt-screen. q / Esc / ← resolve "back".
 *
 * Used by the Consent dashboard: the posture paints in this frame and scrolls
 * if it overflows the terminal height, matching the other read-out panes;
 * pressing Enter opens the inline action picker without dropping to the PTY.
 *
 * Pure presentation - the caller supplies the lines and owns the actions.
 * Non-TTY callers get a single plain print and an immediate "back".
 */
export async function showActionablePane(
  title: string,
  lines: string[],
): Promise<"act" | "back"> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    process.stdout.write(lines.join("\n") + "\n");
    return "back";
  }
  const content = lines.length > 0 ? lines : ["(no output)"];
  let offset = 0;

  const layout = (): { pageRows: number; maxOffset: number } => {
    const { rows } = termSize();
    const pageRows = Math.max(1, rows - 4);
    const maxOffset = Math.max(0, content.length - pageRows);
    return { pageRows, maxOffset };
  };

  const render = (): void => {
    const { pageRows, maxOffset } = layout();
    if (offset > maxOffset) offset = maxOffset;
    if (offset < 0) offset = 0;
    const visible = content.slice(offset, offset + pageRows);
    const total = content.length;
    const fits = total <= pageRows;
    const last = Math.min(total, offset + pageRows);
    const pos = fits ? "" : `lines ${offset + 1}-${last} of ${total}   `;
    const controls = fits
      ? "↵ act · q/esc/← back"
      : "↑↓ scroll · PgUp/PgDn page · ↵ act · q/esc/← back";
    drawFrame({ title, body: visible, footer: pos + controls });
  };

  await drainBufferedKeys();
  render();

  return await new Promise<"act" | "back">((resolve) => {
    let session: InputSession | null = null;
    const teardown = (): void => session?.dispose();
    const onKey = (key: DecodedKey): void => {
      if (key.ctrl && key.name === "c") {
        teardown();
        forceExitAlt();
        process.exitCode = 130;
        return;
      }
      const { pageRows, maxOffset } = layout();
      switch (key.name) {
        case "up":
          offset = Math.max(0, offset - 1);
          render();
          break;
        case "down":
          offset = Math.min(maxOffset, offset + 1);
          render();
          break;
        case "pageup":
          offset = Math.max(0, offset - pageRows);
          render();
          break;
        case "pagedown":
          offset = Math.min(maxOffset, offset + pageRows);
          render();
          break;
        case "home":
          offset = 0;
          render();
          break;
        case "end":
          offset = maxOffset;
          render();
          break;
        case "right":
        case "return":
          teardown();
          resolve("act");
          break;
        case "left":
        case "escape":
        case "q":
          teardown();
          resolve("back");
          break;
        default:
          break;
      }
    };
    session = createInputSession(stdin, onKey);
  });
}

/**
 * Resolve captured raw stdout into display lines: normalise CRLF, strip the
 * cursor-move / erase / mode CSI sequences a spinner emits (SGR colour is
 * kept), collapse each physical line to the text after its last carriage
 * return (a spinner's final frame), and trim trailing blank lines.
 */
function captureToLines(raw: string): string[] {
  if (raw === "") return [];
  const stripped = raw
    .replace(/\r\n/g, "\n")
    // Cursor moves (A-H), erase (J,K), scroll (S,T), column/position (f),
    // mode set/reset (h,l). SGR ("…m") is intentionally NOT matched.
    .replace(/\x1b\[[0-9;?]*[A-HJKSTfhl]/g, "");
  const out = stripped
    .split("\n")
    .map((seg) => (seg.includes("\r") ? seg.slice(seg.lastIndexOf("\r") + 1) : seg));
  while (out.length > 1 && out[out.length - 1].trim() === "") out.pop();
  return out;
}

/**
 * Run a pure-output leaf inside the scrollable {@link showReportPane}.
 * Captures everything the leaf writes to stdout (the bound `console.*`
 * methods write through the same stream object, so they are captured too),
 * normalises it, then hands the text to the pane. A throw from the leaf is
 * caught and appended to the captured output so the error is visible in the
 * pane rather than lost.
 *
 * A loading frame is painted BEFORE the leaf runs: a fetch-backed leaf
 * (status, earnings) draws its own live spinner, which the capture would
 * otherwise swallow - leaving the screen looking frozen for the whole fetch.
 * The frame changes the screen the instant the leaf is selected; the leaf's
 * own esc-to-cancel listener still runs underneath during the fetch.
 *
 * ONLY for leaves that print and never read stdin - an interactive leaf would
 * block on input the user cannot see. Interactive and normal-buffer leaves
 * keep their own flow.
 */
export async function runLeafInPane(
  title: string,
  fn: () => Promise<void> | void,
): Promise<void> {
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  // Immediate feedback before capture begins, so a slow fetch never reads as a
  // frozen menu. Only on a TTY - drawFrame emits escape codes.
  if (process.stdout.isTTY) {
    drawFrame({
      title,
      body: ["", "  " + brand.muted("Loading…")],
      footer: "esc to cancel",
    });
  }
  // Capture: collect the chunk, swallow the real write so nothing paints over
  // the alt-screen mid-run, and honour the optional callback so writers that
  // wait on the drain callback never stall.
  process.stdout.write = ((chunk: unknown, encoding?: unknown, cb?: unknown): boolean => {
    try {
      const enc = typeof encoding === "string" ? encoding : "utf8";
      chunks.push(
        typeof chunk === "string"
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString(enc as BufferEncoding)
            : String(chunk),
      );
    } catch {
      // Never let an undecodable chunk break the leaf.
    }
    const callback = typeof encoding === "function" ? encoding : cb;
    if (typeof callback === "function") (callback as () => void)();
    return true;
  }) as typeof process.stdout.write;

  try {
    await fn();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    chunks.push("\n" + brand.accentDeep("  ⚠  ") + brand.text(message) + "\n");
  } finally {
    process.stdout.write = origWrite as typeof process.stdout.write;
  }

  await showReportPane(title, captureToLines(chunks.join("")));
}

/**
 * BIOS-style interactive tree menu. Draws into the alt screen using the
 * branded frame. Returns the leaf value, or null on exit.
 *
 * Layout mode - chosen at each render based on terminal width:
 *
 *  TWO-PANE (cols >= 80 inner):
 *    Left pane  - top-level groups only, ~50% width.
 *    Right pane - children of the highlighted left-pane group, ~45% width,
 *                 rendered at faded brightness until right-pane focus shifts
 *                 them to full brightness.
 *    → / Enter on a group   : shifts keyboard focus to the right pane.
 *    → / Enter on a leaf    : activates the leaf.
 *    ← from right pane      : returns focus to the left pane.
 *    ← from left pane       : no-op (no parent level above root).
 *    ↑ / ↓                  : navigate within the focused pane.
 *
 *  SINGLE-COLUMN (cols < 80 inner):
 *    Falls back to the original inline-tree behaviour. The multi-expand
 *    bug is fixed by replacing the old `expanded: Set<string>` with a
 *    single `expandedSingle: string | null` - only one group can be open
 *    at a time; navigating to a sibling auto-collapses the previous.
 */
export async function biosMenu(
  rootItems: MenuNode[],
  opts: BiosMenuOptions = {}
): Promise<string | null> {
  const stdin = process.stdin;
  const stdout = process.stdout;

  // ── Two-pane state ──────────────────────────────────────────────────────
  // `leftIndex`  - which top-level item is highlighted.
  // `rightIndex` - which child in the right pane is highlighted.
  // `focusPane`  - which pane holds keyboard focus ("left" | "right").
  // These are used in two-pane mode; single-column mode uses its own
  // `flatIndex` + `expandedSingle` track below.
  const topItems = rootItems; // alias for clarity in two-pane paths

  let leftIndex = 0;
  if (opts.lastSelected) {
    // Try to find the top-level item that contains lastSelected.
    const topIdx = topItems.findIndex(
      (i) => i.value === opts.lastSelected || i.children?.some((c) => c.value === opts.lastSelected)
    );
    if (topIdx >= 0) leftIndex = topIdx;
  }
  // Never start the cursor on a decorative divider.
  if (topItems.length > 0 && !isSelectable(topItems[leftIndex])) {
    leftIndex = nextSelectableIndex(
      topItems.length,
      leftIndex,
      1,
      (i) => isSelectable(topItems[i]),
    );
  }
  let rightIndex = 0;
  let focusPane: "left" | "right" = "left";

  // ── Single-column state ─────────────────────────────────────────────────
  // Only one group can be open at a time (replaces the old `Set<string>`).
  let expandedSingle: string | null = null;

  type VisibleEntry = {
    item: MenuNode;
    depth: number;
    parent: MenuNode | null;
  };

  const flattenSingle = (): VisibleEntry[] => {
    const out: VisibleEntry[] = [];
    const walk = (items: MenuNode[], depth: number, parent: MenuNode | null) => {
      for (const item of items) {
        out.push({ item, depth, parent });
        if (item.children && item.children.length > 0 && expandedSingle === item.value) {
          walk(item.children, depth + 1, item);
        }
      }
    };
    walk(rootItems, 0, null);
    return out;
  };

  let visibleSingle = flattenSingle();
  let flatIndex = Math.min(
    Math.max(
      0,
      opts.lastSelected
        ? visibleSingle.findIndex((v) => v.item.value === opts.lastSelected)
        : leftIndex
    ),
    Math.max(0, visibleSingle.length - 1)
  );
  if (
    visibleSingle.length > 0 &&
    visibleSingle[flatIndex] &&
    !isSelectable(visibleSingle[flatIndex].item)
  ) {
    flatIndex = nextSelectableIndex(
      visibleSingle.length,
      flatIndex,
      1,
      (i) => isSelectable(visibleSingle[i].item),
    );
  }

  // Scroll offset for the single-column viewport - tracks the first
  // visible row index so the selected item always stays in view.
  let singleScrollOffset = 0;

  // Windows settle. The persistent keyboard transport (rawKeys.ts) is what
  // actually keeps the reader alive across a leaf handoff now, so the menu no
  // longer re-arms a fresh listener here. This drain stays as a cheap belt-and-
  // suspenders flush of any keys buffered while a leaf held the loop, so a
  // queued keystroke can't fire the instant the menu takes focus. Harmless
  // elsewhere.
  await drainBufferedKeys();

  return new Promise<string | null>((resolve) => {
    let session: InputSession | null = null;

    /** True when the terminal is wide enough for the two-pane layout. */
    const isTwoPane = (): boolean => {
      const { cols } = termSize();
      // Inner width = cols - 6 (two-char pad each side + two border cols).
      // Two-pane requires enough inner room for both columns plus separator.
      return cols >= 80;
    };

    // ────────────────────────────────────────────────────────────────────
    // Two-pane render helpers
    // ────────────────────────────────────────────────────────────────────

    /**
     * Return the left-pane group that is currently highlighted.
     * Skips `__rule__` decoration items and bare leaf footer items.
     */
    const highlightedTopItem = (): MenuNode | null => {
      const item = topItems[leftIndex] ?? null;
      return item;
    };

    /** Children of the currently highlighted top-level group, or []. */
    const rightPaneChildren = (): MenuNode[] => {
      const top = highlightedTopItem();
      return top?.children ?? [];
    };

    /**
     * Right-pane *preview* rows for a childless top-level leaf that carries
     * inline content rather than a submenu. Today only "About" opts in: its
     * version / install / runtime / config stats render in the right pane the
     * moment the leaf is focused (no activation needed), reusing the same
     * `aboutStatRows()` data the `alter about` command prints. Returns null
     * for every other leaf so the normal blank-right-pane path is unchanged.
     *
     * Styled to `colWidth`: a dim title, then `label  value` rows with the
     * label column aligned. Pure render - no side effects.
     */
    const rightPanePreview = (colWidth: number): string[] | null => {
      const top = highlightedTopItem();
      if (!top || top.value !== "about") return null;

      const rows = aboutStatRows();
      const labelWidth = Math.max(...rows.map(([k]) => k.length));
      const out: string[] = [brand.titleDim("About alter"), ""];
      for (const [k, v] of rows) {
        const line = brand.dim(k.padEnd(labelWidth)) + "  " + brand.text(v);
        out.push(truncate(line, colWidth));
      }
      return out;
    };

    /**
     * Clamp `rightIndex` to the valid range of the current right pane.
     * Called whenever `leftIndex` changes so the right cursor is always
     * within bounds.
     */
    const clampRightIndex = (): void => {
      const children = rightPaneChildren();
      rightIndex = Math.min(Math.max(0, rightIndex), Math.max(0, children.length - 1));
    };

    /**
     * Render the two-pane body rows.
     *
     * Inner layout:
     *   [left col, ~50%] [separator " │ "] [right col, remainder]
     *
     * Left col renders all rootItems (including rule/footer items).
     * Right col renders children of the highlighted top-level item;
     * when there are no children (leaf top-level) the right col is blank.
     */
    const renderTwoPaneBody = (): string[] => {
      const { cols } = termSize();
      // drawFrame reserves `cols - 6` for body content, but render()
      // prepends a two-space indent to every two-pane row (matching the
      // header and the single-column rows), so the row itself must fit
      // within `cols - 8`. Overrunning that tripped drawFrame's width
      // clamp, which lopped the trailing columns and painted a stray "…"
      // at the right edge of each two-pane row.
      const inner = Math.max(24, cols - 8);
      const sepWidth = 3; // " │ "
      const leftColWidth = Math.floor(inner * 0.50);
      const rightColWidth = inner - leftColWidth - sepWidth;

      const leftRows: string[] = [];
      topItems.forEach((item, i) => {
        const isHighlighted = i === leftIndex;
        const hasChildren = !!(item.children && item.children.length > 0);

        // Rule row - dimmed line, no marker. Pad to the full left-column
        // width so the centre separator and the right pane stay aligned
        // on this row; an unpadded rule sat two columns short, jogging
        // the "│" divider and the right-pane label left.
        if (item.value === "__rule__") {
          const rule = brand.borderDim("─".repeat(Math.max(4, leftColWidth - 2)));
          leftRows.push(padRight(rule, leftColWidth));
          return;
        }

        let marker: string;
        if (focusPane === "left" && isHighlighted) {
          marker = brand.marker("▸");
        } else if (focusPane === "right" && isHighlighted) {
          // Left item stays visually indicated even when focus is in right pane
          marker = brand.accentDeep("▸");
        } else {
          marker = " ";
        }

        const label =
          focusPane === "left" && isHighlighted
            ? brand.title(item.label)
            : brand.text(item.label);

        const forwardHint =
          hasChildren && isHighlighted && focusPane === "left"
            ? brand.accentDeep("  ›")
            : "";

        const row = `${marker} ${label}${forwardHint}`;
        // Pad/truncate to left column width
        const vis = visualLen(row);
        const padded = vis < leftColWidth
          ? row + " ".repeat(leftColWidth - vis)
          : truncate(row, leftColWidth);
        leftRows.push(padded);
      });

      const rightRows: string[] = [];
      // Childless leaves can opt into an inline right-pane preview (e.g.
      // "About" renders its build stats on focus). When a preview is present
      // it owns the whole right column; otherwise fall back to the submenu
      // children of the highlighted group.
      const preview = rightPanePreview(rightColWidth);
      if (preview) {
        for (const line of preview) {
          const vis = visualLen(line);
          rightRows.push(
            vis < rightColWidth
              ? line + " ".repeat(rightColWidth - vis)
              : truncate(line, rightColWidth),
          );
        }
      } else {
        const children = rightPaneChildren();
        children.forEach((child, i) => {
          const isSelected = i === rightIndex;
          const isFocused = focusPane === "right";

          let marker: string;
          if (isFocused && isSelected) {
            marker = brand.marker("▸");
          } else {
            marker = " ";
          }

          let label: string;
          if (isFocused && isSelected) {
            label = brand.accent(child.label);
          } else {
            // Faded - visible but clearly subordinate until focused
            label = brand.dim(child.label);
          }

          const row = `${marker} ${label}`;
          const vis = visualLen(row);
          const padded = vis < rightColWidth
            ? row + " ".repeat(rightColWidth - vis)
            : truncate(row, rightColWidth);
          rightRows.push(padded);
        });
      }

      // Combine left + separator + right into body rows.
      // Both columns start after the header rows; the frame body rows are
      // already padded to `inner` width by drawFrame → padRight.
      const sep = brand.borderDim(" │ ");
      const maxRows = Math.max(leftRows.length, rightRows.length);
      const combined: string[] = [];
      for (let r = 0; r < maxRows; r++) {
        const left = leftRows[r] ?? " ".repeat(leftColWidth);
        const right = rightRows[r] ?? " ".repeat(rightColWidth);
        combined.push(left + sep + right);
      }
      return combined;
    };

    // ────────────────────────────────────────────────────────────────────
    // Unified render
    // ────────────────────────────────────────────────────────────────────

    const render = () => {
      const twoPaneMode = isTwoPane();

      const body: string[] = [];
      body.push("");

      if (opts.header) {
        const headerLines = Array.isArray(opts.header)
          ? opts.header
          : opts.header.split("\n");
        for (const line of headerLines) {
          body.push("  " + line);
        }
        body.push("");
        body.push(brand.borderDim("  ─".repeat(20)));
        body.push("");
      }

      // Determine the hint and footer based on which item/pane is focused.
      let focusHint = "";
      if (twoPaneMode) {
        clampRightIndex();
        const twoPaneRows = renderTwoPaneBody();
        for (const row of twoPaneRows) {
          body.push("  " + row);
        }
        // Hint: right pane child hint when right is focused; top-level hint when left.
        if (focusPane === "right") {
          const children = rightPaneChildren();
          focusHint = children[rightIndex]?.hint ?? "";
          // Fall back to parent's hint if child has none
          if (!focusHint) focusHint = highlightedTopItem()?.hint ?? "";
        } else {
          focusHint = highlightedTopItem()?.hint ?? "";
        }
      } else {
        // Single-column mode - rebuild the flat list and render inline tree.
        visibleSingle = flattenSingle();
        if (flatIndex >= visibleSingle.length) {
          flatIndex = Math.max(0, visibleSingle.length - 1);
        }

        // Compute how many item rows fit in the body after chrome + prefix rows.
        // chrome = top border + hint block (3) + footer block (2) + bottom = 7
        // prefix = rows already pushed into body (blank line, optional header)
        const { rows: maxRowsNow } = termSize();
        const chromeRows = 7; // top + bottom borders + hint(3) + footer(2)
        const prefixRows = body.length;
        // Reserve 1 row for "▴ more" and 1 for "▾ more" indicators when needed.
        const availableRows = Math.max(1, maxRowsNow - chromeRows - prefixRows);
        const totalItems = visibleSingle.length;

        // Scroll-follow: keep flatIndex inside [singleScrollOffset, singleScrollOffset + availableRows - 1].
        if (flatIndex < singleScrollOffset) {
          singleScrollOffset = flatIndex;
        } else if (flatIndex >= singleScrollOffset + availableRows) {
          singleScrollOffset = flatIndex - availableRows + 1;
        }
        // Clamp offset to valid range.
        singleScrollOffset = Math.max(0, Math.min(singleScrollOffset, Math.max(0, totalItems - availableRows)));

        const hasAbove = singleScrollOffset > 0;
        const hasBelow = singleScrollOffset + availableRows < totalItems;

        // "▴ more" indicator row above the window.
        if (hasAbove) {
          body.push("  " + brand.dim("▴ more"));
        }

        // Render only the visible window.
        const windowEnd = Math.min(singleScrollOffset + availableRows, totalItems);
        for (let i = singleScrollOffset; i < windowEnd; i++) {
          const v = visibleSingle[i];
          const selected = i === flatIndex;
          const indent = "  ".repeat(v.depth);
          const hasChildren = !!(v.item.children && v.item.children.length > 0);
          const isExpanded = hasChildren && expandedSingle === v.item.value;

          let marker: string;
          if (isExpanded) {
            marker = brand.accentDeep("▾");
          } else if (selected) {
            marker = brand.marker("▸");
          } else {
            marker = " ";
          }

          const label = selected
            ? brand.title(v.item.label)
            : v.depth === 0
            ? brand.text(v.item.label)
            : brand.muted(v.item.label);

          const forward = selected ? brand.accentDeep("  ›") : "";
          body.push(`  ${indent}${marker} ${label}${forward}`);

          // Inline About preview in single-column: mirror the two-pane
          // on-focus behaviour. About is a childless leaf, so in single-column
          // it previously required Enter to see its build stats. When it is the
          // focused row, render the same aboutStatRows() data beneath it so the
          // stats are visible on focus without leaving the menu.
          if (selected && v.item.value === "about") {
            const statRows = aboutStatRows();
            const labelWidth = Math.max(...statRows.map(([k]) => k.length));
            const statIndent = "  ".repeat(v.depth) + "    ";
            body.push("  " + statIndent + brand.titleDim("About alter"));
            for (const [k, val] of statRows) {
              body.push(
                "  " + statIndent + brand.dim(k.padEnd(labelWidth)) + "  " + brand.text(val),
              );
            }
          }
        }

        // "▾ more" indicator row below the window.
        if (hasBelow) {
          body.push("  " + brand.dim("▾ more"));
        }

        focusHint = visibleSingle[flatIndex]?.item.hint ?? "";
      }

      const footer =
        twoPaneMode
          ? brand.dim("↑↓ move    ") +
            brand.muted("→") +
            brand.dim(" open / select    ") +
            brand.muted("←") +
            brand.dim(" back    ") +
            brand.muted("↩") +
            brand.dim(" select    ") +
            brand.muted("q/esc") +
            brand.dim(" quit")
          : brand.dim("↑↓ move    ") +
            brand.muted("→") +
            brand.dim(" enter    ") +
            brand.muted("←") +
            brand.dim(" back    ") +
            brand.muted("↩") +
            brand.dim(" select    ") +
            brand.muted("q/esc") +
            brand.dim(" quit");

      // Title carries location. Top-level = `~Alter`. When a submenu is open
      // - single-column: `expandedSingle` is set; two-pane: the highlighted
      // top-level item has children - append ` · <Submenu Label>` so the
      // reader always knows where they sit. Rule rows (__rule__) and leaf
      // top-level items (Log out, Exit) collapse back to `~Alter`.
      const submenuLabel = ((): string | null => {
        if (twoPaneMode) {
          const top = highlightedTopItem();
          if (!top || top.value === "__rule__") return null;
          return top.children && top.children.length > 0 ? top.label : null;
        }
        if (!expandedSingle) return null;
        const expanded = topItems.find((t) => t.value === expandedSingle);
        return expanded?.label ?? null;
      })();
      const title = submenuLabel
        ? "~Alter " + brand.dim("· ") + brand.titleDim(submenuLabel)
        : "~Alter";

      drawFrame({
        title,
        body,
        hint: focusHint,
        footer,
      });
    };

    // Non-TTY (CI / pipe / node --test): no keypress will ever arrive.
    // Render the first frame so frame-capture tests still get output, then
    // resolve with null so the caller's `choice === null` guard exits cleanly.
    // Mirrors the identical guard used by the sibling helpers (~line 515, 555, 631).
    if (!process.stdin.isTTY) {
      render();
      resolve(null);
      return;
    }

    const cleanup = () => {
      session?.dispose();
      process.stdout.removeListener("resize", render);
    };

    const finish = (result: string | null) => {
      cleanup();
      resolve(result);
    };

    // ────────────────────────────────────────────────────────────────────
    // Single-column: collapse the deepest open expansion.
    // Returns true if anything actually closed.
    // ────────────────────────────────────────────────────────────────────
    const popOneLevelSingle = (): boolean => {
      if (expandedSingle === null) return false;
      const entry = visibleSingle[flatIndex];
      const here = entry?.item;
      const parent = entry?.parent;

      if (here && expandedSingle === here.value) {
        expandedSingle = null;
        return true;
      }
      if (parent && expandedSingle === parent.value) {
        expandedSingle = null;
        const parentValue = parent.value;
        visibleSingle = flattenSingle();
        const idx = visibleSingle.findIndex((v) => v.item.value === parentValue);
        if (idx >= 0) flatIndex = idx;
        return true;
      }
      expandedSingle = null;
      return true;
    };

    // ────────────────────────────────────────────────────────────────────
    // Keypress handler
    // ────────────────────────────────────────────────────────────────────

    const onKeypress = (key: DecodedKey) => {
      // Ctrl+C is always an immediate hard-out.
      if (key.ctrl && key.name === "c") return finish(null);

      // ── quit (q / Esc exit immediately - closing is as fast as
      // opening; the menu is a read surface with nothing mid-flight,
      // so a confirm step here was pure friction) ──────────────────────
      if (key.name === "escape" || key.name === "q") {
        return finish(null);
      }

      const twoPaneMode = isTwoPane();

      // ══════════════════════════════════════════════════════════════════
      // TWO-PANE navigation
      // ══════════════════════════════════════════════════════════════════
      if (twoPaneMode) {
        if (key.name === "up") {
          if (focusPane === "left") {
            leftIndex = nextSelectableIndex(
              topItems.length,
              leftIndex,
              -1,
              (i) => isSelectable(topItems[i]),
            );
            clampRightIndex();
          } else {
            const children = rightPaneChildren();
            if (children.length > 0) {
              rightIndex = (rightIndex - 1 + children.length) % children.length;
            }
          }
          render();
          return;
        }

        if (key.name === "down") {
          if (focusPane === "left") {
            leftIndex = nextSelectableIndex(
              topItems.length,
              leftIndex,
              1,
              (i) => isSelectable(topItems[i]),
            );
            clampRightIndex();
          } else {
            const children = rightPaneChildren();
            if (children.length > 0) {
              rightIndex = (rightIndex + 1) % children.length;
            }
          }
          render();
          return;
        }

        if (key.name === "left") {
          if (focusPane === "right") {
            focusPane = "left";
            render();
          }
          // left at root left pane - no-op (no level above root)
          return;
        }

        if (key.name === "right" || key.name === "return") {
          const topItem = highlightedTopItem();
          if (!topItem) return;

          if (focusPane === "left") {
            const hasChildren = !!(topItem.children && topItem.children.length > 0);
            if (hasChildren) {
              // Shift focus to the right pane - children brighten up.
              focusPane = "right";
              rightIndex = 0;
              render();
            } else {
              // Top-level leaf (e.g. "Log out", "Exit") - activate directly.
              finish(topItem.value);
            }
          } else {
            // Right pane: activate the focused child.
            const children = rightPaneChildren();
            const child = children[rightIndex];
            if (child) {
              finish(child.value);
            }
          }
          return;
        }

        // Any other key - fall through (no-op in menu mode).
        return;
      }

      // ══════════════════════════════════════════════════════════════════
      // SINGLE-COLUMN navigation
      // ══════════════════════════════════════════════════════════════════

      if (key.name === "up") {
        if (visibleSingle.length === 0) return;
        flatIndex = nextSelectableIndex(
          visibleSingle.length,
          flatIndex,
          -1,
          (i) => isSelectable(visibleSingle[i].item),
        );
        render();
        return;
      }

      if (key.name === "down") {
        if (visibleSingle.length === 0) return;
        flatIndex = nextSelectableIndex(
          visibleSingle.length,
          flatIndex,
          1,
          (i) => isSelectable(visibleSingle[i].item),
        );
        render();
        return;
      }

      if (key.name === "left") {
        if (popOneLevelSingle()) render();
        return;
      }

      if (key.name === "right" || key.name === "return") {
        const entry = visibleSingle[flatIndex];
        if (!entry) return;
        const hasChildren =
          !!(entry.item.children && entry.item.children.length > 0);
        if (hasChildren) {
          if (expandedSingle === entry.item.value) {
            // Already open: drop into the first child.
            const firstChild = entry.item.children![0];
            visibleSingle = flattenSingle();
            const childIdx = visibleSingle.findIndex(
              (v) => v.item.value === firstChild.value && v.parent === entry.item
            );
            if (childIdx >= 0) flatIndex = childIdx;
            render();
          } else {
            // Open this group; close any previously open sibling.
            expandedSingle = entry.item.value;
            visibleSingle = flattenSingle();
            render();
          }
        } else {
          finish(entry.item.value);
        }
        return;
      }
    };

    session = createInputSession(stdin, onKeypress);
    stdout.on("resize", render);
    render();
  });
}

/**
 * Run an async operation with a key listener that cancels it on q/Esc.
 *
 * Returns `{ result, cancelled }` rather than throwing on cancel - lets
 * callers branch on cancellation without wrapping every site in try/catch.
 * `cancelled === true` means the user pressed q/Esc/Ctrl+C and `result`
 * is `null`; `cancelled === false` means the op completed normally and
 * `result` is whatever it resolved to.
 *
 * The caller is responsible for rendering a "press q to cancel" hint
 * before invoking; this primitive only handles the listener + abort
 * plumbing. Decouples visual treatment from the cancellation contract.
 *
 * Escape-contract foundation. Use this around every authenticated
 * `apiCall`, file-poll, OAuth wait, or stdio:"inherit" subprocess so
 * q/Esc always returns the user to the menu.
 */
export async function withKeyListenerCancel<T>(
  op: (signal: AbortSignal) => Promise<T>,
): Promise<{ result: T | null; cancelled: boolean }> {
  const controller = new AbortController();
  const stdin = process.stdin;

  let cancelled = false;
  const onKey = (key: DecodedKey) => {
    if (key.ctrl && key.name === "c") {
      cancelled = true;
      controller.abort();
      return;
    }
    if (key.name === "q" || key.name === "escape") {
      cancelled = true;
      controller.abort();
    }
  };
  const session = createInputSession(stdin, onKey);

  try {
    const result = await op(controller.signal);
    return { result, cancelled: false };
  } catch (err: any) {
    if (cancelled || err?.name === "AbortError") {
      return { result: null, cancelled: true };
    }
    throw err;
  } finally {
    session.dispose();
  }
}

/**
 * withKeyListenerCancel + a visible "loading… esc to cancel" line.
 *
 * The bare primitive leaves visual treatment to the caller - and in
 * practice the data leaves (identity profile, traits, observations,
 * sources) called `apiCall` raw: no hint, no listener, so a slow call
 * froze the screen indistinguishably from a hang for up to the full
 * request timeout. This wrapper is the leaf-side idiom: paint one dim
 * status line, run the op cancellable, then erase the line so the
 * leaf's own output renders clean.
 *
 * Pass the AbortSignal through to every `apiCall` inside `op` so esc
 * aborts the in-flight fetch itself, not just the wait.
 */
export async function withLoadingCancel<T>(
  op: (signal: AbortSignal) => Promise<T>,
  label = "loading",
): Promise<{ result: T | null; cancelled: boolean }> {
  const out = process.stdout;
  // Paint only on a TTY: these wrappers sit inside leaves that also run
  // as shell verbs (`alter portfolio --json | jq`), where a status line -
  // even an ANSI-erased one - would corrupt piped output.
  const paint = !!out.isTTY;
  if (paint) {
    out.write(
      "  " + brand.dim(label + "…  ") + brand.muted("esc") + brand.dim(" cancel") + "\n",
    );
  }
  try {
    return await withKeyListenerCancel(op);
  } finally {
    // Erase the status line in place (cursor up one, clear to line end).
    if (paint) out.write("\x1b[1A\x1b[2K");
  }
}
