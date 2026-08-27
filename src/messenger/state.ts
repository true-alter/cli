/**
 * messenger state - pure data model.
 *
 * Holds the conversation list, per-conversation threads, unread counts,
 * presence overlay, selection cursor, compose drafts, and the mark-read
 * dwell scheduler. No I/O happens in here - the app glue wires the
 * transport's events into `applyIncoming()` and the renderer reads
 * the current snapshot.
 *
 * The dwell scheduler implements the "auto-mark on view, ~1.5s" rule:
 * a message is marked read once it has been
 * the selected conversation's visible message for DWELL_MS, not the
 * instant the conversation opens. That avoids counting a glance as a
 * read. `R` mass-marks the conversation; `u` toggles a single id.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import type { IncomingMessage, OutboundDelta, TransportStatus } from "./transport.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Conversation must be in view for this long before its visible messages
 * are POST-ed to /messaging/mark_read. */
export const DWELL_MS = 1_500;

const PRESENCE_FEED_FILE = path.join(
  process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
  "alter-runtime",
  "presence.jsonl",
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ThreadMessage {
  message_id: string;
  from: string;
  to?: string;
  body: string;
  sent_at: string;
  read: boolean;
  /** Outbound (we sent it) or inbound (we received it). */
  direction: "in" | "out";
  /** Sender-supplied or local optimistic marker. */
  pending?: boolean;
  /** Set once the message has been redacted (body replaced with "[redacted]"). */
  redacted?: boolean;
}

export interface Conversation {
  peer: string;
  /** Last message sent_at - drives ordering of the conversation list. */
  last_at: string;
  /** Last message body preview (already untrusted-stripped). */
  preview: string;
  /** Count of inbound messages with read=false. */
  unread: number;
  /** Newest-last ordered messages with this peer. */
  thread: ThreadMessage[];
}

export interface PresenceEntry {
  sender: string;
  state: "here" | "focus" | "open" | "quiet";
  sent_at: string;
  until?: string;
}

export type Pane = "list" | "compose" | "presence" | "search" | "jump" | "grant";

export interface MessengerSnapshot {
  /** Caller's bound ~handle - never chromed (LOCKED: no user handle in CLI
   *  headers/footers); used to compute message direction and label outbound
   *  rows in the thread. */
  me: string;
  /** Sorted newest-first by last_at. */
  conversations: Conversation[];
  /** Index into `conversations`; -1 when the list is empty. */
  selectedConversationIndex: number;
  /** Index into the selected conversation's thread (-1 for "newest"). */
  selectedMessageIndex: number;
  /** Active foreground pane. Drives keymap + render emphasis. */
  pane: Pane;
  /** Per-peer compose draft so switching conversations preserves typing. */
  composeDraft: Record<string, string>;
  /** Current text in the compose buffer for the selected peer. */
  composeBuffer: string;
  /** Recent presence broadcasts from granted peers. */
  presence: PresenceEntry[];
  /**
   * True while the presence pane's `e` state picker is armed - the next
   * keypress picks a state (h/f/o/q) or cancels (esc). Drives the picker
   * row + keymap swap in the renderer and re-routes the pane keymap so
   * `q` means quiet (not quit) while picking.
   */
  presencePick: boolean;
  /** The member's own last-broadcast state (local mirror), or null. */
  ownPresence: string | null;
  /** Fuzzy-jump filter text. Active only when `pane === "jump"`. */
  jumpFilter: string;
  /** In-thread search filter. Active only when `pane === "search"`. */
  searchFilter: string;
  /** Last transient banner; cleared by the next render-tick after ~3s. */
  flash: { kind: "ok" | "info" | "error"; text: string; until_ms: number } | null;
  /** Set of message_ids the renderer was asked to acknowledge as read. */
  pendingReadAck: Set<string>;
  /** Live transport posture - drives the footer right-edge identity line. */
  transportStatus: TransportStatus | null;
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

export function emptySnapshot(me: string): MessengerSnapshot {
  return {
    me,
    conversations: [],
    selectedConversationIndex: -1,
    selectedMessageIndex: -1,
    pane: "list",
    composeDraft: {},
    composeBuffer: "",
    presence: [],
    presencePick: false,
    ownPresence: null,
    jumpFilter: "",
    searchFilter: "",
    flash: null,
    pendingReadAck: new Set(),
    transportStatus: null,
  };
}

/**
 * Insert or update a message in the snapshot. Mutates in place and
 * returns the modified snapshot for chaining. Sorts the conversation
 * list newest-first by `last_at`. Idempotent on (peer, message_id).
 */
export function applyIncoming(
  snap: MessengerSnapshot,
  msg: IncomingMessage,
): MessengerSnapshot {
  const direction: ThreadMessage["direction"] = msg.from === snap.me ? "out" : "in";
  const peer = direction === "out" ? msg.to ?? "~unknown" : msg.from;
  if (peer === snap.me) {
    // Self-send loopback - backend rejects these but defend anyway.
    return snap;
  }

  const tm: ThreadMessage = {
    message_id: msg.message_id,
    from: msg.from,
    to: msg.to,
    body: msg.body,
    sent_at: msg.sent_at,
    read: msg.read === true,
    direction,
  };

  let conv = snap.conversations.find((c) => c.peer === peer);
  if (!conv) {
    conv = {
      peer,
      last_at: tm.sent_at,
      preview: previewFor(tm.body),
      unread: direction === "in" && !tm.read ? 1 : 0,
      thread: [tm],
    };
    snap.conversations.push(conv);
  } else {
    const existing = conv.thread.find((m) => m.message_id === tm.message_id);
    if (existing) {
      // Update read flag if it flipped; otherwise leave it.
      if (!existing.read && tm.read) {
        existing.read = true;
        if (direction === "in") conv.unread = Math.max(0, conv.unread - 1);
      }
      return snap;
    }
    conv.thread.push(tm);
    conv.thread.sort((a, b) => (a.sent_at < b.sent_at ? -1 : 1));
    if (tm.sent_at > conv.last_at) {
      conv.last_at = tm.sent_at;
      conv.preview = previewFor(tm.body);
    }
    if (direction === "in" && !tm.read) conv.unread += 1;
  }

  // Newest conversation first; selection sticks to its peer across re-sorts.
  const selectedPeer =
    snap.selectedConversationIndex >= 0
      ? snap.conversations[snap.selectedConversationIndex]?.peer
      : undefined;
  snap.conversations.sort((a, b) => (a.last_at < b.last_at ? 1 : -1));
  if (selectedPeer) {
    const newIdx = snap.conversations.findIndex((c) => c.peer === selectedPeer);
    if (newIdx >= 0) snap.selectedConversationIndex = newIdx;
  } else if (snap.selectedConversationIndex < 0 && snap.conversations.length > 0) {
    snap.selectedConversationIndex = 0;
  }
  return snap;
}

/**
 * Apply an outbound message we just sent. Mirrors `applyIncoming` but
 * marks the message as pending until the SSE / poll echo confirms it.
 */
export function applyOutbound(
  snap: MessengerSnapshot,
  delta: OutboundDelta,
): MessengerSnapshot {
  return applyIncoming(snap, {
    message_id: delta.message_id,
    from: snap.me,
    to: delta.to,
    body: delta.body,
    sent_at: delta.sent_at,
    read: true,
    source: "sse",
  });
}

/** Mark every inbound message in a conversation as read. */
export function markConversationRead(snap: MessengerSnapshot, peer: string): string[] {
  const conv = snap.conversations.find((c) => c.peer === peer);
  if (!conv) return [];
  const newly: string[] = [];
  for (const m of conv.thread) {
    if (m.direction === "in" && !m.read) {
      m.read = true;
      newly.push(m.message_id);
    }
  }
  conv.unread = 0;
  return newly;
}

/** Toggle a single message's read flag. Returns the new state. */
export function toggleMessageRead(
  snap: MessengerSnapshot,
  peer: string,
  message_id: string,
): { id: string; read: boolean } | null {
  const conv = snap.conversations.find((c) => c.peer === peer);
  if (!conv) return null;
  const msg = conv.thread.find((m) => m.message_id === message_id);
  if (!msg || msg.direction !== "in") return null;
  msg.read = !msg.read;
  conv.unread = conv.thread.filter((m) => m.direction === "in" && !m.read).length;
  return { id: msg.message_id, read: msg.read };
}

/**
 * Remove a message body and replace with a redaction marker. Used after
 * a successful `alter_message_redact` call. Only valid for INBOUND
 * messages - the `alter_message_redact` backend tool redacts messages
 * where you are the recipient (it soft-tombstones the body of something
 * you received; the audit row is preserved). It cannot touch
 * messages you sent. We enforce the same recipient-only gate here so a
 * confused caller can't redact an outbound message client-side and end
 * up out of sync with the server.
 *
 * On success the message body becomes the literal "[redacted]" and the
 * `redacted` flag is set; if the redacted message is the last item in the
 * thread, `conv.preview` is also rewritten.
 */
export function applyRedaction(
  snap: MessengerSnapshot,
  peer: string,
  message_id: string,
): boolean {
  const conv = snap.conversations.find((c) => c.peer === peer);
  if (!conv) return false;
  const msg = conv.thread.find((m) => m.message_id === message_id);
  if (!msg) return false;
  if (msg.direction !== "in") return false;
  msg.body = "[redacted]";
  msg.redacted = true;
  if (conv.thread[conv.thread.length - 1]?.message_id === message_id) {
    conv.preview = "[redacted]";
  }
  return true;
}

// ---------------------------------------------------------------------------
// Presence overlay
// ---------------------------------------------------------------------------

/**
 * Read the alter-runtime presence feed. Identical contract to the room view -
 * voluntary broadcasts only, no ambient sampling. Missing file returns
 * an empty array, never throws.
 */
export function readPresence(limit = 32): PresenceEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(PRESENCE_FEED_FILE, "utf8");
  } catch {
    return [];
  }
  const out: PresenceEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      // presence.jsonl fields are handle/set_at/expires_at; older builds
      // wrote sender/sent_at/until. Accept both so a legacy file parses.
      const sender = parsed.handle ?? parsed.sender;
      const sentAt = parsed.set_at ?? parsed.sent_at;
      const until = parsed.expires_at ?? parsed.until;
      if (
        typeof sender === "string" &&
        typeof parsed.state === "string" &&
        typeof sentAt === "string" &&
        (parsed.state === "here" ||
          parsed.state === "focus" ||
          parsed.state === "open" ||
          parsed.state === "quiet")
      ) {
        out.push({
          sender,
          state: parsed.state as PresenceEntry["state"],
          sent_at: sentAt,
          until: typeof until === "string" ? until : undefined,
        });
      }
    } catch {
      // skip malformed line
    }
  }
  out.sort((a, b) => (a.sent_at < b.sent_at ? 1 : -1));
  return out.slice(0, limit);
}

