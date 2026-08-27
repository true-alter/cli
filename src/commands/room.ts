/**
 * `alter room` -- the personal panel.
 *
 * Extends the bios-menu alt-screen frame into a content panel that
 * holds the user's identity card on top and a presence pane below.
 * Substrate is brand-locked; the framing is the user's (composition
 * is the authorship).
 *
 * Two panes:
 *
 *   YOU             handle, opener, sigil, attunement glyph, seat
 *                   marker if held, status line per config
 *   PRESENCE        recent presence broadcasts from granted peers
 *
 * The presence pane is grounded in the voluntary-broadcast model -
 * there is NO ambient "green dot" for any peer. A peer appears only
 * if THEY explicitly broadcast a presence message of the form
 * `application/x-alter-presence` to your inbox. ALTER does not
 * sample, does not synthesise, does not pass through behavioural
 * signal. This is the consent floor.
 *
 * The user emits their own presence with `alter room emit [state]`,
 * which writes an `application/x-alter-presence` message to all
 * granted peers. State defaults to `here`; the four canonical states
 * are `here`, `focus`, `open`, `quiet` - declarative-provenance
 * (you wrote it; nothing inferred).
 *
 * Sub-keybinds inside the room:
 *   e             broadcast your own presence
 *   r             refresh the presence pane
 *   ↑/↓           navigate the presence list
 *   ← | q | Esc   back to main menu
 *
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import {
  AlterClient,
  AlterAuthError,
  AlterRateLimited,
  AlterToolError,
} from "@truealter/sdk";

import { getSession, sessionRejectedMessage } from "../auth.js";
import { resolveBoundSigningKey, SigningKeyMismatchError } from "../signing.js";
import { loadConfig } from "../config/loader.js";
import { getMcpExtraHeaders } from "../lib/cf-access-headers.js";
import { getCliVersion } from "../lib/version.js";
import { DEFAULT_OPENERS, render as renderOpener, pick as pickOpener } from "../theme/openers.js";
import { composeSigil } from "../theme/sigil.js";
import type { SigilConfig } from "../config/schema.js";
import {
  brand,
  drawFrame,
  enterAlt,
  exitAlt,
  termSize,
} from "../ui/biosMenu.js";
import {
  createInputSession,
  type DecodedKey,
  type InputSession,
} from "../ui/rawKeys.js";
import { openMessenger } from "../messenger/index.js";
import { emitSessionHeartbeat } from "../lib/active-sessions-emit.js";

/** Running CLI version - read from package.json at load, never a literal (see lib/version.ts). */
const CLI_VERSION = getCliVersion();

// ---------------------------------------------------------------------------
// Presence feed - voluntary broadcast model
// ---------------------------------------------------------------------------

/**
 * The L3 daemon's local presence-feed cache. Each line is one
 * `application/x-alter-presence` message that arrived in the
 * caller's inbox from a granted peer.
 *
 * Schema per line (JSON), as written by the local daemon
 * into presence.jsonl:
 *   {
 *     "handle":     "~peer",
 *     "state":      "focus" | "here" | "open" | "quiet",
 *     "set_at":     "2026-04-24T10:42:11Z",
 *     "expires_at": "2026-04-24T11:42:11Z"   // OPTIONAL, may be null
 *   }
 *
 * The file is read-only from the CLI's perspective; the daemon owns the
 * write side (alter_presence_set MCP tool -> bus -> the daemon).
 * Until a granted peer broadcasts, this file may not exist and the
 * presence pane shows the "no peers active right now" placeholder.
 * That is the correct behaviour - we do not synthesise presence.
 * Legacy builds wrote sender/sent_at/until; the reader accepts both.
 */
const ALTER_RUNTIME_DATA_DIR = path.join(
  process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
  "alter-runtime",
);
const PRESENCE_FEED_FILE = path.join(
  ALTER_RUNTIME_DATA_DIR,
  "presence.jsonl",
);
const CEREMONY_ECHO_FILE = path.join(
  ALTER_RUNTIME_DATA_DIR,
  "ceremony-echo.json",
);

/**
 * Local mirror of the member's public-presence capability and last-
 * emitted own state. The authoritative store is the backend (set by the
 * `alter_presence_public_enable` / `alter_presence_public_disable`
 * member_self tools and `alter_presence_set`); this file is a cheap,
 * synchronously-readable shadow so the ambient header can render
 * "open to the street" (public ON) vs "open to peers" (public OFF)
 * without a network round-trip. Default-closed: a missing file means
 * the public-presence capability is OFF - the header never claims
 * "open to the street" without an explicit local enable on record.
 *
 * Schema (JSON):
 *   { "public_enabled": boolean, "own_state": "here"|"focus"|"open"|"quiet"|null }
 */
const PUBLIC_PRESENCE_FILE = path.join(
  ALTER_RUNTIME_DATA_DIR,
  "public-presence.json",
);

