/**
 * Inline picker - single- and multi-select prompts with the same key
 * contract as the BIOS menu.
 *
 * Why this exists: the rest of the CLI used `@clack/prompts.select` and
 * `multiselect`, which bind their own keys (Esc cancels back to caller,
 * no `q`, no `←`).
 *
 * Key contract (revised 2026-06-02 - Esc is back, not quit):
 * `←` and `Esc` both pop one level (cancel this picker, return to caller),
 * matching the messenger and clack `text()` - so
 * "back" means back everywhere. `q` is the deliberate quit-ALTER hard key.
 * The prior "q AND Esc quit everywhere" model trapped users in submenus:
 * pressing Esc to go back instead quit the whole app on the second press.
 *
 * `pickOne` and `pickMany` honour that contract by decoding raw stdin
 * bytes (the shared rawKeys decoder) directly:
 *
 *   ↑/↓       move selection (wraps)
 *   →/Enter   select (single) / move forward (multi: same as Enter when
 *             a confirm row is highlighted; otherwise no-op)
 *   Space     toggle (multi only)
 *   ← | Esc   cancel this picker - return to caller (returns null)
 *   q         quit ALTER - first press raises confirm-exit; second press
 *             of q/y exits the process; Esc/n/Enter/anything else stays
 *
 * Rendering is inline (printed at the current cursor position, then
 * redrawn in place via ANSI cursor moves). It does NOT enter the alt
 * screen and does NOT clear the terminal - callers that want a framed
 * panel use biosMenu instead.
 */

import stripAnsi from "strip-ansi";
import {
  createInputSession,
  type DecodedKey,
  type InputSession,
} from "./rawKeys.js";
import { brand, forceExitAlt } from "./biosMenu.js";

export interface PickerOption<V extends string = string> {
  value: V;
  label: string;
  hint?: string;
}

/**
 * A decorative, non-selectable row - breathing room between option
 * groups. Renders as a blank line (or a faint label when given one);
 * arrow navigation skips over it in both directions, so the cursor can
 * never rest on a separator. pickOne only - pickMany keeps flat lists.
 */
export interface PickerSeparator {
  separator: true;
  /** Optional faint group label; a bare blank spacer when omitted. */
  label?: string;
}

export type PickerRow<V extends string = string> =
  | PickerOption<V>
  | PickerSeparator;

export function isSeparator(
  row: PickerRow<string>,
): row is PickerSeparator {
  return (row as PickerSeparator).separator === true;
}

/**
 * The shared "← Back" row. Append it to a sub-picker's options so the
 * back affordance is discoverable on-screen (not just the ←/Esc keys).
 * Selecting it returns the literal `"back"` value; callers treat `"back"`
 * exactly like `null` (Esc/←) - i.e. pop one level. The leading arrow
 * mirrors the footer hint so the row reads as navigation, not an action.
 */
export const BACK_VALUE = "back" as const;
export const BACK_OPTION: PickerOption = {
  value: BACK_VALUE,
  label: "← Back",
};

/** True when a picker result means "go back" - either the Back row or a
 *  ←/Esc cancel (null). A type predicate so the continuing branch narrows
 *  to a non-null, non-"back" string. Lets call sites collapse both cases
 *  into one guard: `if (isBack(choice)) return;`. */
export function isBack(
  choice: string | null,
): choice is null | typeof BACK_VALUE {
  return choice === null || choice === BACK_VALUE;
}

/**
 * Minimal stdin shape the picker drives. `process.stdin` satisfies it;
 * tests pass a fake stream so they don't fight node:test's own stdin
 * handling (which silently swallows the keypress events the picker
 * relies on when it shares the real `process.stdin`).
 */
export interface PickerStdin {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", listener: (buf: Buffer) => void): unknown;
  removeListener(event: "data", listener: (buf: Buffer) => void): unknown;
}

export interface PickerStdout {
  write(chunk: string): unknown;
}