/** Latest presence for a given peer, or null if they haven't broadcast. */
export function presenceFor(
  snap: MessengerSnapshot,
  peer: string,
): PresenceEntry | null {
  return snap.presence.find((p) => p.sender === peer) ?? null;
}

// ---------------------------------------------------------------------------
// Fuzzy + search filters
// ---------------------------------------------------------------------------

/**
 * Fuzzy match - every character of `pattern` (lowercased) must appear in
 * `text` (lowercased) in order, not necessarily contiguously. Returns
 * true on empty pattern. Cheap; runs on every keystroke.
 */
export function fuzzyMatch(pattern: string, text: string): boolean {
  if (!pattern) return true;
  const p = pattern.toLowerCase();
  const t = text.toLowerCase();
  let i = 0;
  for (const ch of t) {
    if (ch === p[i]) i += 1;
    if (i === p.length) return true;
  }
  return i === p.length;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function previewFor(body: string, max = 72): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1) + "…";
}

/**
 * Build a 0..N-second relative age string. Used by both the conversation
 * list and the thread pane so the time format reads consistently.
 */
export function formatAge(iso: string | undefined): string {
  if (!iso) return "-";
  const when = Date.parse(iso);
  if (Number.isNaN(when)) return "-";
  const diffMs = Date.now() - when;
  const sec = Math.max(0, Math.floor(diffMs / 1000));
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
