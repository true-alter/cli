/**
 * Raw-byte key decoding for ALTER's interactive surfaces.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Node's `readline.emitKeypressEvents` + `keypress` listeners desync on
 * Windows/PowerShell. The menu surfaces toggle `setRawMode` and pause/resume
 * stdin many times per session (loading spinners, cancel listeners, drain,
 * "press a key to return"). After enough toggles the readline keypress
 * decoder stops emitting on Windows: the listener is still attached but no
 * `keypress` ever fires again, so every navigation key goes dead and the
 * menu freezes. The freeze relocated each time a single surface was patched
 * because the others still used keypress.
 *
 * Raw `data` byte reads are the one input primitive that stays reliable
 * across Windows console, macOS, and Linux through repeated rawMode/pause/
 * resume cycles (confirmed in the field on the `drainBufferedKeys` and
 * `pressEnterToReturn` paths). This module decodes those raw bytes into the
 * same `{ name, ctrl, shift, meta, sequence }` shape the handlers already
 * switch on, so every interactive surface can drop readline keypress and
 * share one transport. With no surface calling `emitKeypressEvents`, the
 * fragile decoder is never attached and there is nothing left to desync.
 */

/** Mirrors the subset of `readline.Key` the interactive handlers read. */
export interface DecodedKey {
  name: string;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  sequence: string;
}

function mk(
  name: string,
  sequence: string,
  extra: Partial<DecodedKey> = {},
): DecodedKey {
  return {
    name,
    sequence,
    ctrl: false,
    shift: false,
    meta: false,
    ...extra,
  };
}

/** Name for a single printable / control ASCII byte (no escape prefix). */
function nameForByte(b: number, seq: string): DecodedKey {
  // Enter (CR or LF).
  if (b === 0x0d || b === 0x0a) return mk("return", seq);
  // Tab.
  if (b === 0x09) return mk("tab", seq);
  // Backspace: DEL (0x7f) and BS (0x08) both map to backspace, matching
  // readline (terminals disagree on which they send).
  if (b === 0x7f || b === 0x08) return mk("backspace", seq);
  // Space.
  if (b === 0x20) return mk("space", seq);
  // Ctrl-letter: 0x01..0x1a → ctrl+a..ctrl+z. 0x1b (Esc), 0x09 (Tab),
  // 0x0d/0x0a (Enter), 0x08 (BS) are handled above and never reach here.
  if (b >= 0x01 && b <= 0x1a) {
    const letter = String.fromCharCode(b + 0x60); // 0x01 → 'a'
    return mk(letter, seq, { ctrl: true });
  }
  // Printable ASCII.
  if (b >= 0x21 && b <= 0x7e) {
    const ch = String.fromCharCode(b);
    const lower = ch.toLowerCase();
    // Shift is set for an uppercase letter, matching readline's behaviour.
    const shift = ch >= "A" && ch <= "Z";
    return mk(lower, seq, { shift });
  }
  // Unknown / non-ASCII byte: surface it as an unnamed key so handlers
  // that typeahead-filter on `sequence` still see the character.
  return mk("", seq);
}

/** Decode the tail of a CSI / SS3 escape sequence (the bytes after ESC [ or ESC O). */
function decodeEscapeFinal(final: number, seq: string): DecodedKey {
  switch (final) {
    case 0x41:
      return mk("up", seq); // A
    case 0x42:
      return mk("down", seq); // B
    case 0x43:
      return mk("right", seq); // C
    case 0x44:
      return mk("left", seq); // D
    case 0x48:
      return mk("home", seq); // H
    case 0x46:
      return mk("end", seq); // F
    default:
      // Unrecognised CSI/SS3 final byte: treat as a bare Escape rather than
      // a dead key, so an unknown sequence can never trap the surface.
      return mk("escape", "\x1b");
  }
}

/**
 * Decode one raw `data` chunk into zero or more keys. Greedy: a chunk that
 * carries several keystrokes (fast typing, paste, or a queued backlog) yields
 * one DecodedKey per keystroke in order.
 */
