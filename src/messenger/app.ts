/**
 * messenger app - alt-screen input loop + state/transport/render glue.
 *
 * Five things happen in here:
 *
 *   1. Boot the AlterClient + MessengerTransport. Subscribe to
 *      `message` / `outbound` / `status` events and feed them into
 *      the snapshot.
 *   2. Enter the alternate screen, put stdin into raw keypress mode,
 *      and install a single keymap that maps to state mutations.
 *      Repaint is triggered on every state change.
 *   3. Track which conversation has been in view for DWELL_MS and
 *      POST mark_read for its newly-visible inbound messages.
 *   4. Run a `setInterval(refreshPresence, 5_000)` so the presence
 *      glyphs next to conversations stay fresh even when the user
 *      isn't pressing keys.
 *   5. On q/Esc back to where the user opened the messenger from
 *      (menu, command-line, or shell), cleanly shutting down the
 *      transport and exiting the alt-screen.
 *
 * The repaint is debounced through a frame queue so a burst of SSE
 * events doesn't redraw the screen ten times in a row.
 */

import * as childProcess from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  AlterClient,
  AlterAuthError,
  AlterRateLimited,
  AlterToolError,
} from "@truealter/sdk";

import { getSession, sessionRejectedMessage } from "../auth.js";
import { parseCommandString, CommandParseError } from "../lib/parse-cmd.js";
import { resolveBoundSigningKey, SigningKeyMismatchError } from "../signing.js";
import { getMcpExtraHeaders } from "../lib/cf-access-headers.js";
import { getCliVersion } from "../lib/version.js";
import {
  brand,
  drawFrame,
  enterAlt,
  exitAlt,
  suspendAlt,
  resumeAlt,
  termSize,
} from "../ui/biosMenu.js";
import {
  applyIncoming,
  applyOutbound,
  applyRedaction,
  DWELL_MS,
  emptySnapshot,
  markConversationRead,
  readPresence,
  toggleMessageRead,
  type MessengerSnapshot,
  type Pane,
} from "./state.js";
import {
  MessengerTransport,
  type IncomingMessage,
  type OutboundDelta,
  type TransportStatus,
} from "./transport.js";
import { render } from "./render.js";
import {
  createInputSession,
  type DecodedKey,
  type InputSession,
} from "../ui/rawKeys.js";

const CLI_VERSION = getCliVersion();
const INSTRUMENT_HANDLE = `~alter-cli@${CLI_VERSION}`;
const FRAME_RATE_HZ = 30;
const FRAME_INTERVAL_MS = Math.floor(1000 / FRAME_RATE_HZ);
const PRESENCE_REFRESH_MS = 5_000;
const FLASH_TTL_MS = 3_000;

// ---------------------------------------------------------------------------
// openMessenger - single public entry point
// ---------------------------------------------------------------------------

export interface OpenMessengerOptions {
  /** Conversation to focus on launch, e.g. `~peer`. */
  initialPeer?: string;
  /** Open in presence pane instead of the conversation list. */
  initialPane?: Pane;
}

