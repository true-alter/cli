/**
 * alter mfa - TOTP multi-factor authentication lifecycle.
 *
 *   alter mfa setup          Generate TOTP secret, scan QR, verify, capture recovery codes
 *   alter mfa status         Show MFA state + registered passkeys + recovery-codes remaining
 *   alter mfa disable        Disable MFA (requires current TOTP code + confirm)
 *   alter mfa authenticate   Unavailable - `alter login` performs MFA step-up
 */

import { text, password as promptPassword, isCancel, cancel } from "@clack/prompts";
import { confirmYesNo } from "../ui/picker.js";
import { apiCall, failNotLoggedIn, requireSessionOrExit } from "../auth.js";
import { withLoadingCancel } from "../ui/biosMenu.js";
import { apiErrorMessage } from "../lib/api-error.js";
import { shortDate } from "../lib/format-date.js";

interface MFASetupResponse {
  provisioning_uri: string;
  secret: string;
}

interface MFAVerifyResponse {
  recovery_codes: string[];
  warning?: string;
}

interface WebAuthnCredential {
  // The /auth/mfa/status payload returns `credential_id`, not `id`. The
  // prior `id` field rendered as `(undefined)` on the status surface while
  // `alter passkey list` (reading the same payload) formatted cleanly.
  credential_id: string;
  device_name: string;
  created_at: string | null;
}

interface MFAStatusResponse {
  mfa_enabled: boolean;
  totp_configured: boolean;
  webauthn_credentials: WebAuthnCredential[];
  recovery_codes_remaining: number | null;
}

function printHelp(): void {
  console.log(
    "Usage: alter mfa {setup|status|disable|authenticate}\n" +
      "\n" +
      "Manage TOTP multi-factor authentication on the current account.\n" +
      "  setup         enrol a new TOTP authenticator\n" +
      "  status        show whether MFA is active + recovery-code count\n" +
      "  disable       remove TOTP MFA (requires a valid code)\n" +
      "  authenticate  unavailable - run `alter login` for MFA step-up\n",
  );
}

export async function mfa(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "--help" || sub === "-h" || sub === "help") {
    printHelp();
    return;
  }
  if (sub === "setup") return setup();
  if (sub === "status") return status();
  if (sub === "disable") return disable();
  if (sub === "authenticate") return authenticate();
  console.log("Usage: alter mfa {setup|status|disable|authenticate}");
  process.exitCode = 1;
}

async function setup(): Promise<void> {
  const setupWait = await withLoadingCancel(
    (signal) => apiCall("/api/v1/auth/mfa/setup", { method: "POST", signal }),
    "starting MFA setup",
  );
  if (setupWait.cancelled) {
    cancel("Aborted - MFA not enabled.");
    return;
  }
  const setupRes = setupWait.result;
  if (!setupRes) {
    failNotLoggedIn();
    return;
  }
  if (!setupRes.ok) {
    console.error(apiErrorMessage("set up MFA", setupRes.status, await setupRes.text()));
    process.exitCode = 1;
    return;
  }
  const setupData = (await setupRes.json()) as MFASetupResponse;

  console.log("Scan this URI in your authenticator (Google Authenticator, 1Password, Authy, etc.):");
  console.log(setupData.provisioning_uri);
  console.log("");
  console.log("Or type this secret manually (shown once - store securely):");
  console.log(setupData.secret);
  console.log("");

  const code = await promptPassword({
    message: "Enter the 6-digit code from your authenticator",
    mask: "•",
    validate: (v) => (v.length < 6 ? "Must be at least 6 digits." : undefined),
  });
  if (isCancel(code)) {
    cancel("Aborted - MFA not enabled.");
    return;
  }

  const verifyWait = await withLoadingCancel(
    (signal) =>
      apiCall("/api/v1/auth/mfa/verify", {
        method: "POST",
        body: { code },
        signal,
      }),
    "verifying code",
  );
  if (verifyWait.cancelled) {
    cancel(
      "Cancelled. Run 'alter mfa status' to check whether MFA was enabled.",
    );
    return;
  }
  const verifyRes = verifyWait.result;
  if (!verifyRes || !verifyRes.ok) {
    const msg = verifyRes ? await verifyRes.text() : "session expired";
    console.error(`Verification failed: ${msg}`);
    process.exitCode = 1;
    return;
  }
  const verifyData = (await verifyRes.json()) as MFAVerifyResponse;

  console.log("");
  console.log("MFA enabled. STORE THESE RECOVERY CODES - they are shown only once:");
  console.log("");
  for (const rc of verifyData.recovery_codes) console.log(`  ${rc}`);
  console.log("");
  if (verifyData.warning) console.warn(`warning: ${verifyData.warning}`);
}