export function decodeKeys(buf: Buffer): DecodedKey[] {
  const keys: DecodedKey[] = [];
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];

    if (b === 0x1b) {
      const next = i + 1 < buf.length ? buf[i + 1] : -1;

      // CSI ( ESC [ ) or SS3 ( ESC O ) — arrow / home / end / etc.
      if (next === 0x5b || next === 0x4f) {
        // Find the final byte. CSI params are digits / ';' (0x30..0x3b);
        // the final byte is 0x40..0x7e. SS3 is ESC O <final>.
        let j = i + 2;
        if (next === 0x4f) {
          // SS3: exactly one final byte.
          if (j < buf.length) {
            const seq = buf.toString("latin1", i, j + 1);
            keys.push(decodeEscapeFinal(buf[j], seq));
            i = j + 1;
            continue;
          }
          // Truncated SS3: treat the ESC as Escape.
          keys.push(mk("escape", "\x1b"));
          i += 1;
          continue;
        }
        // CSI: skip parameter/intermediate bytes to the final byte.
        while (j < buf.length && buf[j] >= 0x30 && buf[j] <= 0x3f) j++;
        if (j < buf.length) {
          const finalByte = buf[j];
          const seq = buf.toString("latin1", i, j + 1);
          // Tilde-terminated CSI (e.g. ESC [ 3 ~ = delete, 1~/7~ = home,
          // 4~/8~ = end, 5~/6~ = pageup/pagedown). Map the common ones;
          // everything else → escape.
          if (finalByte === 0x7e) {
            const param = buf.toString("latin1", i + 2, j); // digits before ~
            if (param === "3") keys.push(mk("delete", seq));
            else if (param === "1" || param === "7") keys.push(mk("home", seq));
            else if (param === "4" || param === "8") keys.push(mk("end", seq));
            else if (param === "5") keys.push(mk("pageup", seq));
            else if (param === "6") keys.push(mk("pagedown", seq));
            else keys.push(mk("escape", "\x1b"));
          } else {
            keys.push(decodeEscapeFinal(finalByte, seq));
          }
          i = j + 1;
          continue;
        }
        // Truncated CSI: treat the ESC as Escape.
        keys.push(mk("escape", "\x1b"));
        i += 1;
        continue;
      }

      // ESC + printable = Alt/Meta + key (e.g. Alt-Enter, Alt-x).
      if (next >= 0x20 && next <= 0x7e) {
        const seq = buf.toString("latin1", i, i + 2);
        const base = nameForByte(next, seq);
        keys.push({ ...base, meta: true });
        i += 2;
        continue;
      }

      // Lone ESC (or ESC followed by a control byte): Escape.
      keys.push(mk("escape", "\x1b"));
      i += 1;
      continue;
    }

    // UTF-8 multibyte character (lead byte 0xc0..0xff): consume the whole
    // sequence so typed / pasted non-ASCII text inserts intact rather than
    // byte-split. name stays "" (not a navigation key); text fields read it
    // through `sequence`.
    if (b >= 0xc0) {
      const len = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
      if (i + len <= buf.length) {
        keys.push(mk("", buf.toString("utf8", i, i + len)));
        i += len;
        continue;
      }
    }

    // Single-byte (ASCII / control) key.
    const seq = String.fromCharCode(b);
    keys.push(nameForByte(b, seq));
    i += 1;
  }
  return keys;
}

/**
 * Length of the longest prefix of `buf` that decodes to *complete* keys,
 * leaving any incomplete trailing escape (or UTF-8 multibyte) sequence
 * behind. The returned index is where the held tail begins; `buf.length`
 * means the whole buffer is complete and nothing needs to be carried over.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Windows/PowerShell can split a single keypress across two `data` reads:
 * an arrow arrives as `ESC` in one chunk and `[A` in the next. The pure
 * {@link decodeKeys} is stateless, so it would turn that lone trailing `ESC`
 * into a spurious Escape (a phantom quit) and then mis-read the `[A`. A
 * genuine single `ESC` is likewise indistinguishable from the start of a
 * sequence without waiting. The stream layer ({@link createInputSession})
 * uses this to hold the incomplete tail until the next chunk completes it
 * (a split arrow reassembles) or a short timer flushes it as Escape (a real
 * single ESC registers on one press).
 *
 * The consumption logic mirrors {@link decodeKeys} byte-for-byte so the two
 * never disagree about where a token ends.
 */