export interface PickOneOptions<V extends string = string> {
  message: string;
  options: PickerRow<V>[];
  initialValue?: V;
  /**
   * Fired whenever the highlighted option changes (and once for the
   * initial highlight), BEFORE the redraw - so a caller can mutate
   * preview state (e.g. re-tint the brand palette) and the very next
   * paint reflects it. Realtime preview hook; selection semantics are
   * untouched.
   */
  onHighlight?: (value: V) => void;
  /** Inject an alternative input stream - defaults to process.stdin. */
  input?: PickerStdin;
  /** Inject an alternative output stream - defaults to process.stdout. */
  output?: PickerStdout;
  /**
   * ESC-settle delay (ms) forwarded to the shared input session. Omit for
   * the default (50ms on a TTY, 0 off one). Tests inject 0 for immediacy.
   */
  escDelayMs?: number;
}

export interface PickManyOptions<V extends string = string> {
  message: string;
  options: PickerOption<V>[];
  initialValues?: V[];
  /** When true, Enter on an empty selection still returns []. */
  allowEmpty?: boolean;
  /** Inject an alternative input stream - defaults to process.stdin. */
  input?: PickerStdin;
  /** Inject an alternative output stream - defaults to process.stdout. */
  output?: PickerStdout;
  /**
   * ESC-settle delay (ms) forwarded to the shared input session. Omit for
   * the default (50ms on a TTY, 0 off one). Tests inject 0 for immediacy.
   */
  escDelayMs?: number;
}

export interface ConfirmYesNoOptions {
  message: string;
  /** Highlighted on first paint; Enter alone returns this value. Default true. */
  initialValue?: boolean;
  /** Inject an alternative input stream - defaults to process.stdin. */
  input?: PickerStdin;
  /** Inject an alternative output stream - defaults to process.stdout. */
  output?: PickerStdout;
  /**
   * ESC-settle delay (ms) forwarded to the shared input session. Omit for
   * the default (50ms on a TTY, 0 off one). Tests inject 0 for immediacy.
   */
  escDelayMs?: number;
}

/**
 * Process-exit hook used when the confirm-exit modal resolves to "yes".
 * Tests override this so node:test isn't killed by a real process.exit.
 */
let quitHandler: () => void = () => {
  // Quitting ALTER must fully restore the terminal regardless of how deeply
  // the picker was nested (menu → leaf → picker), so force the teardown.
  forceExitAlt();
  // Soft exit: set exitCode and return so the event loop drains cleanly on
  // Windows rather than calling process.exit(0) which can race libuv handles.
  process.exitCode = 0;
};

export function _setQuitHandlerForTests(fn: () => void): void {
  quitHandler = fn;
}

function visualLen(s: string): number {
  return stripAnsi(s).length;
}

function clearLines(out: PickerStdout, n: number): void {
  if (n <= 0) return;
  // The render writes `lines.join("\n") + "\n"`, so when we're called
  // the cursor sits one row BELOW the last rendered row (the trailing
  // \n moved it past the content). To clear all `n` rendered rows we
  // therefore need to step up `n` times - clearing as we go - landing
  // on row 1 of the previous render, ready for the next paint.
  //
  // Earlier versions issued `\x1b[2K` first and only moved up `n - 1`
  // times, which cleared the empty row plus rows 2..n and left row 1
  // alive. Each redraw shifted the previous render down by one row,
  // accumulating ghost amber title bars on every up/down keypress.
  out.write("\r");
  for (let i = 0; i < n; i++) {
    out.write("\x1b[1A\x1b[2K");
  }
}

interface RenderResult {
  /** Number of terminal rows the render consumed (for next-redraw clear). */
  rows: number;
}

