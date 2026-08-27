/**
 * alter login - authenticate to ALTER.
 *
 * Two modes:
 *   alter login           - OAuth 2.1 PKCE via browser (like `gh auth login`)
 *   alter login --token   - paste a JWT directly (like `gh auth login --with-token`)
 *
 * The full first-run flow (three beats):
 *   Beat 1 (Be Seen):    read local signals → pick observation → wait for
 *                        return-or-ctrl-c. No network. On ctrl-c, record a
 *                        single timestamp in ~/.cache/alter/first-look-seen-at
 *                        and return cleanly - no session, no nudge, no email.
 *   Beat 2 (Declare):    existing OAuth 2.1 PKCE + passkey ceremony. This is
 *                        the only beat that touches the network.
 *   Beat 3 (Seed Planted): after session is written, pick the next
 *                        observation in-memory (silent no-op until a
 *                        future menu-seed writer lands). Exit in silence.
 *
 * Hidden flags:
 *   --audit-signals     print exactly what was read during beat 1 and exit;
 *                       never writes, never authenticates.
 *   --no-beats          skip beats 1 and 3 (used by CI / automation).
 *   --allow-partial     opt into the legacy warn-and-continue behaviour for
 *                       member-key mint and signing-key registration
 *                       failures. Default is fail-fast: a partial login
 *                       leaves the CLI with a JWT but no usable MCP
 *                       credential, and every subsequent tools/call 401s
 *                       with no breadcrumb. Use this flag only for offline
 *                       debugging or against a backend with the MCP
 *                       invocation gate disabled.
 */

import * as fs from "node:fs";
import * as http from "http";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { password as clackPassword, isCancel } from "@clack/prompts";
import stripAnsi from "strip-ansi";

import { openBrowser } from "../browser.js";
import { deriveDeviceLabel } from "../lib/device-label.js";
import { fetchWithRetry } from "../lib/fetch-with-retry.js";
import { LOGIN_TIMEOUT_MS } from "../lib/timeouts.js";
import { apiErrorMessage, alterDebugEnabled } from "../lib/api-error.js";
import {
  writeSession,
  readSession,
  apiCall,
  decodeJwtPayload,
  extractAlterClaims,
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  generateNonce,
  isSentinelSession,
  ALTER_CONFIG_DIR,
  type AlterSession,
  type OrgMembership,
} from "../auth.js";
import { fetchMemberships } from "../lib/memberships.js";
import { mintBridgeToken } from "../bridge/security.js";
import { startBridgeServer } from "../bridge/server.js";
import {
  computePublicKeyFingerprint,
  generateSigningKeypair,
  readPrivateKeyPem,
  registerSigningKey,
  writeSigningCredential,
} from "../signing.js";
import { invokeDeviceSignHelper } from "../lib/device-sign.js";
import {
  generateX25519Keypair,
  writeX25519PrivateKeyPem,
} from "../x25519.js";
import { readProfile, summariseProfile } from "../onboarding/signals.js";
import { classify, pickPrimaryArchetype } from "../onboarding/archetypes.js";
import {
  beatOne,
  beatThree,
  profileSeed,
} from "../onboarding/beats.js";
import {
  runOnboardingChain,
  fetchOnboardingState,
} from "../onboarding/orchestrator.js";
import {
  emitSessionStarted,
  emitSessionEnded,
} from "../lib/active-sessions-emit.js";
import {
  boxWidth,
  firstTimeFraming,
  indented,
  pauseMs,
  printBoxedPhase,
  renderAudit,
  returningFraming,
  speakerTag,
  startSpinner,
  subIndented,
  wrapUrl,
} from "../onboarding/render.js";

const ALTER_BOX_TITLE = "◇ ~alter ◇";
import { withKeyListenerCancel } from "../ui/biosMenu.js";
import { bounceDaemon } from "../lib/daemon-bounce.js";

// The `ALTER_API` env var is validated through the SAME
// allow-list as the `--api` flag. Previously the env path was trusted
// verbatim, so a poisoned shell profile / `.envrc` / CI env could silently
// redirect all auth + JWT + key-mint traffic to an attacker host. A
// non-allow-listed value is refused fail-closed rather than honoured.
function resolveDefaultApi(): string {
  const fromEnv = process.env.ALTER_API;
  if (!fromEnv) return "https://api.truealter.com";
  try {
    return validateApiOverride(fromEnv);
  } catch (err) {
    process.stderr.write(
      `alter: ALTER_API='${fromEnv}' is not in the allow-list - refusing to ` +
        `send credentials to an unvalidated host. ${(err as Error).message}\n`,
    );
    // NOTE: process.exitCode set here; module-level init returns empty string.
    // The caller (DEFAULT_API assignment) will have an empty string; any
    // subsequent network call will fail safely rather than sending creds
    // to an unvalidated host. The event loop drains before exit.
    process.exitCode = 2;
    return "";
  }
}

export const DEFAULT_API = resolveDefaultApi();
const CLIENT_ID = process.env.ALTER_CLIENT_ID ?? "alter_cli";
const SCOPES = "openid profile email alter:level identity_read";

/**
 * Resolve the bound `~handle` for a fresh session.
 *
 * Precedence:
 *   1. Server-issued `alter_handle` OIDC claim - when the backend looks the
 *      handle up by `sub` and emits it in the id_token, that wins.
 *   2. Prior session's persisted `~handle` - only when the prior session's
 *      stored `user_id` matches the fresh access-token `sub`. The sub-match
 *      guard prevents handle-bleed: an OAuth login on the same machine by a
 *      different account would otherwise inherit the prior owner's `~handle`
 *      whenever the server omits the `alter_handle` claim. The prior handle
 *      must also be non-synthetic (i.e. not already a `~<8-hex>` sub-prefix
 *      or the new `~u<7-hex>` letter-leading form), so we don't reuse a
 *      placeholder.
 *   3. Synthetic letter-leading form (`~u<7 hex chars of sub>`) - last resort,
 *      marks the session as unbound so status-time UX can flag it.  The `u`
 *      prefix guarantees the handle starts with a letter and passes
 *      `HANDLE_RE = /^~[a-z][a-z0-9._-]{0,62}$/`.  Legacy sessions may still
 *      carry the old `~<8-hex>` form; both forms are treated as synthetic.
 *
 * Pure helper exported for tests.
 */
export function resolveBoundHandle(args: {
  alterHandleClaim?: string | undefined;
  sub: string;
  priorHandle?: string | undefined;
  priorUserId?: string | undefined;
}): string {
  if (args.alterHandleClaim) return args.alterHandleClaim;

  const hexSub = args.sub.replace(/-/g, "").slice(0, 7);
  const syntheticHandle = args.sub === "" ? "~unknown" : `~u${hexSub}`;
  const priorMatchesSub = args.sub !== "" && args.priorUserId === args.sub;
  const priorLooksReal =
    !!args.priorHandle &&
    args.priorHandle !== syntheticHandle &&
    // Reject both the new ~u<7hex> form and the legacy ~<8hex> form as synthetic.
    !/^~u[0-9a-f]{7}$/i.test(args.priorHandle) &&
    !/^~[0-9a-f]{8}$/i.test(args.priorHandle);

  if (priorMatchesSub && priorLooksReal) return args.priorHandle as string;
  return syntheticHandle;
}

/**
 * Render a friendly, actionable message for a rate-limited / account-locked
 * login response, or `null` when the response is not one we want to rewrite.
 *
 * The ALTER backend returns `429 TOO_MANY_REQUESTS` after a tier of failed
 * login attempts (5/10/20 → 15-min / 1-hr / 24-hr lockout, keyed on a
 * compound `(email_hash, ip/24)`), with `detail` of the form
 * `"Account temporarily locked due to repeated failed login attempts. Try
 * again in N minutes."`. The generic rate-limit middleware can also 429 the
 * device-code init / poll endpoints. Either way the raw `429: <body>` reads
 * as a bug to anyone who hits it - this turns it into a sentence that says
 * what happened, when to retry, and that a successful login clears it.
 *
 * Precedence for the retry-time hint:
 *   1. `Retry-After` header - integer seconds, or an HTTP-date delta.
 *   2. A `"Try again in N minutes"` substring scraped from the JSON
 *      `detail` field of `body`.
 *   3. Generic "wait a few minutes" fallback.
 *
 * Pure helper exported for tests. `body` is the already-read response text
 * (the caller has typically `stripAnsi`'d it).
 */
export function formatRateLimitMessage(
  resp: { status: number; headers?: { get(name: string): string | null } },
  body: string,
): string | null {
  if (resp.status !== 429 && resp.status !== 423) return null;

  // 1 - Retry-After header.
  let retryHint: string | null = null;
  const retryAfter = resp.headers?.get("retry-after") ?? null;
  if (retryAfter) {
    const trimmed = retryAfter.trim();
    if (/^\d+$/.test(trimmed)) {
      const secs = parseInt(trimmed, 10);
      if (Number.isFinite(secs) && secs >= 0) {
        const mins = Math.max(1, Math.ceil(secs / 60));
        retryHint = `try again in ${mins} minute${mins === 1 ? "" : "s"}`;
      }
    } else {
      const when = Date.parse(trimmed);
      if (!Number.isNaN(when)) {
        const deltaSecs = Math.max(0, Math.round((when - Date.now()) / 1000));
        const mins = Math.max(1, Math.ceil(deltaSecs / 60));
        retryHint = `try again in ${mins} minute${mins === 1 ? "" : "s"}`;
      }
    }
  }

  // Parse the JSON body once - used for both the detail-scrape fallback and
  // the failed-login-attempts hint.
  let detail = "";
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    if (typeof parsed.detail === "string") detail = parsed.detail;
  } catch {
    // Non-JSON body (e.g. an HTML 429 from a proxy) - fall through.
  }

  // 2 - scrape an existing "Try again in N minutes" out of `detail`.
  if (!retryHint && detail) {
    const m = /try again in (\d+)\s*minute/i.exec(detail);
    if (m) {
      const mins = parseInt(m[1] as string, 10);
      if (Number.isFinite(mins) && mins > 0) {
        retryHint = `try again in ${mins} minute${mins === 1 ? "" : "s"}`;
      }
    }
  }

  const base =
    "alter login: Alter has temporarily rate-limited this login" +
    (retryHint
      ? ` - ${retryHint}.`
      : " (repeated attempts trip a lockout). Wait a few minutes, then run `alter login` again.");

  // If the backend's detail names failed login attempts, add the
  // self-clearing reassurance - this is the account-lockout tier, not a
  // generic burst limit, and people who hit it should know it isn't sticky.
  if (/failed login attempt/i.test(detail)) {
    return (
      base +
      " This clears on its own when the window passes; a successful `alter login` resets it immediately."
    );
  }
  return base;
}

