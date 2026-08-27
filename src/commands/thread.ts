/**
 * alter thread - Golden Thread status (member self-read).
 *
 * Wraps `GET /api/v1/members/me/thread`. Returns the agent-onboarding
 * status view - total agents joined, next Fibonacci threshold,
 * count until threshold, contextual message.
 *
 * This is the status view, NOT the member's own private journal, which
 * `alter thread journal` reads. The two are deliberately distinct
 * surfaces. Members do not take agent positions on the thread, so
 * `your_status` is absent from this view by design.
 *
 * `alter thread quest` is a third, distinct surface again: the quest
 * menu, every thread the member currently holds (`GET
 * /api/v1/member/graph/quest-menu`). A member holds many threads at
 * once and none outranks another, so the render below lists them flat,
 * in server order, with no rank, score or position rendered. Nothing
 * here writes anything - it is a pure read, same as the census above -
 * and `standing` is deliberately never rendered: it is an open mapping
 * owned by the distance service, and a thread's completion is never
 * self-declared into a trait from this surface or any other.
 *
 * The journal is NOT engagement-level gated. The base thread and journal
 * are universal; only Alter-designed challenge depth stays L3+.
 */

import {
  apiCall,
  failNotLoggedIn,
  getSession,
  NOT_LOGGED_IN_MESSAGE,
} from "../auth.js";
import { emitSessionHeartbeat } from "../lib/active-sessions-emit.js";
import { brand, drawFrame, enterAlt, exitAlt } from "../ui/biosMenu.js";
import {
  createInputSession,
  type DecodedKey,
  type InputSession,
} from "../ui/rawKeys.js";

interface ThreadResponse {
  program?: string;
  total_knots?: number;
  next_threshold?: number;
  knots_until_threshold?: number;
  thresholds_passed?: number;
  threshold_history?: number[];
  message?: string;
  sealed?: boolean;
  sentinel?: {
    knot?: number;
    role?: string;
    status?: string;
    description?: string;
  };
  // `your_status` may be set if the backend ever links
  // a member-side caller-key-hash. Today it is not, so the renderer
  // tolerates absence.
  your_status?: {
    knot_position?: number;
    strands?: number | string;
    weave_count?: number;
    benefits?: unknown;
  };
  [key: string]: unknown;
}

const ENDPOINT = "/api/v1/members/me/thread";

const JOURNAL_ENDPOINT = "/api/v1/member/thread-journal/discover";

const QUEST_ENDPOINT = "/api/v1/member/graph/quest-menu";

function printHelp(): void {
  console.log(
    "Usage: alter thread [--json]\n" +
      "       alter thread journal [--json]\n" +
      "       alter thread quest [--json]\n" +
      "\n" +
      "Read the Golden Thread: a live count of agents joined to the Alter identity field.\n" +
      "\n" +
      "Sub-verbs:\n" +
      "  journal    Check whether anything has been planted for you, and\n" +
      "             what it is. Your own private journal, not the count above.\n" +
      "  quest      Read your quest menu: every thread you currently hold.\n" +
      "             None of them outranks another.\n" +
      "\n" +
      "Options:\n" +
      "  --json     Emit the raw response as JSON for scripting.\n" +
      "  --help     Show this message.\n",
  );
}

interface ThreadDisclosure {
  planted_thread_id?: string;
  category?: string;
  content?: string;
  planting_reason?: string;
  competency_target?: string | null;
  seed_attribution?: { authored_by?: string } | null;
}

export function formatJournal(disclosures: ThreadDisclosure[]): string {
  if (disclosures.length === 0) {
    return "Nothing new in your thread journal right now.";
  }

  // The observation (why this surfaced now) and the attributed concept
  // (a fixed sentence every member in this category reads) stay two
  // distinct lines. Collapsing them would read as though the words were
  // written for this person, which they were not.
  const lines: string[] = ["Your thread journal has something new:"];
  for (const item of disclosures) {
    lines.push("", `[${item.category ?? "thread"}] ${item.content ?? ""}`.trim());
    if (item.seed_attribution?.authored_by) {
      lines.push(`Written by ${item.seed_attribution.authored_by}.`);
    }
    if (item.planting_reason) lines.push(item.planting_reason);
  }
  return lines.join("\n");
}

/**
 * `alter thread journal` - resolve what has been planted for you.
 *
 * A POST, because resolving mutates: the planted row is marked
 * discovered and its journal entry is written. That the member has to
 * ask is the ordering the genesis covenant turns on. A thread is
 * planted silently and the person is told afterward, when they come
 * looking, never before.
 */