function renderOne<V extends string>(
  out: PickerStdout,
  message: string,
  options: PickerRow<V>[],
  index: number,
  mode: "menu" | "confirm-exit"
): RenderResult {
  const lines: string[] = [];
  lines.push("  " + brand.title(message));
  lines.push("");

  options.forEach((opt, i) => {
    if (isSeparator(opt)) {
      // Breathing room between option groups - blank, or a faint label.
      lines.push(opt.label ? "    " + brand.faint(opt.label) : "");
      return;
    }
    const selected = i === index;
    const marker = selected ? brand.marker("▸") : " ";
    const label = selected ? brand.title(opt.label) : brand.text(opt.label);
    const hint = opt.hint ? "  " + brand.muted(opt.hint) : "";
    lines.push(`  ${marker} ${label}${hint}`);
  });

  lines.push("");
  if (mode === "confirm-exit") {
    lines.push(
      "  " +
        brand.title("leave ~alter? ") +
        brand.dim("press ") +
        brand.muted("q") +
        brand.dim(" / ") +
        brand.muted("y") +
        brand.dim(" again to exit, ") +
        brand.muted("esc") +
        brand.dim(" / ") +
        brand.muted("n") +
        brand.dim(" to stay")
    );
  } else {
    lines.push(
      "  " +
        brand.dim("↑↓ move    ") +
        brand.muted("⏎") +
        brand.dim(" select    ") +
        brand.muted("←/esc") +
        brand.dim(" back    ") +
        brand.muted("q") +
        brand.dim(" quit")
    );
  }

  out.write(lines.join("\n") + "\n");
  return { rows: lines.length };
}

function renderMany<V extends string>(
  out: PickerStdout,
  message: string,
  options: PickerOption<V>[],
  index: number,
  picked: Set<V>,
  mode: "menu" | "confirm-exit"
): RenderResult {
  const lines: string[] = [];
  lines.push("  " + brand.title(message));
  lines.push("");

  options.forEach((opt, i) => {
    const selected = i === index;
    const isOn = picked.has(opt.value);
    const cursor = selected ? brand.marker("▸") : " ";
    const box = isOn ? brand.accentDeep("◆") : brand.dim("◇");
    const label = selected ? brand.title(opt.label) : brand.text(opt.label);
    const hint = opt.hint ? "  " + brand.muted(opt.hint) : "";
    lines.push(`  ${cursor} ${box} ${label}${hint}`);
  });

  lines.push("");
  if (mode === "confirm-exit") {
    lines.push(
      "  " +
        brand.title("leave ~alter? ") +
        brand.dim("press ") +
        brand.muted("q") +
        brand.dim(" / ") +
        brand.muted("y") +
        brand.dim(" again to exit, ") +
        brand.muted("esc") +
        brand.dim(" / ") +
        brand.muted("n") +
        brand.dim(" to stay")
    );
  } else {
    lines.push(
      "  " +
        brand.dim("↑↓ move    ") +
        brand.muted("space") +
        brand.dim(" toggle    ") +
        brand.muted("⏎") +
        brand.dim(" confirm    ") +
        brand.muted("←/esc") +
        brand.dim(" back    ") +
        brand.muted("q") +
        brand.dim(" quit")
    );
  }
  // Suppress unused-import lint when nobody calls visualLen - the helper
  // is kept available for future hint-truncation work.
  void visualLen;

  out.write(lines.join("\n") + "\n");
  return { rows: lines.length };
}

/**
 * Walk from `from` in `dir` (+1 down / -1 up), wrapping at the ends and
 * skipping separator rows. Returns `from` unchanged when no other row
 * is selectable - mirrors biosMenu's nextSelectableIndex so the cursor
 * never rests on a divider.
 */
function stepSelectable<V extends string>(
  rows: PickerRow<V>[],
  from: number,
  dir: 1 | -1,
): number {
  const len = rows.length;
  if (len === 0) return from;
  let i = (((from + dir) % len) + len) % len;
  for (let guard = 0; guard < len; guard++) {
    if (!isSeparator(rows[i])) return i;
    i = (((i + dir) % len) + len) % len;
  }
  return from;
}

