/**
 * CLI render primitives for the three-beat onboarding experience.
 *
 * Voice register: lowercase intimate. One muted accent colour, speaker
 * tag once per screen, strategic-friction pauses, no emoji, no
 * exclamation marks, no celebratory ticks, no "Successfully". The
 * Trill `~` appears only in the speaker tag - never in body copy.
 *
 * Rendering stack: `@clack/prompts` for prompts, `chalk` for the one
 * accent colour. If `NO_COLOR` is set or `TERM=dumb`, chalk produces plain
 * output automatically; the speaker tag degrades cleanly. If
 * `ALTER_A11Y=1`, all pauses and typing effects collapse to zero so
 * screen readers can consume the body without delay.
 *
 * Glyph policy: no inline `⌥` at any beat. The intimate register is
 * carried by language density, silence, and the Trill alone.
 *
 * History:
 *   - 2026-04-23 `orientation()` removed - beat 1 is exactly two
 *     lines. The third dim-coda line was retired because it diluted the
 *     volta the two-line shape is meant to deliver; every observation now
 *     works as a two-line unit or is rewritten until it does.
 *   - 2026-05-27 boxed-phase primitives added (printBoxedPhase, spinner)
 *     so login phases stack as rounded-border panels in scrollback,
 *     matching the visual register of `alter menu` / `alter room`. Box
 *     is a recognition primitive, not a voice mutation - the intimate
 *     copy doctrine still applies inside the box. ASCII fallback under
 *     NO_COLOR / TERM=dumb; static label under ALTER_A11Y=1.
 */

import chalk from "chalk";
import stripAnsi from "strip-ansi";

import {
  createInputSession,
  type DecodedKey,
  type InputSession,
} from "../ui/rawKeys.js";

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

const NO_COLOR = !!process.env.NO_COLOR;
const DUMB_TERM = process.env.TERM === "dumb";
const A11Y = process.env.ALTER_A11Y === "1";
const ASCII_ONLY = NO_COLOR || DUMB_TERM;

