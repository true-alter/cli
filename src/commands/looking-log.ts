/**
 * lookingLog - record and read back moments in the search.
 *
 * Wraps two backend endpoints:
 *   POST /api/v1/me/looking  { body: "<text>" }  → 201 { id, body, created_at }
 *   GET  /api/v1/me/looking  → cursor-paginated list of own entries
 *
 * Owner-only, authenticated. Not a claim UI - free text, records an
 * event, never asserts a trait or skill.
 *
 * Copy discipline (per dispatch):
 *   - All net-new user-facing strings flagged NEEDS VOICE REVIEW below.
 *   - No progress %, no completion badge, no streaks.
 *   - Lowercase intimate register, no emoji, no em-dash.
 *   - Never the word "wallet".
 */

import { apiCall } from "../auth.js";
import { pickOne, textInput, BACK_OPTION, isBack } from "../ui/picker.js";
import { brand, withLoadingCancel } from "../ui/biosMenu.js";

// ---------------------------------------------------------------------------
// Backend types
// ---------------------------------------------------------------------------

interface LookingEntry {
  id: string;
  body: string;
  created_at: string;
}

interface LookingListResponse {
  entries: LookingEntry[];
  next_cursor?: string | null;
}

interface LookingCreateResponse {
  id: string;
  body: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Backend wrappers
// ---------------------------------------------------------------------------

async function postMoment(body: string): Promise<LookingCreateResponse | null> {
  try {
    const { result } = await withLoadingCancel(async (signal) => {
      const resp = await apiCall("/api/v1/me/looking", {
        method: "POST",
        body: { body },
        signal,
      });
      if (!resp || !resp.ok) return null;
      return (await resp.json()) as LookingCreateResponse;
    }, "recording");
    return result;
  } catch {
    return null;
  }
}

async function fetchEntries(cursor?: string): Promise<LookingListResponse | null> {
  try {
    const url = cursor
      ? `/api/v1/me/looking?cursor=${encodeURIComponent(cursor)}`
      : "/api/v1/me/looking";
    const { result } = await withLoadingCancel(async (signal) => {
      const resp = await apiCall(url, { method: "GET", signal });
      if (!resp || !resp.ok) return null;
      return (await resp.json()) as LookingListResponse;
    });
    return result;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function renderEntry(entry: LookingEntry): void {
  process.stdout.write(
    "  " +
      brand.faint(formatDate(entry.created_at)) +
      "  " +
      brand.text(entry.body) +
      "\n",
  );
}

// ---------------------------------------------------------------------------
// Sub-flows
// ---------------------------------------------------------------------------

/** Record a new moment. */
async function recordMoment(): Promise<void> {
  process.stdout.write("\n");
  process.stdout.write(
    "  " + brand.faint("what happened?  an application, a rejection, a shift in direction.") + "\n\n",
  );

  // textInput, not clack text(): clack offers no visible way out and its
  // non-empty validate made this screen a hard trap - you could neither
  // submit nothing nor escape. textInput's footer promises esc back.
  const raw = await textInput({
    message: "log it",
    validate(val) {
      if (val.trim().length > 1000) return "keep it under 1000 characters.";
      return undefined;
    },
  });

  if (raw === null) {
    process.stdout.write("\n  " + brand.faint("nothing recorded.") + "\n\n");
    return;
  }

  const body = raw.trim();
  const result = await postMoment(body);
  if (!result) {
    process.stdout.write(
      "\n  " +
        brand.faint("could not reach the field right now. come back from  alter  ›  Me  ›  Observations.") +
        "\n\n",
    );
    return;
  }

  process.stdout.write(
    "\n  " +
      brand.faint("recorded.") +
      "\n\n",
  );
}

/** Read back past entries, one page at a time. */
async function readEntries(): Promise<void> {
  let cursor: string | undefined;
  let firstPage = true;

  while (true) {
    const page = await fetchEntries(cursor);
    if (!page) {
      process.stdout.write(
        "\n  " +
          brand.faint("could not reach the field right now. come back from  alter  ›  Me  ›  Observations.") +
          "\n\n",
      );
      return;
    }

    if (firstPage && page.entries.length === 0) {
      process.stdout.write(
        "\n  " +
          brand.faint("nothing recorded yet.") +
          "\n\n",
      );
      return;
    }

    process.stdout.write("\n");
    for (const entry of page.entries) {
      renderEntry(entry);
    }
    process.stdout.write("\n");

    firstPage = false;

    if (!page.next_cursor) {
      // Last page - no more to load.
      break;
    }

    // Offer to load the next page.
    const more = await pickOne<"more" | "back">({
      message: "more entries",
      options: [
        { value: "more", label: "load more" },
        BACK_OPTION as { value: "back"; label: string },
      ],
      initialValue: "back",
    });

    if (!more || isBack(more)) break;
    cursor = page.next_cursor;
  }
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Top-level Looking Log leaf: pick between recording a moment and reading
 * past entries.
 */
export async function lookingLog(): Promise<void> {
  process.stdout.write("\n");

  const choice = await pickOne<"record" | "read" | "back">({
    message: "looking log",
    options: [
      {
        value: "record",
        label: "Log a moment",
        hint: "an application sent, a rejection, a recalibration",
      },
      {
        value: "read",
        label: "Read back",
        hint: "your past entries",
      },
      BACK_OPTION as { value: "back"; label: string },
    ],
    initialValue: "record",
  });

  if (!choice || isBack(choice)) return;

  if (choice === "record") {
    await recordMoment();
  } else if (choice === "read") {
    await readEntries();
  }
}