export async function pickOne<V extends string = string>(
  opts: PickOneOptions<V>
): Promise<V | null> {
  if (!opts.options.some((o) => !isSeparator(o))) return null;
  const stdin: PickerStdin = opts.input ?? (process.stdin as PickerStdin);
  const stdout: PickerStdout = opts.output ?? process.stdout;
  // First selectable row is the default highlight; a leading separator
  // can never hold the cursor.
  let index = isSeparator(opts.options[0])
    ? stepSelectable(opts.options, 0, 1)
    : 0;
  if (opts.initialValue) {
    const found = opts.options.findIndex(
      (o) => !isSeparator(o) && o.value === opts.initialValue,
    );
    if (found >= 0) index = found;
  }

  const highlighted = (): V => (opts.options[index] as PickerOption<V>).value;

  return new Promise<V | null>((resolve) => {
    let session: InputSession | null = null;

    let mode: "menu" | "confirm-exit" = "menu";
    let lastRows = 0;

    const draw = () => {
      clearLines(stdout, lastRows);
      const r = renderOne(stdout, opts.message, opts.options, index, mode);
      lastRows = r.rows;
    };

    const cleanup = () => {
      session?.dispose();
    };

    const finish = (result: V | null) => {
      cleanup();
      resolve(result);
    };

    const onKey = (key: DecodedKey) => {

      // Ctrl+C remains as a hard-out safety net. Per the locked spec,
      // it is never required - q/Esc twice does the same thing - but
      // muscle memory keeps it working.
      if (key.ctrl && key.name === "c") {
        cleanup();
        quitHandler();
        return;
      }

      if (mode === "confirm-exit") {
        // Second press of q/y → exit ALTER. Esc / n / Enter / anything else
        // dismisses the modal and returns to the picker (Esc is back, not a
        // quit key - see the key contract at the top of this file).
        if (key.name === "q" || key.name === "y") {
          cleanup();
          quitHandler();
          return;
        }
        mode = "menu";
        draw();
        return;
      }

      // q raises the quit-with-confirm modal - the deliberate "leave ALTER"
      // hard key. Esc and ← both pop one level instead.
      if (key.name === "q") {
        mode = "confirm-exit";
        draw();
        return;
      }

      if (key.name === "left" || key.name === "escape") {
        // ← / Esc cancel this picker and return to the caller (back up a level).
        return finish(null);
      }

      if (key.name === "up") {
        index = stepSelectable(opts.options, index, -1);
        opts.onHighlight?.(highlighted());
        draw();
        return;
      }

      if (key.name === "down") {
        index = stepSelectable(opts.options, index, 1);
        opts.onHighlight?.(highlighted());
        draw();
        return;
      }

      if (key.name === "right" || key.name === "return") {
        return finish(highlighted());
      }
    };

    session = createInputSession(stdin, onKey, { escDelayMs: opts.escDelayMs });
    // Initial render - no clear-lines, just paint. The initial highlight
    // fires onHighlight too, so preview state starts consistent.
    opts.onHighlight?.(highlighted());
    const r = renderOne(stdout, opts.message, opts.options, index, mode);
    lastRows = r.rows;
  });
}