export async function openMessenger(opts: OpenMessengerOptions = {}): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stdout.write(
      "alter msg is interactive - run from a real terminal, or use `alter msg <verb>` for the line-oriented commands.\n",
    );
    return;
  }
  const session = getSession();
  if (!session) {
    process.stdout.write("Not signed in. Run `alter login` first.\n");
    return;
  }
  if (!session.member_api_key || !session.signing_kid) {
    process.stdout.write(
      "Session missing member key or signing kid. Run `alter login` again to re-provision.\n",
    );
    return;
  }
  // Bound resolution: refuses on kid/key mismatch, never another key.
  let privateKeyPem: string | null;
  try {
    privateKeyPem = resolveBoundSigningKey(session);
  } catch (err) {
    if (err instanceof SigningKeyMismatchError) {
      process.stdout.write(`${err.message}\n`);
      return;
    }
    throw err;
  }
  if (!privateKeyPem) {
    process.stdout.write(
      "Signing key missing from the credential store. Re-run `alter login`.\n",
    );
    return;
  }

  const client = new AlterClient({
    apiKey: session.member_api_key,
    clientInfo: { name: "alter-cli", version: CLI_VERSION },
    signing: {
      kid: session.signing_kid,
      privateKey: privateKeyPem,
      handle: session.handle,
    },
    extraHeaders: getMcpExtraHeaders(CLI_VERSION),
  });

  const snap = emptySnapshot(session.handle);
  snap.presence = readPresence();
  // Own-broadcast state (local mirror) - the presence pane's persistent
  // "you · <state>" row. Lazy import keeps the room view's alt-screen lifecycle
  // out of this module's load graph (same pattern as the `e` broadcast).
  try {
    const { readPublicPresenceLocal } = await import("../commands/room.js");
    snap.ownPresence = readPublicPresenceLocal().own_state;
  } catch {
    snap.ownPresence = null;
  }
  if (opts.initialPane) snap.pane = opts.initialPane;

  const transport = new MessengerTransport({
    handle: session.handle,
    client,
    extraHeaders: getMcpExtraHeaders(CLI_VERSION),
  });

  // When the messenger is launched directly into the presence pane (via
  // `alter room` or the menu's "Presence" entry), q/esc from presence
  // should exit the TUI entirely - that matches the user's "I opened the
  // Room" mental model. When presence is reached internally via the `p`
  // keypress from list/thread, q/esc should return to the conversation
  // list. The flag rides through LoopContext.
  const enteredAsRoom = opts.initialPane === "presence";

  await runLoop({
    snap,
    transport,
    client,
    initialPeer: opts.initialPeer,
    enteredAsRoom,
  });
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

interface LoopContext {
  snap: MessengerSnapshot;
  transport: MessengerTransport;
  client: AlterClient;
  initialPeer?: string;
  /** True when the messenger opened directly into presence (Room entry). */
  enteredAsRoom?: boolean;
}