/** Friction pause between beats; zero under ALTER_A11Y=1. */
export function pauseMs(ms: number): Promise<void> {
  if (A11Y) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Styling
// ---------------------------------------------------------------------------

function accent(text: string): string {
  if (NO_COLOR || DUMB_TERM) return text;
  // Single muted accent - dim cyan works across dark and light terminals
  // without resembling any brand's primary. Do NOT switch to a second
  // colour; the voice rule is one accent, no more.
  return chalk.cyan(text);
}

function dim(text: string): string {
  if (NO_COLOR || DUMB_TERM) return text;
  return chalk.dim(text);
}

// ---------------------------------------------------------------------------
// Screen primitives
// ---------------------------------------------------------------------------

/**
 * Render the speaker tag once at the top of a screen.
 *
 * Single pin for any future `⌥` glyph addition: the beat-3 variant of
 * this tag may someday render `~alter ⌥` - NOT inline in body copy.
 */
export function speakerTag(): void {
  process.stdout.write(accent("~alter") + "\n\n");
}

/**
 * Render an observation body - indented two spaces, one line per array
 * entry, blank line after. Never uses colour (plain terminal default).
 *
 * Beat 1 expects exactly two entries. The renderer does
 * not enforce that - observations.json is where the contract lives - but
 * any three-entry body is a voice-pass bug, not a feature.
 */
export function body(lines: string[]): void {
  for (const line of lines) {
    process.stdout.write("  " + line + "\n");
  }
  process.stdout.write("\n");
}

/**
 * Beat-2 framing block - same 2-space indent + trailing blank as `body()`,
 * separate name so callers don't pretend OAuth chrome is observation copy.
 * Voice doctrine: short voiced sentences only, never ALL-CAPS or ticks.
 */
export function framing(lines: string[]): void {
  body(lines);
}

/**
 * Beat-2 framing for first-time logins - the naming-ceremony copy that
 * names what is about to happen before handing the user to the browser.
 * Centralised here so the three callers (browser flow, device-code flow,
 * dry-run journey) stay in lockstep. Returning users get
 * `returningFraming()` instead - the naming ceremony is doctrinally a
 * first-meeting moment, not a re-auth event.
 */
export function firstTimeFraming(): void {
  framing([
    "To be known anywhere, you first need a name here.",
    "You can use one you already have, or take one that is only yours.",
  ]);
  framing([
    "~ is the Trill. It is the smallest unit of a name that is yours.",
  ]);
  framing([
    "New here? Choose Register in the browser to name yourself.",
  ]);
}

/**
 * Beat-2 framing for returning logins - quiet re-auth, no naming
 * ceremony, no mystery observation upstream. The user has already named
 * themselves; we acknowledge them by handle and hand to the browser.
 *
 * Voice register: lowercase intimate matches the existing `waiting…` /
 * `login cancelled.` state announcements. The handle is the only place
 * the Trill appears (in body) - it's a name, not a glyph.
 */
export function returningFraming(handle: string): void {
  body([`renewing your session, ${handle}.`]);
}

/**
 * Single indented line, no trailing blank. For tightly-paired pairs like
 * `If it doesn't open, visit:` followed by the URL on the next line.
 */
export function indented(line: string): void {
  process.stdout.write("  " + line + "\n");
}

/**
 * Dimmed indented line - visual demotion for fallback / paste-escape
 * content. The line still prints (no `--debug` gate), it just reads as
 * nested status rather than primary instruction. Used for the OAuth
 * authorise URL: it must remain available for manual paste, but it
 * shouldn't dominate the screen.
 */
export function indentedDim(line: string): void {
  process.stdout.write("  " + dim(line) + "\n");
}

/**
 * Sub-indented (4-space) line, no trailing blank. Used for heartbeat ticks
 * during the OAuth wait - the extra indent steps below the framing layer
 * so the eye reads them as nested status, not new instructions.
 */
export function subIndented(line: string): void {
  process.stdout.write("    " + line + "\n");
}

/**
 * Render the return/cancel prompt. The phrasing is fixed by doctrine -
 * `ctrl-c` reads as *the mystery keeps*, NOT "you can always come back".
 * No dark-pattern rescue attempts.
 */
export function continueOrExitLabel(): string {
  return "  " + continueOrExitLabelInline();
}

/**
 * Inline variant of `continueOrExitLabel()` with no leading indent - for
 * callers (printBoxedPhase / boxLine) that supply their own padding.
 */
export function continueOrExitLabelInline(): string {
  return (
    dim("[return]") + " continue  " + dim("·") + "  " + dim("[ctrl-c]") + " the mystery keeps"
  );
}

// ---------------------------------------------------------------------------
// Wait-for-return - blocks until the user presses enter OR ctrl-c
// ---------------------------------------------------------------------------

export type ContinueOrExit = "continue" | "exit";

/**
 * Present the continue/exit prompt and resolve when the user answers.
 * Returns `"continue"` on enter, `"exit"` on ctrl-c or ctrl-d. Never
 * throws - callers branch on the result.
 */
export function awaitContinueOrExit(): Promise<ContinueOrExit> {
  process.stdout.write(continueOrExitLabel() + "\n");
  return waitContinueOrExitKeypress();
}

/**
 * Keypress half of `awaitContinueOrExit()` - no label print. For callers
 * (boxed-phase renderers) that emit the continue/exit label inside the
 * box footer themselves and just need the wait.
 */
export function waitContinueOrExitKeypress(): Promise<ContinueOrExit> {
  return new Promise((resolve) => {
    let session: InputSession | null = null;

    const finish = (outcome: ContinueOrExit) => {
      session?.dispose();
      process.stdout.write("\n");
      resolve(outcome);
    };

    const onKey = (key: DecodedKey) => {
      // ctrl-c, ctrl-d, escape: treat as exit.
      if (
        (key.ctrl && (key.name === "c" || key.name === "d")) ||
        key.name === "escape"
      ) {
        finish("exit");
        return;
      }
      if (key.name === "return") {
        finish("continue");
        return;
      }
      // Any other keypress is ignored - no feedback, no "press return to
      // continue" reminder. Silence is part of the voice.
    };

    session = createInputSession(process.stdin, onKey);
  });
}

// ---------------------------------------------------------------------------
// Audit rendering - used by `alter audit` and `alter login --audit-signals`
// ---------------------------------------------------------------------------

export function renderAudit(lines: string[]): void {
  process.stdout.write("\n");
  process.stdout.write(dim("  read on this run:") + "\n");
  for (const line of lines) {
    process.stdout.write(line + "\n");
  }
  process.stdout.write("\n");
  process.stdout.write(
    dim("  nothing was written, nothing was uploaded.") + "\n\n",
  );
}

// ---------------------------------------------------------------------------
// Boxed phase rendering
// ---------------------------------------------------------------------------
//
// Each login phase prints a complete rounded-border box (top → body → optional
// divider → optional footer → bottom). Boxes stack in scrollback rather than
// re-render in place, so:
//   - copy-paste of the session is preserved (no cursor-positioning escapes)
//   - screen readers consume each box as a complete unit
//   - the OAuth URL stays selectable in the user's terminal history
//
// Width clamps to [60, 88] cols, matching the bios menu. NO_COLOR / TERM=dumb
// degrade the border characters to ASCII `+-+ | | +-+` while preserving layout
// so width-dependent rendering still aligns. ALTER_A11Y=1 doesn't alter the
// box - the friction-pause + spinner-animation primitives are the
// a11y-degradable surface.

const BOX_MIN_COLS = 60;
const BOX_MAX_COLS = 88;

interface BoxChars {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  vertical: string;
  horizontal: string;
  divLeft: string;
  divRight: string;
}

const BOX_UNICODE: BoxChars = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  vertical: "│",
  horizontal: "─",
  divLeft: "├",
  divRight: "┤",
};