export function completePrefixLength(buf: Buffer): number {
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];

    if (b === 0x1b) {
      // Lone trailing ESC: could be a bare Escape OR the start of a
      // CSI/SS3/Alt sequence. Hold it.
      if (i + 1 >= buf.length) return i;
      const next = buf[i + 1];

      // CSI ( ESC [ ): scan params (0x30..0x3f) for the final byte.
      if (next === 0x5b) {
        let j = i + 2;
        while (j < buf.length && buf[j] >= 0x30 && buf[j] <= 0x3f) j++;
        if (j < buf.length) {
          i = j + 1; // final byte present — complete
          continue;
        }
        return i; // truncated CSI — hold
      }

      // SS3 ( ESC O ): exactly one final byte at i+2.
      if (next === 0x4f) {
        if (i + 2 < buf.length) {
          i += 3;
          continue;
        }
        return i; // truncated SS3 — hold
      }

      // ESC + printable = Alt/Meta + key (both bytes present here).
      if (next >= 0x20 && next <= 0x7e) {
        i += 2;
        continue;
      }

      // ESC + control byte: decodeKeys consumes the ESC alone as Escape.
      i += 1;
      continue;
    }

    // UTF-8 multibyte lead byte: hold a truncated trailing sequence so a
    // split character reassembles intact rather than byte-splitting.
    if (b >= 0xc0) {
      const len = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
      if (i + len <= buf.length) {
        i += len;
        continue;
      }
      return i; // truncated UTF-8 — hold
    }

    // Single-byte (ASCII / control) key.
    i += 1;
  }
  return i; // == buf.length: everything is complete
}

/** Handle returned by {@link onRawKeys}; call `dispose()` to detach. */
export interface RawKeyHandle {
  dispose(): void;
}

/**
 * Attach a raw-byte key listener to a stdin-like stream. Decodes each `data`
 * chunk via {@link decodeKeys} and invokes `handler` once per key. Returns a
 * handle whose `dispose()` detaches the underlying `data` listener.
 *
 * The caller owns rawMode + resume/pause exactly as before (this only swaps
 * the `keypress` transport for raw `data`); it never calls
 * `emitKeypressEvents`, so the readline keypress decoder is never attached.
 *
 * Prefer {@link createInputSession} for interactive surfaces — it owns the
 * full rawMode/resume lifecycle AND the cross-chunk reassembly that makes
 * navigation single-click on Windows. `onRawKeys` remains for callers that
 * already manage their own lifecycle and only want the byte→key transport.
 */
export function onRawKeys(
  stdin: NodeJS.ReadStream,
  handler: (key: DecodedKey) => void,
): RawKeyHandle {
  const onData = (chunk: Buffer): void => {
    for (const key of decodeKeys(asBuffer(chunk))) handler(key);
  };
  forceBufferMode(stdin as InputSessionStdin);
  stdin.on("data", onData);
  return {
    dispose(): void {
      stdin.removeListener("data", onData);
    },
  };
}

/**
 * The minimal stdin shape {@link createInputSession} drives. `process.stdin`
 * satisfies it; tests pass a fake EventEmitter-shaped stream so node:test's
 * own stdin handling doesn't swallow the synthetic bytes.
 */
export interface InputSessionStdin {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  setEncoding?: (encoding?: BufferEncoding) => unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", listener: (buf: Buffer) => void): unknown;
  removeListener(event: "data", listener: (buf: Buffer) => void): unknown;
}

/**
 * Put the stream back into Buffer mode before we attach.
 *
 * `process.stdin` is a process-wide singleton and `setEncoding` on it is
 * sticky: once any caller sets one, every later `data` chunk arrives as a
 * string, for the life of the process. This decoder reads bytes, so a string
 * chunk is not a degraded input, it is a crash. Re-asserting Buffer mode at
 * every attach makes the transport independent of whatever ran before it.
 */
function forceBufferMode(stdin: InputSessionStdin): void {
  try {
    // `setEncoding(null)` is Node's documented revert-to-Buffer call; the
    // published types only admit an encoding or `undefined`, hence the cast.
    (stdin.setEncoding as ((encoding: null) => unknown) | undefined)?.(null);
  } catch {
    // A stream without a settable encoding is already in Buffer mode.
  }
}

/**
 * Coerce a `data` chunk to a Buffer. Belt-and-braces behind
 * {@link forceBufferMode}: a stream we do not own could set an encoding
 * between our attach and the keypress, and dropping the key beats throwing.
 */
function asBuffer(chunk: Buffer | string): Buffer {
  return typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
}

export interface InputSessionOptions {
  /**
   * How long (ms) to hold a lone trailing ESC before flushing it as Escape,
   * waiting for a possible continuation (a split arrow). Defaults to 50ms on
   * a TTY and 0 off a TTY (piped / test input arrives atomically, so there
   * is nothing to wait for). A value <= 0 flushes on a microtask, which
   * keeps synthetic single-ESC tests resolving on the next tick.
   */
  escDelayMs?: number;
}

