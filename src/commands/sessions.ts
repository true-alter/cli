/**
 * alter sessions - session revocation.
 *
 *   alter sessions revoke-all   Invalidate every outstanding access + refresh
 *                               token for this account. The local JWT remains
 *                               on disk but will 401 on the next API call;
 *                               run `alter login` afterwards.
 */

import { cancel } from "@clack/prompts";
import { confirmTypeNoun } from "../ui/picker.js";
import { apiCall, failNotLoggedIn, requireSessionOrExit } from "../auth.js";
import { apiErrorMessage } from "../lib/api-error.js";
import { withLoadingCancel } from "../ui/biosMenu.js";
import { emitSessionHeartbeat } from "../lib/active-sessions-emit.js";

function printHelp(): void {
  console.log(
    "Usage: alter sessions revoke-all [--yes]\n" +
      "\n" +
      "Invalidate every outstanding access + refresh token for this\n" +
      "account. The local JWT stays on disk but will 401 on the next API\n" +
      "call; run `alter login` afterwards. Pass --yes to skip the\n" +
      "interactive confirmation.\n",
  );
}

export async function sessions(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "--help" || sub === "-h" || sub === "help") {
    printHelp();
    return;
  }
  try {
    emitSessionHeartbeat({
      sessionId: String(process.pid),
      workingOn: "alter sessions",
    });
  } catch { /* silent - must not block command */ }
  if (sub === "revoke-all") {
    await revokeAll(args.slice(1));
    return;
  }
  console.log("Usage: alter sessions revoke-all [--yes]");
  process.exitCode = 1;
}

async function revokeAll(args: string[]): Promise<void> {
  if (!requireSessionOrExit()) return;
  const skipConfirm = args.includes("--yes");
  if (!skipConfirm) {
    // Tier 3 type-the-noun - plural-destructive (every session, every
    // device). The noun must be typed verbatim because friction is the design.
    const ok = await confirmTypeNoun({
      message:
        "Revoke every session for this account on every device? You will need to sign in again everywhere.",
      noun: "sessions",
    });
    if (!ok) {
      cancel("Aborted.");
      return;
    }
  }

  const revokeWait = await withLoadingCancel(
    (signal) => apiCall("/api/v1/auth/revoke", { method: "POST", signal }),
    "revoking sessions",
  );
  if (revokeWait.cancelled) {
    cancel(
      "Cancelled. If the revoke had already reached the server every session is signed out - run any command to check.",
    );
    return;
  }
  const res = revokeWait.result;
  if (!res) {
    failNotLoggedIn();
    return;
  }
  if (!res.ok) {
    const text = await res.text();
    console.error(apiErrorMessage("revoke that session", res.status, text));
    process.exitCode = 1;
    return;
  }
  console.log("Signed out of all devices, including this one. Run `alter login` to sign back in.");
}
