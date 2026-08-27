/**
 * alter email change - rotate the authenticated email address.
 *
 * Menu-only entry under the Account zone. Not registered as a
 * top-level CLI verb (the verb surface is kept frozen). The "change
 * email" path is table-stakes
 * account management: a member who needs to update their address
 * shouldn't be told to log a support ticket.
 *
 * Flow mirrors `password change`: re-verify current password, prompt
 * for the new email, post to the authenticated endpoint. The backend
 * dispatches a 6-digit OTP code to the NEW address; the swap happens
 * only when that code is confirmed via /auth/change-email/confirm -
 * so the flow finishes here with a code prompt. On success the backend
 * revokes all other sessions (the login credential changed).
 */

import { apiCall, failNotLoggedIn, getSession } from "../auth.js";
import { apiErrorMessage } from "../lib/api-error.js";
import { textInput } from "../ui/picker.js";
import { withLoadingCancel } from "../ui/biosMenu.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function emailChange(): Promise<void> {
  const session = getSession();
  if (!session) {
    failNotLoggedIn();
    return;
  }

  // Say what this flow IS before prompting - "Current email: X" straight
  // into "New email address" read ambiguously (telling you your email, or
  // asking you to change it?). One lead line + the esc-out makes it a
  // deliberate change ceremony you can leave.
  console.log("");
  console.log("  Change the email you sign in with.");
  console.log(`  Current email: ${session.email || "(none)"}`);
  console.log("  Press esc at any prompt to keep your current address.");
  console.log("");

  const newEmail = await textInput({
    message: "New email address",
    placeholder: "you@example.com",
    validate: (v) => {
      const trimmed = v.trim();
      if (!trimmed) return "Required.";
      if (!EMAIL_REGEX.test(trimmed)) return "Must be a valid email address.";
      if (trimmed.toLowerCase() === session.email.toLowerCase()) {
        return "New email must differ from the current one.";
      }
      return undefined;
    },
  });
  if (newEmail === null) {
    console.log("Aborted - your email was not changed.");
    return;
  }

  const current = await textInput({
    message: "Current password (to confirm)",
    mask: true,
  });
  if (current === null) {
    console.log("Aborted - your email was not changed.");
    return;
  }

  const changeWait = await withLoadingCancel(
    (signal) =>
      apiCall("/api/v1/auth/change-email", {
        method: "POST",
        body: {
          current_password: current,
          new_email: newEmail.trim(),
        },
        signal,
      }),
    "requesting change",
  );
  if (changeWait.cancelled) {
    console.log("Cancelled - your email was not changed.");
    return;
  }
  const res = changeWait.result;
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
  if (res.status === 409) {
    console.error("That email is already in use on another account.");
    process.exitCode = 1;
    return;
  }
  if (!res.ok) {
    const textBody = await res.text();
    console.error(apiErrorMessage("change your email", res.status, textBody));
    process.exitCode = 1;
    return;
  }

  // Backend dispatched a 6-digit code to the NEW address. The swap only
  // happens when that code is confirmed - finish the ceremony here.
  const target = newEmail.trim();
  console.log("");
  console.log(`  A 6-digit code was sent to ${target}.`);
  console.log(
    "  It expires in 15 minutes. Your current address stays active"
  );
  console.log("  until the code is confirmed.");
  console.log("");

  const code = await textInput({
    message: "Verification code",
    placeholder: "123456",
    validate: (v) =>
      /^\d{6}$/.test(v.trim()) ? undefined : "Enter the 6-digit code.",
  });
  if (code === null) {
    console.log("Aborted - your email was not changed.");
    return;
  }

  const confirmWait = await withLoadingCancel(
    (signal) =>
      apiCall("/api/v1/auth/change-email/confirm", {
        method: "POST",
        body: { code: String(code).trim() },
        signal,
      }),
    "confirming",
  );
  if (confirmWait.cancelled) {
    console.log(
      "Cancelled. Run 'alter whoami' to check whether the email changed.",
    );
    return;
  }
  const confirmRes = confirmWait.result;
  if (!confirmRes) {
    console.error("Session expired. Run `alter login` again.");
    process.exitCode = 1;
    return;
  }
  // 403 here is an OTP failure (wrong/expired code or attempts cap), not
  // an auth failure - keep it out of the generic apiErrorMessage mapping.
  if (confirmRes.status === 403) {
    const detail = await confirmRes.text();
    if (detail.includes("Too many failed attempts")) {
      console.error(
        "Too many failed attempts - start the change again to get a new code."
      );
    } else {
      console.error(
        "That code didn't match (or it expired). Start the change again to get a new code."
      );
    }
    process.exitCode = 1;
    return;
  }
  if (confirmRes.status === 409) {
    console.error("That email is already in use on another account.");
    process.exitCode = 1;
    return;
  }
  if (!confirmRes.ok) {
    const textBody = await confirmRes.text();
    console.error(
      apiErrorMessage("confirm your new email", confirmRes.status, textBody)
    );
    process.exitCode = 1;
    return;
  }

  console.log("");
  console.log(`  Email changed to ${target}.`);
  console.log(
    "  All other sessions have been signed out - sign in again on any"
  );
  console.log(
    "  other device. This session stays active until its token expires;"
  );
  console.log("  run `alter login` if you're asked to sign in again.");
  console.log("");
}
