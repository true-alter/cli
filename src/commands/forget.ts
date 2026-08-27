/**
 * alter forget - the identity off-switch.
 *
 *   alter forget            Schedule permanent erasure of your Alter identity
 *                           record. 30-day grace period; cancellable until then.
 *   alter forget --cancel   Cancel a pending erasure during the grace period.
 *   alter forget --yes      Skip the interactive confirmation (scripting).
 *   alter forget --reason "<text>"   Attach an optional reason.
 *
 * Deferred radical erasure: scheduling marks your record for cryptographic
 * erasure across every Alter database after a 30-day grace period. The window
 * is deliberate - it is the anti-accident and anti-coercion guard. Only you,
 * with your own credential, can cancel it, so a deletion made in error or
 * under pressure stays recoverable until the window closes. After it closes
 * the erasure is complete and irreversible: the per-member key is destroyed
 * and the data cannot be recovered, even from backups.
 *
 * Your local session is left intact on purpose - you need your own credential
 * on this machine to run `alter forget --cancel`. Erasing it here would make
 * self-cancellation impossible.
 */

import { cancel } from "@clack/prompts";
import { confirmTypeNoun } from "../ui/picker.js";
import {
  apiCall,
  failNotLoggedIn,
  getSessionInfo,
  requireSessionOrExit,
} from "../auth.js";
import { apiErrorMessage } from "../lib/api-error.js";
import { emitSessionHeartbeat } from "../lib/active-sessions-emit.js";
import { withLoadingCancel } from "../ui/biosMenu.js";

function printHelp(): void {
  console.log(
    "Usage: alter forget [--cancel] [--yes] [--reason \"<text>\"]\n" +
      "\n" +
      "Schedule permanent erasure of your Alter identity record. Erasure\n" +
      "does not happen immediately: it is scheduled with a 30-day grace\n" +
      "period and crypto-erases everything across all databases when the\n" +
      "window closes. Until then you can stop it with `alter forget --cancel`.\n" +
      "\n" +
      "  --cancel   Cancel a pending erasure during the grace period.\n" +
      "  --yes      Skip the interactive type-your-handle confirmation.\n" +
      "  --reason   Optional reason recorded with the request.\n" +
      "\n" +
      "Only you, with your own credential, can schedule or cancel. After the\n" +
      "grace period the erasure is complete and cannot be undone.\n",
  );
}

/** Pull `--reason <value>` or `--reason=<value>` out of the args. */
export function readReason(args: string[]): string | null {
  const eq = args.find((a) => a.startsWith("--reason="));
  if (eq) return eq.slice("--reason=".length).trim() || null;
  const i = args.indexOf("--reason");
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith("-")) {
    return args[i + 1].trim() || null;
  }
  return null;
}

export interface ForgetArgs {
  /** `--cancel` routes to the cancel path; otherwise schedule erasure. */
  mode: "schedule" | "cancel";
  /** `--yes` skips the type-your-handle confirmation gate (scripting). */
  skipConfirm: boolean;
  /** Optional `--reason` recorded with the request. */
  reason: string | null;
}

/**
 * Pure routing of the forget verb's flags. Kept side-effect free so the
 * decision that gates a destructive call - schedule vs cancel, and whether
 * the confirmation is skipped - is unit-testable without the network or TTY.
 */
export function parseForgetArgs(args: string[]): ForgetArgs {
  return {
    mode: args.includes("--cancel") ? "cancel" : "schedule",
    skipConfirm: args.includes("--yes"),
    reason: readReason(args),
  };
}

export async function forget(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "--help" || sub === "-h" || sub === "help") {
    printHelp();
    return;
  }

  try {
    emitSessionHeartbeat({
      sessionId: String(process.pid),
      workingOn: "alter forget",
    });
  } catch {
    /* silent - must not block command */
  }

  const parsed = parseForgetArgs(args);
  if (parsed.mode === "cancel") {
    await cancelErasure();
    return;
  }

  await scheduleErasure(parsed);
}

async function scheduleErasure(parsed: ForgetArgs): Promise<void> {
  if (!requireSessionOrExit()) return;
  const session = getSessionInfo();
  if (!session) {
    failNotLoggedIn();
    return;
  }

  // Consequence preview - neutral and honest, no dark pattern in either
  // direction. The member should see exactly what they lose before the gate.
  console.log(
    "\nThis schedules permanent erasure of your Alter identity record:\n" +
      "  - your trait vector and Discovery results\n" +
      "  - every paired connector and its imported data\n" +
      "  - your earnings history and payout details\n" +
      "  - your sealed identity-log entries\n" +
      `  - your handle (${session.handle}) is retired and cannot be reclaimed\n` +
      "\nIt is scheduled now and runs in 30 days. You can stop it any time\n" +
      "before then with `alter forget --cancel`. After the window closes the\n" +
      "erasure is complete and irreversible.\n",
  );

  if (!parsed.skipConfirm) {
    // Tier-3 type-the-noun. Per the locked confirm taxonomy, account erasure
    // uses the member's own ~handle as the noun - friction designed to be
    // read and typed deliberately, not muscle-memory.
    const ok = await confirmTypeNoun({
      message:
        "Schedule permanent erasure of your identity record? This cannot be undone once the 30-day window closes.",
      noun: session.handle,
    });
    if (!ok) {
      cancel("Aborted. Nothing was scheduled.");
      return;
    }
  }

  let endpoint = "/api/v1/members/me?confirm=true";
  if (parsed.reason) endpoint += `&reason=${encodeURIComponent(parsed.reason)}`;

  const scheduleWait = await withLoadingCancel(
    (signal) => apiCall(endpoint, { method: "DELETE", signal }),
    "scheduling erasure",
  );
  if (scheduleWait.cancelled) {
    cancel(
      "Cancelled. Run 'alter forget --cancel' if an erasure was scheduled anyway - it reports when nothing is pending.",
    );
    return;
  }
  const res = scheduleWait.result;
  if (!res) {
    failNotLoggedIn();
    return;
  }
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 409) {
      console.error(
        "An erasure is already scheduled for this account. Run `alter forget --cancel` to stop it.",
      );
    } else {
      console.error(apiErrorMessage("schedule erasure", res.status, body));
    }
    process.exitCode = 1;
    return;
  }

  let deletionDate: string | null = null;
  try {
    const data = (await res.json()) as { deletion_date?: string };
    deletionDate = data.deletion_date ?? null;
  } catch {
    /* response parsed best-effort; success is the status code */
  }

  const when = deletionDate
    ? new Date(deletionDate).toUTCString()
    : "in 30 days";
  console.log(
    `\nErasure scheduled. Your record is permanently erased on ${when}.\n` +
      "Run `alter forget --cancel` any time before then to stop it.\n" +
      "Your session is still active so you can cancel from this machine.\n",
  );
}

async function cancelErasure(): Promise<void> {
  if (!requireSessionOrExit()) return;

  const cancelWait = await withLoadingCancel(
    (signal) =>
      apiCall("/api/v1/members/me/cancel-deletion", {
        method: "POST",
        signal,
      }),
    "cancelling erasure",
  );
  if (cancelWait.cancelled) {
    cancel("Cancelled. Run 'alter forget --cancel' again to be sure the erasure is stopped.");
    return;
  }
  const res = cancelWait.result;
  if (!res) {
    failNotLoggedIn();
    return;
  }
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 404) {
      console.error("No erasure is currently scheduled - nothing to cancel.");
    } else {
      console.error(apiErrorMessage("cancel the erasure", res.status, body));
    }
    process.exitCode = 1;
    return;
  }

  console.log("Erasure cancelled. Your identity record is staying put.");
}