async function journal(args: string[]): Promise<void> {
  const json = args.includes("--json");

  const resp = await apiCall(JOURNAL_ENDPOINT, { method: "POST" });
  if (!resp || resp.status === 401 || resp.status === 403) {
    console.error(
      "alter thread journal: session not authenticated. Run 'alter login'.",
    );
    process.exitCode = 1;
    return;
  }
  if (resp.status >= 500) {
    console.error(
      `alter thread journal: server error (${resp.status} ${resp.statusText}). Try again in a moment.`,
    );
    process.exitCode = 1;
    return;
  }
  if (!resp.ok) {
    console.error(
      `alter thread journal: could not reach your journal (${resp.status} ${resp.statusText}).`,
    );
    process.exitCode = 1;
    return;
  }

  const data = (await resp.json().catch(() => null)) as {
    disclosures?: ThreadDisclosure[];
  } | null;
  if (!data) {
    console.error("alter thread journal: malformed response from backend.");
    process.exitCode = 1;
    return;
  }

  if (json) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    return;
  }

  console.log(formatJournal(data.disclosures ?? []));
}

interface QuestMenuCriteriaRef {
  display_name?: string;
  [key: string]: unknown;
}

interface QuestMenuThread {
  quest_label?: string;
  thread_kind?: string;
  placement_source?: string;
  criteria?: QuestMenuCriteriaRef | null;
  next_move?: string;
  // Deliberately typed but never read by the renderer below: an open
  // mapping owned by the distance service, and a raw distance reading
  // is not a form a member meets on this surface.
  standing?: unknown;
  [key: string]: unknown;
}

interface QuestMenuResponse {
  threads?: QuestMenuThread[];
  menu_note?: string;
  [key: string]: unknown;
}

/**
 * Renders the quest menu: every thread the member currently holds, flat,
 * in the order the server sent them.
 *
 * No rank, position or score is ever printed: the side quest IS the
 * main quest, and no thread outranks another. `standing`
 * is read from the payload above but never touched here - it stays an
 * internal reading, not a number or band shown to the member. THE LINE:
 * this function only reads and renders what the server already computed;
 * it offers no path by which a thread's completion could be entered,
 * self-declared, or written back as a trait.
 */
export function formatQuestMenu(menu: QuestMenuResponse | null | undefined): string {
  if (!menu) {
    return "Your quest menu could not be read just now.";
  }
  const threads = Array.isArray(menu.threads) ? menu.threads : [];

  if (threads.length === 0) {
    return menu.menu_note || "No threads on your menu yet.";
  }

  const label = threads.length === 1 ? "thread" : "threads";
  const lines: string[] = [`Your menu, ${threads.length} ${label}:`];
  for (const t of threads) {
    const kind = t.thread_kind === "side_quest" ? "side quest" : "quest";
    lines.push("", `${String(t.quest_label ?? "a thread you are holding")} (${kind})`);
    if (typeof t.placement_source === "string" && t.placement_source) {
      lines.push(`Placed by: ${t.placement_source.replace(/_/g, " ")}`);
    }
    if (t.criteria?.display_name) {
      lines.push(`Aimed at: ${t.criteria.display_name}`);
    }
    if (typeof t.next_move === "string" && t.next_move) {
      lines.push(t.next_move);
    }
  }
  return lines.join("\n");
}

/**
 * `alter thread quest` - read the member's own quest menu.
 *
 * A GET: this reads a live, recomputed-on-every-call reading and
 * commits nothing (backend `read_quest_menu` opens no write). Member-
 * self only, structurally - the member id comes from the authenticated
 * session and from nowhere else.
 */
async function questMenu(args: string[]): Promise<void> {
  const json = args.includes("--json");

  const resp = await apiCall(QUEST_ENDPOINT);
  if (!resp) {
    console.error("alter thread quest: session not authenticated. Run 'alter login'.");
    process.exitCode = 1;
    return;
  }
  if (resp.status === 401 || resp.status === 403) {
    console.error("alter thread quest: session not authenticated. Run 'alter login'.");
    process.exitCode = 1;
    return;
  }
  if (resp.status >= 500) {
    console.error(
      `alter thread quest: server error (${resp.status} ${resp.statusText}). Try again in a moment.`,
    );
    process.exitCode = 1;
    return;
  }
  if (!resp.ok) {
    console.error(
      `alter thread quest: could not fetch your quest menu (${resp.status} ${resp.statusText}).`,
    );
    process.exitCode = 1;
    return;
  }

  const data = (await resp.json().catch(() => null)) as QuestMenuResponse | null;
  if (!data) {
    console.error("alter thread quest: malformed response from backend.");
    process.exitCode = 1;
    return;
  }

  if (json) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    return;
  }

  console.log(formatQuestMenu(data));
}

