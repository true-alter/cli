/**
 * alter passkey - browser-callback WebAuthn passkey lifecycle.
 *
 *   alter passkey add            Register a new passkey via browser handoff
 *   alter passkey list           Show passkeys bound to this account
 *   alter passkey remove <id>    Tombstone a passkey
 *
 * Design note: the CLI never touches FIDO2/HID directly. `add`
 * opens the browser at the server's `/auth/webauthn/cli-register` HTML
 * bridge with the JWT in the URL hash (never reaches the server) plus a
 * localhost callback + CSRF state in the query string. The browser drives
 * the WebAuthn ceremony against whatever authenticator it already supports
 * (Yubikey, platform passkey, 1Password, etc.) and bounces the user back to
 * our local server with the resulting credential id. No passkey material
 * ever touches the CLI - respects the browser-only sovereign-key
 * doctrine and stays forward-compatible with the planned PRF dual-enrol
 * upgrade.
 */

import * as http from "http";
import { cancel } from "@clack/prompts";
import { confirmYesNo } from "../ui/picker.js";
import { apiCall, failNotLoggedIn, getSession, generateState } from "../auth.js";
import { openBrowser } from "../browser.js";
import { LOGIN_TIMEOUT_MS } from "../lib/timeouts.js";
import { apiErrorMessage, alterDebugEnabled } from "../lib/api-error.js";
import { withKeyListenerCancel } from "../ui/biosMenu.js";
import { shortDate } from "../lib/format-date.js";

interface WebAuthnCredential {
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
    "Usage: alter passkey {add|list|remove <credential-id>}\n" +
      "\n" +
      "Manage WebAuthn credentials bound to the current session.\n" +
      "  add           enrol a new passkey (browser-callback ceremony)\n" +
      "  list          show existing passkeys on this account\n" +
      "  remove <id>   revoke a passkey by credential id\n",
  );
}

export async function passkey(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "--help" || sub === "-h" || sub === "help") {
    printHelp();
    return;
  }
  if (sub === "add") return add();
  if (sub === "list") return list();
  if (sub === "remove") return remove(args[1]);
  console.log("Usage: alter passkey {add|list|remove <id>}");
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// add - browser-callback ceremony
// ---------------------------------------------------------------------------