function printHelp(): void {
  console.log(
    "Usage: alter login [--token] [--device-code] [--bridge] [--resume]\n" +
      "                  [--api <url>] [--dry-run] [--no-beats] [--allow-partial]\n" +
      "\n" +
      "Authenticate to ~Alter via the browser OAuth 2.1 PKCE flow (default)\n" +
      "or by pasting a JWT directly (--token), or via the device-code flow\n" +
      "(--device-code, RFC 8628) for headless environments.\n" +
      "\n" +
      "Flags:\n" +
      "  --token          prompt for a JWT instead of opening the browser\n" +
      "  --device-code    force the RFC 8628 device-code flow. Auto-selected when\n" +
      "                   stdin is not a TTY, ALTER_HEADLESS=1, or no DISPLAY on Linux\n" +
      "  --bridge         after OAuth completes, run a localhost browser-setup\n" +
      "                   bridge so the browser can drive pairing / wiring verbs\n" +
      "  --resume         pick up a browser-first setup already authenticated\n" +
      "                   in your browser; stands up the localhost bridge and\n" +
      "                   opens the setup page to continue\n" +
      "  --api <url>      override the API base URL (default: api.truealter.com)\n" +
      "  --dry-run        walk the three first-run setup beats without OAuth or writes\n" +
      "  --no-beats       skip beats 1 + 3 (used by CI / automation)\n" +
      "  --allow-partial  opt into legacy warn-and-continue if member-key mint or\n" +
      "                   signing-key registration fails. Default is fail-fast:\n" +
      "                   no session.json is written on a partial login.\n",
  );
}

/**
 * Should we route to the device-code flow rather than the browser flow?
 *
 * Activation tests, in priority order:
 *   1. Explicit --device-code flag → always device-code
 *   2. ALTER_HEADLESS=1 → always device-code
 *   3. stdin is NOT a TTY (piped/redirected; CI runners) → device-code
 *   4. Linux + no $DISPLAY (no X / Wayland session) → device-code
 *
 * Otherwise the browser flow remains the default. macOS / Windows
 * desktops never auto-route to device-code because every supported
 * version has a usable default browser.
 */
export function shouldUseDeviceCodeFlow(args: string[]): boolean {
  if (args.includes("--device-code")) return true;
  if (process.env.ALTER_HEADLESS === "1") return true;
  if (!process.stdin.isTTY) return true;
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return true;
  }
  return false;
}

// Re-export for callers that still imported it from this module.
// The canonical source now lives in `src/lib/timeouts.ts` so the
// passkey flow can share the same guard without circular imports.
export { LOGIN_TIMEOUT_MS } from "../lib/timeouts.js";
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Validate an `--api <url>` override. We accept HTTPS only against the
 * production API host, plus `localhost` / `127.0.0.1` exclusively when
 * the e2e harness opts in via `ALTER_E2E_DEV=1`. Everything else is
 * refused - this stops a phishing flow from coaxing the CLI into
 * sending a JWT to an attacker-controlled origin.
 */
export function validateApiOverride(raw: string | undefined): string {
  if (!raw) {
    throw new Error("alter login: --api requires a URL argument");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `alter login: --api value '${raw}' is not a valid URL`,
    );
  }
  const e2eDev = process.env.ALTER_E2E_DEV === "1";
  const allowed = new Set<string>(["api.truealter.com"]);
  if (e2eDev) {
    allowed.add("localhost");
    allowed.add("127.0.0.1");
  }
  const host = parsed.hostname;
  const proto = parsed.protocol;
  const httpsOk = proto === "https:";
  const localOk =
    e2eDev && proto === "http:" && (host === "localhost" || host === "127.0.0.1");
  if (!allowed.has(host) || !(httpsOk || localOk)) {
    throw new Error(
      `alter login: --api host '${host}' (${proto}) is not in the allow-list. ` +
        "Production hosts must use https://api.truealter.com; localhost/127.0.0.1 " +
        "are accepted only with ALTER_E2E_DEV=1.",
    );
  }
  // Strip trailing slashes so the rest of the code can append /api/v1/... cleanly.
  return parsed.origin;
}

function loginSessionEmit(kind: "started" | "ended", workingOn: string): void {
  try {
    const sessionId = String(process.pid);
    if (kind === "started") emitSessionStarted({ sessionId, workingOn });
    else emitSessionEnded({ sessionId, workingOn });
  } catch {
    // Silent - emit module already swallows, this is belt-and-braces
    // so a signal-emit failure never blocks login.
  }
}

export async function login(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  // Hidden: --audit-signals dumps exactly what beat 1 would read and exits.
  // Never authenticates, never writes session state.
  if (args.includes("--audit-signals")) {
    const profile = readProfile();
    renderAudit(summariseProfile(profile));
    return;
  }

  // --resume: browser-first onboarding handoff. Browser has already
  // completed OAuth; we read a single-use resume hint file the backend
  // wrote into the user's local cache and stand up a bridge listener
  // the browser tab can post verbs through. Runs BEFORE the standard
  // OAuth path because there is nothing to authorise here - the
  // session.json must already exist.
  if (args.includes("--resume")) {
    await loginResume();
    return;
  }

  // --dry-run: walk all three beats end-to-end without OAuth, without
  // writing session.json, and without touching ~/.cache/alter. Bypasses
  // the "already logged in" check so copy-review can run on a live machine.
  const dryRun = args.includes("--dry-run");

  // --allow-partial: opt-in escape hatch that restores the pre-fix
  // warn-and-continue behaviour for member-key mint and signing-key
  // registration. Without it, either failure is fatal -- a happy-path
  // login that leaves the CLI with a JWT but no member credential or
  // no registered signing kid is a trap: every subsequent MCP
  // `tools/call` 401s with no breadcrumb pointing back to login. Use
  // this flag only when you knowingly need a degraded session (offline
  // debugging, staging backend with the MCP gate disabled, etc.).
  const allowPartial = args.includes("--allow-partial");
  process.env.ALTER_LOGIN_ALLOW_PARTIAL = allowPartial ? "1" : "";

  loginSessionEmit("started", "alter login");
  try {
    // Returning user signal: session.json on disk carries the user's prior
    // ~handle, independent of whether the JWT is still valid. We branch on
    // *presence*, not validity - an expired JWT is a re-auth event, not a
    // first meeting, and the naming-ceremony framing ("you first need a
    // name here", "smallest unit of a name that is yours") doesn't apply
    // to someone who has already named themselves. The valid-JWT branch
    // below still short-circuits with the "already logged in" message;
    // only the expired-or-missing-JWT branch reaches OAuth.
    const priorSession = !dryRun ? readSession() : null;
    // GUARD 3a: defensive sentinel check on the "already logged in" gate.
    // readSession() rejects sentinels via parseSessionContent, so priorSession
    // is already null when only a sentinel is present. However, isSentinelSession
    // is added here as belt-and-braces to ensure the gate can never be
    // short-circuited by a sentinel with a far-future jwt_expires_at even if a
    // future refactor weakens the read-path rejection.
    if (priorSession && !isSentinelSession(priorSession) && new Date(priorSession.jwt_expires_at) > new Date()) {
      // `--bridge` against a live session is the supported re-entry
      // path - skip the "already logged in" short-circuit and go
      // straight to the bridge handoff. Everything else short-circuits
      // as before so re-running `alter login` does no harm.
      if (args.includes("--bridge")) {
        await runBridge(priorSession, { mode: "cli-first" });
        return;
      }
      // Email may be empty for pseudonymous / synthetic sessions where the
      // backend never emitted an `email` claim; rendering raw `(${email})`
      // surfaces as a bare `()` after the handle, which reads as a bug.
      // Suppress the parenthetical when there is nothing to show.
      const emailSuffix =
        priorSession.email && priorSession.email.trim().length > 0
          ? ` (${priorSession.email})`
          : "";
      console.log(
        `Already logged in as ${priorSession.handle}${emailSuffix}.`,
      );
      console.log("Run 'alter logout' first to switch accounts.");
      return;
    }
    const returningHandle = priorSession?.handle ?? null;

    if (args.includes("--token")) {
      await loginWithToken(args);
      return;
    }

    if (dryRun) {
      await runDryJourney();
      return;
    }

    const api = args.includes("--api")
      ? validateApiOverride(args[args.indexOf("--api") + 1])
      : DEFAULT_API;

    // Headless environments (CI runners, remote SSH, docker exec, agent
    // containers) cannot complete the browser OAuth flow because there is
    // no usable browser on the same host. Route to RFC 8628 device-code
    // instead - the user pastes a short user_code into a browser on a
    // trusted device they're already signed in on, and the CLI polls the
    // /oauth/token endpoint until the approval lands.
    if (shouldUseDeviceCodeFlow(args)) {
      await loginWithDeviceCode(api, returningHandle);
      return;
    }

    const skipBeats = args.includes("--no-beats");

    // --- Beat 1: Be Seen ---------------------------------------------------
    // Local-only. If the user exits here, nothing else runs.
    // Returning users skip Beat 1 entirely: the mystery-observation moment
    // is a first-meeting beat, not a re-auth one. We go straight to
    // browser hand-off with the quiet re-auth framing.
    let shownObservationId: string | null = null;
    let archetype = "fallback" as ReturnType<typeof pickPrimaryArchetype>;
    const profile = readProfile();
    if (!skipBeats && returningHandle === null) {
      const matches = classify(profile);
      archetype = pickPrimaryArchetype(matches, profileSeed(profile));
      const result = await beatOne(profile, archetype);
      if (result.decision === "exit") {
        // No session created. No network touched. The only state left is a
        // single timestamp in ~/.cache/alter/first-look-seen-at (written by
        // beatOne); if the user comes back, a different observation fires.
        return;
      }
      shownObservationId = result.shownObservationId;
    }

    // --- Beat 2: Declare (existing OAuth PKCE flow) ------------------------
    await loginWithBrowser(api, returningHandle);

    // --- Beat 3: Seed Planted ---------------------------------------------
    if (!skipBeats && shownObservationId !== null) {
      await beatThree(profile, archetype, shownObservationId);
    }

    // --- Browser onboarding handoff --------------------
    // Default: after OAuth, hand off to the browser /onboarding flow via
    // the localhost bridge. The terminal guided chain (runOnboardingChain)
    // is no longer the default - it is dev/dry-run only.
    //
    // Gates:
    //  - --no-beats suppresses beats AND handoff (CI/automation).
    //  - non-TTY: no handoff (device-code returned early above).
    //  - Returning/already-onboarded users: skip silently.
    //  - --bridge explicit re-entry still works (below).
    if (!skipBeats && process.stdin.isTTY) {
      const session = readSession();
      if (session) {
        const state = await fetchOnboardingState();
        const alreadyDone =
          state === "not-applicable" ||
          (state !== null &&
            (state.onboarded_at !== null || state.onboarding_skipped_at !== null));
        if (!alreadyDone) {
          await runBridge(session, { mode: "cli-first" });
        }
      }
    }

    // Login closes on the welcome box. No post-login next-step surface: the
    // member asked to log in, not to be told what to do next. `alter status`
    // still carries the canonical next-best-action block for anyone who wants
    // it (src/commands/status.ts).

    // --- --bridge: CLI-first browser-onboarding explicit re-entry --------
    // Explicit --bridge flag: stand up the bridge against the live session.
    // The bridge runs until the browser posts `forget`, the 30-min idle
    // timer fires, or the user interrupts with Ctrl+C.
    if (args.includes("--bridge")) {
      const session = readSession();
      if (!session) {
        throw new Error(
          "alter login --bridge: OAuth succeeded but no session.json was written. " +
            "Re-run 'alter login' before retrying.",
        );
      }
      await runBridge(session, { mode: "cli-first" });
    }
  } finally {
    loginSessionEmit("ended", "alter login");
  }
}

