/**
 * Guided post-login onboarding chain - the flow controller.
 *
 * The full guided chain is dev/dry-run only.
 * Default interactive login hands off to the browser /onboarding flow
 * instead. `runOnboardingChain` is retained for `--dry-run` and for
 * future re-enablement; do not delete it.
 *
 * Runs after a successful interactive browser `alter login` (and is
 * resumable from the `alter` menu) and stitches together the operational
 * provisioning verbs that already exist as standalone commands -
 * passkey · pair-GitHub · wire ·
 * cosmetics - plus honest placeholder rows for future
 * surfaces (Obsidian, device-substrate) and a level-gated line for Identity Income
 * pay-out setup (which 403s below engagement level 3).
 *
 * Design:
 *  - One screen per step, three affordances: `[enter]` do it now ·
 *    `[s]` skip (I'll handle it myself) · `[q]` later (close setup, ask
 *    me again next time).
 *  - No deliberate sleeps (Zero-Friction Doctrine - friction lives in
 *    the meaningful choices, not the plumbing). Every screen interruptible.
 *  - No gamification, no progress %, no completion badge (Recognition
 *    over Qualification). The frame is "set up your instruments".
 *  - Account-level step state is read back from the backend, never
 *    trusted from the client-side progress file. `wire` and `cosmetics`
 *    are per-machine - keyed to a stable local machine id.
 *  - The chain reads/writes the SAME server flags as the web
 *    `auth/success` funnel (`/members/me/onboarding` + `/complete` +
 *    `/skip`), so whichever the member finishes first suppresses the
 *    other.
 *  - All HTTP goes through the auth helper, never raw fetch.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import chalk from "chalk";

import {
  apiCall,
  getSession,
  extractAlterClaims,
  readIdentity,
  readStatusSnapshot,
  ALTER_CONFIG_DIR,
} from "../auth.js";
import {
  loadOrInitProgress,
  writeProgress,
  markCompleted,
  markSkipped,
  markDeferred,
  touchResumed,
  isSecondOrLaterResume,
  markOnboardingSettled,
  type OnboardingProgress,
} from "./progress.js";

// Wrapped commands - invoked on `[enter]`. Each owns its own sub-flow.
import { passkey } from "../commands/passkey.js";
import { pairGithub } from "../commands/pair-github.js";
import { wire } from "../commands/wire.js";
import { prompt } from "../commands/prompt.js";
import { probeCosmetics } from "../lib/cosmetics/detect.js";
import { promptDaemonBootstrap } from "../lib/daemon-bootstrap.js";
import {
  createInputSession,
  type DecodedKey,
  type InputSession,
} from "../ui/rawKeys.js";

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export interface RunOnboardingChainOptions {
  /**
   * True when invoked from the `alter` menu's "Finish setting up ~alter" row
   * rather than from inside `login()`. On a resume, a *skipped* step is
   * re-presented (a *completed* one is not), and the once-only "stop
   * asking me about setup entirely" affordance becomes eligible (it is
   * only ever offered after `[q]` on a second-or-later resume).
   */
  resume?: boolean;
}

/**
 * Run (or resume) the guided onboarding chain.
 *
 * Returns immediately - doing nothing - when:
 *  - there is no live session;
 *  - stdin is not a TTY (CI, `docker exec`, agent containers);
 *  - the backend reports onboarding already done or skipped
 *    (`onboarded_at` / `onboarding_skipped_at` non-null);
 *  - the caller is an org user (the onboarding endpoint 403s - "not
 *    applicable").
 *
 * Never throws - a network blip in the satisfied-checks degrades to
 * "show the step" rather than crashing the login flow.
 */