export async function pickMany<V extends string = string>(
  opts: PickManyOptions<V>
): Promise<V[] | null> {
  if (opts.options.length === 0) return [];
  const stdin: PickerStdin = opts.input ?? (process.stdin as PickerStdin);
  const stdout: PickerStdout = opts.output ?? process.stdout;
  let index = 0;
  const picked = new Set<V>(opts.initialValues ?? []);

  return new Promise<V[] | null>((resolve) => {
    let session: InputSession | null = null;

    let mode: "menu" | "confirm-exit" = "menu";
    let lastRows = 0;

    const draw = () => {
      clearLines(stdout, lastRows);
      const r = renderMany(stdout, opts.message, opts.options, index, picked, mode);
      lastRows = r.rows;
    };

    const cleanup = () => {
      session?.dispose();
    };

    const finish = (result: V[] | null) => {
      cleanup();
      resolve(result);
    };

    const onKey = (key: DecodedKey) => {

      if (key.ctrl && key.name === "c") {
        cleanup();
        quitHandler();
        return;
      }

      if (mode === "confirm-exit") {
        if (key.name === "q" || key.name === "y") {
          cleanup();
          quitHandler();
          return;
        }
        mode = "menu";
        draw();
        return;
      }

      if (key.name === "q") {
        mode = "confirm-exit";
        draw();
        return;
      }

      if (key.name === "left" || key.name === "escape") {
        return finish(null);
      }

      if (key.name === "up") {
        index = (index - 1 + opts.options.length) % opts.options.length;
        draw();
        return;
      }

      if (key.name === "down") {
        index = (index + 1) % opts.options.length;
        draw();
        return;
      }

      if (key.name === "space") {
        const v = opts.options[index].value;
        if (picked.has(v)) picked.delete(v);
        else picked.add(v);
        draw();
        return;
      }

      if (key.name === "return") {
        if (picked.size === 0 && !opts.allowEmpty) {
          // Refuse to confirm an empty selection unless the caller opts in.
          return;
        }
        const out = opts.options
          .map((o) => o.value)
          .filter((v) => picked.has(v));
        return finish(out);
      }
    };

    session = createInputSession(stdin, onKey, { escDelayMs: opts.escDelayMs });
    const r = renderMany(stdout, opts.message, opts.options, index, picked, mode);
    lastRows = r.rows;
  });
}

function renderConfirm(
  out: PickerStdout,
  message: string,
  highlight: boolean,
  mode: "menu" | "confirm-exit"
): RenderResult {
  const lines: string[] = [];
  lines.push("  " + brand.title(message));
  lines.push("");

  // Two-state row: ▸ Yes / No, with the highlighted side bold-amber.
  const yesLabel = highlight ? brand.title("Yes") : brand.text("Yes");
  const noLabel = !highlight ? brand.title("No") : brand.text("No");
  const yesMark = highlight ? brand.marker("▸") : " ";
  const noMark = !highlight ? brand.marker("▸") : " ";
  lines.push(`  ${yesMark} ${yesLabel}    ${noMark} ${noLabel}`);

  lines.push("");
  if (mode === "confirm-exit") {
    lines.push(
      "  " +
        brand.title("leave ~alter? ") +
        brand.dim("press ") +
        brand.muted("q") +
        brand.dim(" / ") +
        brand.muted("y") +
        brand.dim(" again to exit, ") +
        brand.muted("esc") +
        brand.dim(" / ") +
        brand.muted("n") +
        brand.dim(" to stay")
    );
  } else {
    lines.push(
      "  " +
        brand.muted("y") +
        brand.dim(" yes    ") +
        brand.muted("n") +
        brand.dim(" no    ") +
        brand.muted("←/→") +
        brand.dim(" toggle    ") +
        brand.muted("esc") +
        brand.dim(" back    ") +
        brand.muted("q") +
        brand.dim(" quit")
    );
  }

  out.write(lines.join("\n") + "\n");
  return { rows: lines.length };
}

/**
 * Yes/No prompt - same key contract as the picker. y/n decide directly;
 * Enter returns whichever side is currently highlighted (the user can
 * toggle via ←/↑/↓ before pressing Enter, mirroring clack's layout but
 * without clack's Esc-cancels-this-prompt semantic - Esc here is the
 * quit-ALTER alias). Returns the boolean answer, or null if the user
 * quits via the confirm-exit modal.
 */