// ---------------------------------------------------------------------------
// Browser-onboarding bridge - CLI-first and browser-first entry points
// ---------------------------------------------------------------------------

// ALTER-ARCHIVED: superseded 2026-07-05 | status=retained-not-deleted | note=the browser-first CLI-bridge onboarding consumer was removed; no live browser consumer. Retained pending a desktop-client rendezvous decision.
/**
 * Path to the browser-first resume hint. The backend (or any other
 * trusted writer) drops this file when the browser-side onboarding
 * has completed OAuth and is waiting for a local bridge listener
 * before it can post pairing / wiring verbs. The CLI consumes it
 * exactly once via `alter login --resume`.
 */
export function resumeHintFile(): string {
  const xdg =
    process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
  return path.join(xdg, "alter", "onboarding-resume.json");
}

// ALTER-ARCHIVED: superseded 2026-07-05 | status=retained-not-deleted | note=the browser-first CLI-bridge onboarding consumer was removed; no live browser consumer. Retained pending a desktop-client rendezvous decision.
interface ResumeHint {
  resume_id: string;
  expires_at: string;
  opened_at: string;
}

const RESUME_MAX_AGE_MS = 2 * 60 * 60 * 1000;

// ALTER-ARCHIVED: superseded 2026-07-05 | status=retained-not-deleted | note=the browser-first CLI-bridge onboarding consumer was removed; no live browser consumer. Retained pending a desktop-client rendezvous decision.
/**
 * Read and validate the browser-first resume hint. Returns the parsed
 * payload, or null when the file is absent / unparseable / expired -
 * the caller surfaces the failure as a plain-English exit-1 message.
 */
function readResumeHint(): ResumeHint | null {
  let raw: string;
  try {
    raw = fs.readFileSync(resumeHintFile(), "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (
    typeof o.resume_id !== "string" ||
    o.resume_id.length === 0 ||
    typeof o.expires_at !== "string" ||
    typeof o.opened_at !== "string"
  ) {
    return null;
  }
  // Reject hints older than two hours regardless of the embedded
  // `expires_at`, so a stale file on disk can't be replayed if the
  // backend forgets to set the field.
  const opened = Date.parse(o.opened_at);
  if (Number.isNaN(opened) || Date.now() - opened > RESUME_MAX_AGE_MS) {
    return null;
  }
  const expires = Date.parse(o.expires_at);
  if (Number.isNaN(expires) || expires < Date.now()) return null;
  return {
    resume_id: o.resume_id,
    expires_at: o.expires_at,
    opened_at: o.opened_at,
  };
}

// ALTER-ARCHIVED: superseded 2026-07-05 | status=retained-not-deleted | note=the browser-first CLI-bridge onboarding consumer was removed; no live browser consumer. Retained pending a desktop-client rendezvous decision.
/** Browser-first onboarding - read resume hint, stand up bridge. */
async function loginResume(): Promise<void> {
  const session = readSession();
  if (!session) {
    console.error(
      "alter login --resume: no signed-in session on this machine.\n" +
        "Open your browser to truealter.com/auth/login first, then re-run\n" +
        "'alter login --resume'.",
    );
    process.exitCode = 1;
    return;
  }
  if (new Date(session.jwt_expires_at) <= new Date()) {
    console.error(
      "alter login --resume: your local session has expired.\n" +
        "Run 'alter login' to sign in, then retry 'alter login --resume'.",
    );
    process.exitCode = 1;
    return;
  }

  const hint = readResumeHint();
  if (!hint) {
    console.error(
      "alter login --resume: no pending browser setup found.\n" +
        "Expected a resume hint at " +
        resumeHintFile() +
        ".\n" +
        "Visit truealter.com/auth/success from your browser, or run\n" +
        "'alter login --bridge' to start a CLI-first browser setup instead.",
    );
    process.exitCode = 1;
    return;
  }

  await runBridge(session, { mode: "browser-first", hint });
}

interface RunBridgeOptions {
  mode: "cli-first" | "browser-first";
  hint?: ResumeHint;
}

/**
 * Stand up the localhost bridge listener, open the browser onboarding
 * page, and block until the server shuts down (forget verb / idle
 * timer / SIGINT). The bridge token lives in process memory only -
 * never written to disk, never logged. Plan §2 item 15.
 *
 * Exported for `menu.ts` ("Finish setting up ~alter" → browser handoff).
 */
export async function runBridge(
  session: AlterSession,
  opts: RunBridgeOptions,
): Promise<void> {
  const bridgeToken = mintBridgeToken();

  // Canonical origin only by default. Dev mode (ALTER_DEV=1) layers in
  // a comma-separated list from ALTER_BRIDGE_DEV_ORIGINS so a local
  // truealter.com dev server can drive the bridge during e2e work.
  const allowedOrigins = ["https://truealter.com"];
  if (process.env.ALTER_DEV === "1") {
    const extra = process.env.ALTER_BRIDGE_DEV_ORIGINS ?? "";
    for (const raw of extra.split(",")) {
      const trimmed = raw.trim();
      if (trimmed) allowedOrigins.push(trimmed);
    }
  }

  const { port, server, shutdown } = await startBridgeServer({
    session,
    bridgeToken,
    allowedOrigins,
  });

  console.log(`Bridge listening on 127.0.0.1:${port}. Opening browser...`);

  // ALTER-ARCHIVED: superseded 2026-07-05 | status=retained-not-deleted | note=the browser-first CLI-bridge onboarding consumer was removed; no live browser consumer. Retained pending a desktop-client rendezvous decision.
  // Browser-first mode: notify the backend that the local listener is
  // up. The browser tab will then learn the (port, token_proof) pair
  // from its server-rendered context. Degraded path: if the endpoint
  // 404s (backend not yet shipped), the browser still picks the
  // listener up from the `#bridge=<token>:<port>` URL fragment we
  // open below.
  if (opts.mode === "browser-first" && opts.hint) {
    const proof = createHash("sha256")
      .update(bridgeToken, "utf-8")
      .digest("hex");
    try {
      const resp = await apiCall("/api/v1/onboarding/bridge/rendezvous", {
        method: "POST",
        body: {
          resume_id: opts.hint.resume_id,
          port,
          bridge_token_proof: proof,
        },
      });
      if (resp && resp.status === 404) {
        console.log(
          "Bridge rendezvous endpoint not yet deployed: continuing in degraded mode. " +
            "Browser will pick up the listener from the URL fragment.",
        );
      } else if (resp && !resp.ok) {
        console.log(
          `Bridge rendezvous returned HTTP ${resp.status}: continuing in degraded mode.`,
        );
      }
    } catch (err) {
      console.log(
        `Bridge rendezvous failed (${(err as Error).message}): continuing in degraded mode.`,
      );
    }
    // Single-use: drop the hint regardless of rendezvous outcome so a
    // crashed / killed bridge can't be replayed against the same id.
    try {
      fs.unlinkSync(resumeHintFile());
    } catch {
      // Already gone or permission denied - both fine.
    }
  }

  const fragment = `#bridge=${bridgeToken}:${port}`;
  const url =
    opts.mode === "browser-first" && opts.hint
      ? // ALTER-ARCHIVED: superseded 2026-07-05 | status=retained-not-deleted | note=the browser-first CLI-bridge onboarding consumer was removed; no live browser consumer. Retained pending a desktop-client rendezvous decision.
        `https://truealter.com/auth/success?resume=${encodeURIComponent(opts.hint.resume_id)}${fragment}`
      : `https://truealter.com/auth/success?session=${encodeURIComponent(session.user_id)}${fragment}`;

  try {
    openBrowser(url);
  } catch {
    console.log("Could not open your browser automatically.");
    console.log(
      "Visit https://truealter.com/auth/success manually. The listener " +
        "will pick up the matching token from the URL fragment your browser opens.",
    );
  }

  console.log(
    "Bridge token never leaves this terminal. Press Ctrl+C to stop the bridge early.",
  );

  // SIGINT: trigger graceful shutdown rather than letting the runtime
  // tear the server down mid-request.
  const onSigint = (): void => {
    shutdown();
  };
  process.on("SIGINT", onSigint);
  try {
    await new Promise<void>((resolve) => {
      server.on("close", () => resolve());
    });
  } finally {
    process.off("SIGINT", onSigint);
  }
}

// ---------------------------------------------------------------------------
// Dry-run journey - beats 1→2→3 with zero network and zero writes
// ---------------------------------------------------------------------------

async function runDryJourney(): Promise<void> {
  process.env.ALTER_DRY_RUN = "1";

  const profile = readProfile();
  const matches = classify(profile);
  const archetype = pickPrimaryArchetype(matches, profileSeed(profile));

  // Beat 1 - real render, real keypress wait.
  const result = await beatOne(profile, archetype);
  if (result.decision === "exit") {
    return;
  }

  // Beat 2 - simulate the OAuth chrome. No callback server, no browser,
  // no token exchange. Pauses approximate the real flow's tempo.
  //
  // Boxed naming-framing + boxed URL panel + transient spinner mirror
  // the live `loginWithBrowser` shape exactly so dry-run is faithful for
  // copy review. Dry-run always walks the first-time path; the
  // returning-user branch is covered by `tests/test_login_returning_user.ts`.
  printBoxedPhase({
    title: ALTER_BOX_TITLE,
    body: [
      "",
      "To be known anywhere, you first need a name here.",
      "You can use one you already have, or take one that is only yours.",
      "",
      "~ is the Trill. It is the smallest unit of a name that is yours.",
      "",
    ],
  });
  printBoxedPhase({
    title: ALTER_BOX_TITLE,
    body: [
      "",
      "Opening your browser. (dry-run - not opened)",
      "If it doesn't open, visit:",
      // Dry-run uses a clearly-truncated marker rather than a raw URL
      // tail that could be mistaken for a real authorize URL.
      "  https://api.truealter.com/api/v1/oauth/authorize?<dry-run placeholder>",
      "",
    ],
  });
  const drySpinner = startSpinner("waiting…");
  // Approximate the live flow's tempo without a second adjacent pauseMs
  // call - the wait is conceptually a single beat, not two.
  await pauseMs(1600);
  drySpinner.stop();

  // Beat 3 - real typing effect. Cache write is suppressed by ALTER_DRY_RUN.
  await beatThree(profile, archetype, result.shownObservationId);
}

// ---------------------------------------------------------------------------
// Device-code OAuth flow (RFC 8628) - for headless environments
// ---------------------------------------------------------------------------

interface DeviceInitResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface DeviceTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  refresh_expires_in?: number;
  id_token?: string;
  scope?: string;
}