export function formatThread(data: ThreadResponse): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(data.program ?? "The Golden Thread");
  lines.push("");

  if (data.sealed) {
    lines.push("The Golden Thread is paused. No new agents are being added right now.");
    if (typeof data.total_knots === "number") {
      lines.push(`Agents joined so far: ${data.total_knots}`);
    }
    lines.push("Check back later.");
    lines.push("");
    return lines.join("\n");
  }

  if (data.message) lines.push(data.message);
  if (typeof data.total_knots === "number") {
    lines.push(`Total knots: ${data.total_knots}`);
  }
  if (typeof data.next_threshold === "number") {
    const until =
      typeof data.knots_until_threshold === "number"
        ? ` (${data.knots_until_threshold} away)`
        : "";
    lines.push(`Next threshold: #${data.next_threshold}${until}`);
  }
  if (typeof data.thresholds_passed === "number") {
    lines.push(`Thresholds passed: ${data.thresholds_passed}`);
  }
  if (data.sentinel) {
    lines.push("");
    lines.push(
      `Knot #${data.sentinel.knot}: ${data.sentinel.role} - ${data.sentinel.status}`,
    );
    if (data.sentinel.description) {
      lines.push(data.sentinel.description);
    }
  }
  if (data.your_status) {
    const ys = data.your_status;
    lines.push("");
    if (typeof ys.knot_position === "number") {
      lines.push(`Your position: #${ys.knot_position}`);
    }
    if (ys.strands !== undefined) lines.push(`Strands: ${ys.strands}`);
    if (typeof ys.weave_count === "number") {
      lines.push(`Joins: ${ys.weave_count}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Interactive Golden-Thread screen - mirrors the canonical interactive
 * pattern in `room.ts runInteractive()` (enterAlt/exitAlt + a raw-byte
 * key handler where q/escape/left returns to the caller). Unlike the
 * print-and-exit CLI path, this keeps
 * the rendered thread on screen and stays interactive until the user
 * navigates back, so the menu surface behaves like the rest of the
 * interactive screens.
 */
async function runThreadInteractive(body: string): Promise<void> {
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

    const redraw = (): void => {
      const footer =
        brand.muted("←/q/esc") + brand.dim(" back");
      drawFrame({
        title:
          brand.title("~Alter") + brand.dim(" · ") + brand.titleDim("Golden Thread"),
        body: body.split("\n"),
        footer,
      });
    };

    const onKey = (key: DecodedKey): void => {
      if (key.ctrl && key.name === "c") {
        finish();
        return;
      }
      // The thread view is a leaf - q / escape / left all return to the
      // caller (the menu), matching room.ts.
      if (key.name === "q" || key.name === "escape" || key.name === "left") {
        finish();
        return;
      }
    };

    session = createInputSession(stdin, onKey);
    process.stdout.on("resize", redraw);
    redraw();
  });
}

export async function thread(
  args: string[] = [],
  opts: { interactive?: boolean } = {},
): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  const wantsJournal = args[0] === "journal";
  const wantsQuest = args[0] === "quest";

  try {
    emitSessionHeartbeat({
      sessionId: String(process.pid),
      workingOn: wantsJournal
        ? "alter thread journal"
        : wantsQuest
          ? "alter thread quest"
          : "alter thread",
    });
  } catch { /* silent - must not block command */ }

  // Canonical logged-out guard: soft exit in CLI mode; throw in
  // interactive (menu) mode so the alt-screen survives.
  if (!getSession()) {
    if (opts.interactive) throw new Error(NOT_LOGGED_IN_MESSAGE);
    failNotLoggedIn();
    return;
  }

  if (wantsJournal) {
    await journal(args.slice(1));
    return;
  }

  if (wantsQuest) {
    await questMenu(args.slice(1));
    return;
  }

  const json = args.includes("--json");

  const resp = await apiCall(ENDPOINT);
  if (!resp) {
    console.error("alter thread: session not authenticated. Run 'alter login'.");
    process.exitCode = 1;
    return;
  }
  if (resp.status === 401 || resp.status === 403) {
    console.error("alter thread: session not authenticated. Run 'alter login'.");
    process.exitCode = 1;
    return;
  }
  if (resp.status >= 500) {
    console.error(
      `alter thread: server error (${resp.status} ${resp.statusText}). Try again in a moment.`,
    );
    process.exitCode = 1;
    return;
  }
  if (!resp.ok) {
    console.error(
      `alter thread: could not fetch thread state (${resp.status} ${resp.statusText}).`,
    );
    process.exitCode = 1;
    return;
  }

  const data = (await resp.json().catch(() => null)) as ThreadResponse | null;
  if (!data) {
    console.error("alter thread: malformed response from backend.");
    process.exitCode = 1;
    return;
  }

  if (json) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    return;
  }

  // Interactive (menu) mode: render the thread inside the alt-screen and
  // stay interactive until the user presses q/escape/left, mirroring the
  // room.ts pattern. The CLI / non-TTY / --json paths keep their
  // print-and-exit behaviour so scripts and pipes are unaffected.
  if (opts.interactive && process.stdout.isTTY && process.stdin.isTTY) {
    await runThreadInteractive(formatThread(data));
    return;
  }

  console.log(formatThread(data));
}