async function add(): Promise<void> {
  const session = getSession();
  if (!session) {
    failNotLoggedIn();
    return;
  }

  // Mint a single-use bridge nonce. The authenticated POST binds the
  // nonce to this user; the bridge GET then GETDELs it and mints a
  // short-lived ceremony token (rendered into the page via data-attr)
  // that the in-page JS uses as Bearer for the WebAuthn ceremony POSTs.
  // The session JWT never leaves this process - not in the URL bar,
  // not in a fragment, not in browser history.
  const nonceRes = await apiCall("/api/v1/auth/webauthn/cli-register-nonce", {
    method: "POST",
  });
  if (!nonceRes) {
    failNotLoggedIn();
    return;
  }
  if (!nonceRes.ok) {
    const detail = await nonceRes.text();
    console.error(apiErrorMessage("start passkey setup", nonceRes.status, detail));
    process.exitCode = 1;
    return;
  }
  const noncePayload = (await nonceRes.json()) as { nonce?: string };
  const nonce = noncePayload?.nonce;
  if (!nonce || typeof nonce !== "string") {
    console.error(
      "Server returned an empty bridge nonce - refusing to continue.",
    );
    process.exitCode = 1;
    return;
  }

  const state = generateState();
  const { port, resultPromise, server } = await startCallbackServer(state);
  const callback = `http://127.0.0.1:${port}/callback`;

  const params = new URLSearchParams({ callback, state, nonce });
  const bridgeUrl = `${session.api}/api/v1/auth/webauthn/cli-register?${params.toString()}`;

  console.log("");
  console.log("Opening browser to register a passkey...");
  console.log("");
  try {
    openBrowser(bridgeUrl);
    console.log("If the browser didn't open, visit this URL:");
  } catch {
    console.log("Open this URL in your browser:");
  }
  console.log("");
  console.log(`  ${bridgeUrl}`);
  console.log("");
  console.log("Complete the passkey ceremony in your browser (touch authenticator, platform prompt, or 1Password).");
  console.log("Waiting for the browser to complete the ceremony...");

  // Hard deadline - same `LOGIN_TIMEOUT_MS` guard the OAuth flow uses.
  // Without it, a stuck CF Access page or a closed browser tab leaves
  // the loopback server (and the terminal) hanging forever, with no
  // way for the user to tell whether the wait will end. Both timers
  // are `unref()`'d so the success path exits without waiting for the
  // deadline to fire.
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () =>
        reject(
          new Error(
            `Passkey setup timed out after ${Math.floor(LOGIN_TIMEOUT_MS / 1000)}s - the browser didn't complete the ceremony with this terminal.\n\n` +
              `What to try:\n` +
              `  • Re-run \`alter passkey add\` and finish the prompt in the browser window\n` +
              `    that opens (touch authenticator, platform prompt, or password manager).\n` +
              `  • If the browser finished but the terminal kept waiting, a firewall or an\n` +
              `    HTTPS-upgrade browser extension may be blocking the local callback. Try a\n` +
              `    different browser, or pause that extension and run it again.\n` +
              `  • Still stuck? Visit truealter.com.` +
              (alterDebugEnabled()
                ? `\n\n[debug] loopback callback never reached this process: ${callback}`
                : ``),
          ),
        ),
      LOGIN_TIMEOUT_MS,
    );
    timeoutId.unref();
  });
  let outcome: { credential_id: string };
  try {
    // q/Esc collapses the wait without ctrl-C: signal-aborted promise
    // joins the race, and an abort listener closes the loopback server
    // immediately so the next ceremony can re-bind without socket grace.
    const wait = await withKeyListenerCancel(async (signal) => {
      const aborted = new Promise<never>((_, reject) => {
        if (signal.aborted) {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          return;
        }
        signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
      signal.addEventListener("abort", () => server.close());
      return Promise.race([resultPromise, timeout, aborted]);
    });
    if (wait.cancelled) {
      console.log("");
      console.log("Passkey ceremony cancelled.");
      return;
    }
    outcome = wait.result as { credential_id: string };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    server.close();
  }

  console.log(`Passkey registered: ${outcome.credential_id}`);
  console.log("Run `alter passkey list` to see all registered passkeys.");
}

// ---------------------------------------------------------------------------
// list - proxy through /auth/mfa/status
// ---------------------------------------------------------------------------

async function list(): Promise<void> {
  const res = await apiCall("/api/v1/auth/mfa/status");
  if (!res) {
    failNotLoggedIn();
    return;
  }
  if (!res.ok) {
    console.error(apiErrorMessage("fetch your passkeys", res.status, await res.text()));
    process.exitCode = 1;
    return;
  }
  const data = (await res.json()) as MFAStatusResponse;
  if (data.webauthn_credentials.length === 0) {
    console.log("No passkeys registered. Run `alter passkey add`.");
    return;
  }
  for (const cred of data.webauthn_credentials) {
    const added = cred.created_at ? `  added ${shortDate(cred.created_at)}` : "";
    console.log(`${cred.credential_id}  ${cred.device_name ?? "unnamed"}${added}`);
  }
}

// ---------------------------------------------------------------------------
// remove - confirm + DELETE /auth/webauthn/credentials/<id>
// ---------------------------------------------------------------------------

async function remove(credentialId: string | undefined): Promise<void> {
  if (!credentialId) {
    console.error("Usage: alter passkey remove <credential-id>");
    console.error("Run `alter passkey list` to see credential ids.");
    process.exitCode = 1;
    return;
  }

  const ok = await confirmYesNo({
    message: `Remove passkey ${credentialId}? This cannot be undone.`,
    initialValue: false,
  });
  if (!ok) {
    cancel("Aborted.");
    return;
  }

  const res = await apiCall(
    `/api/v1/auth/webauthn/credentials/${encodeURIComponent(credentialId)}`,
    { method: "DELETE" },
  );
  if (!res) {
    failNotLoggedIn();
    return;
  }
  if (res.status === 404) {
    console.error("No passkey with that id.");
    process.exitCode = 1;
    return;
  }
  if (!res.ok) {
    console.error(apiErrorMessage("remove that passkey", res.status, await res.text()));
    process.exitCode = 1;
    return;
  }
  console.log(`Removed passkey ${credentialId}.`);
}

// ---------------------------------------------------------------------------
// Local callback server - listens for the browser's success/error redirect
// ---------------------------------------------------------------------------

interface CallbackServer {
  port: number;
  resultPromise: Promise<{ credential_id: string }>;
  server: http.Server;
}

export function startCallbackServer(
  expectedState: string,
): Promise<CallbackServer> {
  return new Promise((resolveSetup) => {
    let resolveResult: (v: { credential_id: string }) => void;
    let rejectResult: (err: Error) => void;
    const resultPromise = new Promise<{ credential_id: string }>(
      (resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      },
    );

    const server = http.createServer((req, res) => {
      // Origin + Host header validation - mirror the OAuth callback
      // server's Origin + Host validation.
      // (1) Origin allowlist. Top-frame navigations from the browser
      //     (address-bar redirect) typically OMIT the Origin header - so
      //     undefined/empty is allowed. When Origin IS set, only the
      //     canonical truealter.com host is accepted (plus localhost in dev).
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== "") {
        const allowedOrigins = new Set<string>(["https://truealter.com"]);
        if (process.env.ALTER_BRIDGE_DEV === "1") {
          allowedOrigins.add("https://localhost:4200");
          allowedOrigins.add("http://127.0.0.1:4200");
          allowedOrigins.add("http://localhost:4200");
        }
        if (!allowedOrigins.has(origin)) {
          res.writeHead(403, { Connection: "close" });
          res.end();
          return;
        }
      }

      // (2) DNS-rebinding Host header check. Only the literal loopback
      //     addresses at the bound port are accepted.
      const addr = server.address();
      const boundPort =
        typeof addr === "object" && addr ? addr.port : 0;
      const host = req.headers.host;
      // Accept only the literal loopback IP - `localhost` is rejected because
      // IPv6 `::1` resolves through it under different filtering rules and a
      // /etc/hosts re-map can break the loopback assumption (mirrors the
      // bridge server's host validation).
      const allowedHosts = new Set<string>([`127.0.0.1:${boundPort}`]);
      if (!host || !allowedHosts.has(host)) {
        res.writeHead(403, { Connection: "close" });
        res.end();
        return;
      }

      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const state = url.searchParams.get("state");
      if (state !== expectedState) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(errorPage("State mismatch - possible CSRF attack."));
        rejectResult(new Error("State mismatch"));
        return;
      }

      const err = url.searchParams.get("error");
      if (err) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(errorPage(`Passkey registration failed: ${err}`));
        rejectResult(new Error(`Passkey registration failed: ${err}`));
        return;
      }

      const credentialId = url.searchParams.get("credential_id");
      const success = url.searchParams.get("success");
      if (success !== "true" || !credentialId) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(errorPage("No credential id received."));
        rejectResult(new Error("Missing credential_id"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(successPage());
      resolveResult({ credential_id: credentialId });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolveSetup({ port, resultPromise, server });
    });
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function successPage(): string {
  return `<!DOCTYPE html>
<html>
<head><title>~Alter - Passkey registered</title></head>
<body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #0a0a0a; color: #e0e0e0;">
  <div style="text-align: center;">
    <h1 style="font-size: 2rem; margin-bottom: 0.5rem;">~ passkey registered</h1>
    <p style="color: #888;">You can close this window and return to your terminal.</p>
  </div>
</body>
</html>`;
}

function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html>
<head><title>~Alter - Error</title></head>
<body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #0a0a0a; color: #e0e0e0;">
  <div style="text-align: center;">
    <h1 style="font-size: 2rem; margin-bottom: 0.5rem; color: #ff4444;">Passkey registration failed</h1>
    <p style="color: #888;">${escapeHtml(message)}</p>
  </div>
</body>
</html>`;
}