interface DeviceTokenError {
  error:
    | "authorization_pending"
    | "slow_down"
    | "expired_token"
    | "access_denied"
    | string;
  error_description?: string;
  /** Seconds the server asked us to wait, parsed from Retry-After. */
  retry_after_sec?: number;
}

/**
 * Seconds to wait per the response's Retry-After header, or null.
 * Accepts both the integer-seconds and HTTP-date forms.
 */
export function retryAfterSeconds(resp: {
  headers?: { get(name: string): string | null };
}): number | null {
  const raw = resp.headers?.get("retry-after")?.trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const secs = parseInt(raw, 10);
    return Number.isFinite(secs) && secs >= 0 ? secs : null;
  }
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return null;
  return Math.max(0, Math.round((when - Date.now()) / 1000));
}

const DEVICE_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:device_code";

/**
 * Cancellable sleep - the polling loop races this against signal abort
 * so q/Esc can collapse a slow wait without ctrl-C.
 */
function deviceSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(t);
        resolve(true);
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          resolve(true);
        },
        { once: true },
      );
    }
  });
}

async function deviceInit(api: string): Promise<DeviceInitResponse> {
  const resp = await fetchWithRetry(`${api}/api/v1/oauth/device/init`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPES }),
  });
  if (!resp.ok) {
    const body = stripAnsi(await resp.text());
    const rateLimited = formatRateLimitMessage(resp, body);
    if (rateLimited) throw new Error(rateLimited);
    throw new Error(apiErrorMessage("start sign-in", resp.status, body.slice(0, 200)));
  }
  return (await resp.json()) as DeviceInitResponse;
}

/**
 * The device-grant poll has its OWN address on the backend, separate from
 * the general token endpoint.
 *
 * The poll is the highest-volume, lowest-privilege call in the whole flow
 * (one every 5s for up to 10 minutes), and on the shared /oauth/token path
 * it shared a per-IP rate-limit bucket with every other client on the same
 * network. On 2026-07-14 an unrelated process looping against that endpoint
 * drained the shared daily quota and every `alter login` from that network
 * was 429'd for 11 hours. The dedicated path is metered per device_code
 * instead of per IP, so a stranger's runaway loop can no longer spend the
 * quota your login needs.
 *
 * `/oauth/token` still serves the device grant for older backends, so the
 * poll falls back to it on a 404 and stays there for the rest of the loop.
 */
const DEVICE_POLL_PATH = "/api/v1/oauth/device/token";
const DEVICE_POLL_FALLBACK_PATH = "/api/v1/oauth/token";
let devicePollPath: string = DEVICE_POLL_PATH;

/** Reset the poll path. Exported for tests; each login starts fresh. */
export function resetDevicePollPath(): void {
  devicePollPath = DEVICE_POLL_PATH;
}