interface PresenceEntry {
  sender: string;
  state: string;
  sent_at: string;
  until?: string;
}

const VALID_STATES = ["here", "focus", "open", "quiet"] as const;
type PresenceState = (typeof VALID_STATES)[number];

function isValidState(s: string): s is PresenceState {
  return (VALID_STATES as readonly string[]).includes(s);
}

function readPresenceFeed(limit = 12): PresenceEntry[] {
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
        typeof sentAt === "string"
      ) {
        out.push({
          sender,
          state: parsed.state,
          sent_at: sentAt,
          until: typeof until === "string" ? until : undefined,
        });
      }
    } catch {
      // skip malformed line
    }
  }
  // Newest first; cap to limit.
  out.sort((a, b) => (a.sent_at < b.sent_at ? 1 : -1));
  return out.slice(0, limit);
}

/**
 * True when the presence-feed file exists on disk - i.e. the
 * alter-runtime daemon has run and created its cache. We use the same
 * ENOENT signal the reader swallows to tell two empty states apart:
 * file absent → daemon never started; file present but no current peers
 * → daemon running, nobody broadcasting.
 */
function presenceFeedExists(): boolean {
  return fs.existsSync(PRESENCE_FEED_FILE);
}

// ---------------------------------------------------------------------------
// Public-presence capability - local mirror of the backend flag
// ---------------------------------------------------------------------------

interface PublicPresenceLocal {
  /** Whether the public-presence capability is enabled (default OFF). */
  public_enabled: boolean;
  /** The member's last-emitted own state, or null if never emitted. */
  own_state: string | null;
}

/**
 * Read the local public-presence mirror. Default-closed: a missing or
 * unparseable file reports the capability OFF and no own-state, so the
 * header never claims "open to the street" without an explicit enable
 * on record. Exported for the ambient header's open-qualifier render.
 */
export function readPublicPresenceLocal(): PublicPresenceLocal {
  let raw: string;
  try {
    raw = fs.readFileSync(PUBLIC_PRESENCE_FILE, "utf8");
  } catch {
    return { public_enabled: false, own_state: null };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { public_enabled: false, own_state: null };
  }
  return {
    public_enabled: parsed.public_enabled === true,
    own_state:
      typeof parsed.own_state === "string" ? parsed.own_state : null,
  };
}

/**
 * Merge-write the local public-presence mirror. Only the provided fields
 * are overwritten; the others are preserved so an enable/disable does not
 * clobber the last-emitted own state and vice versa. Best-effort: a write
 * failure is swallowed (the backend remains authoritative; the local
 * mirror is only a header convenience).
 */
