/**
 * `alter audit` - print exactly what the first-run onboarding reads.
 *
 * Runs the same local signal-reader that `alter login` runs at beat 1,
 * prints a redacted summary, then exits. Never authenticates, never writes
 * session state, never touches the network. The transparency surface that
 * makes the provenance of what's read visible to users without asking
 * them to read source code.
 *
 * Equivalent to the hidden `alter login --audit-signals` flag, promoted to
 * a first-class verb during the onboarding voice-pass.
 *
 * Safe in any shell context: zero privilege escalation, zero file writes,
 * timeout-bounded on the only external command (`gh auth status`, 2s cap).
 */

import { readProfile, summariseProfile } from "../onboarding/signals.js";
import { renderAudit } from "../onboarding/render.js";
import { emitSessionHeartbeat } from "../lib/active-sessions-emit.js";
import { secureStore } from "../secure-store.js";

function printHelp(): void {
  console.log(
    "Usage: alter audit\n" +
      "\n" +
      "Show exactly what ~Alter reads from your local environment at first\n" +
      "login: git identity, connected tools, shell, editor, runtime. Runs\n" +
      "without a session - no authentication, no network, no writes.\n" +
      "\n" +
      "Nothing is read in secret. You can see every local signal\n" +
      "before it leaves your machine.\n",
  );
}

export function audit(args: string[] = []): void {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  try {
    emitSessionHeartbeat({
      sessionId: String(process.pid),
      workingOn: "alter audit",
    });
  } catch { /* silent - must not block command */ }
  const profile = readProfile();
  renderAudit(summariseProfile(profile));
  // Report the active secure-store backend so the release checklist and the
  // per-platform backend matrix can verify DPAPI/keychain/libsecret detection
  // actually resolved (not silently downgraded to the encrypted-file fallback).
  // backendName() returns one of four fixed enum strings, no paths or secrets;
  // best-effort so a probe hiccup never breaks the transparency command.
  try {
    process.stdout.write(`\nsecure-store: ${secureStore.backendName()}\n`);
  } catch { /* silent - the transparency line must not block the command */ }
}