async function runLoop(ctx: LoopContext): Promise<void> {
  const { snap, transport, client } = ctx;
  const stdin = process.stdin;

  enterAlt();

  // ── Repaint plumbing ─────────────────────────────────────────────────
  let dirty = true;
  let frameTimer: NodeJS.Timeout | null = null;
  const repaint = (): void => {
    dirty = true;
    if (frameTimer) return;
    frameTimer = setTimeout(() => {
      frameTimer = null;
      if (!dirty) return;
      dirty = false;
      const frame = render(snap);
      drawFrame({
        title: frame.title,
        body: frame.body,
        hint: frame.hint,
        footer: frame.footer,
      });
    }, FRAME_INTERVAL_MS);
  };

  // ── Transport wiring ─────────────────────────────────────────────────
  transport.on("message", (m: IncomingMessage) => {
    applyIncoming(snap, m);
    if (ctx.initialPeer && snap.selectedConversationIndex < 0) {
      const idx = snap.conversations.findIndex((c) => c.peer === ctx.initialPeer);
      if (idx >= 0) snap.selectedConversationIndex = idx;
    }
    repaint();
  });
  transport.on("outbound", (_d: OutboundDelta) => {
    repaint();
  });
  transport.on("status", (s: TransportStatus) => {
    snap.transportStatus = s;
    repaint();
  });
  snap.transportStatus = transport.getStatus();
  let authErrorFlashed = false;
  transport.on("error", (err: unknown) => {
    // Most transport errors are non-fatal - the poll backstop keeps the
    // inbox honest. A 401/403, though, means every path (poll + SSE) is
    // bouncing on a rejected session, so the conversation list will stay
    // empty with no other explanation. Surface it once.
    if (!authErrorFlashed && err instanceof AlterAuthError) {
      authErrorFlashed = true;
      flash(snap, "error", sessionRejectedMessage({ terse: true }));
      repaint();
    }
  });

  await transport.start();

  // Honour --to / "alter msg ~peer" - if the peer hasn't shown up in
  // the inbox yet, seed an empty conversation so the user can compose
  // straight away. The first send will graduate it to a real thread.
  if (ctx.initialPeer) {
    const peer = ctx.initialPeer;
    if (!snap.conversations.find((c) => c.peer === peer)) {
      snap.conversations.unshift({
        peer,
        last_at: new Date().toISOString(),
        preview: "",
        unread: 0,
        thread: [],
      });
    }
    snap.selectedConversationIndex = snap.conversations.findIndex(
      (c) => c.peer === peer,
    );
    snap.pane = "compose";
    snap.composeBuffer = snap.composeDraft[peer] ?? "";
  }
  if (snap.selectedConversationIndex < 0 && snap.conversations.length > 0) {
    snap.selectedConversationIndex = 0;
  }
  repaint();

  // ── Dwell-based mark-read ─────────────────────────────────────────────
  let dwellPeer: string | null = null;
  let dwellTimer: NodeJS.Timeout | null = null;

  const scheduleDwellMarkRead = (): void => {
    if (dwellTimer) {
      clearTimeout(dwellTimer);
      dwellTimer = null;
    }
    const conv =
      snap.selectedConversationIndex >= 0
        ? snap.conversations[snap.selectedConversationIndex]
        : null;
    if (!conv || conv.unread === 0) {
      dwellPeer = null;
      return;
    }
    dwellPeer = conv.peer;
    dwellTimer = setTimeout(() => {
      dwellTimer = null;
      if (dwellPeer !== conv.peer) return;
      // Fire while the thread is in view - the list pane (two-pane shows
      // the thread alongside; stacked shows it below) or compose. If an
      // overlay (jump/search/grant/presence) has taken over, the
      // conversation isn't really in view and a silent mark-read would
      // surprise the user.
      if (snap.pane !== "list" && snap.pane !== "compose") return;
      // Snapshot the ids first so we don't race with new SSE events.
      const ids = markConversationRead(snap, conv.peer);
      if (ids.length > 0) {
        // Fire and forget; failures don't unwind the UI.
        void postMarkRead(client, ids);
      }
      repaint();
    }, DWELL_MS);
  };

  // ── Presence refresh ─────────────────────────────────────────────────
  const presenceTimer = setInterval(() => {
    const fresh = readPresence();
    if (
      fresh.length !== snap.presence.length ||
      fresh.some((p, i) => p.sent_at !== snap.presence[i]?.sent_at)
    ) {
      snap.presence = fresh;
      repaint();
    }
  }, PRESENCE_REFRESH_MS);
  presenceTimer.unref();

  // ── Resize ───────────────────────────────────────────────────────────
  const onResize = (): void => repaint();
  process.stdout.on("resize", onResize);

  // ── Keymap ───────────────────────────────────────────────────────────
  await new Promise<void>((resolve) => {
    let session: InputSession | null = null;
    // `cleanup` lives inside the Promise callback so it can reference
    // `onKey` (function-scoped to this callback). `finish` is the only
    // caller and resolves the outer await once teardown completes.
    const cleanup = (): void => {
      if (frameTimer) clearTimeout(frameTimer);
      if (dwellTimer) clearTimeout(dwellTimer);
      clearInterval(presenceTimer);
      session?.dispose();
      process.stdout.removeListener("resize", onResize);
      transport.stop();
      exitAlt();
    };

    const finish = (): void => {
      cleanup();
      resolve();
    };

    function onKey(key: DecodedKey): void {
      if (key.ctrl && key.name === "c") return finish();

      // Overlays own their own keymap until dismissed.
      if (snap.pane === "jump") {
        handleJumpKey(key);
        return;
      }
      if (snap.pane === "search") {
        handleSearchKey(key);
        return;
      }
      if (snap.pane === "grant") {
        handleGrantKey(key);
        return;
      }
      if (snap.pane === "presence") {
        handlePresenceKey(key);
        return;
      }

      // ── Main pane: list / compose ──────────────────────────────────
      if (snap.pane === "compose") {
        handleComposeKey(key);
        return;
      }

      // Only the list pane reaches here - overlays and compose are routed
      // above. The thread is always drawn alongside (two-pane) or below
      // (stacked), so "focus the thread" was never a distinct view; the
      // list pane IS the thread-in-view state.
      if (key.name === "q" || key.name === "escape") {
        return finish();
      }
      if (key.ctrl && key.name === "k") {
        snap.pane = "jump";
        snap.jumpFilter = "";
        repaint();
        return;
      }
      if (key.name === "up") {
        if (snap.conversations.length > 0) {
          const next =
            (snap.selectedConversationIndex - 1 + snap.conversations.length) %
            snap.conversations.length;
          snap.selectedConversationIndex = next;
          snap.composeBuffer = snap.composeDraft[snap.conversations[next].peer] ?? "";
          scheduleDwellMarkRead();
          repaint();
        }
        return;
      }
      if (key.name === "down") {
        if (snap.conversations.length > 0) {
          const next =
            (snap.selectedConversationIndex + 1) % snap.conversations.length;
          snap.selectedConversationIndex = next;
          snap.composeBuffer = snap.composeDraft[snap.conversations[next].peer] ?? "";
          scheduleDwellMarkRead();
          repaint();
        }
        return;
      }
      if (key.name === "right" || key.name === "return") {
        // Enter / → on a conversation goes straight to compose - the thread
        // is already in view, so there's no intermediate focus step. Mark
        // it read on the way in (opening a peer to reply means you've seen
        // what they sent).
        if (snap.conversations.length > 0) {
          snap.pane = "compose";
          scheduleDwellMarkRead();
          repaint();
        }
        return;
      }
      if (key.name === "n") {
        // New conversation - open the grant overlay's compose row,
        // pre-filled with `~`. Pressing Enter there creates the empty
        // thread and drops into compose.
        snap.pane = "grant";
        snap.composeBuffer = "~";
        repaint();
        return;
      }
      if (key.name === "g") {
        // grants overlay: show the grant-management overlay (distinct from
        // 'n' which is new-thread). For now open the same grant pane with
        // composeBuffer cleared so the user sees the grant list, not the
        // new-thread pre-fill (avoids n/g rendering identically).
        snap.pane = "grant";
        snap.composeBuffer = "";
        repaint();
        return;
      }
      if (key.shift && key.name === "r") {
        // Capital R - mark current conversation read immediately.
        const conv =
          snap.selectedConversationIndex >= 0
            ? snap.conversations[snap.selectedConversationIndex]
            : null;
        if (conv) {
          const ids = markConversationRead(snap, conv.peer);
          if (ids.length > 0) void postMarkRead(client, ids);
          flash(snap, "ok", `marked ${ids.length} message(s) read`);
          repaint();
        }
        return;
      }
      if (key.name === "u") {
        // Toggle unread on the most recent inbound message in the
        // selected conversation. Simpler than per-message selection;
        // covers the "I want to deal with that later" use case.
        const conv =
          snap.selectedConversationIndex >= 0
            ? snap.conversations[snap.selectedConversationIndex]
            : null;
        if (conv) {
          const last = [...conv.thread].reverse().find((m) => m.direction === "in");
          if (last) {
            toggleMessageRead(snap, conv.peer, last.message_id);
            flash(snap, "info", last.read ? "marked read" : "marked unread");
            repaint();
          }
        }
        return;
      }
      if (key.name === "/") {
        snap.pane = "search";
        snap.searchFilter = "";
        repaint();
        return;
      }
      if (key.name === "p") {
        snap.pane = "presence";
        snap.presence = readPresence();
        repaint();
        return;
      }
      if (key.name === "c") {
        // Copy currently-selected conversation's most-recent body to the
        // OS clipboard if a clipboard binary is available - graceful no-op
        // when running in a TTY without one (CI, ssh without xclip, etc).
        const conv =
          snap.selectedConversationIndex >= 0
            ? snap.conversations[snap.selectedConversationIndex]
            : null;
        if (conv && conv.thread.length > 0) {
          const body = conv.thread[conv.thread.length - 1].body;
          tryCopyToClipboard(body).then(
            (ok) => {
              flash(snap, ok ? "ok" : "info", ok ? "copied to clipboard" : "no clipboard available");
              repaint();
            },
            () => {
              flash(snap, "info", "no clipboard available");
              repaint();
            },
          );
        }
        return;
      }
      // 'x' - redact the most recent INBOUND message in this conversation
      // (a message you received). The `alter_message_redact` tool is
      // recipient-only: it soft-tombstones the body of something sent TO
      // you; it cannot touch messages you sent. Lower case so it doesn't
      // collide with Shift+R = mark-read. Already-redacted messages are
      // skipped, and a no-target press is a quiet status no-op.
      if (key.name === "x" && !key.shift) {
        const conv =
          snap.selectedConversationIndex >= 0
            ? snap.conversations[snap.selectedConversationIndex]
            : null;
        if (conv) {
          const lastIn = [...conv.thread]
            .reverse()
            .find((m) => m.direction === "in" && !m.redacted && m.body !== "[redacted]");
          if (lastIn) {
            void redact(client, conv.peer, lastIn.message_id).then(
              (err) => {
                if (err) {
                  flash(snap, "error", `redact failed: ${err}`);
                } else {
                  applyRedaction(snap, conv.peer, lastIn.message_id);
                  flash(snap, "ok", "redacted");
                }
                repaint();
              },
            );
          } else {
            flash(snap, "info", "nothing to redact - you can only redact messages you received");
            repaint();
          }
        }
        return;
      }
    }

    function handleComposeKey(key: DecodedKey): void {
      const conv =
        snap.selectedConversationIndex >= 0
          ? snap.conversations[snap.selectedConversationIndex]
          : null;
      if (!conv) {
        snap.pane = "list";
        repaint();
        return;
      }
      if (key.name === "escape") {
        // Persist the draft and back out to the list. The keymap above
        // intentionally treats Esc as a back-out, not a quit-the-app.
        snap.composeDraft[conv.peer] = snap.composeBuffer;
        snap.pane = "list";
        repaint();
        return;
      }
      if (key.ctrl && key.name === "e") {
        // Open $EDITOR for long-form / multiline composition. Saves the
        // current buffer to a tempfile, opens $EDITOR inherit-stdio, and
        // reads the result back when the editor exits. openEditorCompose
        // suspends/resumes the alt-screen around the editor itself, so the
        // refcount (and the menu's outer hold, if launched from the menu)
        // survives untouched - just repaint the restored screen here.
        snap.composeDraft[conv.peer] = snap.composeBuffer;
        void openEditorCompose(snap.composeBuffer).then(
          (next) => {
            if (next !== null) {
              snap.composeBuffer = next;
              snap.composeDraft[conv.peer] = next;
            }
            repaint();
          },
        );
        return;
      }
      if (key.name === "return") {
        // Send. Move buffer to the wire then clear and back to the list.
        const body = snap.composeBuffer.trim();
        if (!body) {
          snap.pane = "list";
          repaint();
          return;
        }
        snap.composeBuffer = "";
        snap.composeDraft[conv.peer] = "";
        snap.pane = "list";
        repaint();
        void sendMessage(client, conv.peer, body, snap.me).then(
          (outcome) => {
            if (outcome.kind === "ok") {
              transport.noteOutbound(outcome.delta);
              applyOutbound(snap, outcome.delta);
              flash(snap, "ok", `sent to ${conv.peer}`);
            } else {
              flash(snap, "error", outcome.message);
            }
            repaint();
          },
        );
        return;
      }
      if (key.name === "backspace") {
        snap.composeBuffer = snap.composeBuffer.slice(0, -1);
        repaint();
        return;
      }
      if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        // Plain printable - append to buffer.
        snap.composeBuffer += key.sequence;
        repaint();
        return;
      }
    }

    function handleJumpKey(key: DecodedKey): void {
      if (key.name === "escape") {
        snap.pane = "list";
        snap.jumpFilter = "";
        repaint();
        return;
      }
      if (key.name === "return") {
        // Land on the top-ranked match.
        const filtered = snap.conversations.filter((c) =>
          fuzzyContains(snap.jumpFilter, c.peer + " " + c.preview),
        );
        if (filtered.length > 0) {
          const idx = snap.conversations.findIndex((c) => c.peer === filtered[0].peer);
          if (idx >= 0) {
            snap.selectedConversationIndex = idx;
            snap.composeBuffer = snap.composeDraft[filtered[0].peer] ?? "";
            scheduleDwellMarkRead();
          }
        }
        snap.pane = "list";
        snap.jumpFilter = "";
        repaint();
        return;
      }
      if (key.name === "backspace") {
        snap.jumpFilter = snap.jumpFilter.slice(0, -1);
        repaint();
        return;
      }
      if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        snap.jumpFilter += key.sequence;
        repaint();
        return;
      }
    }

    function handleSearchKey(key: DecodedKey): void {
      if (key.name === "escape") {
        snap.pane = "list";
        snap.searchFilter = "";
        repaint();
        return;
      }
      if (key.name === "return") {
        // Keep the filter active and return to the list (thread stays in view).
        snap.pane = "list";
        repaint();
        return;
      }
      if (key.name === "backspace") {
        snap.searchFilter = snap.searchFilter.slice(0, -1);
        repaint();
        return;
      }
      if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        snap.searchFilter += key.sequence;
        repaint();
        return;
      }
    }

    function handleGrantKey(key: DecodedKey): void {
      if (key.name === "escape") {
        snap.pane = "list";
        snap.composeBuffer = "";
        repaint();
        return;
      }
      const peer = snap.composeBuffer.trim();
      if (key.shift && key.name === "r") {
        if (peer.startsWith("~")) {
          void invokeGrant(client, peer, "revoke").then((err) => {
            flash(snap, err ? "error" : "ok", err ?? `revoked ${peer}`);
            snap.composeBuffer = "";
            snap.pane = "list";
            repaint();
          });
        }
        return;
      }
      if (key.name === "return") {
        if (peer.startsWith("~") && peer.length > 1) {
          void invokeGrant(client, peer, "grant").then((err) => {
            if (err) {
              flash(snap, "error", err);
            } else {
              // Seed an empty conversation so the user can compose.
              if (!snap.conversations.find((c) => c.peer === peer)) {
                snap.conversations.unshift({
                  peer,
                  last_at: new Date().toISOString(),
                  preview: "",
                  unread: 0,
                  thread: [],
                });
              }
              snap.selectedConversationIndex = snap.conversations.findIndex(
                (c) => c.peer === peer,
              );
              flash(snap, "ok", `granted ${peer}`);
            }
            snap.composeBuffer = "";
            snap.pane = snap.selectedConversationIndex >= 0 ? "compose" : "list";
            repaint();
          });
        }
        return;
      }
      if (key.name === "backspace") {
        snap.composeBuffer = snap.composeBuffer.slice(0, -1);
        if (snap.composeBuffer.length === 0) snap.composeBuffer = "~";
        repaint();
        return;
      }
      if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        snap.composeBuffer += key.sequence;
        repaint();
        return;
      }
    }

    function handlePresenceKey(key: DecodedKey): void {
      // --- State-pick mode: the next key picks a state or cancels -------
      // This branch runs FIRST so `q` means quiet (not quit) and Esc means
      // cancel-the-pick (not leave the pane) while the picker is armed.
      if (snap.presencePick) {
        snap.presencePick = false;
        let state: string | null = null;
        if (key.name === "h") state = "here";
        else if (key.name === "f") state = "focus";
        else if (key.name === "o") state = "open";
        else if (key.name === "q" && !key.ctrl) state = "quiet";
        if (!state) {
          flash(snap, "info", "cancelled - nothing broadcast");
          repaint();
          return;
        }
        const chosen = state;
        flash(snap, "info", `broadcasting ${chosen}…`);
        repaint();
        void (async () => {
          // Structured outcome so failure renders as an ERROR flash - the
          // prior path flashed emitPresence's error strings as "ok", which
          // made a failed broadcast look like nothing happened.
          const { broadcastPresence } = await import("../commands/room.js");
          try {
            const outcome = await broadcastPresence(chosen);
            flash(snap, outcome.ok ? "ok" : "error", outcome.text);
            if (outcome.ok) snap.ownPresence = chosen;
          } catch (err) {
            flash(snap, "error", (err as Error).message);
          }
          snap.presence = readPresence();
          repaint();
        })();
        return;
      }

      if (key.name === "q" || key.name === "escape") {
        // Room-entry path (alter room / menu Presence) → exit TUI.
        // Internal `p`-from-list path → return to the conversation list.
        if (ctx.enteredAsRoom) return finish();
        snap.pane = "list";
        repaint();
        return;
      }
      if (key.name === "m") {
        snap.pane = "list";
        repaint();
        return;
      }
      if (key.name === "r") {
        snap.presence = readPresence();
        repaint();
        return;
      }
      // 'e' arms the state picker - the pane renders the four states and
      // the next keypress resolves the choice (handled above).
      if (key.name === "e") {
        snap.presencePick = true;
        repaint();
        return;
      }
    }

    session = createInputSession(stdin, onKey);
  });
}