export async function runOnboardingChain(
  opts: RunOnboardingChainOptions = {},
): Promise<void> {
  const resume = opts.resume === true;

  if (!process.stdin.isTTY) return;
  const session = getSession();
  if (!session) return;

  // --- Backend gate: is onboarding already done / skipped / N/A? --------
  const state = await fetchOnboardingState();
  if (state === "not-applicable") return; // org user - 403
  if (state && (state.onboarded_at || state.onboarding_skipped_at)) {
    // Self-heal the local "settled" marker so the menu hides the resume
    // rows even on a returning member who completed onboarding elsewhere
    // (the web auth/success funnel, or another machine).
    markOnboardingSettled();
    return;
  }

  // --- Snapshot the account-level satisfied-checks once at chain start --
  const ctx = await buildStepContext(session.handle);

  let progress = loadOrInitProgress();
  progress = touchResumed(progress);

  // --- Build the step list (principal-only pair-org-alter conditional) --
  const steps = buildSteps(ctx);

  // --- Run the steps in fixed order ------------------------------------
  let deferredOut = false;
  for (const step of steps) {
    const outcome = await runStep(step, ctx, progress, resume);
    progress = outcome.progress;
    writeProgress(progress);
    if (outcome.action === "defer") {
      deferredOut = true;
      break;
    }
  }

  // --- Completion / stop-asking ----------------------------------------
  if (deferredOut) {
    // `[q]` - record nothing new beyond `last_resumed_at`; the menu's
    // "Finish setting up ~alter" row stays live. Optionally offer the once-only
    // "stop asking me about setup entirely" affordance.
    if (resume && isSecondOrLaterResume(progress)) {
      const stop = await offerStopAsking();
      if (stop) {
        await postOnboardingSkip();
        markOnboardingSettled();
      }
    }
    return;
  }

  // Every step was done-or-skipped-or-deferred-stub → idempotent complete.
  await postOnboardingComplete();
  markOnboardingSettled();
}

// ---------------------------------------------------------------------------
// Backend reads
// ---------------------------------------------------------------------------

interface OnboardingStateResponse {
  onboarded_at: string | null;
  onboarding_skipped_at: string | null;
  should_show_funnel?: boolean;
}

/**
 * `GET /api/v1/members/me/onboarding`. Returns the parsed state, the
 * sentinel `"not-applicable"` on a 403 (org user), or `null` on any
 * other failure - in which case the chain proceeds (fail-open: a flaky
 * read should not strand a fresh login without setup).
 */
export async function fetchOnboardingState(): Promise<
  OnboardingStateResponse | "not-applicable" | null
> {
  try {
    const resp = await apiCall("/api/v1/members/me/onboarding");
    if (!resp) return null;
    if (resp.status === 403 || resp.status === 404) return "not-applicable";
    if (!resp.ok) return null;
    const body = (await resp.json()) as Partial<OnboardingStateResponse>;
    return {
      onboarded_at:
        typeof body.onboarded_at === "string" ? body.onboarded_at : null,
      onboarding_skipped_at:
        typeof body.onboarding_skipped_at === "string"
          ? body.onboarding_skipped_at
          : null,
      should_show_funnel:
        typeof body.should_show_funnel === "boolean"
          ? body.should_show_funnel
          : undefined,
    };
  } catch {
    return null;
  }
}

async function postOnboardingComplete(): Promise<void> {
  try {
    await apiCall("/api/v1/members/me/onboarding/complete", { method: "POST" });
  } catch {
    // Idempotent server-side; a transient failure just means the next
    // run re-asks - harmless.
  }
}

async function postOnboardingSkip(): Promise<void> {
  try {
    await apiCall("/api/v1/members/me/onboarding/skip", { method: "POST" });
  } catch {
    // Same idempotency note as complete().
  }
}

// ---------------------------------------------------------------------------
// Step context - the account-level satisfied-checks, snapshotted once
// ---------------------------------------------------------------------------