const BOX_ASCII: BoxChars = {
  topLeft: "+",
  topRight: "+",
  bottomLeft: "+",
  bottomRight: "+",
  vertical: "|",
  horizontal: "-",
  divLeft: "+",
  divRight: "+",
};

function boxChars(): BoxChars {
  return ASCII_ONLY ? BOX_ASCII : BOX_UNICODE;
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
 * Resolve the box width for the current terminal. Clamps to
 * [BOX_MIN_COLS, BOX_MAX_COLS] when the terminal is at least BOX_MIN_COLS
 * wide; collapses to the real width on narrower terminals so the right
 * border never overflows. Defaults to 80 cols on non-TTY (CI capture).
 */
export function boxWidth(): number {
  const real = process.stdout.columns || 80;
  if (real < BOX_MIN_COLS) return real;
  return Math.min(BOX_MAX_COLS, Math.max(BOX_MIN_COLS, real));
}

/**
 * Word-wrap arbitrary text to a width budget. Breaks at spaces when one
 * is available within the budget; otherwise hard-wraps. Returns one
 * entry per output line. Preserves the input verbatim if it already fits.
 *
 * Strips ANSI for width math so colour escapes don't push wrapped output
 * off the right border, but emits the wrapped slices as raw text - the
 * caller (boxLine) reapplies styling if needed.
 */
export function wrapText(text: string, width: number): string[] {
  if (visualLen(text) <= width) return [text];
  // Operate on the ANSI-stripped text - the box-line writer doesn't
  // attempt to preserve mid-word ANSI runs. If the caller needs colour,
  // it should style the unwrapped string before splitting OR style each
  // returned slice itself.
  const plain = stripAnsi(text);
  const words = plain.split(/(\s+)/); // keep separators
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    if (word.length === 0) continue;
    if ((cur + word).length <= width) {
      cur += word;
      continue;
    }
    if (cur.length > 0) {
      lines.push(cur.trimEnd());
      cur = "";
    }
    if (word.length <= width) {
      cur = word.trimStart();
      continue;
    }
    // Word longer than width - hard-wrap it across multiple lines.
    let rem = word;
    while (rem.length > width) {
      lines.push(rem.slice(0, width));
      rem = rem.slice(width);
    }
    cur = rem;
  }
  if (cur.length > 0) lines.push(cur.trimEnd());
  return lines;
}

/**
 * Greedy URL wrapper. Breaks at `&`, `?`, or `/` when one is available
 * within the budget; otherwise hard-wraps at the boundary. Keeps the
 * separator on the previous line so the eye can scan that the next line
 * is a continuation, not a new instruction.
 */
export function wrapUrl(url: string, width: number): string[] {
  if (url.length <= width) return [url];
  const lines: string[] = [];
  let pos = 0;
  while (pos < url.length) {
    if (url.length - pos <= width) {
      lines.push(url.slice(pos));
      break;
    }
    const hardEnd = pos + width;
    let breakAt = -1;
    for (const sep of ["&", "?", "/"]) {
      const idx = url.lastIndexOf(sep, hardEnd);
      if (idx > pos) {
        breakAt = idx + 1; // include separator on the preceding line
        break;
      }
    }
    if (breakAt <= pos) breakAt = hardEnd;
    lines.push(url.slice(pos, breakAt));
    pos = breakAt;
  }
  return lines;
}

