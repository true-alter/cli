/**
 * messenger render - pure state → string-array transformations.
 *
 * No I/O, no side effects. The app loop calls renderBody(state) and
 * passes the result to drawFrame from biosMenu. Every visible pane is
 * just a slice of that body. Splitting render from app keeps the
 * keybind logic readable and lets us snapshot-test the panes without
 * spinning up an alt-screen.
 */

import stripAnsi from "strip-ansi";

import { brand, termSize } from "../ui/biosMenu.js";
import {
  formatAge,
  fuzzyMatch,
  presenceFor,
  type Conversation,
  type MessengerSnapshot,
  type ThreadMessage,
} from "./state.js";

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Side-by-side panes are visible when the inner frame width hits this. */
const TWO_PANE_MIN_COLS = 80;

interface Geometry {
  cols: number;
  rows: number;
  inner: number;
  bodyHeight: number;
  twoPane: boolean;
  leftWidth: number;
  rightWidth: number;
}

function geometry(): Geometry {
  const { cols, rows } = termSize();
  const inner = cols - 6;
  // drawFrame reserves 2 rows for top/bottom border, 2 for the footer
  // strip, and 3 for the hint strip. Keep this in lockstep with the
  // chrome math in the bios-menu frame drawer.
  const bodyHeight = Math.max(8, rows - 2 - 3 - 2);
  const twoPane = inner >= TWO_PANE_MIN_COLS - 6;
  const leftWidth = twoPane ? Math.floor(inner * 0.32) : inner;
  const rightWidth = twoPane ? inner - leftWidth - 3 : inner;
  return { cols, rows, inner, bodyHeight, twoPane, leftWidth, rightWidth };
}

function visualLen(s: string): number {
  return stripAnsi(s).length;
}

function pad(s: string, width: number): string {
  const v = visualLen(s);
  if (v === width) return s;
  if (v > width) {
    // Strip ANSI before slicing so the cut never lands inside an escape
    // sequence (would leak unterminated SGR codes into the next row).
    // Mirrors the 2026-04-24 biosMenu fix. Colour is lost on overflow -
    // accepted as the lesser evil vs. visual corruption - but the exact-
    // fit branch above keeps colour intact for rows that just fit.
    return stripAnsi(s).slice(0, width);
  }
  return s + " ".repeat(width - v);
}

