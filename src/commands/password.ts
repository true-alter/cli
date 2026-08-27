/**
 * alter password - rotate the authenticated password or trigger reset.
 *
 *   alter password change   Re-verify current pw, rotate to a new one
 *   alter password reset    Print the forgot-password URL (out-of-band email flow)
 *
 * The `change` subcommand hits the authenticated endpoint and never writes
 * the new password to disk. All refresh tokens for the account are revoked
 * server-side; the calling session keeps its JWT (rotation is local to the
 * credential, not the session).
 */

import { apiCall, failNotLoggedIn, getSession, getSessionInfo } from "../auth.js";
import { apiErrorMessage } from "../lib/api-error.js";
import { textInput } from "../ui/picker.js";

function printHelp(): void {
  console.log(
    "Usage: alter password {change|reset}\n" +
      "\n" +
      "Rotate or reset the account password.\n" +
      "  change   re-verify current password and rotate to a new one\n" +
      "  reset    print the forgot-password URL (out-of-band email flow)\n",
  );
}

export async function password(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "--help" || sub === "-h" || sub === "help") {
    printHelp();
    return;
  }
  if (sub === "change") {
    await change();
    return;
  }
  if (sub === "reset") {
    reset();
    return;
  }
  console.log("Usage: alter password {change|reset}");
  process.exitCode = 1;
}

async function change(): Promise<void> {
  const session = getSession();
  if (!session) {
    failNotLoggedIn();
    return;
  }

  // textInput with mask, not clack password(): clack shows no way out
  // (and a lone Esc isn't reliably delivered on Windows), which trapped
  // users mid-rotation. textInput's footer promises esc back.
  const current = await textInput({
    message: "Current password",
    mask: true,
  });
  if (current === null) {
    console.log("Aborted.");
    return;
  }

  const next = await textInput({
    message: "New password (min 12 chars)",
    mask: true,
    validate: (v) =>
      v.length < 12 ? "Must be at least 12 characters." : undefined,
  });
  if (next === null) {
    console.log("Aborted.");
    return;
  }

  const confirm = await textInput({
    message: "Confirm new password",
    mask: true,
  });
  if (confirm === null) {
    console.log("Aborted.");
    return;
  }
  if (next !== confirm) {
    console.error("Passwords do not match.");
    process.exitCode = 1;
    return;
  }

  const res = await apiCall("/api/v1/auth/change-password", {
    method: "POST",
    body: { current_password: current, new_password: next },
  });
  if (!res) {
    console.error("Session expired. Run `alter login` again.");
    process.exitCode = 1;
    return;
  }
  if (res.status === 401) {
    console.error("Current password incorrect.");
    process.exitCode = 1;
    return;
  }
  if (!res.ok) {
    const text = await res.text();
    console.error(apiErrorMessage("change your password", res.status, text));
    process.exitCode = 1;
    return;
  }
  const body = (await res.json()) as {
    message: string;
    warning?: string;
  };
  console.log(body.message);
  if (body.warning) console.warn(`warning: ${body.warning}`);
  console.log(
    "All other sessions have been revoked. Sign in again on any other device."
  );
}

function reset(): void {
  const url = "https://truealter.com/auth/forgot-password";
  console.log(
    `Password reset is an out-of-band email flow. Open: ${url}\nEnter the email on your account and follow the link sent to your inbox.`
  );
}