// ---------------------------------------------------------------------------
// Backend operations (network) - fail-safe wrappers
// ---------------------------------------------------------------------------

type SendOutcome =
  | { kind: "ok"; delta: OutboundDelta }
  | { kind: "error"; message: string };

async function sendMessage(
  client: AlterClient,
  to: string,
  body: string,
  me: string,
): Promise<SendOutcome> {
  // Same body-ceiling and trailer contract as the message command.
  const nfc = body.normalize("NFC");
  const byteLen = Buffer.byteLength(nfc, "utf-8");
  if (byteLen > 8 * 1024) {
    return {
      kind: "error",
      message: `body exceeds 8 KiB (${byteLen} bytes)`,
    };
  }
  try {
    const result = await client.mcp.callTool("alter_message_send", {
      to,
      body: nfc,
      meta: {
        identity_trailers: {
          acted_by: me,
          drafted_with: [INSTRUMENT_HANDLE],
        },
      },
    });
    const payload = extractData<{ event_id?: string; message_id?: string; id?: string }>(result);
    const id = payload?.event_id ?? payload?.message_id ?? payload?.id ?? `local-${Date.now()}`;
    return {
      kind: "ok",
      delta: {
        message_id: id,
        to,
        body: nfc,
        sent_at: new Date().toISOString(),
      },
    };
  } catch (err) {
    return { kind: "error", message: translateSendError(err, to) };
  }
}