function truncate(s: string, width: number): string {
  const v = visualLen(s);
  if (v <= width) return s;
  // ANSI-naive: this is acceptable because our render strings keep
  // chalk segments short and self-contained. If a row ever spans a
  // chalk segment past the budget, the segment gets cut at a safe
  // visual column and the renderer continues; chalk auto-emits an SGR
  // reset at the end of each line so colour state doesn't leak.
  return stripAnsi(s).slice(0, Math.max(0, width - 1)) + "…";
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export interface RenderedFrame {
  title: string;
  body: string[];
  hint?: string;
  footer: string;
}

export function render(snap: MessengerSnapshot): RenderedFrame {
  const geo = geometry();

  switch (snap.pane) {
    case "jump":
      return renderJumpOverlay(snap, geo);
    case "search":
      return renderSearchOverlay(snap, geo);
    case "grant":
      return renderGrantOverlay(snap, geo);
    case "presence":
      return renderPresencePane(snap, geo);
    default:
      // list + compose share the same two-pane layout - the thread is
      // always drawn; `compose` only adds the active cursor on the
      // compose bar.
      return renderMain(snap, geo);
  }
}

// ---------------------------------------------------------------------------
// Main two-pane (or stacked) layout
// ---------------------------------------------------------------------------

function renderMain(snap: MessengerSnapshot, geo: Geometry): RenderedFrame {
  const conv =
    snap.selectedConversationIndex >= 0
      ? snap.conversations[snap.selectedConversationIndex]
      : null;

  const left = renderConversationList(snap, geo);
  const right = conv ? renderThread(snap, conv, geo) : renderEmptyRight(geo);

  let body: string[];
  if (geo.twoPane) {
    body = stitchTwoColumns(left, right, geo);
  } else {
    // Stacked: list on top, thread below - match the room view's vertical pattern.
    body = [...left, "", brand.borderDim("  " + "─".repeat(geo.inner - 4)), "", ...right];
  }

  // Compose bar always pinned at the bottom of the body section so the
  // user can see what they're about to send without losing thread context.
  // CRITICAL: trim panes BEFORE appending compose. A naive `slice(0,
  // bodyHeight)` after the push would clip the compose row when panes are
  // tall (many conversations or a long thread) and the user would see no
  // visible echo of what they're typing.
  const composeRows = renderComposeBar(snap, geo);
  const flashRows: string[] = [];
  if (snap.flash && Date.now() < snap.flash.until_ms) {
    const tinter =
      snap.flash.kind === "ok"
        ? brand.accent
        : snap.flash.kind === "error"
          ? brand.accentDeep
          : brand.dim;
    flashRows.push("  " + tinter(`· ${snap.flash.text} ·`));
  }

  const reserve = composeRows.length + 1 /* blank separator */ + flashRows.length;
  const paneBudget = Math.max(0, geo.bodyHeight - reserve);
  if (body.length > paneBudget) {
    body = body.slice(0, paneBudget);
  }

  body = [...flashRows, ...body, "", ...composeRows];

  return {
    title: titleFor(snap),
    body,
    hint: hintFor(snap),
    footer: footerFor(snap, geo),
  };
}

// ---------------------------------------------------------------------------
// Header / title / hint / footer
// ---------------------------------------------------------------------------

/**
 * Title bar: `~Alter · <where you are>` - exactly two segments, always.
 * The user is in the Messenger, so the title is `~Alter · Messenger`,
 * full stop. No peer handle (`· ~peer` reads as "you are ~peer"), and no
 * pane/overlay third segment - Jump / Search / Grants / Room are surfaces
 * *within* the Messenger and announce themselves in their own pane content
 * and the hint line, not the chrome. The signed-in handle never appears in
 * any chrome (the locked CLI-chrome rule).
 *
 * Takes `snap` for call-site stability and in case a future pane warrants a
 * distinct top-level label; it is intentionally unused today.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function titleFor(snap: MessengerSnapshot): string {
  return brand.title("~Alter") + brand.dim(" · ") + brand.titleDim("Messenger");
}

function hintFor(snap: MessengerSnapshot): string {
  switch (snap.pane) {
    case "list":
      return "↑↓ pick a peer · Enter / → to write · Ctrl-K jump · / search";
    case "compose":
      return "type, Enter sends · Ctrl-E for multiline in $EDITOR · Esc back to list";
    case "presence":
      return "voluntary broadcasts from granted peers · e emits your own";
    default:
      return "";
  }
}

/**
 * Transport state → single-word footer token. `live` when SSE is up, falls
 * back through `polling` when we're on the long-poll path, `offline` when
 * everything is failing. Keeps to one short token so the right-edge slot
 * stays compact.
 */
function transportLabel(snap: MessengerSnapshot): string {
  const s = snap.transportStatus;
  if (!s) return "connecting";
  if (s.active === "sse" && s.sse === "live") return "live";
  if (s.active === "daemon" && s.daemon === "live") return "live";
  if (s.active === "poll") return "polling";
  if (s.sse === "connecting") return "connecting";
  return "offline";
}

/**
 * Right-edge transport chip. No handle prefix - the locked CLI-chrome rule
 * bans `~handle` in any
 * footer; transport state alone may chrome to tell the user whether the
 * wire is carrying their messages. One short token so the right edge stays
 * compact at 80-col floor.
 */
function transportChip(snap: MessengerSnapshot): string {
  return brand.muted(transportLabel(snap));
}

/**
 * Join a left-aligned keymap and the right-edge transport chip into a
 * single footer row, sizing the gutter so the chip clings to the inner
 * frame width. Floor of 2 spaces between the two halves so the keymap
 * never touches the chip at the narrowest terminal width.
 */
function joinFooter(keymap: string, snap: MessengerSnapshot, geo: Geometry): string {
  const tail = transportChip(snap);
  const gap = Math.max(2, geo.inner - visualLen(keymap) - visualLen(tail));
  return keymap + " ".repeat(gap) + tail;
}

/**
 * Footer is two information classes in one row: the keymap left-aligned
 * for muscle memory, transport state pinned hard-right so the user always
 * knows whether the wire is actually carrying their messages. The two
 * halves are joined by a gutter sized to the current terminal width.
 */
function footerFor(snap: MessengerSnapshot, geo: Geometry): string {
  const k = (label: string, desc: string): string =>
    brand.muted(label) + brand.dim(` ${desc}`);
  const keymap =
    k("↑↓", "nav  ") +
    k("↵", "write  ") +
    k("^E", "$EDITOR  ") +
    k("^K", "jump  ") +
    k("/", "search  ") +
    k("n", "new  ") +
    k("g", "grants  ") +
    k("R", "read  ") +
    k("q", "back");
  return joinFooter(keymap, snap, geo);
}

// ---------------------------------------------------------------------------
// Conversation list pane
// ---------------------------------------------------------------------------

/**
 * Handle styling encodes BOTH read state and presence through brightness -
 * no glyphs, no text-labels, no dots. Unread always wins the colour slot
 * (handles with new messages render in brand gold), then the read-state
 * grade falls back through text → muted → faint based on the peer's
 * presence broadcast. The selection marker `▸` is the only non-handle
 * decoration on the row.
 *
 *   unread          → brand.title  (gold, bold)
 *   read + here     → brand.text   (paper-bright)
 *   read + focus    → brand.text   (paper-bright; focus reads as engaged)
 *   read + open     → brand.muted  (legible but quiet)
 *   read + quiet    → brand.dim
 *   read + no data  → brand.muted  (default)
 *   read + away/old → brand.faint  (fades out of the list visually)
 */
function styleHandleByState(
  snap: MessengerSnapshot,
  conv: Conversation,
): string {
  if (conv.unread > 0) return brand.title(conv.peer);
  const presence = presenceFor(snap, conv.peer);
  if (!presence) return brand.muted(conv.peer);
  switch (presence.state) {
    case "here":
    case "focus":
      return brand.text(conv.peer);
    case "open":
      return brand.muted(conv.peer);
    case "quiet":
      return brand.dim(conv.peer);
    default:
      return brand.faint(conv.peer);
  }
}

function renderConversationList(snap: MessengerSnapshot, geo: Geometry): string[] {
  const out: string[] = [];
  const w = geo.leftWidth;
  out.push(
    pad(
      brand.titleDim("conversations") +
        brand.dim(`  (${snap.conversations.length})`),
      w,
    ),
  );
  out.push(pad(brand.borderDim("─".repeat(Math.max(4, w - 2))), w));

  if (snap.conversations.length === 0) {
    out.push(pad(brand.faint("  no conversations yet"), w));
    out.push(pad(brand.faint("  press n to start one"), w));
    return out;
  }

  snap.conversations.forEach((conv, i) => {
    const selected = i === snap.selectedConversationIndex;
    const marker = selected ? brand.marker("▸") : " ";
    const peerLabel = styleHandleByState(snap, conv);
    const unreadCount =
      conv.unread > 0 ? brand.title(`${conv.unread}`) : "";
    const head = `${marker} ${peerLabel}`;
    const tail = unreadCount;
    const tailLen = visualLen(tail);
    const headFit = truncate(head, Math.max(1, w - tailLen - 2));
    out.push(pad(headFit, w - tailLen - 1) + " " + tail);
    // Preview on every row, 2-space indent (down from 4 - see Q3 lock).
    if (conv.preview) {
      out.push(pad("  " + brand.faint(conv.preview), w));
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Thread pane
// ---------------------------------------------------------------------------

/**
 * Right-flush a single line inside a column of width `w`. ANSI-aware width
 * via `visualLen`. If the visible content is wider than the column, fall
 * back to flush-left - the line is already too wide to right-align cleanly,
 * and forcing right-flush at that point would push text off the column.
 */
function flushRight(s: string, w: number): string {
  const v = visualLen(s);
  if (v >= w) return s;
  return " ".repeat(w - v) + s;
}

function renderThread(snap: MessengerSnapshot, conv: Conversation, geo: Geometry): string[] {
  const out: string[] = [];
  const w = geo.rightWidth;
  out.push(pad(brand.handle(conv.peer) + brand.dim(`  (${conv.thread.length})`), w));
  out.push(pad(brand.borderDim("─".repeat(Math.max(4, w - 2))), w));

  if (conv.thread.length === 0) {
    out.push(pad(brand.faint("  no messages with " + conv.peer + " yet"), w));
    return out;
  }

  // Show the tail of the thread that fits in the available rows; the
  // compose bar + status take ~6 rows, conversation list takes the rest
  // of `bodyHeight` when stacked. In two-pane mode the thread gets the
  // full body height, minus the header rows we just drew.
  const headerRows = 2;
  const composeReserve = 6;
  const available = Math.max(4, geo.bodyHeight - headerRows - composeReserve);
  // Apply search filter when active.
  const filtered =
    snap.searchFilter.length > 0
      ? conv.thread.filter((m) => fuzzyMatch(snap.searchFilter, m.body))
      : conv.thread;

  const tail = filtered.slice(Math.max(0, filtered.length - available));
  // Width of the message-body column inside the thread pane. We bias the
  // bodies tighter than the pane width itself so neither flush-left nor
  // flush-right reads as a wall; ~70% of pane width with sane floor/ceiling.
  // Below ~40 cols of right-pane width, right-flush would collide with the
  // left edge - at that point we degrade to flush-left for both directions.
  const RIGHT_FLUSH_MIN = 40;
  const useRightFlush = w >= RIGHT_FLUSH_MIN;
  const bodyCol = Math.max(20, Math.min(w - 2, Math.floor(w * 0.72)));

  let prevSender: string | null = null;
  for (const m of tail) {
    const inbound = m.direction === "in";
    const senderHandle = inbound ? conv.peer : snap.me;
    const flushRightHere = useRightFlush && !inbound;
    // Header row - symmetric handles, no arrows, no per-message dot.
    // Outbound headers tint to accent so "this is you" reads even when the
    // terminal is too narrow for the right-flush spatial cue, and before a
    // peer's presence broadcast settles. Inbound stays in the neutral
    // handle colour. Repeated headers from the same sender within a run are
    // skipped so bursts read as a paragraph rather than a stack of meta lines.
    if (m.from !== prevSender) {
      const ageDim = brand.dim(formatAge(m.sent_at));
      const handleTint = inbound ? brand.handle : brand.accent;
      const head = `${handleTint(senderHandle)}  ${ageDim}`;
      const padded = flushRightHere
        ? pad(flushRight(head, w - 2) + "  ", w)
        : pad("  " + head, w);
      out.push(padded);
    }
    // Body - wrap to bodyCol, then position inside the pane. Unread inbound
    // bodies stay bright (`brand.text`); read inbound bodies dim to faint;
    // outbound starts dim (you've already read what you wrote). Redacted
    // (a message you received, soft-tombstoned via alter_message_redact)
    // and pending fall back to their own muted variants.
    const lines = wrapBody(m.body, bodyCol);
    const tinter =
      m.redacted || m.body === "[redacted]"
        ? brand.faint
        : m.pending && !inbound
          ? brand.dim
          : inbound
            ? (m.read ? brand.faint : brand.text)
            : brand.dim;
    for (const ln of lines) {
      const styled = tinter(ln);
      const positioned = flushRightHere
        ? pad(flushRight(styled, w - 2) + "  ", w)
        : pad("  " + styled, w);
      out.push(positioned);
    }
    prevSender = m.from;
  }
  return out;
}

function wrapBody(body: string, width: number): string[] {
  const lines: string[] = [];
  for (const raw of body.split("\n")) {
    // Measure in codepoints so CJK / emoji bodies from other clients don't
    // overflow the column budget the way raw `.length` (UTF-16 code units)
    // would. This is not full grapheme-cluster width but it stops the worst
    // overrun without pulling in a wide-char library.
    const points = Array.from(raw);
    if (points.length <= width) {
      lines.push(raw);
      continue;
    }
    let rest = points;
    while (rest.length > width) {
      // Word-boundary cut search, codepoint-aware.
      let cut = -1;
      for (let i = width; i >= 0; i -= 1) {
        if (rest[i] === " ") {
          cut = i;
          break;
        }
      }
      if (cut < width / 2) cut = width;
      lines.push(rest.slice(0, cut).join(""));
      rest = rest.slice(cut);
      // Drop AT MOST ONE leading space - the artefact of the word-boundary
      // cut itself. Preserves intentional indentation in code-block bodies.
      if (rest.length > 0 && rest[0] === " ") rest = rest.slice(1);
    }
    if (rest.length > 0) lines.push(rest.join(""));
  }
  return lines;
}

function renderEmptyRight(geo: Geometry): string[] {
  return [
    pad(brand.titleDim("no conversation selected"), geo.rightWidth),
    pad(brand.borderDim("─".repeat(Math.max(4, geo.rightWidth - 2))), geo.rightWidth),
    pad(brand.faint("  pick a peer on the left, or press n to start one"), geo.rightWidth),
  ];
}

// ---------------------------------------------------------------------------
// Compose bar
// ---------------------------------------------------------------------------

function renderComposeBar(snap: MessengerSnapshot, geo: Geometry): string[] {
  const w = geo.inner;
  const conv =
    snap.selectedConversationIndex >= 0
      ? snap.conversations[snap.selectedConversationIndex]
      : null;
  if (!conv) {
    return [pad(brand.faint("  no conversation selected"), w)];
  }
  const focused = snap.pane === "compose";
  const prompt = focused
    ? brand.accent("▸") + " " + brand.text(`to ${conv.peer}: `)
    : brand.dim("· ") + brand.dim(`to ${conv.peer}: `);
  const cursor = focused ? brand.accentDeep("█") : "";
  // Horizontal scroll: when the buffer overflows the compose row width,
  // truncating from the end would hide the cursor and the user's most
  // recent keystrokes. Anchor on the tail of the buffer instead so the
  // cursor and the chars they just typed always sit in view, with a `…`
  // marker on the left to signal trimmed-leading text.
  const fullBuffer = snap.composeBuffer.replace(/\n/g, " ⏎ ");
  const promptVis = visualLen("  " + prompt);
  const cursorVis = focused ? 1 : 0;
  const bufferBudget = Math.max(4, w - promptVis - cursorVis);
  let visible = fullBuffer;
  if (Array.from(fullBuffer).length > bufferBudget) {
    const points = Array.from(fullBuffer);
    visible = "…" + points.slice(points.length - (bufferBudget - 1)).join("");
  }
  const row = `  ${prompt}${brand.text(visible)}${cursor}`;
  return [pad(row, w)];
}

// ---------------------------------------------------------------------------
// Presence pane (full-frame "Room" view)
// ---------------------------------------------------------------------------

function renderPresencePane(snap: MessengerSnapshot, geo: Geometry): RenderedFrame {
  const body: string[] = [];
  body.push("");
  body.push("  " + brand.titleDim("presence") + brand.dim("  ·  ") + brand.faint("voluntary broadcasts from granted peers"));
  body.push("");
  // Persistent own-broadcast row - the lasting answer to "what am I
  // broadcasting right now?". The flash banner confirms the moment; this
  // row stays. Absent until the member has ever broadcast.
  if (snap.ownPresence) {
    body.push(
      "  " +
        brand.handle(snap.me) +
        brand.dim("  ·  ") +
        brand.accent(snap.ownPresence) +
        brand.dim("  ·  ") +
        brand.faint("your broadcast - e to change"),
    );
    body.push("");
  }
  if (snap.presence.length === 0) {
    body.push("  " + brand.dim("no peers active right now."));
    body.push("");
    body.push("  " + brand.faint("voluntary presence broadcasts from granted peers"));
    body.push("  " + brand.faint("land here. nobody is sampled, nobody is inferred -"));
    body.push("  " + brand.faint("only what peers send."));
  } else {
    for (const p of snap.presence) {
      body.push(
        "  " +
          brand.handle(p.sender) +
          brand.dim("  ·  ") +
          brand.accent(p.state) +
          brand.dim("  ·  ") +
          brand.dim(formatAge(p.sent_at)),
      );
    }
  }
  // Pick mode swaps the keymap for the four states so the choice is a
  // visible mode, not a hint the eye can miss - and renders an explicit
  // picker row in the body.
  if (snap.presencePick) {
    body.push("");
    body.push(
      "  " + brand.title("broadcast which state?") + brand.dim("  ·  ") +
        brand.faint("granted peers see it; only 'open' can ever face strangers"),
    );
  }
  const keymap = snap.presencePick
    ? brand.muted("h") + brand.dim(" here  ") +
      brand.muted("f") + brand.dim(" focus  ") +
      brand.muted("o") + brand.dim(" open  ") +
      brand.muted("q") + brand.dim(" quiet  ") +
      brand.muted("esc") + brand.dim(" cancel")
    : brand.muted("e") + brand.dim(" broadcast  ") +
      brand.muted("r") + brand.dim(" refresh  ") +
      brand.muted("m") + brand.dim(" messages  ") +
      brand.muted("q/esc") + brand.dim(" back");
  return {
    title: titleFor(snap),
    body,
    hint: snap.presencePick
      ? "pick a state - it broadcasts the moment you press the key"
      : "presence is voluntary - e to broadcast your own state",
    footer: joinFooter(keymap, snap, geo),
  };
}

// ---------------------------------------------------------------------------
// Fuzzy jump overlay (Ctrl-K)
// ---------------------------------------------------------------------------

function renderJumpOverlay(snap: MessengerSnapshot, geo: Geometry): RenderedFrame {
  const body: string[] = [];
  body.push("");
  body.push("  " + brand.titleDim("jump to conversation"));
  body.push("");
  body.push(
    "  " +
      brand.accent("▸ ") +
      brand.text(snap.jumpFilter || "") +
      brand.accentDeep("█"),
  );
  body.push("");
  const filtered = snap.conversations.filter((c) =>
    fuzzyMatch(snap.jumpFilter, c.peer + " " + c.preview),
  );
  if (filtered.length === 0) {
    body.push("  " + brand.faint("no matches"));
  } else {
    for (const c of filtered.slice(0, 12)) {
      const peerStyled = c.unread > 0 ? brand.title(c.peer) : brand.handle(c.peer);
      const unreadTail = c.unread > 0 ? brand.title(`  ${c.unread}`) : "";
      const row =
        "  " +
        peerStyled +
        unreadTail +
        brand.dim(`  ${formatAge(c.last_at)}`) +
        brand.dim(`  ${c.preview}`);
      body.push(truncate(row, geo.inner));
    }
  }
  return {
    title: titleFor(snap),
    body,
    hint: "type to filter - Enter jumps, Esc cancels",
    footer: joinFooter(
      brand.muted("↵") + brand.dim(" jump  ") +
        brand.muted("esc") + brand.dim(" cancel"),
      snap,
      geo,
    ),
  };
}

// ---------------------------------------------------------------------------
// In-thread search overlay (/)
// ---------------------------------------------------------------------------

function renderSearchOverlay(snap: MessengerSnapshot, geo: Geometry): RenderedFrame {
  const conv =
    snap.selectedConversationIndex >= 0
      ? snap.conversations[snap.selectedConversationIndex]
      : null;
  const body: string[] = [];
  body.push("");
  body.push(
    "  " +
      brand.titleDim("search in ") +
      brand.handle(conv?.peer ?? "-"),
  );
  body.push("");
  body.push(
    "  " +
      brand.accent("/") +
      brand.text(snap.searchFilter || "") +
      brand.accentDeep("█"),
  );
  body.push("");
  if (!conv || conv.thread.length === 0) {
    body.push("  " + brand.faint("nothing to search"));
  } else {
    const matches = conv.thread.filter((m) =>
      fuzzyMatch(snap.searchFilter, m.body),
    );
    body.push("  " + brand.dim(`${matches.length} of ${conv.thread.length} match`));
    body.push("");
    for (const m of matches.slice(-6)) {
      const senderHandle = m.direction === "out" ? snap.me : (conv?.peer ?? "-");
      const bodyPreview = stripAnsi(m.body).slice(0, 96);
      const row =
        "  " +
        brand.handle(senderHandle) +
        "  " +
        brand.dim(formatAge(m.sent_at)) +
        "  " +
        brand.text(bodyPreview);
      body.push(truncate(row, geo.inner));
    }
  }
  return {
    title: titleFor(snap),
    body,
    hint: "type to filter - Enter keeps filter, Esc clears",
    footer: joinFooter(
      brand.muted("↵") + brand.dim(" keep  ") +
        brand.muted("esc") + brand.dim(" clear"),
      snap,
      geo,
    ),
  };
}

// ---------------------------------------------------------------------------
// Grant overlay (g)
// ---------------------------------------------------------------------------

function renderGrantOverlay(snap: MessengerSnapshot, geo: Geometry): RenderedFrame {
  const body: string[] = [];
  body.push("");
  body.push("  " + brand.titleDim("grants"));
  body.push("");
  body.push("  " + brand.text("Peers you've received messages from:"));
  // Inferred from inbox senders (same heuristic the room view uses for
  // outbound broadcast - strict subset of true granted-peers, the largest set
  // shippable until the backend grows a list-grants RPC).
  const senders = new Set<string>();
  for (const conv of snap.conversations) {
    for (const m of conv.thread) {
      if (m.direction === "in") senders.add(m.from);
    }
  }
  if (senders.size === 0) {
    body.push("  " + brand.faint("    none yet - share `alter msg grant ~yourhandle` with a peer"));
  } else {
    for (const s of Array.from(senders).sort()) {
      body.push("  " + brand.handle("    " + s));
    }
  }
  body.push("");
  body.push("  " + brand.text("Type a handle to grant / revoke:"));
  body.push(
    "  " +
      brand.accent("▸ ") +
      brand.text(snap.composeBuffer) +
      brand.accentDeep("█"),
  );
  return {
    title: titleFor(snap),
    body,
    hint: "Enter grants, R revokes, Esc closes",
    footer: joinFooter(
      brand.muted("↵") + brand.dim(" grant  ") +
        brand.muted("R") + brand.dim(" revoke  ") +
        brand.muted("esc") + brand.dim(" close"),
      snap,
      geo,
    ),
  };
}

// ---------------------------------------------------------------------------
// Two-column stitcher
// ---------------------------------------------------------------------------

function stitchTwoColumns(
  left: string[],
  right: string[],
  geo: Geometry,
): string[] {
  const rows = Math.max(left.length, right.length);
  const out: string[] = [];
  const sep = brand.borderDim(" │ ");
  for (let i = 0; i < rows; i++) {
    const l = pad(left[i] ?? "", geo.leftWidth);
    const r = pad(right[i] ?? "", geo.rightWidth);
    out.push(l + sep + r);
  }
  return out;
}