export async function confirmYesNo(
  opts: ConfirmYesNoOptions
): Promise<boolean | null> {
  const stdin: PickerStdin = opts.input ?? (process.stdin as PickerStdin);
  const stdout: PickerStdout = opts.output ?? process.stdout;
  let highlight = opts.initialValue ?? true;

  return new Promise<boolean | null>((resolve) => {
    let session: InputSession | null = null;

    let mode: "menu" | "confirm-exit" = "menu";
    let lastRows = 0;

    const draw = () => {
      clearLines(stdout, lastRows);
      const r = renderConfirm(stdout, opts.message, highlight, mode);
      lastRows = r.rows;
    };

    const cleanup = () => {
      session?.dispose();
    };

    const finish = (result: boolean | null) => {
      cleanup();
      resolve(result);
    };

    const onKey = (key: DecodedKey) => {

      if (key.ctrl && key.name === "c") {
        cleanup();
        quitHandler();
        return;
      }

      if (mode === "confirm-exit") {
        if (key.name === "q" || key.name === "y") {
          cleanup();
          quitHandler();
          return;
        }
        // Esc / n / Enter / anything else → bail back to the y/n prompt.
        mode = "menu";
        draw();
        return;
      }

      // q → quit-with-confirm (the deliberate "leave ALTER" hard key).
      if (key.name === "q") {
        mode = "confirm-exit";
        draw();
        return;
      }

      // Esc cancels this confirm and returns null (back) - same as the
      // pickers, so Esc means back everywhere. Callers treat null falsily
      // (don't proceed), identical to a "No".
      if (key.name === "escape") {
        return finish(null);
      }

      if (key.name === "y") return finish(true);
      if (key.name === "n") return finish(false);

      // ←/→ toggle the Yes/No highlight. (Esc is reserved for cancel above,
      // so it is intentionally NOT a toggle key.)
      if (
        key.name === "left" ||
        key.name === "right" ||
        key.name === "up" ||
        key.name === "down" ||
        key.name === "tab"
      ) {
        highlight = !highlight;
        draw();
        return;
      }

      if (key.name === "return") {
        return finish(highlight);
      }
    };

    session = createInputSession(stdin, onKey, { escDelayMs: opts.escDelayMs });
    const r = renderConfirm(stdout, opts.message, highlight, mode);
    lastRows = r.rows;
  });
}

// ---------------------------------------------------------------------------
// Inline text input - same key contract + visible navigation footer
// ---------------------------------------------------------------------------

export interface TextInputOptions {
  message: string;
  /**
   * Uneditable prefix rendered ahead of the editable body (e.g. "~" for
   * handle entry). The cursor can never move into it and backspace at the
   * body's left edge is a no-op - the prefix ALWAYS persists. The resolved
   * value INCLUDES the prefix, so callers receive a well-formed whole.
   */
  lockedPrefix?: string;
  /** Dim ghost text shown while the body is empty. */
  placeholder?: string;
  /** Pre-filled editable body (EXCLUDING any lockedPrefix). */
  initialValue?: string;
  /**
   * Validate the FULL value (prefix + body). Return an error string to
   * block submit - rendered inline below the field; the input stays live.
   */
  validate?: (value: string) => string | undefined;
  /** Permit submitting an empty body (e.g. "blank clears"). Default false. */
  allowEmpty?: boolean;
  /**
   * Render every body character as a mask glyph (secret entry - passwords,
   * codes). `true` masks with "•"; a string masks with that glyph. The
   * REAL body is still what resolves; only the paint is masked. This is
   * the one capability the clack `password()` prompt had over textInput -
   * with it here, no screen needs clack (and its missing-escape trap).
   */
  mask?: boolean | string;
  /** Inject an alternative input stream - defaults to process.stdin. */
  input?: PickerStdin;
  /** Inject an alternative output stream - defaults to process.stdout. */
  output?: PickerStdout;
  /**
   * ESC-settle delay (ms) forwarded to the shared input session. Omit for
   * the default (50ms on a TTY, 0 off one). Tests inject 0 for immediacy.
   */
  escDelayMs?: number;
}