interface StepContext {
  handle: string;
  /** WebAuthn credential count on the account, or null if unreadable. */
  passkeyCount: number | null;
  /** Is GitHub already an active connection? null if unreadable. */
  githubConnected: boolean | null;
  /** Is the GitHub connector currently available to this caller? */
  githubConnectorAvailable: boolean | null;
  /** Is a pay-out method (crypto rail or bank rail) already registered? */
  payoutRegistered: boolean | null;
  /** Engagement level (0-4); defaults to 1 when unknowable. */
  engagementLevel: number;
  /** Has cosmetics been opted out (cosmetics.skip sentinel)? */
  cosmeticsOptedOut: boolean;
  /** Are cosmetics already inscribed on this machine? */
  cosmeticsAlreadyInscribed: boolean;
  /** Is the principal org-alter pairing already done (state.json present)? */
  orgAlterPaired: boolean;
}

async function buildStepContext(handle: string): Promise<StepContext> {
  const [passkeyCount, conn, payoutRegistered] = await Promise.all([
    fetchPasskeyCount(),
    fetchGithubConnection(),
    fetchPayoutRegistered(),
  ]);

  const session = getSession();
  // NOTE: inline mirror of the engagement-level resolver, kept to avoid an
  // import cycle.
  // Precedence: JWT claim → identity.json → status snapshot → Explorer (1).
  // If you change the resolution order in either copy, mirror it in the other.
  let engagementLevel = 1;
  if (session) {
    const claims = extractAlterClaims(session.jwt);
    if (typeof claims.engagement_level === "number") {
      engagementLevel = claims.engagement_level;
    } else {
      const id = readIdentity();
      if (id && typeof id.engagement_level === "number") {
        engagementLevel = id.engagement_level;
      } else {
        const snap = readStatusSnapshot();
        if (snap && typeof snap.engagement_level === "number") {
          engagementLevel = snap.engagement_level;
        }
      }
    }
  }

  const cosmeticsOptedOut = fs.existsSync(
    path.join(ALTER_CONFIG_DIR, "cosmetics.skip"),
  );
  // `probeCosmetics()` lists *detectable surfaces* on this machine, not
  // surfaces that already carry an ALTER block - we can't cheaply tell
  // "already inscribed" from it without re-reading every file. The
  // conservative choice: when there is no detectable surface at all,
  // there is nothing to inscribe, so treat the cosmetics step as
  // satisfied; otherwise leave it to the cosmetics.skip sentinel or an
  // explicit run/skip. (Per-machine; harmless to re-offer either way.)
  let cosmeticsNothingToDo = false;
  try {
    cosmeticsNothingToDo = probeCosmetics().length === 0;
  } catch {
    cosmeticsNothingToDo = false;
  }
  const cosmeticsAlreadyInscribed = cosmeticsNothingToDo;

  return {
    handle,
    passkeyCount,
    githubConnected: conn.connected,
    githubConnectorAvailable: conn.available,
    payoutRegistered,
    engagementLevel,
    cosmeticsOptedOut,
    cosmeticsAlreadyInscribed,
    // orgAlterPaired: principal-only step not in the public build.
    orgAlterPaired: false,
  };
}


async function fetchPasskeyCount(): Promise<number | null> {
  try {
    const resp = await apiCall("/api/v1/auth/mfa/status");
    if (!resp || !resp.ok) return null;
    const body = (await resp.json()) as {
      webauthn_credentials?: unknown[];
    };
    return Array.isArray(body.webauthn_credentials)
      ? body.webauthn_credentials.length
      : null;
  } catch {
    return null;
  }
}

async function fetchGithubConnection(): Promise<{
  connected: boolean | null;
  available: boolean | null;
}> {
  let connected: boolean | null = null;
  let available: boolean | null = null;
  try {
    const resp = await apiCall("/api/v1/me/connections");
    if (resp && resp.ok) {
      const body = (await resp.json()) as Array<{ platform?: string }>;
      connected = Array.isArray(body)
        ? body.some((c) => c.platform === "github")
        : null;
    }
  } catch {
    connected = null;
  }
  try {
    const resp = await apiCall("/api/v1/connectors");
    if (resp && resp.ok) {
      const body = (await resp.json()) as {
        connectors?: Array<{ id?: string; available?: boolean }>;
      };
      const gh = body.connectors?.find((c) => c.id === "github");
      available = gh ? Boolean(gh.available) : false;
    }
  } catch {
    available = null;
  }
  return { connected, available };
}