interface BoxLineOpts {
  /** Wrap content in `accent()` colour. */
  accent?: boolean;
  /** Wrap content in `dim()`. */
  dim?: boolean;
  /** Extra left-pad inside the box body (defaults to 0). */
  leftPad?: number;
}

function writeOneBoxedLine(text: string, opts: BoxLineOpts = {}): void {
  const w = boxWidth();
  const inner = w - 6; // border + 2 pad + inner + 2 pad + border
  const c = boxChars();
  const border = ASCII_ONLY ? c.vertical : dim(c.vertical);
  let payload = text;
  // Defensive truncate - the caller (writeBoxedLine) is supposed to
  // wrap before reaching here, but if a pre-styled ANSI line slips
  // through too long, ellipsise rather than overflow the border.
  if (visualLen(payload) > inner) {
    payload = stripAnsi(payload).slice(0, inner - 1) + "…";
  }
  let styled = payload;
  if (opts.accent) styled = accent(stripAnsi(payload));
  else if (opts.dim) styled = dim(stripAnsi(payload));
  const padded = padRight(styled, inner);
  process.stdout.write(border + "  " + padded + "  " + border + "\n");
}

function writeBoxedLine(text: string, opts: BoxLineOpts = {}): void {
  const inner = boxWidth() - 6;
  const leftPad = " ".repeat(opts.leftPad ?? 0);
  const raw = leftPad + text;
  // Skip the wrap path when the line already fits or carries ANSI
  // escapes (chalk styling is line-scoped; mid-line wrap would orphan
  // the SGR state). Pre-styled chalk prompts must stay one-row by
  // construction; callers wrap their own content if it might exceed
  // the inner budget.
  // eslint-disable-next-line no-control-regex
  const hasAnsi = /\x1b\[/.test(raw);
  if (hasAnsi || visualLen(raw) <= inner) {
    writeOneBoxedLine(raw, opts);
    return;
  }
  // Word-wrap. Preserve any leading whitespace on every continuation
  // line so wrapped URLs / indented body keep their gutter.
  const indentMatch = raw.match(/^(\s+)/);
  const indent = indentMatch ? indentMatch[1] : "";
  const content = raw.slice(indent.length);
  const wrapped = wrapText(content, Math.max(1, inner - indent.length));
  for (const w of wrapped) writeOneBoxedLine(indent + w, opts);
}

/**
 * Print the top border of a boxed phase with a centred title.
 */
export function openBox(title?: string): void {
  const w = boxWidth();
  const c = boxChars();
  const titleText = title ?? "";
  const titleSlot = titleText ? ` ${titleText} ` : "";
  const titleVis = visualLen(titleSlot);
  const remaining = Math.max(0, w - 2 - titleVis);
  const leftLen = Math.floor(remaining / 2);
  const rightLen = remaining - leftLen;
  const styledTitle = titleText ? accent(titleSlot) : "";
  const horiz = c.horizontal;
  const border = ASCII_ONLY ? horiz : dim(horiz);
  process.stdout.write(
    (ASCII_ONLY ? c.topLeft : dim(c.topLeft)) +
      border.repeat(leftLen) +
      styledTitle +
      border.repeat(rightLen) +
      (ASCII_ONLY ? c.topRight : dim(c.topRight)) +
      "\n",
  );
}

/**
 * Print a body row inside the current box.
 */
export function boxLine(text: string, opts: BoxLineOpts = {}): void {
  writeBoxedLine(text, opts);
}

/** Print a blank body row inside the current box (preserves left/right border). */
export function boxBlank(): void {
  writeBoxedLine("");
}

/** Print a horizontal divider inside the current box. */
export function boxDivider(): void {
  const w = boxWidth();
  const c = boxChars();
  const horiz = ASCII_ONLY ? c.horizontal : dim(c.horizontal);
  process.stdout.write(
    (ASCII_ONLY ? c.divLeft : dim(c.divLeft)) +
      horiz.repeat(w - 2) +
      (ASCII_ONLY ? c.divRight : dim(c.divRight)) +
      "\n",
  );
}

/**
 * Close the current box with a bottom border and a trailing blank line so
 * the next phase has visual breathing room above its top border.
 */
export function closeBox(): void {
  const w = boxWidth();
  const c = boxChars();
  const horiz = ASCII_ONLY ? c.horizontal : dim(c.horizontal);
  process.stdout.write(
    (ASCII_ONLY ? c.bottomLeft : dim(c.bottomLeft)) +
      horiz.repeat(w - 2) +
      (ASCII_ONLY ? c.bottomRight : dim(c.bottomRight)) +
      "\n\n",
  );
}

export interface BoxedPhaseSpec {
  /** Title text rendered inside the top border (e.g. `"◇ ~alter ◇"`). */
  title?: string;
  /** Body rows. Empty strings render as blank body rows. */
  body: string[];
  /** Optional rows after a divider (the "footer-state" row). */
  footer?: string[];
}

/**
 * Convenience: emit a full boxed phase in one call. Use when no streaming
 * updates (spinner, in-place tick) are needed inside the box. boxLine
 * itself handles word-wrap for any plain-text row that exceeds the inner
 * width; pre-styled (ANSI-bearing) lines must fit by construction.
 */
export function printBoxedPhase(spec: BoxedPhaseSpec): void {
  openBox(spec.title);
  for (const line of spec.body) {
    if (line === "") boxBlank();
    else boxLine(line);
  }
  if (spec.footer && spec.footer.length > 0) {
    boxDivider();
    for (const line of spec.footer) {
      boxLine(line, { dim: true });
    }
  }
  closeBox();
}

// ---------------------------------------------------------------------------
// Spinner - transient status line printed OUTSIDE any box.
// ---------------------------------------------------------------------------
//
// The spinner does NOT live inside the OAuth-wait box because animating a
// line inside a printed box requires cursor-up + clear-line, which corrupts
// scrollback on copy-paste and confuses screen readers. Instead the box
// closes after the static "Opening browser / visit URL" content; the
// spinner runs as a single transient line beneath the box; on completion
// it is cleared and a fresh box (the welcome panel) prints below it.

const SPINNER_FRAMES_UNICODE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_FRAMES_ASCII = ["-", "\\", "|", "/"];
const SPINNER_INTERVAL_MS = 80;

export interface SpinnerHandle {
  /** Stop the animation. If `final` given, print it as a static line in
   * place of the spinner; otherwise clear the line. */
  stop(final?: string): void;
  /** Replace the spinner's trailing tick text (e.g. heartbeat seconds). */
  setTick(text: string): void;
}

/**
 * Print an animated spinner line beneath the current cursor position.
 * Returns a handle to stop or update it. Under ALTER_A11Y=1, prints the
 * label once with no animation and returns a no-op handle. Under NO_COLOR
 * / TERM=dumb, uses ASCII frames and no colour but still animates (so the
 * user sees progress).
 */
export function startSpinner(label: string): SpinnerHandle {
  const frames = ASCII_ONLY ? SPINNER_FRAMES_ASCII : SPINNER_FRAMES_UNICODE;
  let tick = "";
  // Hide the cursor while we're animating in place. Restore on stop().
  const isTTY = !!process.stdout.isTTY;

  if (A11Y || !isTTY) {
    process.stdout.write("  " + label + "\n");
    return {
      stop(final?: string) {
        if (final) process.stdout.write("  " + final + "\n");
      },
      setTick(text: string) {
        tick = text;
      },
    };
  }

  let frame = 0;
  let stopped = false;

  process.stdout.write("\x1b[?25l"); // hide cursor

  const render = (): void => {
    const glyph = frames[frame % frames.length];
    const styled = ASCII_ONLY ? glyph : accent(glyph);
    const trailing = tick ? "  " + dim(tick) : "";
    process.stdout.write("\r\x1b[2K  " + styled + "  " + label + trailing);
  };

  render();
  const timer = setInterval(() => {
    if (stopped) return;
    frame = (frame + 1) % frames.length;
    render();
  }, SPINNER_INTERVAL_MS);
  // Don't keep the event loop alive on the spinner alone.
  timer.unref?.();

  return {
    stop(final?: string) {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      process.stdout.write("\r\x1b[2K"); // clear spinner line
      process.stdout.write("\x1b[?25h"); // show cursor
      if (final) process.stdout.write("  " + final + "\n");
    },
    setTick(text: string) {
      tick = text;
      if (!stopped) render();
    },
  };
}