/** Handle returned by {@link createInputSession}; `dispose()` tears it down. */
export interface InputSession {
  dispose(): void;
}

// ───────────────────────────────────────────────────────────────────────────
// Persistent transport — the Windows-freeze fix (one keyboard reader per
// interactive session, not one per prompt).
//
// WHY A SINGLETON
// ───────────────
// The Windows console stops delivering `data` events to a *freshly re-armed*
// raw reader after a prior reader detached: the menu re-arming after a leaf, or
// the second of two back-to-back prompts inside a flow (the wallet payout:
// withLoadingCancel → pickOne → textInput). Each surface used to attach its own
// `data` listener + toggle rawMode and detach on dispose; that detach/re-attach
// churn is exactly what Windows mishandles, so the reader armed cleanly
// (raw=true, resumed, listener attached) yet received no bytes and the surface
// hung (traced as `arm#N` with no `data#N`).
//
// The fix: ONE transport (rawMode + a single `data` listener + the cross-chunk
// reassembly state) is acquired once and HELD across consecutive prompts.
// Surfaces no longer attach/detach the underlying listener; they push a handler
// onto a stack and the held listener routes each key to the top handler. The
// listener is never detached between prompts, so Windows keeps delivering
// bytes (the failure was: a re-armed reader looked correct — raw on, resumed,
// listener attached — yet received no bytes). A short grace window defers the
// real release after the stack empties, so the sub-frame gap between one prompt
// disposing and the next pushing never tears the transport down (no re-arm ⇒
// no freeze).
//
// CLACK COEXISTENCE
// ─────────────────
// Every menu-reachable interactive surface reads stdin through this primitive.
// The @clack/prompts usages reachable from the menu are output-only
// (intro/outro/spinner/cancel/log) and never read stdin, so a held raw listener
// does not fight clack. The only clack stdin readers (login/mfa password) are
// standalone commands run before the menu, never mid-session.
//
// NON-TTY (tests, piped input): the grace window is skipped and the transport
// releases synchronously on the last pop, preserving the exact pre-existing
// lifecycle the unit tests assert against.
// ───────────────────────────────────────────────────────────────────────────

interface HandlerFrame {
  handler: (key: DecodedKey) => void;
  escDelayMs: number;
}

interface Transport {
  stdin: InputSessionStdin;
  canRaw: boolean;
  wasRaw: boolean;
  stack: HandlerFrame[];
  pending: Buffer;
  timer: ReturnType<typeof setTimeout> | null;
  // Bumped whenever the held tail changes; a scheduled flush whose captured
  // generation no longer matches is stale and silently skips.
  gen: number;
  releaseTimer: ReturnType<typeof setTimeout> | null;
  onData: (chunk: Buffer) => void;
  exitHook: (() => void) | null;
}

let transport: Transport | null = null;

/** ms to hold the transport armed after the handler stack empties (TTY only). */
const GRACE_MS = 750;

const topFrame = (t: Transport): HandlerFrame | null =>
  t.stack.length > 0 ? t.stack[t.stack.length - 1] : null;

function physicallyRelease(t: Transport): void {
  if (t.timer) {
    clearTimeout(t.timer);
    t.timer = null;
  }
  if (t.releaseTimer) {
    clearTimeout(t.releaseTimer);
    t.releaseTimer = null;
  }
  try {
    t.stdin.removeListener("data", t.onData);
  } catch {
    // best-effort teardown
  }
  if (t.canRaw) {
    try {
      t.stdin.setRawMode!(t.wasRaw);
    } catch {
      // best-effort
    }
  }
  try {
    t.stdin.pause();
  } catch {
    // best-effort
  }
  if (t.exitHook) {
    try {
      process.removeListener("exit", t.exitHook);
    } catch {
      // best-effort
    }
    t.exitHook = null;
  }
  if (transport === t) transport = null;
}