async function fetchPayoutRegistered(): Promise<boolean | null> {
  // The pay-out reads 403 below engagement level 3 - that is not "no
  // pay-out method", it is "can't tell yet", so treat it as null.
  try {
    const [wallet, payout] = await Promise.all([
      apiCall("/api/v1/members/me/wallet"),
      apiCall("/api/v1/members/me/payout-account"),
    ]);
    let cryptoActive: boolean | null = null;
    if (wallet) {
      if (wallet.status === 403) cryptoActive = null;
      else if (wallet.ok) {
        const body = (await wallet.json()) as { status?: string };
        cryptoActive = Boolean(body.status && body.status !== "not_registered");
      }
    }
    let fiatActive: boolean | null = null;
    if (payout) {
      if (payout.status === 403 || payout.status === 404) fiatActive = false;
      else if (payout.ok) {
        const body = (await payout.json()) as { has_account?: boolean };
        fiatActive = Boolean(body.has_account);
      }
    }
    if (cryptoActive === null && fiatActive === null) return null;
    return Boolean(cryptoActive) || Boolean(fiatActive);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The step list
// ---------------------------------------------------------------------------

/**
 * Per-step shape. `kind` drives how `runStep` handles it:
 *  - `"run"`     - full three-affordance screen; `[enter]` invokes `run`.
 *  - `"stub"`    - locked greyed row; the user `enter`s past it; recorded
 *                  as `${id}:${stubReason}` in `steps_deferred`.
 *  - `"gated"`   - an honest single line (no `[enter]` action); recorded
 *                  as `${id}:${stubReason}`.
 */
interface OnboardingStep {
  id: string;
  kind: "run" | "stub" | "gated";
  /** Heading rendered on the screen for `run` steps; row text for stub/gated. */
  title: string;
  /** Body lines under the heading. */
  body: string[];
  /** True when the account-level satisfied-check says skip-silently. */
  alreadySatisfied: boolean;
  /** Stub / gate sub-reason (for `stub` / `gated` kinds). */
  stubReason?: string;
  /** Action invoked on `[enter]` for `run` steps. */
  run?: (ctx: StepContext) => Promise<void>;
}

function buildSteps(ctx: StepContext): OnboardingStep[] {
  const steps: OnboardingStep[] = [];

  // 1 - passkey (RUN). 0 creds → add one; exactly 1 → add a backup;
  //     ≥2 → satisfied, skip silently.
  {
    const n = ctx.passkeyCount;
    const satisfied = n !== null && n >= 2;
    const body =
      n !== null && n === 1
        ? [
            "you already hold one passkey. one passkey is one device -",
            "add a second so a lost laptop is not a lost identity.",
          ]
        : [
            "a passkey is the lock only you hold - no password to leak,",
            "nothing a server can hand over. add one now, or any time",
            "from  alter  ›  Account  ›  Passkeys.",
          ];
    steps.push({
      id: "passkey",
      kind: "run",
      title: "your passkey",
      body,
      alreadySatisfied: satisfied,
      run: async () => {
        await passkey(["add"]);
      },
    });
  }

  // 2 - pair-org-alter (PRINCIPAL-ONLY) - absent in the public build.

  // 3 - pair-GitHub (RUN / EXPLICIT OPTIONAL BRANCH). Connector-less is
  //     the DEFAULT case, not a fallback. Copy reads warmly skippable for
  //     someone with nothing to pair.
  {
    const satisfied = ctx.githubConnected === true;
    steps.push({
      id: "pair-github",
      kind: "run",
      title: "connect GitHub (optional)",
      body: [
        "no GitHub, nothing to pair? ~alter still works without one.",
        "if you want your public work to feed your identity, you can",
        "connect it here. or skip it now and pair any time from  Sources.",
      ],
      alreadySatisfied: satisfied,
      run: async () => {
        await pairGithub();
      },
    });
  }

  // 4 - pair-Obsidian (stub, not yet available).
  steps.push({
    id: "pair-obsidian",
    kind: "stub",
    title: "Obsidian vault - not yet available",
    body: [
      "pairing a local vault as an identity stream is not yet available,",
      "behind the local-signal forwarder and the vault-stream feature gate.",
    ],
    alreadySatisfied: false,
    stubReason: "not_yet_available",
  });

  // 5 - device-substrate as an identity source (STUB - no date).
  steps.push({
    id: "device-source",
    kind: "stub",
    title: "your devices as a source - coming, no date yet",
    body: [
      "letting the device substrate itself feed your identity needs the",
      "static-binary distribution and the adapter foundation first.",
    ],
    alreadySatisfied: false,
    stubReason: "future",
  });

  // 6 - Identity Income pay-out (LEVEL-GATED below L3). Tether-strict:
  //     never the word "wallet" in displayed copy.
  if (ctx.engagementLevel >= 3) {
    // A later version will run the pay-out picker here:
    //   await wallet(["register"]);
    // For now treat a ≥L3 member's pay-out step the same
    // as a normal RUN step would be - but the picker hand-off is later,
    // so we render the same honest line and record it as deferred. (A
    // ≥L3 member with no pay-out method on file is rare at launch.)
    // TODO: replace this branch with the wallet(["register"])
    // hand-off.
    const satisfied = ctx.payoutRegistered === true;
    steps.push({
      id: "payout",
      kind: "gated",
      title: satisfied
        ? "your pay-out method is set - nothing to do here"
        : "set up where your earnings land",
      body: satisfied
        ? ["a pay-out method is already on file. your Identity Income", "lands there."]
        : [
            "Identity Income lands wherever you point it. setting the",
            "destination from the guided walkthrough is coming - for now,",
            "open  alter  ›  Earn  ›  Pay-out method  when you're ready.",
          ],
      alreadySatisfied: satisfied,
      stubReason: "level_gated",
    });
  } else {
    steps.push({
      id: "payout",
      kind: "gated",
      title: "earnings setup opens at Augmented (Level 3)",
      body: [
        "nothing to do here yet - keep going and it'll be waiting.",
        "Identity Income still accrues; you set the destination once you",
        "reach Augmented.",
      ],
      alreadySatisfied: false,
      stubReason: "level_gated",
    });
  }

  // 7 - wire (RUN - the 4 real targets). Per-machine.
  steps.push({
    id: "wire",
    kind: "run",
    title: "install ~Alter into your tools",
    body: [
      "~Alter becomes an MCP server your agents can talk to. pick which of",
      "Claude Code, Cursor, Claude Desktop and VS Code to install it into.",
    ],
    // Per-machine - never trusted from the progress file; the orchestrator
    // checks the per-machine completion flag in runStep.
    alreadySatisfied: false,
    run: async () => {
      await wire([]);
    },
  });

  // 7b - daemon bootstrap (RUN). Nudges install/start of alter-runtime so
  //      the per-`~handle` SSE substrate has a local subscriber. The
  //      promptDaemonBootstrap call self-guards on isTTY and silently
  //      no-ops when the daemon is already running, so re-runs of
  //      `alter login` only surface a screen when there's something to
  //      do. Idempotency: marked completed after first invocation
  //      (matches pair-* pattern); if the daemon later disappears the
  //      user can re-install from the printed one-liner.
  steps.push({
    id: "daemon",
    kind: "run",
    title: "start the local field subscriber",
    body: [
      "the alter-runtime daemon subscribes to your identity field locally",
      "so peers can see your sessions and `alter coord status` stays honest.",
      "I'll check whether it's installed and running.",
    ],
    alreadySatisfied: false,
    run: async () => {
      await promptDaemonBootstrap();
    },
  });

  // 8 - cosmetics (RUN - via Customise surface + Starship snippet). Per-machine.
  {
    const satisfied = ctx.cosmeticsOptedOut || ctx.cosmeticsAlreadyInscribed;
    steps.push({
      id: "cosmetics",
      kind: "run",
      title: "make alter yours",
      body: [
        "your prompt, your colours, your sigil. ~alter ships the substrate;",
        "the tweak is the authorship. I'll print the starship binding for",
        "your prompt - tune palette, sigil and opener from  alter  ›  Customise.",
      ],
      alreadySatisfied: satisfied,
      run: async () => {
        // `prompt(["install"])` prints the Starship snippet (with the
        // paste-or-rerun-with-`--append` instruction on stderr) - it
        // does NOT process.exit on a pre-existing block the way the
        // `--append` path does, so it's safe to re-run inside the chain.
        // The arrow-key pickers (palette · sigil · opener) live in the
        // existing "Customise" menu surface; we point at them rather
        // than duplicating a picker here.
        await prompt(["install"]);
        process.stdout.write(
          "\n  " +
            dim(
              "tune palette · sigil · opener from  alter  ›  Customise  whenever you like.",
            ) +
            "\n",
        );
      },
    });
  }

  return steps;
}

// ---------------------------------------------------------------------------
// Per-step runner
// ---------------------------------------------------------------------------

type StepAction = "completed" | "skipped" | "stub" | "defer";

interface StepOutcome {
  action: StepAction;
  progress: OnboardingProgress;
}

/** Per-machine steps whose completion is keyed to the machine id. */
const PER_MACHINE_STEPS = new Set(["wire", "cosmetics"]);

function stepAlreadyDone(
  step: OnboardingStep,
  progress: OnboardingProgress,
  resume: boolean,
): boolean {
  // Account-level satisfied-check from the backend snapshot.
  if (step.alreadySatisfied) return true;

  // Per-machine completion: keyed `${id}@${machine_id}`.
  if (PER_MACHINE_STEPS.has(step.id)) {
    const key = `${step.id}@${progress.machine_id}`;
    if (progress.steps_completed.includes(key)) return true;
    // A per-machine *skip* is honoured within a session; on a resume
    // run a skipped (not completed) step is re-presented.
    if (!resume && progress.steps_skipped.includes(key)) return true;
    return false;
  }

  // Account-level steps that the backend can't read back (none today -
  // passkey/github/payout/org-alter all have a satisfied-check) fall
  // through to the progress file: completed → done; skipped → done
  // within a session, re-presented on resume.
  if (progress.steps_completed.includes(step.id)) return true;
  if (!resume && progress.steps_skipped.includes(step.id)) return true;
  return false;
}

async function runStep(
  step: OnboardingStep,
  ctx: StepContext,
  progress: OnboardingProgress,
  resume: boolean,
): Promise<StepOutcome> {
  // Stub rows: the user `enter`s past them; recorded distinctly so a
  // future build can promote them without re-presenting as "skipped".
  if (step.kind === "stub") {
    const key = `${step.id}:${step.stubReason ?? "stub"}`;
    if (progress.steps_deferred.includes(key)) {
      return { action: "stub", progress };
    }
    renderStubScreen(step);
    const choice = await awaitStubAck();
    if (choice === "quit") {
      return { action: "defer", progress };
    }
    return { action: "stub", progress: markDeferred(progress, step.id, step.stubReason ?? "stub") };
  }

  // Gated lines: an honest single screen, no `[enter]` action.
  if (step.kind === "gated") {
    const key = `${step.id}:${step.stubReason ?? "gated"}`;
    if (progress.steps_deferred.includes(key) || step.alreadySatisfied) {
      // Already recorded (or satisfied) - still show the satisfied
      // affirmation once is fine, but don't loop. Record and move on.
      return { action: "stub", progress: markDeferred(progress, step.id, step.stubReason ?? "gated") };
    }
    renderGatedScreen(step);
    const choice = await awaitStubAck();
    if (choice === "quit") {
      return { action: "defer", progress };
    }
    return { action: "stub", progress: markDeferred(progress, step.id, step.stubReason ?? "gated") };
  }

  // RUN steps.
  if (stepAlreadyDone(step, progress, resume)) {
    // Satisfied silently - record as completed so the next run skips it
    // without re-presenting, and don't draw a screen.
    const id = PER_MACHINE_STEPS.has(step.id)
      ? `${step.id}@${progress.machine_id}`
      : step.id;
    return { action: "completed", progress: markCompleted(progress, id) };
  }

  renderRunScreen(step);
  const choice = await awaitStepChoice();

  const recordId = PER_MACHINE_STEPS.has(step.id)
    ? `${step.id}@${progress.machine_id}`
    : step.id;

  if (choice === "quit") {
    return { action: "defer", progress };
  }
  if (choice === "skip") {
    return { action: "skipped", progress: markSkipped(progress, recordId) };
  }
  // `[enter]` - invoke the wrapped command. It owns its own sub-flow;
  // a failure inside it is surfaced but does not abort the chain (the
  // step is left un-completed so the next run re-offers it).
  try {
    await step.run?.(ctx);
    return { action: "completed", progress: markCompleted(progress, recordId) };
  } catch (err) {
    process.stdout.write(
      "\n  " +
        chalk.yellow("·") +
        "  " +
        (err instanceof Error ? err.message : String(err)) +
        "\n  " +
        dim("you can come back to this from  alter  ›  Finish setting up ~alter.") +
        "\n",
    );
    // Not completed, not skipped - re-offered next run.
    return { action: "skipped", progress };
  }
}

// ---------------------------------------------------------------------------
// "Stop asking me about setup entirely" - once-only, after `[q]`, on a
// second-or-later resume.
// ---------------------------------------------------------------------------

async function offerStopAsking(): Promise<boolean> {
  process.stdout.write("\n");
  process.stdout.write("  " + accent("~alter") + "\n\n");
  process.stdout.write(
    "  " +
      "want me to stop asking about setup entirely? you can still run any\n" +
      "  step by hand later; this just retires the guided walkthrough.\n\n",
  );
  process.stdout.write(
    "  " +
      dim("[y]") +
      " stop asking   " +
      dim("·") +
      "   " +
      dim("[anything else]") +
      " keep the walkthrough\n",
  );
  const key = await awaitSingleKey();
  process.stdout.write("\n");
  return key === "y" || key === "Y";
}

// ---------------------------------------------------------------------------
// Screen rendering - mirrors the intimate lowercase register of
// onboarding/render.ts and onboarding/beats.ts. One muted accent colour,
// speaker tag once per screen, no emoji, no celebratory ticks.
// ---------------------------------------------------------------------------

const NO_COLOR = !!process.env.NO_COLOR;
const DUMB_TERM = process.env.TERM === "dumb";

function accent(text: string): string {
  if (NO_COLOR || DUMB_TERM) return text;
  return chalk.cyan(text);
}

function dim(text: string): string {
  if (NO_COLOR || DUMB_TERM) return text;
  return chalk.dim(text);
}

function speakerTag(): void {
  process.stdout.write(accent("~alter") + "\n\n");
}

function writeBody(lines: string[]): void {
  for (const line of lines) {
    process.stdout.write("  " + line + "\n");
  }
  process.stdout.write("\n");
}

function affordanceLine(): void {
  process.stdout.write(
    "  " +
      dim("[enter]") +
      "  do it now      " +
      dim("[s]") +
      "  skip - I'll handle this myself      " +
      dim("[q]") +
      "  later\n",
  );
}

function ackLine(): void {
  process.stdout.write(
    "  " + dim("[enter]") + "  ok      " + dim("[q]") + "  later\n",
  );
}

function renderRunScreen(step: OnboardingStep): void {
  process.stdout.write("\n");
  speakerTag();
  process.stdout.write("  " + chalk.bold(step.title) + "\n\n");
  writeBody(step.body);
  affordanceLine();
}

function renderStubScreen(step: OnboardingStep): void {
  process.stdout.write("\n");
  speakerTag();
  process.stdout.write("  " + dim(step.title) + "\n\n");
  writeBody(step.body.map((l) => dim(l)));
  ackLine();
}

function renderGatedScreen(step: OnboardingStep): void {
  process.stdout.write("\n");
  speakerTag();
  process.stdout.write("  " + chalk.bold(step.title) + "\n\n");
  writeBody(step.body);
  ackLine();
}

// ---------------------------------------------------------------------------
// Key-wait helpers - raw stdin, no deliberate sleeps, fully interruptible.
// Mirrors the pattern in onboarding/render.ts:awaitContinueOrExit.
// ---------------------------------------------------------------------------

type StepChoice = "enter" | "skip" | "quit";

/**
 * Wait for one of `[enter]` / `[s]` / `[q]`. Ctrl-C / Ctrl-D / Esc map
 * to `quit` (same as `[q]` - "later"). Any other key is ignored.
 */
function awaitStepChoice(): Promise<StepChoice> {
  return new Promise((resolve) => {
    let session: InputSession | null = null;

    const finish = (choice: StepChoice) => {
      session?.dispose();
      process.stdout.write("\n");
      resolve(choice);
    };

    const onKey = (key: DecodedKey) => {
      // ctrl-c, ctrl-d, escape -> quit ("later").
      if (
        (key.ctrl && (key.name === "c" || key.name === "d")) ||
        key.name === "escape"
      ) {
        finish("quit");
        return;
      }
      if (key.name === "return") {
        finish("enter");
        return;
      }
      if (key.name === "s") {
        finish("skip");
        return;
      }
      if (key.name === "q") {
        finish("quit");
        return;
      }
      // Any other key - ignored. Silence is part of the voice.
    };

    session = createInputSession(process.stdin, onKey);
  });
}

/**
 * Wait for `[enter]` (→ `"ack"`) or `[q]` / ctrl-c / esc (→ `"quit"`).
 * Used for stub / gated rows: the user `enter`s past them, or `[q]`s
 * out of the chain.
 */
function awaitStubAck(): Promise<"ack" | "quit"> {
  return new Promise((resolve) => {
    let session: InputSession | null = null;

    const finish = (choice: "ack" | "quit") => {
      session?.dispose();
      process.stdout.write("\n");
      resolve(choice);
    };

    const onKey = (key: DecodedKey) => {
      if (
        (key.ctrl && (key.name === "c" || key.name === "d")) ||
        key.name === "escape"
      ) {
        finish("quit");
        return;
      }
      if (key.name === "q") {
        finish("quit");
        return;
      }
      if (key.name === "return") {
        finish("ack");
        return;
      }
    };

    session = createInputSession(process.stdin, onKey);
  });
}

/** Wait for a single character keypress; returns the character. */
function awaitSingleKey(): Promise<string> {
  return new Promise((resolve) => {
    let session: InputSession | null = null;

    const onKey = (key: DecodedKey) => {
      session?.dispose();
      // `sequence` is the raw character, so the caller's own case-sensitive
      // comparison keeps working exactly as it did under the string reader.
      resolve(key.sequence);
    };

    session = createInputSession(process.stdin, onKey);
  });
}