async function status(): Promise<void> {
  const statusWait = await withLoadingCancel(
    (signal) => apiCall("/api/v1/auth/mfa/status", { signal }),
    "loading MFA status",
  );
  if (statusWait.cancelled) return;
  const res = statusWait.result;
  if (!res) {
    failNotLoggedIn();
    return;
  }
  if (!res.ok) {
    console.error(apiErrorMessage("fetch your MFA status", res.status, await res.text()));
    process.exitCode = 1;
    return;
  }
  const data = (await res.json()) as MFAStatusResponse;
  console.log(`MFA enabled:           ${data.mfa_enabled ? "yes" : "no"}`);
  console.log(`TOTP configured:       ${data.totp_configured ? "yes" : "no"}`);
  console.log(`Recovery codes:        ${data.recovery_codes_remaining ?? "n/a"}`);
  console.log(`Passkeys registered:   ${data.webauthn_credentials.length}`);
  for (const cred of data.webauthn_credentials) {
    // Mirror `alter passkey list` formatting so the two surfaces agree:
    // device name, credential id, and a humanised date (not a raw ISO stamp).
    const added = cred.created_at ? ` - added ${shortDate(cred.created_at)}` : "";
    console.log(`  - ${cred.device_name ?? "unnamed"} (${cred.credential_id})${added}`);
  }
}

async function disable(): Promise<void> {
  if (!requireSessionOrExit()) return;
  const ok = await confirmYesNo({
    message: "Disabling MFA will weaken your account. Proceed?",
    initialValue: false,
  });
  if (!ok) {
    cancel("Aborted.");
    return;
  }

  const code = await promptPassword({
    message: "Enter current 6-digit TOTP code",
    mask: "•",
  });
  if (isCancel(code)) {
    cancel("Aborted.");
    return;
  }

  const disableWait = await withLoadingCancel(
    (signal) =>
      apiCall("/api/v1/auth/mfa/disable", {
        method: "POST",
        body: { code },
        signal,
      }),
    "disabling MFA",
  );
  if (disableWait.cancelled) {
    cancel(
      "Cancelled. Run 'alter mfa status' to check whether MFA was disabled.",
    );
    return;
  }
  const res = disableWait.result;
  if (!res) {
    failNotLoggedIn();
    return;
  }
  if (!res.ok) {
    console.error(apiErrorMessage("disable MFA", res.status, await res.text()));
    process.exitCode = 1;
    return;
  }
  console.log("MFA disabled. All sessions have been revoked - sign in again.");
}

async function authenticate(): Promise<void> {
  // MFA step-up authentication requires an mfa_ticket issued only during the
  // full browser login ceremony. This standalone command cannot produce a valid
  // ticket and will 422 on every attempt, so it cannot perform the operation it
  // names.
  //
  // It therefore FAILS rather than printing a note and exiting 0. A security
  // verb that reports success without performing the security operation teaches
  // the caller they are authenticated when nothing authenticated them, and any
  // script or CI harness reading the exit code inherits that false belief. The
  // same posture as `alter hooks` on win32: fail honestly rather than report
  // success while doing nothing.
  console.error(
    "alter mfa authenticate: unavailable - this standalone command cannot\n" +
      "perform MFA step-up, because the backend issues the required mfa_ticket\n" +
      "only during the login ceremony. Nothing was authenticated.\n\n" +
      "To authenticate with MFA, run: alter login",
  );
  process.exitCode = 1;
}