function writePublicPresenceLocal(patch: Partial<PublicPresenceLocal>): void {
  const current = readPublicPresenceLocal();
  const next: PublicPresenceLocal = {
    public_enabled: patch.public_enabled ?? current.public_enabled,
    own_state:
      patch.own_state !== undefined ? patch.own_state : current.own_state,
  };
  try {
    fs.mkdirSync(ALTER_RUNTIME_DATA_DIR, { recursive: true });
    fs.writeFileSync(PUBLIC_PRESENCE_FILE, JSON.stringify(next), "utf8");
  } catch {
    // best-effort - backend is authoritative
  }
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "-";
  const diff = Date.now() - then;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// ---------------------------------------------------------------------------
// Ceremony echo (72 h recognition echo, produced by alter-runtime)
// ---------------------------------------------------------------------------

/**
 * Read the runtime's ceremony-echo state if still within the 72 h
 * window. Produced by the local daemon. Returns
 * `null` if the file is missing, unparseable, or the echo has expired.
 *
 * The user cannot author or dismiss the echo - protocol-observed
 * recognition.
 */
interface CeremonyEchoState {
  sender: string;
  kind: string;
  body_md: string;
  received_at: string;
}

function readCeremonyEcho(now: Date = new Date()): CeremonyEchoState | null {
  let raw: string;
  try {
    raw = fs.readFileSync(CEREMONY_ECHO_FILE, "utf8");
  } catch {
    return null;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const expiresAt =
    typeof parsed.expires_at === "string" ? Date.parse(parsed.expires_at) : NaN;
  if (Number.isNaN(expiresAt) || expiresAt <= now.getTime()) return null;

  const rec = parsed.last_recognition;
  if (!rec || typeof rec !== "object") return null;
  const r = rec as Record<string, unknown>;
  if (
    typeof r.sender !== "string" ||
    typeof r.kind !== "string" ||
    typeof r.received_at !== "string"
  ) {
    return null;
  }
  return {
    sender: r.sender,
    kind: r.kind,
    body_md: typeof r.body_md === "string" ? r.body_md : "",
    received_at: r.received_at,
  };
}

// ---------------------------------------------------------------------------
// Identity card (the YOU pane)
// ---------------------------------------------------------------------------

interface HomepageBlock {
  whoami?: string;
  opener?: string;
  pronouns?: string;
  sigil?: string;
  /** Public contact email - OTP-verified, shown on the handle. */
  contact_email?: string;
  /** ISO timestamp of the verify ceremony - drives the "verified" mark. */
  contact_email_verified_at?: string;
}

function readHomepageBlock(
  passthrough: Record<string, unknown> | undefined,
  typedHomepage?: {
    contact_email?: string;
    contact_email_verified_at?: string;
  } | null,
): HomepageBlock | null {
  const out: HomepageBlock = {};
  let hasAny = false;

  // Legacy passthrough fields (whoami, opener, pronouns, sigil).
  if (passthrough && typeof passthrough.homepage === "object" && passthrough.homepage) {
    const block = passthrough.homepage as Record<string, unknown>;
    if (typeof block.whoami === "string") { out.whoami = block.whoami; hasAny = true; }
    if (typeof block.opener === "string") { out.opener = block.opener; hasAny = true; }
    if (typeof block.pronouns === "string") { out.pronouns = block.pronouns; hasAny = true; }
    if (typeof block.sigil === "string") { out.sigil = block.sigil; hasAny = true; }
  }

  // Typed homepage fields (contact_email - written by the menu's OTP verify
  // ceremony under Account › Contact email; `config set` rejects the key).
  if (typedHomepage?.contact_email) {
    out.contact_email = typedHomepage.contact_email;
    if (typedHomepage.contact_email_verified_at) {
      out.contact_email_verified_at = typedHomepage.contact_email_verified_at;
    }
    hasAny = true;
  }

  return hasAny ? out : null;
}

// ---------------------------------------------------------------------------
// Pane rendering
// ---------------------------------------------------------------------------

interface RoomFlash {
  // `info` (dim), `ok` (accent), or `error` (accentDeep) - controls colour.
  kind: "info" | "ok" | "error";
  text: string;
}

interface RoomState {
  handle: string;
  homepage: HomepageBlock | null;
  sigil: SigilConfig | null;
  /**
   * User's authored opener override (`config.opener.line`). When set,
   * wins over `homepage.opener` and the rotating DEFAULT_OPENERS pool.
   */
  configOpenerLine: string | null;
  feed: PresenceEntry[];
  fieldIndex: number;
  echo: CeremonyEchoState | null;
  /**
   * Transient one-line banner rendered above the keybind footer. Cleared
   * by the next user keypress. Used for broadcast confirmations and
   * inline error messages so the room never silently exits.
   */
  flash: RoomFlash | null;
  /**
   * True while the `e` state picker is armed. The main key handler stands
   * down (the picker's one-shot handler owns the next keypress) and the
   * footer switches to the state options - WITHOUT this flag, the main
   * handler also saw the pick keypress, so choosing `q` (quiet) or
   * pressing Esc (cancel) closed the whole room instead.
   */
  picking: boolean;
  /** The member's own last-broadcast state (local mirror), for the card. */
  ownState: string | null;
}

function renderYouLines(state: RoomState): string[] {
  const lines: string[] = [];
  const homepage = state.homepage ?? {};

  // Opener cascade (highest priority first):
  //   1. config.opener.line  - per-room user customisation
  //   2. homepage.opener     - room-default published in the homepage block
  //   3. pickOpener(DEFAULT_OPENERS) - global rotating fallback pool
  const opener = state.configOpenerLine ?? homepage.opener ?? pickOpener(DEFAULT_OPENERS);
  const openerLine = renderOpener(opener, state.handle);
  lines.push(brand.accent(openerLine));

  // Name what this room is FOR. Short declarative gloss in
  // the existing dim/faint register, broken across two lines so the
  // 88-column frame clamp doesn't truncate it on common terminals.
  lines.push(
    "  " +
      brand.faint(
        "what peers see when they look at you, plus presence broadcasts",
      ),
  );
  lines.push(
    "  " +
      brand.faint("from peers you've granted. declared, not inferred."),
  );
  lines.push("");

  // Recognition echo. Surfaces at the top of the YOU pane for 72 h
  // after any recognition / Naming Ceremony event. User cannot
  // author, extend, or dismiss. Produced by the local daemon.
  if (state.echo) {
    const kindLabel =
      state.echo.kind === "x-alter-recognition" ? "recognised" : "witnessed";
    lines.push(
      "  " +
        brand.accentDeep("· · ·") +
        "  " +
        brand.accent(kindLabel) +
        brand.dim(" by ") +
        brand.handle(state.echo.sender),
    );
    if (state.echo.body_md) {
      // Render the first line of the echo body as a quiet italic gloss.
      const firstLine = state.echo.body_md.split("\n")[0]?.trim() ?? "";
      if (firstLine) {
        const truncated =
          firstLine.length > 80 ? firstLine.slice(0, 80) + "…" : firstLine;
        lines.push("  " + brand.faint(`"${truncated}"`));
      }
    }
    lines.push("");
  }

  if (homepage.whoami) {
    // whoami renders as a quoted block - declared-provenance verbatim.
    lines.push(brand.text(`  ${homepage.whoami}`));
    lines.push("");
  }

  // That row is stripped; the field is private and must not appear in any
  // user-facing surface, debug-gated or not.
  // When a sigil renders, attach a dim hint pointing the user
  // at the customise menu. The caption sits one row below the sigil so
  // the row alignment for `handle`/`pronouns`/`sigil`/`attunement` is
  // unaffected.
  interface CardRow {
    label: string;
    value: string;
    /** Optional caption rendered as a dim continuation line below. */
    caption?: string;
  }
  const cardRows: CardRow[] = [];
  cardRows.push({ label: "handle", value: state.handle });
  // Persistent own-broadcast row: the transient flash confirms the moment;
  // this row keeps the answer to "what am I broadcasting right now?" on
  // screen. Local mirror only - granted peers read the daemon fan-out.
  if (state.ownState) {
    cardRows.push({
      label: "presence",
      value: brand.accent(state.ownState),
      caption: brand.faint("your broadcast to granted peers - e to change"),
    });
  }
  if (homepage.pronouns) {
    cardRows.push({ label: "pronouns", value: homepage.pronouns });
  }
  if (homepage.contact_email) {
    // The verified mark renders only when the OTP ceremony stamped the
    // timestamp - a hand-authored legacy value shows plain, never falsely
    // labelled.
    cardRows.push({
      label: "contact",
      value: homepage.contact_email_verified_at
        ? homepage.contact_email + " " + brand.faint("verified")
        : homepage.contact_email,
    });
  }

  // Prefer the composed sigil (user picked via the Customise menu).
  // Fall back to the legacy `homepage.sigil` passthrough string (hand-
  // edited into `config.toml`) so existing authored
  // values survive. If neither is present, omit the row - an unset
  // sigil renders as nothing, not as a placeholder.
  const composedSigil = composeSigil(state.sigil ?? undefined);
  // The sigil caption. Brighter (`dim`) when the user hasn't
  // customised any slots so the meaning isn't lost on first encounter;
  // quieter (`faint`) once they've picked at least one slot themselves.
  const sigilTouched =
    state.sigil !== null &&
    state.sigil !== undefined &&
    (state.sigil.border_set !== undefined ||
      state.sigil.wordmark !== undefined ||
      state.sigil.accent_glyph !== undefined);
  const sigilCaption = sigilTouched
    ? brand.faint("change in Me → Customise → Sigil")
    : brand.dim("your private mark - change in Me → Customise → Sigil");
  if (composedSigil) {
    cardRows.push({
      label: "sigil",
      value: brand.accent(composedSigil),
      caption: sigilCaption,
    });
  } else if (homepage.sigil) {
    cardRows.push({
      label: "sigil",
      value: homepage.sigil,
      caption: sigilCaption,
    });
  }

  // Stubs for surfaces that arrive later:
  cardRows.push({
    label: "attunement",
    value:
      brand.dim("·  ·  ·  ·  ·  ·  ·  ·  ·  ·") + "  " + brand.faint("(coming soon)"),
  });

  const labelWidth = Math.max(...cardRows.map((r) => r.label.length));
  for (const row of cardRows) {
    lines.push(
      `  ${brand.muted(row.label.padEnd(labelWidth))}  ${brand.dim("│")}  ${row.value}`,
    );
    if (row.caption) {
      // Indent under the value column so the caption visually trails
      // the row it belongs to without re-claiming the label slot.
      lines.push(`  ${" ".repeat(labelWidth)}  ${brand.dim("│")}  ${row.caption}`);
    }
  }

  return lines;
}

function renderFieldLines(state: RoomState): string[] {
  const lines: string[] = [];

  if (state.feed.length === 0) {
    if (!presenceFeedExists()) {
      // Daemon never started - the presence cache file doesn't exist yet.
      // Tell the member exactly how to turn presence on.
      lines.push(brand.dim("  presence needs the alter-runtime daemon."));
      lines.push(brand.faint("  start it:  alter-runtime daemon"));
      lines.push("");
      lines.push(brand.faint("  granted peers' voluntary broadcasts land"));
      lines.push(brand.faint("  here once it's running. nobody is sampled,"));
      lines.push(brand.faint("  nobody is inferred - only what peers send."));
      return lines;
    }
    // Daemon is running (cache file exists) - just nobody present.
    lines.push(brand.dim("  no peers active right now."));
    lines.push("");
    lines.push(brand.faint("  voluntary presence broadcasts from your"));
    lines.push(brand.faint("  granted peers land here. nobody is sampled,"));
    lines.push(brand.faint("  nobody is inferred - only what peers send."));
    return lines;
  }

  state.feed.forEach((entry, i) => {
    const selected = i === state.fieldIndex;
    const marker = selected ? brand.marker("▸") : " ";
    const sender = brand.handle(entry.sender);
    const state_ = brand.accent(entry.state);
    const when = brand.dim(formatRelative(entry.sent_at));
    lines.push(`  ${marker} ${sender}  ${brand.dim("·")}  ${state_}  ${brand.dim("·")}  ${when}`);
  });

  return lines;
}

// ---------------------------------------------------------------------------
// Two-pane content frame (built on biosMenu's drawFrame)
// ---------------------------------------------------------------------------

function renderRoom(state: RoomState): void {
  const { cols } = termSize();
  const youLines = renderYouLines(state);
  const fieldLines = renderFieldLines(state);

  // Stack vertically - the alt-screen frame is too narrow for a true
  // two-column layout at common terminal sizes. The two sections read
  // top-down with a horizontal divider between them, which keeps the
  // identity card prominent and the presence pane scannable below.
  const body: string[] = [];
  body.push("");
  body.push("  " + brand.titleDim("you") + brand.dim("  ·  ") + brand.faint("declarative, locally authored"));
  body.push("");
  body.push(...youLines);
  body.push("");
  body.push("  " + brand.borderDim("─".repeat(Math.max(20, cols - 8))));
  body.push("");
  body.push("  " + brand.titleDim("presence") + brand.dim("  ·  ") + brand.faint("voluntary broadcasts from granted peers"));
  body.push("");
  body.push(...fieldLines);

  // Transient flash banner - confirmations, no-op notes, errors.
  if (state.flash) {
    body.push("");
    const colour =
      state.flash.kind === "ok"
        ? brand.accent
        : state.flash.kind === "error"
          ? brand.accentDeep
          : brand.dim;
    body.push("  " + colour(`· ${state.flash.text} ·`));
  }

  // Pick mode swaps the footer for the state options so the choice is a
  // visible mode, not a one-line hint the eye can miss.
  const footer = state.picking
    ? brand.title("  broadcast:  ") +
      brand.muted("h") + brand.dim(" here    ") +
      brand.muted("f") + brand.dim(" focus    ") +
      brand.muted("o") + brand.dim(" open    ") +
      brand.muted("q") + brand.dim(" quiet    ") +
      brand.muted("esc") + brand.dim(" cancel")
    : brand.dim("  ↑↓ presence    ") +
      brand.muted("e") +
      brand.dim(" broadcast presence    ") +
      brand.muted("r") +
      brand.dim(" refresh    ") +
      brand.muted("←/q/esc") +
      brand.dim(" back");

  drawFrame({
    title: brand.title("~Alter") + brand.dim(" · ") + brand.titleDim("Room"),
    body,
    footer,
  });
}

// ---------------------------------------------------------------------------
// Interactive room loop
// ---------------------------------------------------------------------------

async function runInteractive(state: RoomState): Promise<void> {
  const stdin = process.stdin;

  enterAlt();

  return new Promise<void>((resolve) => {
    let session: InputSession | null = null;
    const cleanup = (): void => {
      session?.dispose();
      process.stdout.removeListener("resize", redraw);
      exitAlt();
    };

    const finish = (): void => {
      cleanup();
      resolve();
    };

    const redraw = (): void => renderRoom(state);

    // Resolve the `e` state-pick from the next keypress. Folded into the
    // single input session (was a second one-shot raw listener): a parallel
    // listener raced the session's held-ESC flush, so a cancel-the-pick Esc
    // could later re-fire as leave-the-room. One handler, one `picking` flag.
    const resolveStatePick = (sk: DecodedKey): void => {
      state.picking = false;
      let presenceState: typeof VALID_STATES[number] | null = null;
      if (sk.name === "h") presenceState = "here";
      else if (sk.name === "f") presenceState = "focus";
      else if (sk.name === "o") presenceState = "open";
      else if (sk.name === "q" && !sk.ctrl) presenceState = "quiet";
      // esc or any other key cancels
      if (!presenceState) {
        state.flash = { kind: "info", text: "cancelled - nothing broadcast" };
        redraw();
        return;
      }
      state.flash = { kind: "info", text: `broadcasting ${presenceState}…` };
      redraw();
      broadcastPresenceFromRoom(presenceState).then(
        (flash) => {
          state.flash = flash;
          // Mirror the new own-state onto the card immediately - the
          // persistent row is the lasting feedback, the flash the moment.
          if (flash.kind === "ok") state.ownState = presenceState;
          redraw();
        },
        (err) => {
          state.flash = {
            kind: "error",
            text: `broadcast failed - ${(err as Error).message ?? String(err)}`,
          };
          redraw();
        },
      );
    };

    const onKey = (key: DecodedKey): void => {
      if (key.ctrl && key.name === "c") {
        finish();
        return;
      }
      // While the `e` state picker is armed, the next keypress resolves the
      // pick - `q` means quiet and Esc means cancel-the-pick, NOT leave the
      // room.
      if (state.picking) {
        resolveStatePick(key);
        return;
      }
      if (key.name === "q" || key.name === "escape" || key.name === "left") {
        // Back to the main menu - the room is a leaf action, so
        // exit-the-room and exit-back-up-a-level are the same move.
        finish();
        return;
      }
      if (key.name === "up" && state.feed.length > 0) {
        state.fieldIndex =
          (state.fieldIndex - 1 + state.feed.length) % state.feed.length;
        redraw();
        return;
      }
      if (key.name === "down" && state.feed.length > 0) {
        state.fieldIndex = (state.fieldIndex + 1) % state.feed.length;
        redraw();
        return;
      }
      if (key.name === "r") {
        state.feed = readPresenceFeed();
        state.echo = readCeremonyEcho();
        if (state.fieldIndex >= state.feed.length) state.fieldIndex = 0;
        // Refresh clears any flash banner - the room is fresh again.
        state.flash = null;
        redraw();
        return;
      }
      if (key.name === "e") {
        // State picker: the footer switches to the visible state options
        // (h=here, f=focus, o=open, q=quiet); the next keypress resolves it
        // via resolveStatePick (the `picking` branch at the top of onKey).
        state.picking = true;
        state.flash = { kind: "info", text: "pick a state to broadcast" };
        redraw();
        return;
      }
    };

    session = createInputSession(stdin, onKey);
    process.stdout.on("resize", redraw);
    redraw();
  });
}

// ---------------------------------------------------------------------------
// Presence emit - ceremony state via alter_presence_set
// ---------------------------------------------------------------------------

/**
 * `alter_presence_set` is the single MCP tool that
 * records the caller's ceremony state. Replaces the prior per-peer
 * `alter_message_send` fan-out with content_type
 * `application/x-alter-presence`. The daemon-owned presence.jsonl
 * file + DO SSE fan-out carry the broadcast to granted peers; the
 * CLI no longer iterates peers itself.
 */

interface BroadcastOutcome {
  /** Whether the presence state was accepted by the wire. */
  sent: boolean;
  /** Server-side error message if the set failed. Empty on success. */
  error: string | null;
}

/**
 * Build an authenticated MCP client from the on-disk session, mirroring
 * the pattern in `src/commands/msg.ts::requireAuthedClient`. Returns
 * `null` and a remediation message when the session is incomplete; the
 * caller decides how to surface it (CLI subcommand prints it, room
 * keypress shows it as a flash banner).
 */
function tryBuildClient(): { client: AlterClient; handle: string } | { error: string } {
  const session = getSession();
  if (!session) return { error: "not signed in. run `alter login` first." };
  if (!session.member_api_key) {
    return { error: "no member API key on this session. run `alter key member rotate`." };
  }
  if (!session.signing_kid) {
    return { error: "no signing kid. re-run `alter login`." };
  }
  // Bound resolution: refuses on kid/key mismatch, never another key.
  let privateKeyPem: string | null;
  try {
    privateKeyPem = resolveBoundSigningKey(session);
  } catch (err) {
    if (err instanceof SigningKeyMismatchError) return { error: err.message };
    throw err;
  }
  if (!privateKeyPem) {
    return { error: "signing key missing - re-run `alter login`." };
  }
  const extraHeaders = getMcpExtraHeaders(CLI_VERSION);
  const client = new AlterClient({
    apiKey: session.member_api_key,
    clientInfo: { name: "alter-cli", version: CLI_VERSION },
    signing: {
      kid: session.signing_kid,
      privateKey: privateKeyPem,
      handle: session.handle,
    },
    extraHeaders,
  });
  return { client, handle: session.handle };
}

/**
 * Common presence-set core, shared between the in-room keypress path
 * and the `alter room emit` CLI subcommand. Calls the
 * `alter_presence_set` MCP tool - the daemon-owned presence.jsonl +
 * DO SSE fan-out carry the state to granted peers. Never throws;
 * every error becomes a structured outcome so the caller can decide
 * how to surface it.
 */
async function executeBroadcast(state: string): Promise<BroadcastOutcome | { error: string }> {
  if (!isValidState(state)) {
    return {
      error: `unknown presence state: ${state}. valid: ${VALID_STATES.join(", ")}`,
    };
  }
  const built = tryBuildClient();
  if ("error" in built) return built;

  const { client } = built;
  try {
    await client.mcp.callTool("alter_presence_set", { state });
    // Mirror the emitted own state locally so the ambient header can tell
    // "open to the street" (public ON) from "open to peers" (public OFF)
    // when the member's own state is `open`. Backend stays authoritative.
    writePublicPresenceLocal({ own_state: state });
    return { sent: true, error: null };
  } catch (err) {
    if (err instanceof AlterAuthError) {
      return { error: sessionRejectedMessage({ terse: true }) };
    }
    if (err instanceof AlterRateLimited) {
      return {
        error: `rate limited - retry after ${err.retryAfter}s`,
      };
    }
    if (err instanceof AlterToolError) {
      return { sent: false, error: err.message };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { sent: false, error: message };
  }
}

/**
 * Compose a single-line `RoomFlash` from a presence-set outcome. Used
 * by the in-room `e` keypress path so the room can keep itself open
 * regardless of success or failure.
 */
function flashFromOutcome(
  outcome: BroadcastOutcome | { error: string },
  state: string,
): RoomFlash {
  if ("error" in outcome && outcome.error && !("sent" in outcome)) {
    return { kind: "error", text: outcome.error };
  }
  if ("sent" in outcome) {
    if (outcome.sent) {
      return {
        kind: "ok",
        text: `presence set to ${state} - granted peers can see it`,
      };
    }
    return {
      kind: "error",
      text: `presence set failed - ${outcome.error ?? "unknown error"}`,
    };
  }
  return { kind: "error", text: "presence set failed" };
}

/** In-room keypress entry point - see runInteractive. */
async function broadcastPresenceFromRoom(state: string): Promise<RoomFlash> {
  const outcome = await executeBroadcast(state);
  return flashFromOutcome(outcome, state);
}

/**
 * Structured broadcast for OTHER surfaces (the messenger's presence pane).
 * Returns `{ok, text}` so the caller can colour its own feedback correctly -
 * the prior messenger path flashed `emitPresence`'s error STRINGS as "ok",
 * which is why a failed broadcast looked like nothing happened.
 */
export async function broadcastPresence(
  state: string,
): Promise<{ ok: boolean; text: string }> {
  const outcome = await executeBroadcast(state);
  const f = flashFromOutcome(outcome, state);
  return { ok: f.kind === "ok", text: f.text };
}

/**
 * `alter room emit [state]` - CLI subcommand entry point. Returns a
 * printable string describing the outcome. Tests assert that this
 * function rejects unknown states and resolves to a non-empty string
 * for valid ones (see tests/test_room.ts).
 */
export async function emitPresence(state: string): Promise<string> {
  if (!isValidState(state)) {
    throw new Error(
      `unknown presence state: ${state}. valid: ${VALID_STATES.join(", ")}`,
    );
  }

  const outcome = await executeBroadcast(state);
  if ("error" in outcome && !("sent" in outcome)) {
    return brand.text(outcome.error);
  }

  if ("sent" in outcome && outcome.sent) {
    return brand.accent(
      `presence set to ${brand.title(state)} - broadcast via daemon to granted peers.`,
    );
  }

  const message =
    "sent" in outcome && outcome.error
      ? outcome.error
      : "presence set failed";
  return brand.text(`presence set failed - ${message}`);
}

// ---------------------------------------------------------------------------
// Public presence - the master, default-OFF, revocable "come in" capability
// ---------------------------------------------------------------------------

/**
 * The opt-in disclosure shown BEFORE the public-presence capability turns
 * on. Anti-extraction requirement:
 * the member must see, in plain words, that public reads are free to the
 * caller and EXACTLY what a stranger can see - the open-or-closed bit
 * only, never the specific non-open state. `here`, `focus`, and `quiet`
 * never reach a stranger; only `open` shows, and only as "open".
 */
const PUBLIC_PRESENCE_DISCLOSURE: string[] = [
  "Public presence is a shop-front sign. Turn it on and any verified",
  "caller - including people you've never met - can read ONE bit about",
  "you: whether you are open, or not.",
  "",
  "What a stranger sees:",
  "  • when your state is open  →  \"open\"  (a come-in sign)",
  "  • any other state          →  \"closed\"",
  "",
  "Strangers NEVER see here, focus, or quiet - those stay between you",
  "and the peers you've granted. They see open, or nothing.",
  "",
  "These public reads are free to the caller - no payment, no earning.",
  "Default is OFF. Revoke any time: turn this off, set quiet, or let it",
  "expire. You are always in control of the sign.",
];

/**
 * Flip the public-presence capability on or off via the member_self MCP
 * tools `alter_presence_public_enable` / `alter_presence_public_disable`,
 * mirroring the `executeBroadcast` wire pattern. Records the new state in
 * the local mirror so the ambient header reflects it without a round-trip.
 * Never throws; returns a structured outcome.
 */
async function executeSetPublicPresence(
  enable: boolean,
): Promise<BroadcastOutcome | { error: string }> {
  const built = tryBuildClient();
  if ("error" in built) return built;

  const { client } = built;
  const tool = enable
    ? "alter_presence_public_enable"
    : "alter_presence_public_disable";
  try {
    await client.mcp.callTool(tool, {});
    writePublicPresenceLocal({ public_enabled: enable });
    return { sent: true, error: null };
  } catch (err) {
    if (err instanceof AlterAuthError) {
      return { error: sessionRejectedMessage({ terse: true }) };
    }
    if (err instanceof AlterRateLimited) {
      return { error: `rate limited - retry after ${err.retryAfter}s` };
    }
    if (err instanceof AlterToolError) {
      return { sent: false, error: err.message };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { sent: false, error: message };
  }
}

/**
 * `alter room public on|off` - CLI subcommand entry point for the
 * public-presence toggle. Returns a printable string. On `on`, the
 * anti-extraction disclosure is printed before the wire call so the
 * member always sees what a stranger will see BEFORE the sign goes up.
 */
export async function setPublicPresence(action: string): Promise<string> {
  const enable =
    action === "on" || action === "enable" || action === "true";
  const disable =
    action === "off" || action === "disable" || action === "false";

  if (!enable && !disable) {
    return brand.text(
      "usage: alter room public on|off  (turn the public 'come in' sign on or off)",
    );
  }

  const lines: string[] = [];
  if (enable) {
    // Opt-in disclosure BEFORE the wire call - the member sees exactly
    // what a stranger sees before the sign goes up.
    for (const l of PUBLIC_PRESENCE_DISCLOSURE) {
      lines.push(l ? brand.faint("  " + l) : "");
    }
    lines.push("");
  }

  const outcome = await executeSetPublicPresence(enable);
  if ("error" in outcome && !("sent" in outcome)) {
    lines.push(brand.text(outcome.error));
    return lines.join("\n");
  }
  if ("sent" in outcome && outcome.sent) {
    lines.push(
      enable
        ? brand.accent(
            "public presence ON - your sign reads \"open\" to verified callers when your state is open.",
          )
        : brand.accent(
            "public presence OFF - strangers see nothing; only granted peers see your presence.",
          ),
    );
    return lines.join("\n");
  }
  const message =
    "sent" in outcome && outcome.error ? outcome.error : "unknown error";
  lines.push(brand.text(`public presence change failed - ${message}`));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Top-level command
// ---------------------------------------------------------------------------

/**
 * `alter room` opens the messenger in its presence pane (Room is the
 * messenger; presence is one pane within it - see /msg). With `emit
 * [state]` it broadcasts a presence message without entering the alt-
 * screen.
 *
 * Legacy compatibility: the old presence-only alt-screen panel is still
 * reachable via `alter room legacy` for muscle-memory. Will be removed
 * once the messenger has bedded in.
 */
export async function room(args: string[]): Promise<void> {
  const sub = args[0];

  if (sub === "help" || sub === "--help" || sub === "-h") {
    process.stdout.write(
      [
        "alter room                open the messenger in the presence pane",
        "alter room legacy         legacy presence-only panel (transitional)",
        "alter room emit [state]   broadcast your presence to granted peers",
        "                          state: here (default) | focus | open | quiet",
        "alter room public on|off  the public 'come in' sign - when on, verified",
        "                          strangers can read open-or-closed only (free to them)",
        "",
      ].join("\n"),
    );
    return;
  }

  try {
    emitSessionHeartbeat({
      sessionId: String(process.pid),
      workingOn: "alter room",
    });
  } catch { /* silent - must not block command */ }

  if (sub === "emit") {
    const state = args[1] ?? "here";
    const message = await emitPresence(state);
    process.stdout.write(message + "\n");
    return;
  }

  if (sub === "public") {
    const action = args[1] ?? "";
    const message = await setPublicPresence(action);
    process.stdout.write(message + "\n");
    return;
  }

  const session = getSession();
  if (!session) {
    process.stdout.write(
      "Not signed in. Run `alter login` first.\n",
    );
    return;
  }

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stdout.write(
      "alter room is interactive - run from a real terminal.\n",
    );
    return;
  }

  if (sub !== "legacy") {
    // Default path: the unified messenger, opened in its presence pane.
    // The messenger reads the same presence-feed file and exposes the
    // same `e` keybind to broadcast, so the user experience is a
    // strict superset of the old panel.
    await openMessenger({ initialPane: "presence" });
    return;
  }

  // ── Legacy presence-only panel ───────────────────────────────────────
  const config = await loadConfig();
  const homepage = readHomepageBlock(config._passthrough, config.homepage);
  const feed = readPresenceFeed();
  const echo = readCeremonyEcho();

  const state: RoomState = {
    handle: session.handle,
    homepage,
    sigil: config.sigil ?? null,
    configOpenerLine:
      config.opener && "line" in config.opener ? config.opener.line : null,
    feed,
    fieldIndex: 0,
    echo,
    flash: null,
    picking: false,
    ownState: readPublicPresenceLocal().own_state,
  };

  await runInteractive(state);
}