function renderTextInput(
  out: PickerStdout,
  opts: TextInputOptions,
  body: string,
  cursor: number,
  error: string | null,
): RenderResult {
  const lines: string[] = [];
  lines.push("  " + brand.title(opts.message));
  lines.push("");

  const prefix = opts.lockedPrefix
    ? brand.accentDeep(opts.lockedPrefix)
    : "";

  // Secret entry: paint mask glyphs in place of the body. The cursor
  // still tracks the REAL body's indices - editing behaviour (arrows,
  // backspace, mid-body insert) is unchanged; only the paint differs.
  const maskGlyph =
    opts.mask === true ? "•" : typeof opts.mask === "string" ? opts.mask : null;
  // Repeat per code unit (body.length) so cursor indices align 1:1 with
  // the painted string - the cursor maths below slice by code unit.
  const paint = maskGlyph ? maskGlyph.repeat(body.length) : body;

  let field: string;
  if (body.length === 0) {
    // Empty body: block cursor, then the dim placeholder ghost.
    field =
      prefix +
      "\x1b[7m \x1b[27m" +
      (opts.placeholder ? brand.dim(opts.placeholder) : "");
  } else {
    // Inverse-video block on the char under the cursor (or a trailing
    // space when the cursor sits at the end of the body).
    const before = paint.slice(0, cursor);
    const at = cursor < paint.length ? paint[cursor] : " ";
    const after = cursor < paint.length ? paint.slice(cursor + 1) : "";
    field =
      prefix +
      brand.text(before) +
      "\x1b[7m" + at + "\x1b[27m" +
      brand.text(after);
  }
  lines.push("  " + brand.marker("▸") + " " + field);

  if (error) {
    lines.push("  " + brand.accentDeep(error));
  }

  lines.push("");
  // The navigation footer is the point: every text field SHOWS its way
  // out. Esc goes back; q is an ordinary character here (unlike list
  // pickers), so it is deliberately absent from the footer.
  lines.push(
    "  " +
      brand.muted("⏎") +
      brand.dim(" confirm    ") +
      brand.muted("esc") +
      brand.dim(" back"),
  );

  out.write(lines.join("\n") + "\n");
  return { rows: lines.length };
}

/**
 * Inline single-line text input with the picker family's render idiom
 * and a VISIBLE navigation footer (`⏎ confirm  esc back`) - clack's
 * `text()` shows no way out, which strands users who don't know Esc.
 *
 * Supports an uneditable `lockedPrefix` (the trill for handle entry):
 * the prefix renders in accent ahead of the body, the cursor cannot
 * enter it, and backspace at the boundary is a no-op - so the prefix
 * persists by construction rather than by re-normalisation after the
 * fact.
 *
 * Resolves the FULL value (prefix + body), or `null` when the user
 * pressed Esc (back).
 */