function acquireTransport(stdin: InputSessionStdin): Transport {
  const canRaw = !!(stdin.isTTY && stdin.setRawMode);
  const wasRaw = !!stdin.isRaw;

  const t: Transport = {
    stdin,
    canRaw,
    wasRaw,
    stack: [],
    pending: Buffer.alloc(0),
    timer: null,
    gen: 0,
    releaseTimer: null,
    onData: () => {},
    exitHook: null,
  };

  const emit = (buf: Buffer): void => {
    const frame = topFrame(t);
    if (!frame) return; // no active surface: discard (idle between prompts)
    for (const key of decodeKeys(buf)) frame.handler(key);
  };

  const clearTimer = (): void => {
    t.gen++;
    if (t.timer) {
      clearTimeout(t.timer);
      t.timer = null;
    }
  };

  const flushPending = (): void => {
    if (t.timer) {
      clearTimeout(t.timer);
      t.timer = null;
    }
    if (t.pending.length === 0) return;
    const buf = t.pending;
    t.pending = Buffer.alloc(0);
    emit(buf);
  };

  const arm = (): void => {
    const frame = topFrame(t);
    const escDelayMs = frame ? frame.escDelayMs : 0;
    const myGen = t.gen;
    const run = (): void => {
      if (transport !== t || myGen !== t.gen) return;
      flushPending();
    };
    if (escDelayMs <= 0) {
      queueMicrotask(run);
    } else {
      t.timer = setTimeout(run, escDelayMs);
    }
  };

  t.onData = (chunk: Buffer): void => {
    if (transport !== t) return;
    clearTimer(); // invalidate any armed flush; a new chunk may complete the tail
    const bytes = asBuffer(chunk);
    const buf = t.pending.length ? Buffer.concat([t.pending, bytes]) : bytes;
    const split = completePrefixLength(buf);
    if (split > 0) emit(buf.subarray(0, split));
    t.pending =
      split < buf.length ? Buffer.from(buf.subarray(split)) : Buffer.alloc(0);
    if (t.pending.length > 0) arm();
  };

  // Windows clack-handoff warm-up, ONCE per acquire (a terminal-handoff
  // boundary), not per prompt. Strip any stale `keypress` decoder a prior
  // readline/clack flow left attached and re-cycle raw mode so the Windows TTY
  // hands bytes to our `data` listener. Windows-only; the Linux/FakeStdin path
  // is left byte-for-byte unchanged.
  if (process.platform === "win32" && canRaw) {
    try {
      (stdin as unknown as { removeAllListeners?: (e: string) => void })
        .removeAllListeners?.("keypress");
    } catch {
      // best-effort: a missing removeAllListeners must never block arming
    }
    try {
      stdin.setRawMode!(false);
      stdin.setRawMode!(true);
    } catch {
      // best-effort: raw-mode re-cycle is a kick, not a correctness step
    }
  }
  // Lifecycle arm order: rawMode → attach → resume (the Windows fix).
  if (canRaw) stdin.setRawMode!(true);
  forceBufferMode(stdin);
  stdin.on("data", t.onData);
  stdin.resume();

  // Safety: restore the terminal if the process exits while the transport is
  // still held (Windows does not reliably clear raw mode on exit).
  if (canRaw) {
    const hook = (): void => {
      try {
        stdin.setRawMode!(wasRaw);
      } catch {
        // best-effort
      }
    };
    t.exitHook = hook;
    try {
      process.once("exit", hook);
    } catch {
      // best-effort
    }
  }

  return t;
}

/**
 * Release the persistent keyboard transport immediately, restoring the
 * terminal's prior raw state. Call this when interactive input is fully done
 * (e.g. the menu quits or the process is about to hand the terminal back to the
 * shell) so the TTY is not left in raw mode for the grace window. A no-op when
 * no transport is held; safe to call repeatedly.
 */
export function releaseKeyboardTransport(): void {
  if (transport) physicallyRelease(transport);
}

/**
 * Original per-session keyboard primitive: own the full stdin lifecycle
 * (rawMode → attach → resume on create; flush → detach → restore → pause on
 * dispose), with cross-chunk reassembly and the held-ESC flush timer. This is
 * the path for every platform/stream EXCEPT a Windows TTY: Linux/macOS already
 * re-arm cleanly between prompts, and the unit tests drive a non-TTY FakeStdin,
 * so this lifecycle stays byte-for-byte what they assert against.
 */