async function devicePoll(
  api: string,
  deviceCode: string,
): Promise<{ ok: true; tokens: DeviceTokenResponse } | { ok: false; err: DeviceTokenError; status: number }> {
  // No retry-on-503 wrapper here: the polling loop IS the retry layer.
  // A transient 5xx looks the same as authorization_pending - wait for
  // the next interval and try again.
  const body = new URLSearchParams({
    grant_type: DEVICE_GRANT_TYPE,
    device_code: deviceCode,
    client_id: CLIENT_ID,
  }).toString();
  const post = (path: string) =>
    fetch(`${api}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

  let resp = await post(devicePollPath);
  if (resp.status === 404 && devicePollPath === DEVICE_POLL_PATH) {
    // Backend predates the dedicated poll path: fall back for this login.
    devicePollPath = DEVICE_POLL_FALLBACK_PATH;
    resp = await post(devicePollPath);
  }
  const text = await resp.text();
  if (resp.ok) {
    return { ok: true, tokens: JSON.parse(text) as DeviceTokenResponse };
  }
  // The generic rate-limit middleware can 429 (or 423) the poll endpoint
  // independently of the RFC 8628 error envelope. Surface the friendly
  // lockout message verbatim through `error_description` so the poll loop's
  // terminal-error branch prints it without the `unknown_error:` prefix.
  const rateLimited = formatRateLimitMessage(resp, stripAnsi(text));
  if (rateLimited) {
    return {
      ok: false,
      err: {
        error: "rate_limited",
        error_description: rateLimited,
        retry_after_sec: retryAfterSeconds(resp) ?? undefined,
      },
      status: resp.status,
    };
  }
  let parsed: DeviceTokenError = { error: "unknown_error" };
  try {
    parsed = JSON.parse(text) as DeviceTokenError;
  } catch {
    parsed = {
      error: "unknown_error",
      error_description: text.slice(0, 200),
    };
  }
  return { ok: false, err: parsed, status: resp.status };
}

interface DevicePollOutcome {
  status: "authorised" | "denied" | "expired" | "cancelled" | "error";
  tokens?: DeviceTokenResponse;
  detail?: string;
}

/**
 * Poll /oauth/token until a terminal state. Lifts the polling shape
 * from pair-github.ts:139-184: race the configured interval against
 * signal abort, bump on slow_down, surface terminal errors verbatim.
 */
export async function pollDeviceUntilDone(
  api: string,
  init: DeviceInitResponse,
  signal: AbortSignal,
): Promise<DevicePollOutcome> {
  resetDevicePollPath();
  let intervalSec = init.interval > 0 ? init.interval : 5;
  const deadline = Date.now() + init.expires_in * 1000;
  while (Date.now() < deadline) {
    if (signal.aborted) return { status: "cancelled" };
    const sleepMs = Math.min(
      intervalSec * 1000,
      Math.max(0, deadline - Date.now()),
    );
    if (sleepMs > 0) {
      const interrupted = await deviceSleep(sleepMs, signal);
      if (interrupted) return { status: "cancelled" };
    }
    if (Date.now() >= deadline) break;
    let resp;
    try {
      resp = await devicePoll(api, init.device_code);
    } catch (err) {
      return { status: "error", detail: (err as Error).message };
    }
    if (resp.ok) {
      return { status: "authorised", tokens: resp.tokens };
    }
    const error = resp.err.error;
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      intervalSec += 5;
      continue;
    }
    if (error === "expired_token") {
      return { status: "expired", detail: resp.err.error_description };
    }
    if (error === "access_denied") {
      return { status: "denied", detail: resp.err.error_description };
    }
    if (error === "rate_limited") {
      // A 429 mid-poll is a WAIT, not a death. Killing the login here is
      // what turned a transient throttle into "your login is dead, try
      // again in 679 minutes" on 2026-07-14: the code was still live and
      // still approvable, and the CLI threw it away.
      //
      // Honour Retry-After, but never sleep past the device code's own
      // expiry - once the code is dead there is nothing left to poll for,
      // and the honest answer is to start a new login.
      const waitMs = (resp.err.retry_after_sec ?? intervalSec) * 1000;
      const remainingMs = deadline - Date.now();
      if (waitMs >= remainingMs) {
        return { status: "expired", detail: resp.err.error_description };
      }
      const interrupted = await deviceSleep(waitMs, signal);
      if (interrupted) return { status: "cancelled" };
      continue;
    }
    return {
      status: "error",
      detail: `${error}: ${resp.err.error_description ?? ""}`.trim(),
    };
  }
  return { status: "expired", detail: "local timeout reached" };
}

async function loginWithDeviceCode(
  api: string,
  returningHandle: string | null = null,
): Promise<void> {
  // Returning users skip Beat 1 (the mystery observation), which means
  // they also skip the speaker tag Beat 1 emits. Emit it here so the
  // re-auth screen still opens with a ~alter speaker pin, then the
  // quiet re-auth line. First-time device-code users (no Beat 1 either,
  // because device-code never runs the beats) get the naming-ceremony
  // framing cold, matching the prior behaviour.
  if (returningHandle) {
    speakerTag();
    returningFraming(returningHandle);
  } else {
    firstTimeFraming();
  }

  let init: DeviceInitResponse;
  try {
    init = await deviceInit(api);
  } catch (err) {
    throw new Error(
      `Could not start device authorisation: ${(err as Error).message}`,
    );
  }

  // Surface the user_code prominently - this IS the UX. Both
  // firstTimeFraming() and returningFraming() emit a trailing blank line
  // via body()/framing(), so an extra `\n` here would render as three
  // consecutive blank lines between the framing and the user_code copy.
  indented("To authorise this CLI, visit:");
  indented(`  ${init.verification_uri_complete}`);
  process.stdout.write("\n");
  indented("or open:");
  indented(`  ${init.verification_uri}`);
  indented("and enter the code:");
  process.stdout.write("\n");
  indented(`  ${init.user_code}`);
  process.stdout.write("\n");
  // Render the expiry window in minutes when >= 1 minute, otherwise fall
  // back to seconds so very-short-TTL backends don't read as "0 minutes".
  // Plural-grammar guard: a singular "1 minute" must not surface as
  // "1 minutes".
  const expiresMins = Math.floor(init.expires_in / 60);
  const expiresHint =
    expiresMins >= 1
      ? `${expiresMins} minute${expiresMins === 1 ? "" : "s"}`
      : `${init.expires_in} second${init.expires_in === 1 ? "" : "s"}`;
  indented(`Code expires in ${expiresHint}. Polling for approval…`);
  process.stdout.write("\n");

  // Poll. The pair-github helper races signal abort against the sleep,
  // so q/Esc cancels cleanly. We do the same here.
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.on("SIGINT", onSigint);

  // Progress feedback during the poll. Without it the CLI prints the code
  // once and then goes silent for up to `expires_in` (~10 min) while it
  // polls, which reads as a hang and loses people mid-login.
  //
  // Use the house spinner, never clack's. Clack repaints by writing the
  // erase (`ESC[999D ESC[J`) and the redrawn frame as two separate writes,
  // so the terminal presents a genuinely blank line between them: at a
  // 12Hz frame rate that reads as violent flashing, and it erases to the
  // end of the SCREEN rather than the end of the LINE. The house spinner
  // repaints the single line in one atomic write, so no blank frame is
  // ever shown. It is TTY- and A11Y-guarded internally, so piped and
  // headless output stays clean.
  const showProgress = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  const progress = showProgress
    ? startSpinner(
        `Waiting for you to approve in your browser (up to ${Math.round(
          init.expires_in / 60,
        )} min · press Ctrl+C to cancel)`,
      )
    : null;

  let outcome: DevicePollOutcome;
  try {
    outcome = await pollDeviceUntilDone(api, init, controller.signal);
  } finally {
    process.off("SIGINT", onSigint);
    progress?.stop();
  }

  if (outcome.status === "cancelled") {
    indented("login cancelled.");
    return;
  }
  if (outcome.status === "denied") {
    throw new Error(
      "Device authorisation denied - the approval page rejected this CLI.",
    );
  }
  if (outcome.status === "expired") {
    // Drop the "(no detail)" parenthetical: when the upstream detail is
    // null, surfacing the placeholder reads as a bug - the user already
    // knows expiry happened from the leading sentence.
    const expiredDetail =
      outcome.detail && outcome.detail.trim().length > 0
        ? ` (${outcome.detail})`
        : "";
    throw new Error(
      `Device authorisation expired${expiredDetail}. ` +
        "Re-run 'alter login' to mint a fresh code.",
    );
  }
  if (outcome.status === "error" || !outcome.tokens) {
    // A rate-limit / lockout detail already arrives as a fully-formed
    // `alter login: …` sentence - surface it verbatim rather than burying
    // it behind a second "Device authorisation failed:" prefix.
    if (outcome.detail && outcome.detail.startsWith("alter login:")) {
      throw new Error(outcome.detail);
    }
    // Same posture as the expired branch: an empty / placeholder detail
    // tail ("unknown error") adds no information and reads as a bug.
    const errorDetail =
      outcome.detail && outcome.detail.trim().length > 0
        ? `: ${outcome.detail}`
        : ".";
    throw new Error(`Device authorisation failed${errorDetail}`);
  }

  // Same persistence path as the browser flow - single source of truth
  // for session-write side effects (member-key mint, signing-key
  // registration, fail-fast).
  await storeSession(api, outcome.tokens);

  // The device-code / headless path closes on the welcome box, same as the
  // browser path. No post-login next-step surface is printed; `alter status`
  // carries the next-best-action block for callers that want it.
}

// ---------------------------------------------------------------------------
// Browser-based OAuth 2.1 PKCE flow
// ---------------------------------------------------------------------------

async function loginWithBrowser(
  api: string,
  returningHandle: string | null = null,
): Promise<void> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();
  // OIDC nonce - bound to this login attempt and asserted against the
  // id_token's `nonce` claim after token exchange. Prevents replay of a
  // stolen id_token against a different `alter login` invocation. The
  // server echoes nonce verbatim into the id_token; mismatch is fatal.
  const nonce = generateNonce();

  // Persist gate (the "false-auth" decouple): the browser's "~ authenticated"
  // screen must reflect a CONFIRMED credential persist, not mere receipt of
  // the OAuth code. We resolve this deferred ONLY after storeSession() has
  // written the session through to a secure-store backend; the callback
  // server holds the browser response open until then and renders success or
  // failure to match.
  let settlePersist: (outcome: PersistOutcome) => void = () => {};
  const persistGate = new Promise<PersistOutcome>((resolve) => {
    settlePersist = resolve;
  });
  // Avoid an unhandled-rejection if the gate is never awaited on some path.
  persistGate.catch(() => {});

  // Start local server to receive callback
  const { port, codePromise, server } = await startCallbackServer(
    state,
    persistGate,
  );
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  // Build authorize URL
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  const authorizeUrl = `${api}/api/v1/oauth/authorize?${params.toString()}`;

  // Naming-framing phase rendered as a single bounded panel. First-time
  // users see the Trill doctrine; returning users see the quiet
  // re-auth acknowledgement. Box title carries the ~alter speaker - no
  // separate flush-left tag.
  if (returningHandle) {
    printBoxedPhase({
      title: ALTER_BOX_TITLE,
      body: ["", `renewing your session, ${returningHandle}.`, ""],
    });
  } else {
    printBoxedPhase({
      title: ALTER_BOX_TITLE,
      body: [
        "",
        "To be known anywhere, you first need a name here.",
        "You can use one you already have, or take one that is only yours.",
        "",
        "~ is the Trill. It is the smallest unit of a name that is yours.",
        "",
      ],
    });
  }

  // OAuth-wait phase: open the browser, then print the static URL panel,
  // then animate a transient spinner BELOW the panel. The URL panel
  // closes before the wait so scrollback preserves a copy-pasteable URL
  // without scrollbacks of spinner frames interleaved.
  let opened = false;
  try {
    openBrowser(authorizeUrl);
    opened = true;
  } catch {
    /* fall through to the panel's manual-paste copy */
  }
  // Wrap the authorize URL inside the inner box width minus the extra
  // 2-space inset we apply for paste-hatch URLs (so they read as nested
  // status, not primary instruction). `boxWidth() - 8` = inner - 2.
  const urlInner = Math.max(20, boxWidth() - 8);
  const urlLines = wrapUrl(authorizeUrl, urlInner);
  printBoxedPhase({
    title: ALTER_BOX_TITLE,
    body: [
      "",
      opened ? "Opening your browser." : "Open this URL in your browser:",
      "If it doesn't open, visit:",
      ...urlLines.map((line) => "  " + line),
      "",
    ],
  });
  const callbackUrl = `http://127.0.0.1:${port}/callback`;
  if (alterDebugEnabled()) {
    subIndented(`callback listener: ${callbackUrl}`);
    subIndented(
      `if the terminal hangs ~30s after the browser finishes, open`,
    );
    subIndented(
      `DevTools → Network and look for the ${callbackUrl} request.`,
    );
  }

  // Wait for callback with a hard deadline, periodic heartbeat, and an
  // escape contract. The prior `await codePromise` with no timeout
  // produced the silent-hang-forever failure mode: if CF Access /
  // middleware allowlist / loopback reachability breaks anywhere
  // upstream, the terminal looks frozen and the user can't tell whether
  // to keep waiting or ctrl-C. The spinner reassures during slow
  // browser auth, the timeout surfaces a clear error with actionable
  // diagnostics, and `withKeyListenerCancel` honours q/Esc so the user
  // can back out of a stuck wait without ctrl-C.
  const startedAt = Date.now();
  const spinner = startSpinner("waiting…");
  // Update the spinner's trailing tick text once per second so the user
  // sees elapsed time without scrollback pollution (the spinner line
  // updates in place via \r). The 1s cadence is intentionally faster
  // than the prior 30s heartbeat: with a transient spinner line, tick
  // frequency no longer trades against scrollback noise.
  const heartbeat = setInterval(() => {
    const secs = Math.floor((Date.now() - startedAt) / 1000);
    spinner.setTick(`(${secs}s)`);
  }, 1000);
  heartbeat.unref();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () =>
        reject(
          new Error(
            `Sign-in timed out after ${Math.floor(LOGIN_TIMEOUT_MS / 1000)}s. The browser didn't hand the code back to this terminal.\n\n` +
              `What to try:\n` +
              `  • Re-run \`alter login\` and finish signing in in the browser window that opens.\n` +
              `  • If the browser said you were signed in but the terminal kept waiting, a\n` +
              `    firewall or an HTTPS-upgrade browser extension may be blocking the local\n` +
              `    sign-in callback. Try a different browser, or pause that extension and\n` +
              `    sign in again.\n` +
              `  • Still stuck? Visit truealter.com.` +
              (alterDebugEnabled()
                ? `\n\n[debug] loopback callback never reached this process: ${callbackUrl}`
                : ``),
          ),
        ),
      LOGIN_TIMEOUT_MS,
    );
    timeoutId.unref();
  });
  let code: string;
  try {
    const wait = await withKeyListenerCancel(async (signal) => {
      // Race the OAuth callback, the diagnostic timeout, and a
      // signal-aborted promise so q/Esc collapses the wait without
      // throwing. The signal also closes the loopback HTTP server
      // immediately on cancel so the next `alter login` can re-bind
      // without waiting for the OS socket cleanup grace.
      const onAbort = (): void => {
        server.close();
      };
      const aborted = new Promise<never>((_, reject) => {
        if (signal.aborted) {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          return;
        }
        signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
      signal.addEventListener("abort", onAbort);
      return Promise.race([codePromise, timeout, aborted]);
    });
    if (wait.cancelled) {
      spinner.stop("login cancelled.");
      // No persist will run on the cancel path - release the gate and close
      // the server now (nothing is holding the browser response open).
      settlePersist({
        ok: false,
        message: "Sign-in was cancelled in the terminal. No session was saved.",
      });
      server.close();
      return;
    }
    code = wait.result as string;
    spinner.stop();
  } catch (waitErr) {
    // The wait itself failed (timeout / OAuth error / state mismatch). The
    // browser response, if any, is driven by the callback handler's own
    // error pages - there is no confirmed persist, so release the gate
    // failure-side and close the server before propagating.
    settlePersist({
      ok: false,
      message: "Sign-in did not complete, so no session was saved.",
    });
    server.close();
    throw waitErr;
  } finally {
    clearInterval(heartbeat);
    if (timeoutId) clearTimeout(timeoutId);
    spinner.stop();
  }

  // The welcome punctum in storeSession is the success acknowledgement;
  // a separate "Received authorization code. Exchanging for token..." line
  // here just adds noise between the OAuth wait and the welcome.

  // Everything from here to storeSession() either persists a session or
  // fails. The browser callback response is held open on the persist gate,
  // so we MUST settle that gate (success or failure) and close the server in
  // every exit path - otherwise the browser hangs and never learns the real
  // outcome.
  try {
  // Exchange code for tokens. Retry on 502/503/504 + transport errors -
  // the server resets the auth-code's used flag when the OAuth handler fails
  // post-validation, so the auth-code is safe to retry on infra-class
  // failures. Validation failures still return 400 and are surfaced verbatim.
  const tokenResponse = await fetchWithRetry(`${api}/api/v1/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      client_id: CLIENT_ID,
    }).toString(),
  });

  if (!tokenResponse.ok) {
    const err = stripAnsi(await tokenResponse.text());
    const rateLimited = formatRateLimitMessage(tokenResponse, err);
    if (rateLimited) throw new Error(rateLimited);
    throw new Error(apiErrorMessage("complete sign-in", tokenResponse.status, err));
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token: string;
    token_type: string;
    expires_in: number;
    refresh_expires_in?: number;
    id_token?: string;
    refresh_token?: string;
    scope?: string;
  };

  // OIDC nonce verification - refuse the session if the server-issued
  // id_token doesn't echo the nonce we generated for this login attempt.
  // Mirrors the existing `state` round-trip pattern (CSRF guard), but for
  // id_token replay. When `id_token` is absent (older backends, scope
  // misconfig), we cannot verify and must abort fail-closed rather than
  // silently accept any token. Same posture as the member-key fail-fast
  // policy: a partial login that bypasses verification is worse than no
  // login.
  if (!tokenData.id_token) {
    throw new Error(
      "Sign-in couldn't be verified, so no session was saved. " +
        "Run `alter login` again; if it keeps happening, visit truealter.com.",
    );
  }
  const idPayload = decodeJwtPayload(tokenData.id_token) as
    | Record<string, unknown>
    | null;
  if (!idPayload) {
    throw new Error(
      "id_token payload could not be decoded - refusing the session.",
    );
  }
  const receivedNonce = idPayload.nonce;
  if (typeof receivedNonce !== "string" || receivedNonce !== nonce) {
    throw new Error(
      "OIDC nonce mismatch: id_token did not echo the nonce sent with " +
        "the authorize request. Possible token replay or interception. " +
        "No session was written. Re-run 'alter login' from a clean shell.",
    );
  }

  await storeSession(api, tokenData);
  // storeSession() returned without throwing → the session persisted through
  // a secure-store backend (DPAPI, with encrypted-file fallback on a DPAPI
  // write failure). Only now does the browser get "~ authenticated".
  settlePersist({ ok: true });
  } catch (persistErr) {
    // Token exchange, verification, member-key mint, OR the session persist
    // failed. The credential is NOT saved - tell the browser the truth
    // rather than leaving a "~ authenticated" screen that lies.
    settlePersist({
      ok: false,
      message:
        "Sign-in could not be completed on this device, so no session was " +
        "saved. Return to your terminal for details and run `alter login` again.",
    });
    throw persistErr;
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------------------
// Token paste mode (like gh auth login --with-token)
// ---------------------------------------------------------------------------

async function loginWithToken(args: string[]): Promise<void> {
  const tokenIndex = args.indexOf("--token");
  // SECURITY: refuse a positional token value (`--token <jwt>`). Argv is
  // visible to every other process on the machine via /proc/<pid>/cmdline
  // and frequently leaks into shell history, so we always force the
  // interactive password prompt instead. The next-arg check still has to
  // tolerate a legitimate following flag (e.g. `--token --api ...`).
  const next = args[tokenIndex + 1];
  if (next && !next.startsWith("-")) {
    console.error(
      "alter login --token: refusing to read the JWT from argv.\n" +
        "Tokens passed positionally are exposed to /proc/<pid>/cmdline and\n" +
        "tend to land in shell history. Re-run as `alter login --token` and\n" +
        "paste the value at the masked prompt.",
    );
    process.exitCode = 1;
    return;
  }

  // Use clack so esc/ctrl-c cancel cleanly instead of stranding the
  // user in a raw-readline orphan that only ctrl-c can escape.
  const result = await clackPassword({
    message: "Paste your Alter JWT",
    mask: "•",
  });
  if (isCancel(result)) {
    throw new Error("Token entry cancelled.");
  }
  const jwt = String(result).trim();

  if (!jwt || jwt.split(".").length !== 3) {
    throw new Error("Invalid JWT format. Must be a three-part token.");
  }

  const api = args.includes("--api")
    ? validateApiOverride(args[args.indexOf("--api") + 1])
    : DEFAULT_API;

  // Read exp from the JWT itself
  const claims = extractAlterClaims(jwt);
  const expiresIn = claims.exp
    ? Math.max(0, claims.exp - Math.floor(Date.now() / 1000))
    : 3600;

  await storeSession(api, { access_token: jwt, expires_in: expiresIn });
}

// ---------------------------------------------------------------------------
// Session storage
// ---------------------------------------------------------------------------

export async function storeSession(
  api: string,
  tokenData: {
    access_token: string;
    expires_in: number;
    /**
     * Server-emitted refresh-token TTL (seconds). When present, it is
     * the source of truth for `refresh_expires_at` and overrides the
     * legacy 24h CLI-side fallback. Optional for backwards
     * compatibility with the launch-era OIDC server, which did not
     * carry the field.
     */
    refresh_expires_in?: number;
    id_token?: string;
    refresh_token?: string;
    /** Space-delimited OAuth scopes returned by the token endpoint. */
    scope?: string;
  },
  options?: {
    fetchImpl?: typeof fetch;
    /**
     * Seam for tests: stubs the authoritative org-membership fetch
     * (`GET /api/v1/orgs/memberships`) used to populate session.orgs at
     * login, mirroring the fetchImpl seam. Replaces the retired DNS
     * discovery seam (the email domain never seeds an org membership).
     */
    fetchMembershipsImpl?: typeof fetchMemberships;
  },
): Promise<void> {
  // Seam for tests -- inject a fetch mock to exercise the fatal-by-default
  // paths for member-key mint and signing-key registration without going
  // near the real network.
  const fetchImpl = options?.fetchImpl ?? fetch;

  const jwt = tokenData.access_token;
  const claims = extractAlterClaims(jwt);
  const payload = decodeJwtPayload(jwt) as Record<string, unknown> | null;

  const expiresAt = new Date(
    Date.now() + tokenData.expires_in * 1000
  ).toISOString();

  // Extract identity from ID token if available, else from access token
  const idClaims = tokenData.id_token
    ? extractAlterClaims(tokenData.id_token)
    : claims;

  // Determine handle - prefer the backend-bound ~handle when present
  // (OIDC claim from the handles table reverse lookup). When that claim
  // is absent (older backends, temporarily broken binding lookup), fall
  // back to the handle already persisted in ~/.config/alter/session.json
  // rather than synthesising over the top of it. Only if there is NO
  // prior real handle do we synthesise - and even then we mark it with
  // the sub-prefix form so status-time UX can flag it as unbound.
  // The OAuth access token is intentionally minted with email=None server-side
  // (don't leak email in access tokens). The id_token does carry email, so
  // prefer idClaims first; fall back to access-token claims only for older
  // backends that didn't issue an id_token alongside.
  const email = (idClaims.email ?? claims.email ?? payload?.email ?? "") as string;
  const sub = (claims.sub ?? "") as string;
  const prior = readSession();
  const handle = resolveBoundHandle({
    alterHandleClaim: idClaims.alter_handle,
    sub,
    priorHandle: prior?.handle,
    priorUserId: prior?.user_id,
  });

  // Revoke the prior refresh token before overwriting the session.
  // Without this, a re-login (e.g. after JWT expiry) leaves the old refresh
  // token valid for its full lifetime. Best-effort: failure here must not
  // block the new session being written.
  if (prior?.refresh_token) {
    try {
      await fetch(`${api}/api/v1/oauth/revoke`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...(prior.jwt ? { Authorization: `Bearer ${prior.jwt}` } : {}),
        },
        body: new URLSearchParams({
          token: prior.refresh_token,
          token_type_hint: "refresh_token",
        }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Server unreachable or token already expired - proceed with new session
    }
  }

  // Determine consent tier from engagement level
  const tierMap: Record<number, string> = {
    0: "L0",
    1: "L1",
    2: "L2",
    3: "L3",
    4: "L4",
  };
  const consentTier =
    tierMap[idClaims.engagement_level ?? 0] ?? "L1";

  // Build org memberships. Memberships are authoritative server-side
  // couplings read from `GET /api/v1/orgs/memberships`, NEVER inferred from
  // the login email's domain (the email domain is login identity, never
  // membership). An old email-domain DNS bootstrap could let a privacy-alias
  // address fabricate a bogus org and overwrite the real coupling on every
  // re-login, so it was deleted.
  //
  //   1. Same-account re-login seeds `orgs` from the prior session so a
  //      transient fetch failure never blanks a known coupling.
  //   2. The authoritative fetch runs AFTER the member key is minted (it is
  //      the Bearer credential), and replaces the seed when it succeeds.
  //   3. Empty session.orgs[] is the correct default (clause 1c), never an
  //      error.
  //
  // The actual fetch lives below the member-key mint because it needs the
  // minted key.
  const sameAccount = prior !== null && sub !== "" && prior.user_id === sub;
  let orgs: OrgMembership[] = sameAccount ? (prior.orgs ?? []) : [];

  // Mint the Layer-0 member credential. The JWT is still in hand --
  // exchange it for a member-scoped MCP API key so every downstream
  // consumer (mcp-alter, CC hooks, scripts/alter-identity.sh) reads
  // the same own-behalf authentication from session.json. This is the
  // single place that credential is provisioned.
  //
  // Failure here is FATAL by default (the silent-degradation fix).
  // If the mint 5xx's and we write session.json anyway, every
  // subsequent MCP call from this install will 401 and the user will
  // have no breadcrumb pointing back at login. The `--allow-partial`
  // flag (checked via ALTER_LOGIN_ALLOW_PARTIAL) restores the old
  // warn-and-continue behaviour for the rare case a caller knowingly
  // wants a degraded session.
  const allowPartial = process.env.ALTER_LOGIN_ALLOW_PARTIAL === "1";
  let memberApiKey: string | undefined;
  let memberApiKeyPrefix: string | undefined;
  // Pinned wire contract: member_id = delegated_member_id (null for admin keys).
  // NEVER fall back to user_id - that is the User PK, not members.id.
  let memberIdFromMint: string | null | undefined;
  // Desktop half: generate a fresh X25519 keypair in
  // memory, submit the public half (raw 32-byte, hex) alongside the
  // member-key mint, and persist the private half only AFTER the
  // server confirms the row. Strict ordering matches the signing-key
  // block below -- an orphan private PEM with a public the server
  // never recorded would let alter_peer_devices(peer_handle) return a
  // stale public key that no on-device private half can decrypt
  // against, which the C3 attachment-send path would surface as
  // silent decrypt failures.
  const x25519 = generateX25519Keypair();
  try {
    const mintResp = await fetchWithRetry(
      `${api}/api/v1/auth/member-key`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        // Device-label compose: ship both the X25519
        // public half (so peer-attachment encryption resolves to a
        // live key) and the device_label (so singleton-revoke is
        // scoped to this device, not user-wide).
        body: JSON.stringify({
          x25519_public_key: x25519.publicKeyHex,
          device_label: deriveDeviceLabel(),
        }),
      },
      { fetchImpl },
    );
    if (mintResp.ok) {
      const minted = (await mintResp.json()) as {
        member_api_key?: string;
        display_prefix?: string;
        /** Pinned wire contract: member_id = delegated_member_id. null for admin keys. */
        member_id?: string | null;
      };
      memberApiKey = minted.member_api_key;
      memberApiKeyPrefix = minted.display_prefix;
      // member_id is the member's members.id PK. NEVER fall back to user_id.
      if ("member_id" in minted) {
        memberIdFromMint = minted.member_id ?? null;
      }
      // Server recorded the public half; persist the private half to
      // disk now. Wrap in its own try/catch so a local persistence
      // failure (Windows fsync hazard, full disk, permissions) does
      // not surface under the outer "member-key mint errored" envelope
      // - the mint already succeeded, the disk write is a separate
      // failure class and operators need to see that distinction to
      // troubleshoot.
      try {
        writeX25519PrivateKeyPem(x25519.privateKeyPem);
      } catch (writeErr) {
        // NON-FATAL - and it MUST stay non-fatal. The member-key mint above
        // already succeeded, which means the server has REVOKED the previous
        // member key (mint is singleton-per-device: backend
        // auth.py mint_member_key revokes-then-mints in one txn, committed
        // before this CLI ever sees the response). Aborting here would leave
        // the now-revoked OLD key in session.json and discard the NEW one -
        // the exact partial-login that bricked the MCP bridge every night.
        // So we ALWAYS fall through to writeSession() with the fresh key and
        // degrade only the X25519 half to a warning; peer-attachment
        // encryption re-pairs on the next clean login.
        console.error(
          `warning: X25519 private key could not be written (${(writeErr as Error).message}); ` +
            `peer-attachment encryption is unavailable until your next 'alter login'. ` +
            `Your member credential WAS saved and MCP auth will work.`,
        );
      }
    } else if (allowPartial) {
      console.error(
        `warning: member-key mint returned ${mintResp.status}; continuing without member credential (--allow-partial)`,
      );
    } else {
      console.error(
        `Login failed: member-key mint returned ${mintResp.status}. ` +
          `Your JWT is valid, but the server did not issue an MCP member credential, ` +
          `so every subsequent MCP tools/call would 401. No session.json was written. ` +
          `Retry 'alter login', or pass --allow-partial if you knowingly want a degraded session.`,
      );
      process.exitCode = 1;
      return;
    }
  } catch (err) {
    if (allowPartial) {
      console.error(
        `warning: member-key mint failed (${(err as Error).message}); continuing without member credential (--allow-partial)`,
      );
    } else {
      console.error(
        `Login failed: member-key mint errored (${(err as Error).message}). ` +
          `No session.json was written. Retry 'alter login', ` +
          `or pass --allow-partial if you knowingly want a degraded session.`,
      );
      process.exitCode = 1;
      return;
    }
  }

  // Generate an ES256 keypair (or reuse an existing private
  // key) and register the public half so every subsequent MCP
  // `tools/call` can carry an `Mcp-Invocation-Signature` header. The
  // server hard-requires this gate, so any authenticated caller
  // without a signing key is rejected at dispatch.
  //
  // NON-FATAL after a successful mint. This step runs AFTER the member-key
  // mint, which has already revoked the previous key server-side - so an
  // abort here would strand a revoked key in session.json and lose the fresh
  // one (a past bridge-lockout root cause). We therefore
  // always fall through to writeSession() so the new member key is persisted;
  // a signing-registration failure only costs the signed L4/L5 surface until
  // the next 'alter login'. We still defer the private-key disk write until
  // AFTER the server confirms registration, so a failed POST leaves no
  // orphaned private key on disk paired with a kid the server never
  // acknowledged.
  let signingKid: string | undefined;
  let signingKeyFingerprint: string | undefined;
  if (memberApiKey) {
    try {
      let privateKeyPem = readPrivateKeyPem();
      let publicKeyPem: string;
      if (privateKeyPem) {
        // Reuse existing private key; derive public PEM for
        // registration.
        const nodeCrypto = await import("node:crypto");
        const keyObj = nodeCrypto.createPrivateKey({
          key: privateKeyPem,
          format: "pem",
        });
        publicKeyPem = nodeCrypto
          .createPublicKey(keyObj)
          .export({ format: "pem", type: "spki" }) as string;
      } else {
        // Freshly generated keypair -- hold the private PEM in memory
        // only. Disk write is deferred until the server confirms
        // registration.
        const kp = generateSigningKeypair();
        privateKeyPem = kp.privateKeyPem;
        publicKeyPem = kp.publicKeyPem;
      }
      // Durable validator-device attestation (optional, non-fatal on any
      // failure - see lib/device-sign.ts). The digest binds the
      // countersignature to THIS exact key so a captured countersignature
      // can never be re-attached to a different one; the server
      // independently re-derives and checks it
      // (_verify_device_countersignature, landed).
      const newKeySha256 = createHash("sha256")
        .update(publicKeyPem, "utf-8")
        .digest("hex");
      const deviceAttestation = await invokeDeviceSignHelper(newKeySha256);

      const registered = await registerSigningKey({
        api,
        apiKey: memberApiKey,
        publicKeyPem,
        devicePublicKeyPem: deviceAttestation?.devicePublicKeyPem,
        deviceCountersignature: deviceAttestation?.deviceCountersignature,
        fetchImpl,
      });
      // ALWAYS re-pair after registration (not just for freshly minted
      // keys): the server assigns a NEW kid on every registration, so the
      // kid + key + fingerprint must land together as one atomic
      // secure-store record. writeSigningCredential also purges every
      // plaintext signing-key artefact the CLI manages, so no stale
      // on-disk key can survive a fresh login and shadow this pairing
      // (preventing a session split-brain).
      writeSigningCredential(registered.kid, privateKeyPem);
      signingKid = registered.kid;
      signingKeyFingerprint = computePublicKeyFingerprint(privateKeyPem);
    } catch (err) {
      // NON-FATAL - see the member-key block above. The mint already revoked
      // the previous member key server-side, so we MUST persist the new key
      // rather than exit; a transient signing-registration failure must never
      // leave a revoked key on disk and brick the bridge until the next clean
      // login. Read tools authenticate on the member key alone; only signed
      // L4/L5 tools (message_send/grant, alignment_grant) need the kid, and a
      // re-run of 'alter login' re-registers it.
      console.error(
        `warning: signing-key registration failed (${(err as Error).message}); ` +
          `signed L4/L5 tools (message send/grant, alignment grant) will be rejected ` +
          `until you re-run 'alter login'. Your member credential WAS saved; read tools will work.`,
      );
    }
  }

  // Populate org memberships from the authoritative server-side coupling
  // list. The `/orgs/memberships` endpoint authenticates via the session JWT
  // (get_current_user), NOT the member API key, so we pass the JWT here and
  // gate on it: the member key gets a 401 and silently blanks the badge.
  // Best-effort: a fetch failure NEVER blocks login. On failure we keep the
  // seed (a same-account re-login's prior orgs, or []), so a transient outage
  // cannot blank a known coupling. An empty list is a legitimate 200 and
  // correctly leaves the badge org-less.
  if (jwt) {
    try {
      const fetchImplFn = options?.fetchMembershipsImpl ?? fetchMemberships;
      orgs = await fetchImplFn({ api, jwt, fetchImpl });
    } catch (err) {
      // Transport / non-OK response. Fall back to the seed (prior orgs for a
      // same-account re-login, else []). Never fatal.
      if (alterDebugEnabled()) {
        console.error(
          `debug: org-membership fetch failed (${(err as Error).message}); ` +
            `keeping ${orgs.length} seeded membership(s)`,
        );
      }
    }
  }

  const session: AlterSession = {
    handle,
    api,
    jwt,
    id_token: tokenData.id_token,
    refresh_token: tokenData.refresh_token,
    jwt_expires_at: expiresAt,
    // Prefer the server-emitted `refresh_expires_in` (seconds); fall
    // back to the legacy 24h horizon ONLY when the field is absent.
    // DEPRECATION: the 24h fallback exists for backwards compatibility
    // with launch-era backends - once every reachable OIDC deployment
    // emits `refresh_expires_in`, the fallback should be deleted and
    // sessions without the field should be treated as legacy/optimistic.
    refresh_expires_at: tokenData.refresh_token
      ? new Date(
          Date.now() +
            (typeof tokenData.refresh_expires_in === "number" &&
            tokenData.refresh_expires_in > 0
              ? tokenData.refresh_expires_in
              : 24 * 60 * 60) *
              1000,
        ).toISOString()
      : undefined,
    consent_tier: consentTier,
    user_id: (claims.sub ?? "") as string,
    email,
    orgs,
    logged_in_at: new Date().toISOString(),
    member_api_key: memberApiKey,
    member_api_key_display_prefix: memberApiKeyPrefix,
    signing_kid: signingKid,
    signing_key_fingerprint: signingKeyFingerprint,
    granted_scopes: tokenData.scope ?? SCOPES,
    // member_id is set only when the backend returns it from the member-key
    // mint. If absent (older backend), backfillMemberId() will fetch it via
    // alter_whoami on the next doctrine sync. NEVER write user_id here.
    ...(memberIdFromMint !== undefined ? { member_id: memberIdFromMint } : {}),
  };

  writeSession(session);

  // Bounce the alter-runtime daemon so it picks up the freshly-written
  // session from disk.  Without this, a daemon started before login
  // holds a stale in-memory SessionRef and its proactive token refresher
  // never fires against the new session, causing 401 spirals until the
  // unit is manually restarted.  bounceDaemon() is a no-op on non-Linux
  // platforms and when the unit is not installed or not active.
  const bounceResult = bounceDaemon();
  if (alterDebugEnabled()) {
    console.error(`[alter:login] ${bounceResult}`);
  }

  // Welcome phase rendered as the closing bounded panel. Body holds the
  // welcome line, the (conditional) name-claim line, and the granted
  // scopes. Footer-state row carries handle · scope count · transport so
  // the user can see, at a glance, what was just bound and through which
  // channel.
  //
  // Conditional name-claim: "Nobody else gets this name now. Including us."
  // is doctrinally a FIRST-BINDING line, not a re-auth line. When the prior
  // session's handle matches the freshly-minted one, the line is suppressed
  // - re-binding the same handle is not a naming event. First login OR a
  // login that resolves to a different handle (account switch) keeps it.
  //
  // session.handle already carries the leading ~ (set in storeSession's
  // syntheticHandle path and emitted that way by the OIDC alter_handle
  // claim). Templating `~${handle}` produced a double-tilde rendering
  // bug previously; the current path interpolates handle directly.
  const scopes = (tokenData.scope ?? SCOPES).split(" ").filter(Boolean);
  const isFirstTimeHandle = !prior?.handle || prior.handle !== session.handle;
  const welcomeBody: string[] = ["", `${session.handle}. Welcome.`];
  if (isFirstTimeHandle) {
    welcomeBody.push("Nobody else gets this name now. Including us.");
  }
  if (process.argv.includes("--verbose")) {
    welcomeBody.push("", "scopes granted:");
    for (const s of scopes) {
      welcomeBody.push(`  ${s}`);
    }
  }
  welcomeBody.push("");
  printBoxedPhase({
    title: ALTER_BOX_TITLE,
    body: welcomeBody,
    footer: [
      `${session.handle}  ·  ${scopes.length} scope${scopes.length === 1 ? "" : "s"}  ·  browser`,
    ],
  });

  // Diagnostic surfacing is available via `DEBUG=alter:*` for support and
  // CI contexts where the session-facts dump is genuinely useful. The line
  // deliberately omits the email and the member-key prefix: `alterDebugEnabled`
  // also fires on the broadly-set `DEBUG=*`, so credential-adjacent PII must
  // never reach stderr here regardless of how debug was enabled. Handle, tier,
  // org and expiry are sufficient for support diagnostics.
  if (alterDebugEnabled()) {
    console.error(
      `[alter:login] handle=${session.handle} ` +
        `tier=${session.consent_tier} org=${session.orgs[0]?.domain} ` +
        `expires=${session.jwt_expires_at} stored=${ALTER_CONFIG_DIR}/session.json`
    );
  }
}

// ---------------------------------------------------------------------------
// Local callback server
// ---------------------------------------------------------------------------

/**
 * Outcome the login flow reports back to a waiting browser callback so the
 * "~ authenticated" screen reflects ACTUAL credential-persist success, not
 * mere receipt of the OAuth code.
 *
 *   • `{ ok: true }`        → render the success page ("~ authenticated").
 *   • `{ ok: false, ... }`  → render the failure page; the credential did
 *                             NOT persist, so the browser must not claim
 *                             success.
 */
export type PersistOutcome = { ok: true } | { ok: false; message: string };

export function startCallbackServer(
  expectedState: string,
  /**
   * Optional persist gate. When provided, a valid `/callback` resolves
   * `codePromise` immediately (so the terminal proceeds to exchange the code
   * and persist the session) but HOLDS the browser HTTP response open until
   * this promise settles, then renders success or failure from its outcome.
   * This decouples the success screen from code-receipt and binds it to the
   * confirmed credential persist (the DPAPI-strand "false-auth" fix).
   *
   * When omitted, the legacy behaviour is preserved: the success page is
   * rendered immediately on code receipt (used by the unit tests that probe
   * the server's routing in isolation).
   */
  persistGate?: Promise<PersistOutcome>,
): Promise<{
  port: number;
  codePromise: Promise<string>;
  server: http.Server;
}> {
  return new Promise((resolveSetup) => {
    let resolveCode: (code: string) => void;
    let rejectCode: (err: Error) => void;

    const codePromise = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });

    const server = http.createServer((req, res) => {
      // ---------------------------------------------------------------
      // Bridge baseline hardening. Closes the OAuth-loopback Origin gap
      // (a known browser-loopback attack class) and pre-hardens the
      // surface for the browser-onboarding bridge.
      //
      // (1) Origin allowlist. Top-frame OAuth redirects from a browser
      //     address-bar navigation typically OMIT the Origin header - so
      //     undefined/empty is allowed. When Origin IS set, only the
      //     canonical truealter.com host is accepted (plus localhost in
      //     dev). Any other Origin → 403 + Connection: close, no body,
      //     no codePromise side effects.
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

      // (2) DNS-rebinding Host header check. A browser-side rebinding
      //     attack flips a DNS A record from a controlled host to
      //     127.0.0.1 after the cache primes the page; the resulting
      //     fetch carries the attacker's hostname in the Host header
      //     even though the TCP connection lands on the loopback
      //     server. Only the literal loopback hosts at the bound port
      //     are accepted.
      const addr = server.address();
      const boundPort =
        typeof addr === "object" && addr ? addr.port : 0;
      const host = req.headers.host;
      // Literal loopback IP only. `localhost` is rejected because it can
      // be remapped via /etc/hosts or resolve to an IPv6 `::1` the bound
      // socket never answers, and a DNS-rebound `localhost` could carry an
      // attacker hostname in the Host header while the TCP connection still
      // lands here. Matches the bridge server's host validation
      // and the passkey callback. The redirect_uri is minted as
      // http://127.0.0.1:<port>/callback, so the browser always sends
      // `127.0.0.1:<port>` as Host - no legitimate flow uses `localhost`.
      const allowedHosts = new Set<string>([`127.0.0.1:${boundPort}`]);
      if (!host || !allowedHosts.has(host)) {
        res.writeHead(403, { Connection: "close" });
        res.end();
        return;
      }

      const url = new URL(req.url ?? "/", `http://127.0.0.1`);

      // `GET /` and `GET /health`: reachability probe. If a user's browser
      // never reaches /callback but DOES reach / here, the problem is in
      // the OAuth flow upstream (not loopback connectivity). If neither
      // reaches this server, the problem is firewall / HTTPS-upgrade /
      // localhost-resolution. Cheap debuggability, ~5 lines.
      if (url.pathname === "/" || url.pathname === "/health") {
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          Connection: "close",
        });
        res.end(
          "~Alter CLI callback listener - ready.\n" +
            "Your terminal is waiting for the browser to land on /callback.\n",
        );
        return;
      }

      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        const desc = stripAnsi(url.searchParams.get("error_description") ?? error);
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          Connection: "close",
        });
        res.end(errorPage(desc));
        rejectCode(new Error(`OAuth error: ${desc}`));
        return;
      }

      if (state !== expectedState) {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          Connection: "close",
        });
        res.end(errorPage("State mismatch - possible CSRF attack."));
        rejectCode(new Error("State mismatch"));
        return;
      }

      if (!code) {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          Connection: "close",
        });
        res.end(errorPage("No authorization code received."));
        rejectCode(new Error("No code"));
        return;
      }

      // Valid code received. Hand it to the terminal flow FIRST so the
      // token exchange + credential persist can run.
      resolveCode(code);

      if (persistGate === undefined) {
        // Legacy / unit-test path: no persist gate wired - render success on
        // code receipt, as before.
        res.writeHead(200, {
          "Content-Type": "text/html",
          Connection: "close",
        });
        res.end(successPage());
        return;
      }

      // Persist-gated path (the "false-auth" decouple): keep the browser
      // response OPEN until the terminal confirms the credential actually
      // persisted, then render success or failure to match. A DPAPI write
      // failure that strands the session must NOT show "~ authenticated".
      persistGate.then(
        (outcome) => {
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            Connection: "close",
          });
          res.end(outcome.ok ? successPage() : errorPage(outcome.message));
        },
        () => {
          // The gate rejected unexpectedly (the terminal flow threw before
          // signalling an outcome). Fail closed: the browser must not claim
          // success when persistence was not confirmed.
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            Connection: "close",
          });
          res.end(
            errorPage(
              "Sign-in did not complete on this device, so no session was saved. " +
                "Return to your terminal and run `alter login` again.",
            ),
          );
        },
      );
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port =
        typeof addr === "object" && addr ? addr.port : 0;
      resolveSetup({ port, codePromise, server });
    });
  });
}

// ---------------------------------------------------------------------------
// HTML pages for callback
// ---------------------------------------------------------------------------

function successPage(): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>~Alter - Authenticated</title></head>
<body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #0a0a0a; color: #e0e0e0;">
  <div style="text-align: center;">
    <h1 style="font-size: 2rem; margin-bottom: 0.5rem;">~ authenticated</h1>
    <p style="color: #888;">You can close this window and return to your terminal.</p>
  </div>
</body>
</html>`;
}

/**
 * HTML-escape a string so it is safe to interpolate into an HTML element body
 * or a double-quoted attribute. `message` in errorPage() is derived from the
 * OAuth server's `error_description` redirect param - an attacker who can
 * control that response could otherwise inject HTML/script into the localhost
 * callback page rendered in the user's browser.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>~Alter - Error</title></head>
<body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #0a0a0a; color: #e0e0e0;">
  <div style="text-align: center;">
    <h1 style="font-size: 2rem; margin-bottom: 0.5rem; color: #ff4444;">Authentication failed</h1>
    <p style="color: #888;">${escapeHtml(message)}</p>
  </div>
</body>
</html>`;
}