export async function textInput(opts: TextInputOptions): Promise<string | null> {
  const stdin: PickerStdin = opts.input ?? (process.stdin as PickerStdin);
  const stdout: PickerStdout = opts.output ?? process.stdout;
  const prefix = opts.lockedPrefix ?? "";

  let body = opts.initialValue ?? "";
  let cursor = body.length;
  let error: string | null = null;

  return new Promise<string | null>((resolve) => {
    let session: InputSession | null = null;

    let lastRows = 0;

    const draw = () => {
      clearLines(stdout, lastRows);
      const r = renderTextInput(stdout, opts, body, cursor, error);
      lastRows = r.rows;
    };

    const cleanup = () => {
      session?.dispose();
    };

    const finish = (result: string | null) => {
      cleanup();
      resolve(result);
    };

    const onKey = (key: DecodedKey) => {

      // Ctrl+C - hard-out safety net, same as the pickers.
      if (key.ctrl && key.name === "c") {
        cleanup();
        quitHandler();
        return;
      }

      // Esc = back. The one navigation key a text field can promise,
      // and the footer promises it.
      if (key.name === "escape") {
        return finish(null);
      }

      if (key.name === "return") {
        const full = prefix + body;
        if (body.trim().length === 0 && !opts.allowEmpty) {
          error = "Type a value, or press esc to go back.";
          draw();
          return;
        }
        const verdict = opts.validate?.(full);
        if (verdict) {
          error = verdict;
          draw();
          return;
        }
        return finish(full);
      }

      if (key.name === "left") {
        // Cursor floor is 0 - the locked prefix is not addressable.
        if (cursor > 0) {
          cursor--;
          draw();
        }
        return;
      }
      if (key.name === "right") {
        if (cursor < body.length) {
          cursor++;
          draw();
        }
        return;
      }
      if (key.name === "home" || (key.ctrl && key.name === "a")) {
        cursor = 0;
        draw();
        return;
      }
      if (key.name === "end" || (key.ctrl && key.name === "e")) {
        cursor = body.length;
        draw();
        return;
      }

      if (key.name === "backspace") {
        // At the body's left edge this is a no-op: the prefix persists.
        if (cursor > 0) {
          body = body.slice(0, cursor - 1) + body.slice(cursor);
          cursor--;
          error = null;
          draw();
        }
        return;
      }
      if (key.name === "delete") {
        if (cursor < body.length) {
          body = body.slice(0, cursor) + body.slice(cursor + 1);
          error = null;
          draw();
        }
        return;
      }

      // Printable insertion (single keystroke or pasted chunk). Filter to
      // visible characters; control bytes never enter the body.
      if (key.sequence && !key.ctrl && !key.meta) {
        const printable = Array.from(key.sequence)
          .filter((ch) => ch >= " " && ch !== "\x7f")
          .join("");
        if (printable.length > 0) {
          body = body.slice(0, cursor) + printable + body.slice(cursor);
          cursor += printable.length;
          error = null;
          draw();
        }
      }
    };

    session = createInputSession(stdin, onKey, { escDelayMs: opts.escDelayMs });
    const r = renderTextInput(stdout, opts, body, cursor, error);
    lastRows = r.rows;
  });
}

// ---------------------------------------------------------------------------
// Tier 3 - type-the-noun confirm
// ---------------------------------------------------------------------------

export interface ConfirmTypeNounOptions {
  /**
   * The plural-destructive action being confirmed. Rendered above the
   * input as the friction surface. The user must read this and type the
   * noun verbatim - friction designed to be read, not memorised.
   */
  message: string;
  /**
   * Exact noun the user must type to confirm (case-insensitive). Examples
   * per the locked taxonomy:
   *   "sessions"   - Revoke ALL other sessions
   *   "uninstall"  - Uninstall ALL tools
   *   "~handle"    - Delete account (when this surfaces)
   */
  noun: string;
}

/**
 * Plural-destructive confirm - "type the noun".
 *
 * The user must type the configured `noun` exactly (case-insensitive) to
 * proceed. Anything else cancels. Reserved for actions that touch every
 * one of a class - revoke-all sessions, uninstall-all tools, delete
 * account - never single-target mutations (those use `confirmYesNo`).
 *
 * Returns `true` when the user typed the noun and submitted; `false`
 * on cancel, mismatch, or empty input.
 */
export async function confirmTypeNoun(
  opts: ConfirmTypeNounOptions,
): Promise<boolean> {
  const noun = opts.noun.trim();
  if (!noun) return false;
  const ans = await textInput({
    message:
      opts.message + ` Type "${noun}" to confirm - anything else cancels.`,
    placeholder: noun,
    validate: (v) => {
      if (v.trim().toLowerCase() !== noun.toLowerCase()) {
        return `Doesn't match. Type "${noun}" exactly to confirm.`;
      }
      return;
    },
  });
  if (ans === null) return false;
  return ans.trim().toLowerCase() === noun.toLowerCase();
}