function legacyInputSession(
  stdin: InputSessionStdin,
  handler: (key: DecodedKey) => void,
  opts: InputSessionOptions = {},
): InputSession {
  const canRaw = !!(stdin.isTTY && stdin.setRawMode);
  const escDelayMs = opts.escDelayMs ?? (stdin.isTTY ? 50 : 0);

  let pending: Buffer = Buffer.alloc(0);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let gen = 0;

  const emit = (buf: Buffer): void => {
    for (const key of decodeKeys(buf)) handler(key);
  };

  const clearTimer = (): void => {
    gen++;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const flushPending = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.length === 0) return;
    const buf = pending;
    pending = Buffer.alloc(0);
    emit(buf);
  };

  const arm = (): void => {
    const myGen = gen;
    const run = (): void => {
      if (disposed || myGen !== gen) return;
      flushPending();
    };
    if (escDelayMs <= 0) {
      queueMicrotask(run);
    } else {
      timer = setTimeout(run, escDelayMs);
    }
  };

  const onData = (chunk: Buffer): void => {
    if (disposed) return;
    clearTimer();
    const bytes = asBuffer(chunk);
    const buf = pending.length ? Buffer.concat([pending, bytes]) : bytes;
    const split = completePrefixLength(buf);
    if (split > 0) emit(buf.subarray(0, split));
    pending =
      split < buf.length ? Buffer.from(buf.subarray(split)) : Buffer.alloc(0);
    if (pending.length > 0) arm();
  };

  const wasRaw = !!stdin.isRaw;
  if (canRaw) stdin.setRawMode!(true);
  forceBufferMode(stdin);
  stdin.on("data", onData);
  stdin.resume();

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (pending.length > 0) {
        const buf = pending;
        pending = Buffer.alloc(0);
        emit(buf);
      }
      stdin.removeListener("data", onData);
      if (canRaw) stdin.setRawMode!(wasRaw);
      stdin.pause();
    },
  };
}

/**
 * One hardened keyboard primitive for every interactive surface.
 *
 * On a Windows TTY it pushes `handler` onto the shared persistent transport
 * (acquiring it on first use) and routes every decoded key to the top-most
 * active handler; the transport stays armed across consecutive prompts (a short
 * grace window bridges the gap between one prompt disposing and the next
 * pushing), so the `data` listener is never torn down and re-armed — the Windows
 * re-arm freeze cannot occur. On every OTHER platform/stream it falls through to
 * {@link legacyInputSession}, the original per-session lifecycle, unchanged.
 *
 * The signature is identical for both paths, so no call site changes.
 */
export function createInputSession(
  stdin: InputSessionStdin,
  handler: (key: DecodedKey) => void,
  opts: InputSessionOptions = {},
): InputSession {
  const canRaw = !!(stdin.isTTY && stdin.setRawMode);
  // Persistent singleton transport ONLY on Windows TTYs, where the re-arm
  // freeze lives. Everything else (Linux/macOS TTY, any non-TTY/piped stream,
  // the test FakeStdin) keeps the original per-session lifecycle byte-for-byte.
  if (!(canRaw && process.platform === "win32")) {
    return legacyInputSession(stdin, handler, opts);
  }

  // Acquire on first use. A held transport for a *different* stdin is released
  // first so the new stream owns it (defensive; on Windows it is always
  // process.stdin).
  if (transport && transport.stdin !== stdin) physicallyRelease(transport);
  if (!transport) transport = acquireTransport(stdin);
  const t = transport;

  // A fresh push cancels any pending grace release, so the held listener is
  // never torn down between consecutive prompts (the freeze fix).
  if (t.releaseTimer) {
    clearTimeout(t.releaseTimer);
    t.releaseTimer = null;
  }

  const escDelayMs = opts.escDelayMs ?? 50; // win32 TTY
  const frame: HandlerFrame = { handler, escDelayMs };
  t.stack.push(frame);

  let disposed = false;
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      // Flush any held key to THIS frame before removing it (preserves the
      // "dispose flushes a held key" contract). Only the top frame owns the
      // pending tail.
      if (topFrame(t) === frame && t.pending.length > 0) {
        const buf = t.pending;
        t.pending = Buffer.alloc(0);
        for (const key of decodeKeys(buf)) frame.handler(key);
      }
      if (t.timer) {
        clearTimeout(t.timer);
        t.timer = null;
      }
      const idx = t.stack.lastIndexOf(frame);
      if (idx >= 0) t.stack.splice(idx, 1);
      if (t.stack.length > 0) return; // another surface is active: keep armed

      // Stack empty: defer the release a grace window so the next prompt reuses
      // the held listener instead of re-arming.
      t.releaseTimer = setTimeout(() => {
        if (transport === t && t.stack.length === 0) physicallyRelease(t);
      }, GRACE_MS);
      (t.releaseTimer as unknown as { unref?: () => void }).unref?.();
    },
  };
}