async function postMarkRead(client: AlterClient, ids: string[]): Promise<void> {
  try {
    await client.mcp.callTool("alter_message_mark_read", { message_ids: ids });
  } catch {
    // Best-effort - the local read state is what matters; the backend
    // will catch up on the next poll cycle.
  }
}

async function invokeGrant(
  client: AlterClient,
  peer: string,
  mode: "grant" | "revoke",
): Promise<string | null> {
  try {
    await client.mcp.callTool(
      mode === "grant" ? "alter_message_grant" : "alter_message_revoke",
      { peer },
    );
    return null;
  } catch (err) {
    return translateSendError(err, peer);
  }
}

async function redact(
  client: AlterClient,
  peer: string,
  message_id: string,
): Promise<string | null> {
  // The `alter_message_redact` tool takes only `{ message_id }` and redacts
  // a message you received (recipient-only soft tombstone). `peer` is kept in
  // this helper's signature purely for error-message context, never sent.
  try {
    await client.mcp.callTool("alter_message_redact", { message_id });
    return null;
  } catch (err) {
    return translateSendError(err, peer);
  }
}

function translateSendError(err: unknown, peer: string, yourHandle?: string): string {
  if (err instanceof AlterAuthError) return sessionRejectedMessage({ terse: true });
  if (err instanceof AlterRateLimited) return `rate limited - retry in ${err.retryAfter}s`;
  if (err instanceof AlterToolError) {
    const m = err.message.toLowerCase();
    if (
      m.includes("no grant") ||
      m.includes("not granted") ||
      m.includes("contact_not_established") ||
      err.rpcCode === 403
    ) {
      const you = yourHandle ?? getSession()?.handle ?? "~yourhandle";
      return `${peer} hasn't granted you - ask them to run \`alter msg grant ${you}\``;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

function extractData<T>(result: { data?: unknown; content?: Array<{ type: string; text?: string }> }): T | null {
  if (result.data !== undefined && result.data !== null) return result.data as T;
  const text = result.content?.find((c) => c.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flash(snap: MessengerSnapshot, kind: "ok" | "info" | "error", text: string): void {
  snap.flash = { kind, text, until_ms: Date.now() + FLASH_TTL_MS };
}

function fuzzyContains(pattern: string, text: string): boolean {
  if (!pattern) return true;
  const p = pattern.toLowerCase();
  const t = text.toLowerCase();
  let i = 0;
  for (const ch of t) {
    if (ch === p[i]) i += 1;
    if (i === p.length) return true;
  }
  return false;
}

/**
 * Best-effort clipboard copy. Tries wl-copy → xclip → pbcopy in turn;
 * the first one that exits 0 wins. Returns false when none are present;
 * the caller surfaces a "no clipboard available" flash so the user
 * isn't left wondering.
 */
async function tryCopyToClipboard(body: string): Promise<boolean> {
  const tools = [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["pbcopy", []],
  ] as const;
  for (const [cmd, args] of tools) {
    const ok = await new Promise<boolean>((resolve) => {
      try {
        const child = childProcess.spawn(cmd, args as readonly string[], {
          stdio: ["pipe", "ignore", "ignore"],
        });
        child.on("error", () => resolve(false));
        child.on("exit", (code) => resolve(code === 0));
        child.stdin.end(body);
      } catch {
        resolve(false);
      }
    });
    if (ok) return true;
  }
  return false;
}

/**
 * Open $EDITOR for long-form composition. Saves the current buffer to a
 * tempfile inside a private mkdtemp directory (0600 file, 0700 dir - see
 * inline comment below), suspends the alt-screen (physical drop, refcount
 * untouched), hands the terminal to the editor (stdio inherit), then
 * resumes the alt-screen, reads the file back and removes the directory.
 * Suspend/resume and the temp-directory removal are both balanced
 * internally across every return path, so the caller only needs to
 * repaint on return.
 */
async function openEditorCompose(initial: string): Promise<string | null> {
  const editor = process.env.VISUAL ?? process.env.EDITOR ?? "vi";
  // mkdtempSync + a fixed filename inside, not a predictable name under the
  // shared tmp root directly: the draft is written 0600 inside a directory
  // only this process's uid can traverse, so a pre-planted symlink at a
  // guessed path can no longer be followed and no other user on the box
  // can read an unsent draft off a world-readable/1777 tmp root.
  let tmpDir: string;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alter-msg-"));
  } catch {
    return null;
  }
  const tmp = path.join(tmpDir, "compose.md");
  try {
    fs.writeFileSync(tmp, initial, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    return null;
  }
  // Physically drop the alt-screen for the editor handoff without touching
  // the refcount, so the menu's outer hold (when launched from the menu)
  // survives. Resumed on every return path below.
  const wasAlt = suspendAlt();
  process.stdout.write("\n");
  try {
    // Previously used editor.split(/\s+/) + spawn, which does
    // not reject shell metacharacters in $EDITOR/$VISUAL. A hostile env var
    // (poisoned .envrc, shell profile, companion process) could produce RCE
    // when the composer is opened. Use the command-string parser to reject
    // metacharacters, and gate on path.isAbsolute for the resolved binary.
    let editorCmd: string;
    let editorArgs: string[];
    try {
      const tokens = parseCommandString(editor);
      const [bin, ...rest] = tokens as [string, ...string[]];
      if (!path.isAbsolute(bin)) {
        // Relative binaries are resolved through $PATH; disallow to keep the
        // attack surface explicit. Users should set $EDITOR to an absolute
        // path (e.g. /usr/bin/nano) or a plain name they trust their PATH for.
        // We permit plain names that contain no path separators (e.g. "nano",
        // "vim") since those are the conventional $EDITOR values and have no
        // traversal risk - only reject values with a "/" that don't start at "/".
        if (bin.includes("/")) {
          throw new CommandParseError(
            `editor binary "${bin}" is a relative path; use an absolute path or a plain command name`,
          );
        }
      }
      editorCmd = bin;
      editorArgs = rest;
    } catch (err) {
      const msg =
        err instanceof CommandParseError ? err.message : String(err);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      resumeAlt(wasAlt);
      return null;
      void msg; // suppress lint - logged via the outer catch path
    }
    await new Promise<void>((resolve, reject) => {
      const child = childProcess.spawn(editorCmd, [...editorArgs, tmp], {
        stdio: "inherit",
      });
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`editor exited ${code}`))));
      child.on("error", reject);
    });
  } catch {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    resumeAlt(wasAlt);
    return null;
  }
  resumeAlt(wasAlt);
  let next: string;
  try {
    next = fs.readFileSync(tmp, "utf8");
  } catch {
    next = initial;
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  // Strip a single trailing newline that most editors append.
  return next.replace(/\n$/, "");
}
