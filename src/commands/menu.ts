/**
 * alter -- top-level interactive menu (six-zone room).
 *
 * Rendered when `alter` is run with no arguments and stdout is a TTY.
 * Non-TTY invocations fall through to the help banner in index.ts so
 * automation (CI, pipes, scripts) stays deterministic.
 *
 * The menu lives inside the terminal's alternate screen buffer and is
 * rendered as a branded full-screen panel. The panel stays up until the
 * user exits or logs out; action output shares the same alt-screen
 * session so the terminal history never leaks through.
 *
 * Working zones in daily-use order: Me / Queries / Identity Income /
 * Messages (top-level leaf) / Account / Devs & agents. Below a single rule
 * sits the meta/exit footer: the About zone, then `Log out · Exit`.
 */

import * as fs from "node:fs";
import chalk from "chalk";
import { confirmYesNo, textInput } from "../ui/picker.js";
import {
  daemonTogglesFile,
  readDaemonToggles,
  setDaemonToggle,
  type DaemonToggleField,
} from "../daemon/toggles.js";
import { getCliVersion } from "../lib/version.js";
import {
  apiCall,
  ensureFreshSession,
  getSession,
  peekPaintableSession,
  readStatusSnapshot,
} from "../auth.js";
import type { AlterSession } from "../auth.js";
import { status } from "./status.js";
import { login, resumeHintFile, runBridge } from "./login.js";
import { logout } from "./logout.js";
import { passkey } from "./passkey.js";
import { password } from "./password.js";
import { emailChange } from "./email.js";
import { notices } from "./notices.js";
import { legal } from "./legal.js";
import { sessions } from "./sessions.js";
import { wire, runWardrobe } from "./wire.js";
import { unwire } from "./unwire.js";
import { wallet } from "./wallet.js";
import { earnings } from "./earnings.js";
import { cashOut } from "./cash-out.js";
import { queries } from "./queries.js";
import { trace } from "./trace.js";
import {
  identityIncomeStatus,
  identityFieldQueryInteractive,
  identityIncomeQuery,
  identityIncomeGrants,
  identityIncomeGetQueried,
} from "./identity-income.js";
import { pairStatus } from "./pair-status.js";
import { identityProfile } from "./portfolio.js";
import { traits } from "./traits.js";
import { config } from "./config.js";
import { prompt } from "./prompt.js";
import {
  fetchMergedConsent,
  formatConsentsAsTable,
  formatStreamConsentsAsTable,
  terminalWidth,
  consentRevoke,
} from "./consent.js";
import { forget } from "./forget.js";
import { alignment } from "./alignment.js";
import { requireAuthedClient, extractPayload } from "./msg.js";
import {
  pairInteractive,
  fetchPaired,
  unpairPlatform,
} from "./discover.js";
import { shortDate } from "../lib/format-date.js";
import { unpairObsidian } from "./pair-obsidian.js";
import { pickOne, BACK_OPTION, isBack, type PickerOption } from "../ui/picker.js";
import {
  biosMenu,
  brand,
  setBrandPalette,
  enterAlt,
  exitAlt,
  suspendAlt,
  resumeAlt,
  drawActionHeader,
  pressEnterToReturn,
  runLeafInPane,
  showActionablePane,
  withLoadingCancel,
  MAX_COLS,
  type MenuNode,
} from "../ui/biosMenu.js";
import { room } from "./room.js";
import { msg } from "./msg.js";
import { verify } from "./verify.js";
import { about } from "./about.js";
import { doctor } from "./doctor.js";
import { maybeAutoUpdate } from "../lib/self-update.js";
import { ensureTilde, isValidHandle } from "./handle.js";
import { setUserTheme } from "./config.js";
import {
  PALETTES,
  PALETTE_ROLE_SPECS,
  buildCustomPalette,
  paletteToColors,
  resolvePalette,
} from "../theme/palette.js";
import type { PaletteVariant } from "../config/schema.js";
import { confidenceTier } from "../lib/cosmetics/confidence-tier.js";
import { ALTER_CONFIG_DIR } from "../auth.js";
import { orientation } from "../menus/orientation.js";
import { cutover } from "./cutover.js";
import { resolveMemberDepth } from "../lib/member-depth.js";
import { walkthroughHeaderTeaser } from "../onboarding/walkthrough.js";
import { buildMenuTree } from "./menu-tree.js";
import { SIGNATURE } from "../theme/themes.js";
import {
  EM_DASH,
  NO_SIGNAL_TEXT,
  TRILL_GLYPH,
  engagementStanding,
  openPresenceQualifier,
  readIdentityState,
  readVisitorEntries,
} from "../ui/ambientHeader.js";
import { readPublicPresenceLocal, setPublicPresence } from "./room.js";

/**
 * Menu header: a single useful statusline. Renders ONE frame row -
 * identity and live state share the line (an embedded `\n` in one entry
 * corrupts the frame's left border, so the whole header is one string).
 *
 * State-line rendering rules:
 *  - Leads with the member's engagement standing (Explorer / Learner /
 *    Augmented / Deployed) - present once logged in.
 *  - attunement / queries / earnings are appended only when real, drawn
 *    from the CLI's own status snapshot (`alter status`), which carries
 *    richer numbers than the often-cold daemon cache. Absent segments
 *    are omitted entirely (never a bare placeholder).
 *  - Only when NOTHING is known does the line collapse to "no signal yet".
 */
function renderHeader(handle: string): string[] {
  // Discreet build marker - faint `· vX.Y.Z` trailing the handle. Reads
  // from package.json via getCliVersion(), so it never drifts from the
  // published version. Kept on the left (next to identity) rather than the
  // far edge so a long state line can't truncate it out of the frame.
  // Line 1 is the sovereign ~handle alone - no `@ domain` stamp
  // (the bare handle is the correct form).
  const identity =
    brand.handle(handle) +
    brand.faint(`  ·  v${getCliVersion()}`);

  const state = readIdentityState();
  const snapshot = readStatusSnapshot();

  const segs: { value: string; label?: string; prefix?: string }[] = [];

  const standing = engagementStanding(state);
  if (standing !== EM_DASH) segs.push({ value: standing });

  // Guided walk: a step teaser read straight off the cached status
  // snapshot - same zero-network-on-open contract as attunement / queries /
  // $earned below. Null once the countable arc is complete (or nothing was
  // ever carried), so a finished member's header goes quiet rather than
  // nagging forever. Full teaching content lives on `alter status`.
  const walkTeaser = snapshot ? walkthroughHeaderTeaser(snapshot) : null;
  if (walkTeaser) segs.push({ value: walkTeaser });

  // attunement: prefer the live status snapshot (0-1 fraction), fall
  // back to the daemon cache's preformatted string. Render-when-present,
  // never fabricated.
  // Use tier labels, not raw percentages.
  // confidenceTier(0) returns "" (no tier at zero), so we fall back to the
  // daemon-cache preformatted string which may already be a tier label.
  const attunement =
    snapshot && typeof snapshot.attunement === "number" && snapshot.attunement > 0
      ? confidenceTier(snapshot.attunement) || `${Math.round(snapshot.attunement * 100)}%`
      : state.attunement && state.attunement.length > 0
        ? state.attunement
        : null;
  if (attunement) segs.push({ value: attunement, label: "attunement" });

  if (snapshot && snapshot.transaction_count > 0) {
    segs.push({
      value: String(snapshot.transaction_count),
      label: snapshot.transaction_count === 1 ? "query" : "queries",
    });
  }

  // total_earned is a dollar amount (the `*_cents` fields are the cents
  // surface; this one is not). Render directly.
  if (snapshot && snapshot.total_earned > 0) {
    segs.push({ value: snapshot.total_earned.toFixed(2), prefix: "$" });
  }

  // Public-presence open-qualifier: only when the member's own state is
  // `open` does the header say WHO the sign faces - "open to the street"
  // (public capability ON) vs "open to peers" (default-closed). Non-open
  // states show no qualifier and never reach a stranger.
  const pubPresence = readPublicPresenceLocal();
  const openQualifier = openPresenceQualifier(
    pubPresence.public_enabled,
    pubPresence.own_state,
  );
  if (openQualifier) segs.push({ value: openQualifier });

  let stateLine: string;
  if (segs.length === 0) {
    // Genuinely cold: no standing, no signals at all. A logged-in member
    // normally never reaches here - their standing is the floor.
    stateLine =
      brand.accent(TRILL_GLYPH) + "  " + brand.faint(NO_SIGNAL_TEXT);
  } else {
    stateLine =
      brand.accent(TRILL_GLYPH) + "  " +
      segs
        .map((seg) =>
          (seg.prefix ? brand.dim(seg.prefix) : "") +
          brand.text(seg.value) +
          (seg.label ? brand.dim(` ${seg.label}`) : ""),
        )
        .join(brand.dim("  ·  "));
  }

  // ONE frame row: identity then state on a single line.
  return [identity + brand.dim("   ") + stateLine];
}

/**
 * Resolve the session the menu is allowed to paint with, or `null` when the
 * member is not logged in. Exported for test: it is the whole gate between
 * "bare `alter`" and the room.
 *
 * Paint-first, kept for the case it was built for and withheld from the one
 * case it cannot serve.
 *
 * Paint-first (052c9e6) exists because awaiting the refresh-token rotation
 * (network, up to ALTER_REFRESH_TIMEOUT_MS = 8s) before first paint held the
 * menu hostage to a round-trip. That win is preserved intact: an access token
 * that is still fresh reports needsRefresh=false and returns with zero
 * network, exactly as before.
 *
 * It is deliberately NOT applied once the access token has expired.
 * `peekPaintableSession` answers that case from the refresh token's LOCAL
 * expiry claim, which cannot see whether the issuer will still accept that
 * token: the family may be revoked server-side, or the client may be holding a
 * refresh token the issuer already rotated out (a store-divergence stale
 * token, the observed 2026-07-22 cause). Either way the local claim hands back
 * a paintable session for a member who is no longer logged in. The rotation
 * then ran fire-and-forget with its rejection swallowed, so the full menu
 * opened for a dead session, every leaf 401'd, and nothing ever said why. When
 * a rotation is owed we now wait for its verdict (already bounded by the
 * refresh timeout) and treat a refusal as what it is: not logged in.
 *
 * `rotate` is injectable so the refused-rotation path can be tested without a
 * network; it defaults to the real single-flight rotation.
 */
export async function resolveMenuSession(
  opts: {
    signal?: AbortSignal;
    rotate?: (o: { signal?: AbortSignal }) => Promise<AlterSession | null>;
  } = {},
): Promise<AlterSession | null> {
  const rotate = opts.rotate ?? ensureFreshSession;
  const peeked = peekPaintableSession();
  if (!peeked.session) return null;
  if (!peeked.needsRefresh) return peeked.session;
  // A rejected rotation resolves null and a thrown one is caught: both mean
  // the same thing to the caller, and neither may paint.
  return await rotate({ signal: opts.signal }).catch(() => null);
}

export async function menu(): Promise<void> {
  // Wear the saved palette before first paint - a LOCAL config read.
  // Without this the menu always painted in the hardcoded signature and
  // the Customise > Palette "wears it" promise was never kept.
  try {
    const { loadConfig } = await import("../config/loader.js");
    const cfg = await loadConfig();
    setBrandPalette(resolvePalette(cfg.palette, cfg.custom_palette));
  } catch {
    // Unreadable config - keep the signature brand floor.
  }

  // Aborted on menu exit: runPublicCommand never process.exit()s after
  // menu() returns, so a still-in-flight rotation fetch would otherwise
  // hold the event loop (and the user's terminal) open for up to the
  // refresh timeout after quitting.
  const refreshAbort = new AbortController();
  let session = await resolveMenuSession({ signal: refreshAbort.signal });
  if (!session) {
    // Not logged in, by any of the three routes that reach here: no session
    // on disk at all (first run), both tokens locally expired, or a rotation
    // that the server refused. Flow straight into login rather than making
    // the user re-type `alter login`. Matches the Claude-Code shape - the
    // bare command IS the onboarding ramp. If the user bails out of any
    // beat, login returns without writing session state and we exit
    // cleanly; the menu only renders once a LIVE session exists.
    await login([]);
    session = (await ensureFreshSession()) ?? getSession();
    if (!session) {
      return;
    }
  }

  // Iterative-unlock: the room reveals depth as the member's identity
  // becomes real, rather than dumping every leaf on a cold member or
  // walking them through a chain. MemberDepth is resolved
  // from LOCAL signals only (JWT claims, status snapshot, on-disk markers)
  // so it is safe on this synchronous render path - no network here.
  // buildMenuTree owns the six-zone tree DATA + which leaves are revealed;
  // this function keeps the alt-screen control flow and leaf dispatch.
  const depth = resolveMemberDepth(session);
  const tree: MenuNode[] = buildMenuTree(depth);

  const header = renderHeader(session.handle);
  let lastSelected: string | undefined;

  enterAlt();
  try {
    while (true) {
      const choice = await biosMenu(tree, { header, lastSelected });
      if (choice === null || choice === "exit") {
        return;
      }
      // The rule row is a non-leaf decoration - biosMenu treats nodes
      // without children as leaves and finishes on selection. Defend
      // against accidental selection by skipping back to the menu.
      if (choice === "__rule__") continue;
      lastSelected = choice;

      // Interactive leaves manage their own quit handler (q/esc/← inside
      // the leaf already takes the user back to the menu). Adding the
      // press-enter-to-return prompt afterwards inserts a phantom step
      // between "user pressed back" and "menu redraws" - skip it. The
      // picker-hub leaves (customise / identity-profile / observations)
      // gate their own pressEnterToReturn per action inside the hub loop.
      const isInteractiveLeaf =
        choice === "room-open" ||
        choice === "verify-peer" ||
        choice === "customise" ||
        choice === "identity-profile" ||
        // The Consent dashboard owns its render + action loop and its own
        // back; it must not get the outer press-enter gate.
        choice === "consent";

      // Class-(c) leaves: exit the alt-screen so their console.log output
      // is visible in the normal buffer, then gate on pressEnterToReturn()
      // BEFORE re-entering alt. Drawing the action header also moves into
      // the normal buffer for these leaves (otherwise it is wiped by exitAlt).
      const isNormalBufferLeaf =
        choice === "ii-payout" ||
        choice === "ii-withdraw" ||
        choice === "ii-cashout" ||
        choice === "cutover" ||
        choice === "msg-thread";

      // Pure-output leaves: their stdout is captured and shown in the
      // scrollable report pane (runLeafInPane). The pane draws its own
      // framed title and owns "back", so these skip drawActionHeader AND the
      // outer pressEnterToReturn. Only leaves that print and never read stdin
      // qualify - an interactive leaf would block on input the user can't see.
      const isPaneLeaf =
        choice === "status" ||
        choice === "about" ||
        choice === "orientation" ||
        choice === "ii-earnings" ||
        choice === "queries" ||
        choice === "pair-status" ||
        choice === "stream-consent" ||
        choice === "observations";

      // The Consent dashboard is an interactive in-alt leaf: it owns its own
      // render + action loop entirely inside the persistent alt-screen frame
      // (it never exitAlt()s to the raw PTY). It must NOT get the outer
      // press-enter gate, so it counts as an interactive leaf above.
      const crumb = breadcrumbFor(tree, choice);

      // For normal-buffer leaves, draw the header and print any error in the
      // normal buffer. The pressEnterToReturn is handled inside the branch.
      // Set handledPressEnter=true so the outer gate skips the duplicate.
      let handledPressEnter = false;

      // Pane leaves and normal-buffer leaves manage their own surface; only
      // the plain in-alt leaves get the breadcrumb action header.
      if (!isNormalBufferLeaf && !isPaneLeaf) {
        drawActionHeader(crumb);
      }

      let actionThrew = false;
      try {
        switch (choice) {
          // --- Me ---
          case "status":
            await runLeafInPane(crumb, () => status());
            break;
          case "identity-profile":
            // Consolidated leaf: a two-row picker over trait tiers &
            // archetype (identityProfile) and how they've shifted (traits).
            await identityProfileHub(crumb);
            break;
          case "observations":
            // The observations log: the grounded record of what ~Alter has
            // observed (trace). Pure read-out, so it renders directly in the
            // bordered scroll pane (it owns its own "back"). The old "Log a
            // moment" / Looking Log row was removed.
            await runLeafInPane(crumb, () => trace([], { interactive: true }));
            break;
          case "customise":
            // Customise nests under Me as a picker flow: biosMenu renders
            // one nesting level only, so the seven customisation rows live
            // in a pickOne hub (same pattern as manageSources).
            await customiseHub(crumb);
            break;
          // --- Queries ---
          case "queries":
            // Pure read-out: render in the bordered scroll pane (it owns
            // its own "back"), same as Status and Earnings.
            await runLeafInPane(crumb, () => queries([], { interactive: true }));
            break;
          case "verify-peer":
            // verifyPeerFlow owns its own alt-screen (enterAlt/exitAlt).
            // Those calls refcount under the menu's outer hold, so the
            // shared alt-screen never drops to the raw terminal between the
            // menu and the leaf - run it directly in the persistent screen.
            await verifyPeerFlow();
            break;
          // --- Identity Income ---
          case "ii-status":
            // deferred: row hidden per menu IA reorg
            await identityIncomeStatus();
            break;
          case "ii-query":
            // General field query: the subject is NOT known - you describe
            // the shape and the opted-in field is ranked.
            await identityFieldQueryInteractive();
            break;
          case "ii-align":
            // Peer alignment: alignment against a KNOWN ~handle.
            await identityIncomeQuery();
            break;
          case "ii-grants":
            await identityIncomeGrants();
            break;
          case "ii-earnings":
            await runLeafInPane(crumb, () => earnings([]));
            break;
          case "ii-get-queried":
            await identityIncomeGetQueried();
            break;
          case "ii-payout":
          case "ii-withdraw":
            // Class-(c) normal-buffer leaf: exit alt-screen so wallet()'s
            // console.log output and clack prompts are visible; call
            // pressEnterToReturn() in the normal buffer before re-entering
            // alt so the user can read the results. drawActionHeader runs
            // here (not at the top-level) to avoid being wiped by exitAlt.
            exitAlt();
            drawActionHeader(crumb);
            try {
              await wallet([choice === "ii-payout" ? "register" : "withdraw"]);
              await pressEnterToReturn();
            } catch (err: any) {
              actionThrew = true;
              process.stdout.write(
                "\n  " + brand.accentDeep("⚠  ") + brand.text(err?.message ?? String(err)) + "\n",
              );
              await pressEnterToReturn();
            } finally {
              enterAlt();
            }
            handledPressEnter = true;
            break;
          case "ii-cashout":
            // Normal-buffer leaf like ii-payout: cashOut() prints and runs a
            // clack picker, so exit alt-screen for visible I/O, then gate on
            // pressEnterToReturn() before re-entering alt.
            exitAlt();
            drawActionHeader(crumb);
            try {
              await cashOut([]);
              await pressEnterToReturn();
            } catch (err: any) {
              actionThrew = true;
              process.stdout.write(
                "\n  " + brand.accentDeep("⚠  ") + brand.text(err?.message ?? String(err)) + "\n",
              );
              await pressEnterToReturn();
            } finally {
              enterAlt();
            }
            handledPressEnter = true;
            break;
          // --- Messages (top-level leaf) ---
          case "messages":
            // The messenger manages its own alt-screen lifecycle; those
            // enterAlt/exitAlt calls refcount under the menu's outer hold,
            // so the shared alt-screen persists across the handoff - run it
            // directly without dropping to the raw terminal.
            await msg([]);
            break;
          case "msg-thread":
            // deferred: row hidden per menu IA reorg
            // Wrap like messages/presence so the thread view renders
            // in the normal buffer without printing over the live menu frame.
            exitAlt();
            drawActionHeader(crumb);
            try {
              await msgThreadFlow();
              await pressEnterToReturn();
            } catch (err: any) {
              actionThrew = true;
              process.stdout.write(
                "\n  " + brand.accentDeep("⚠  ") + brand.text(err?.message ?? String(err)) + "\n",
              );
              await pressEnterToReturn();
            } finally {
              enterAlt();
            }
            handledPressEnter = true;
            break;
          case "presence":
            // deferred: row hidden per menu IA reorg
            // room() owns its own alt-screen; refcounted under the menu's
            // outer hold, so the persistent screen survives the handoff.
            await room([]);
            break;
          case "presence-public": {
            // deferred: row hidden per menu IA reorg
            // The public "come in" sign. Master, default-OFF, revocable.
            // Show current state, let the member flip it; setPublicPresence
            // prints the anti-extraction disclosure before turning it on.
            const current = readPublicPresenceLocal();
            const pick = await pickOne<"on" | "off" | "back">({
              message: current.public_enabled
                ? "The open sign is UP - verified strangers can read open-or-closed."
                : "The open sign is DOWN - only granted peers see your presence.",
              options: [
                {
                  value: "on",
                  label: "Put the sign up",
                  hint: "verified strangers read open-or-closed only (free to them)",
                },
                {
                  value: "off",
                  label: "Take the sign down",
                  hint: "strangers see nothing; back to peers-only (the default)",
                },
                BACK_OPTION as { value: "back"; label: string },
              ],
              initialValue: current.public_enabled ? "off" : "on",
            });
            if (pick && !isBack(pick)) {
              const result = await setPublicPresence(pick);
              process.stdout.write("\n" + result + "\n");
            }
            break;
          }
          // --- Consent ---
          case "consent":
            // One interactive sovereignty dashboard, not a list of links.
            // It renders the whole consent posture at a
            // glance and lets the member act on it inline, re-fetching and
            // re-rendering after each action. It owns its own render + action
            // loop and its own back, and exits/re-enters the alt-screen for
            // the few normal-buffer sub-actions itself.
            await consentDashboard(crumb);
            break;
          // --- Onboarding / Devs & agents ---
          case "resume-onboarding":
            // The top-of-tree "Finish setting up ~alter" row routes here
            // (the old "Set up › Continue setup" child was removed when
            // Sources was promoted). Two routes:
            //   1. browser-onboarding hint on disk -> hand to the
            //      bridge entry point so the browser tab can drive
            //      pairing / wiring from where it left off.
            //   2. otherwise -> stand up the bridge on the live session
            //      so the browser /onboarding flow drives pairing.
            //      The terminal guided chain is dev/dry-run only.
            if (hasBrowserOnboardingPending()) {
              await login(["--resume"]);
            } else if (session) {
              await runBridge(session, { mode: "cli-first" });
            }
            break;
          // Devs & agents tool actions - flattened from the old "Tools"
          // picker so the zone never collapses to a single child once the
          // cutover row hides (substrate active).
          case "wire":
            await wire([]);
            break;
          case "unwire":
            // delegated; the unwire command renders its own Tier 3
            // type-the-noun confirm inside unwire.ts, so the asymmetric-
            // confirm taxonomy applies whether reached via menu or verb.
            await unwire([]);
            break;
          case "sources":
            await manageSources();
            break;
          case "pair-status":
            // Pure read-out: bordered scroll pane, owns its own "back".
            await runLeafInPane(crumb, () => pairStatus([], { interactive: true }));
            break;
          case "stream-consent":
            // Pure read-out: bordered scroll pane, owns its own "back".
            await runLeafInPane(crumb, () => streamConsentView());
            break;
          case "cutover":
            // Class-(c) normal-buffer leaf: same pattern as ii-payout.
            exitAlt();
            drawActionHeader(crumb);
            try {
              await cutover();
              await pressEnterToReturn();
            } catch (err: any) {
              actionThrew = true;
              process.stdout.write(
                "\n  " + brand.accentDeep("⚠  ") + brand.text(err?.message ?? String(err)) + "\n",
              );
              await pressEnterToReturn();
            } finally {
              enterAlt();
            }
            handledPressEnter = true;
            break;
          // --- Account ---
          case "passkeys":
            await passkeysFlow();
            break;
          case "password":
            await password(["change"]);
            break;
          case "email":
            await emailChange();
            break;
          case "contact-email":
            await contactEmailFlow();
            break;
          case "sessions":
            await sessions(["revoke-all"]);
            break;
          case "notices":
            await notices();
            break;
          case "legal":
            await legal();
            break;
          // --- About ---
          case "orientation":
            await runLeafInPane(crumb, () => orientation());
            break;
          case "about":
            await runLeafInPane(crumb, () => about());
            break;
          case "update": {
            // Same behaviour as the `alter update` verb (index.ts): forced,
            // synchronous check with verify-before-exec install via
            // maybeAutoUpdate. Renders inside the alt-screen like every
            // standard leaf so nothing persists in the terminal after the
            // menu closes (the alt buffer is wiped on exit).
            const { result } = await maybeAutoUpdate({
              currentVersion: getCliVersion(),
              command: "update",
              mode: "sync",
              force: true,
            });
            if (!result) {
              process.stdout.write(
                "\n  " +
                  brand.text(
                    "Automatic updates are off. Re-enable with `alter update auto on`.",
                  ) +
                  "\n",
              );
            } else if (!result.shouldUpdate) {
              // Plain sentence for the menu surface. Only name the
              // channel when it is not the default public one.
              const channelNote =
                result.channel === "latest" ? "" : ` @${result.channel}`;
              process.stdout.write(
                "\n  " +
                  brand.text(
                    `You are already on the latest${channelNote} version (${result.current}).`,
                  ) +
                  "\n",
              );
            }
            break;
          }
          case "doctor": {
            // Standard alt-screen leaf - the report renders inside the
            // alt buffer and is wiped when the menu closes, so nothing
            // persists in the terminal. Diagnose-only from the menu (no
            // --fix); the printed remedies name the fix commands. doctor()
            // sets process.exitCode on FAIL - restore it so browsing the
            // menu never turns the session's eventual exit code non-zero.
            const priorExitCode = process.exitCode;
            try {
              await doctor([]);
            } finally {
              process.exitCode = priorExitCode;
            }
            break;
          }
          // --- Footer ---
          case "logout":
            await logout();
            return;
        }
      } catch (err: any) {
        actionThrew = true;
        process.stdout.write(
          "\n  " + brand.accentDeep("⚠  ") + brand.text(err?.message ?? String(err)) + "\n"
        );
      }

      // Interactive leaves clean up after themselves; skip the phantom
      // press-enter step UNLESS an error was printed (then the user
      // needs a moment to read it before the menu repaints).
      // Normal-buffer (class-c) leaves already called pressEnterToReturn()
      // inside their own branch - skip the outer gate to avoid a duplicate.
      // Pane leaves own their own "back" key inside runLeafInPane (errors are
      // shown in the pane, so actionThrew never fires for them) - skip too.
      if (!handledPressEnter && ((!isInteractiveLeaf && !isPaneLeaf) || actionThrew)) {
        await pressEnterToReturn();
      }
    }
  } finally {
    refreshAbort.abort();
    exitAlt();
  }
}

/** Resolve the human-readable label for a value, walking children.
 *
 * Returns the full breadcrumb string (e.g. "Identity Income  ›  Earnings")
 * on a match, or null on miss. The top-level caller falls back to `value`
 * only when the entire tree produces no match - preventing the prior bug
 * where a partial-match on a group's trail ("Me") was accepted for every
 * unmatched value.
 */
function labelFor(nodes: MenuNode[], value: string, trail: string[] = []): string | null {
  for (const n of nodes) {
    if (n.value === value) return [...trail, n.label].join("  ›  ");
    if (n.children) {
      const sub = labelFor(n.children, value, [...trail, n.label]);
      if (sub !== null) return sub;
    }
  }
  return null;
}

/** Top-level breadcrumb resolver - falls back to `value` only when the
 *  tree has no match at all (e.g. an unknown leaf value). */
function breadcrumbFor(nodes: MenuNode[], value: string): string {
  return labelFor(nodes, value) ?? value;
}

// ALTER-ARCHIVED: superseded 2026-07-05 | status=retained-not-deleted | note=the browser-first CLI-bridge onboarding consumer was removed; no live browser consumer. Retained pending a desktop-client rendezvous decision.
/**
 * Is there a pending browser-onboarding waiting for a local bridge?
 * Cheap presence check - `alter login --resume` re-validates the file
 * (schema, expiry) before doing anything irreversible.
 */
function hasBrowserOnboardingPending(): boolean {
  try {
    return fs.existsSync(resumeHintFile());
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Me > Identity profile - consolidated picker (2026-06-06 IA reorg). Two
// rows: trait tiers & archetype (identityProfile) and how they've shifted
// (traits). The separate "Traits over time" tree row is consolidated here.
// ---------------------------------------------------------------------------

async function identityProfileHub(crumb: string): Promise<void> {
  while (true) {
    // Clear before each pass so the picker always renders on a clean
    // screen - the pickers paint inline at the cursor, so without this the
    // chooser stacks below the previous report frame on every return.
    drawActionHeader(crumb);
    const pick = await pickOne({
      message: "Identity profile",
      options: [
        { value: "tiers", label: "Trait tiers & archetype", hint: "your trait tiers, archetype, and cognitive style" },
        { value: "shifted", label: "How they've shifted", hint: "how your profile has shifted" },
        BACK_OPTION,
      ],
    });
    if (isBack(pick)) return;
    // Both rows are pure read-outs: render them in the bordered scroll
    // pane (it owns its own "back"), exactly like Status and Earnings.
    if (pick === "tiers") {
      await runLeafInPane(crumb + "  ›  Trait tiers & archetype", () =>
        identityProfile([], { interactive: true }),
      );
    } else {
      await runLeafInPane(crumb + "  ›  How they've shifted", () =>
        traits([], { interactive: true }),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Me > Customise - the customisation hub picker (2026-06-06 IA reorg:
// Customise nests under Me; biosMenu renders one nesting level, so the
// seven rows live in a pickOne loop, labels and hints verbatim from the
// old top-level zone). Restore-the-default-look stays the LAST row - the
// inverse of customising, not its lead.
// ---------------------------------------------------------------------------

/**
 * Repaint the alt-screen action surface from a clean slate: clear, then
 * the breadcrumb header. The customise flow calls this on every screen
 * transition so entering a leaf REPLACES the hub on screen instead of
 * stacking a second picker below it (the pickers render inline at the
 * cursor; without the clear, each nesting level appended).
 */
function repaintActionScreen(crumb: string): void {
  process.stdout.write("\x1b[2J\x1b[H");
  drawActionHeader(crumb);
}

async function customiseHub(crumb: string): Promise<void> {
  // What the last leaf saved (or null) - painted under the header on
  // the next hub repaint so feedback survives the screen replacement.
  let note: string | null = null;
  while (true) {
    repaintActionScreen(crumb);
    if (note) {
      process.stdout.write("  " + note + "\n\n");
    }
    const pick = await pickOne({
      message: "Customise - the tweak is the authorship",
      // Grouped with separator rows so the list breathes: the colours,
      // then the shell surfaces, then the config file + reset.
      options: [
        { value: "cust-palette", label: "Palette", hint: "a preset register: charcoal, ivory, or oxblood" },
        { value: "cust-colours", label: "Custom colours", hint: "build your own - set each colour by hand, live" },
        { value: "cust-opener", label: "Opening line", hint: "the line the menu greets you with" },
        { separator: true },
        { value: "cust-prompt", label: "Shell prompt", hint: "bind your ~handle into the starship prompt" },
        { value: "cust-wardrobe", label: "Terminal wardrobe", hint: "kitty, alacritty, polybar, tmux, fetch - dress your terminal" },
        { separator: true },
        { value: "edit-config", label: "Edit the config file", hint: `open ${ALTER_CONFIG_DIR}/config.toml in $EDITOR` },
        { value: "restore-signature", label: "Restore the default look", hint: "reset the colours to the ~alter signature" },
        { separator: true },
        BACK_OPTION,
      ],
    });
    if (isBack(pick)) return;
    note = null;
    switch (pick) {
      case "cust-palette":
        note = await customisePalette(crumb);
        break;
      case "cust-colours":
        note = await customiseColours(crumb);
        break;
      case "cust-opener":
        note = await customiseOpener(crumb);
        break;
      case "cust-prompt":
        // Starship segment - binds the ~handle into the shell prompt. The
        // prompt is a cosmetic surface, so it lives with the other
        // customisations. Its output prints inline - gate before the
        // hub repaint wipes it.
        repaintActionScreen(crumb + "  ›  Shell prompt");
        await prompt(["install", "--append"]);
        await pressEnterToReturn();
        break;
      case "cust-wardrobe":
        // Terminal wardrobe - kitty / alacritty / polybar / tmux / fetch
        // surfaces, driven by the same detect → preview → inscribe
        // pipeline `alter wire` runs. Normal buffer: the flow uses clack
        // spinners + multi-step pickers and prints per-surface results.
        exitAlt();
        drawActionHeader(crumb + "  ›  Terminal wardrobe");
        try {
          await runWardrobe();
          await pressEnterToReturn();
        } catch (err: any) {
          process.stdout.write(
            "\n  " + brand.accentDeep("⚠  ") + brand.text(err?.message ?? String(err)) + "\n",
          );
          await pressEnterToReturn();
        } finally {
          enterAlt();
        }
        break;
      case "restore-signature":
        note = await restoreSignature(crumb);
        break;
      case "edit-config": {
        // $EDITOR takes over the terminal - physically drop the alt-screen
        // so editors that probe terminal capabilities (vim, nano, helix)
        // get a clean canvas, WITHOUT touching the refcount so the menu's
        // outer hold survives. Restore exactly the prior state on return.
        const wasAlt = suspendAlt();
        try {
          await config(["edit"]);
        } finally {
          resumeAlt(wasAlt);
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Customise leaf flows. Grew from the v1 two-leaf shape:
// palette, sigil, opener, shell prompt and the terminal wardrobe
// were all built but only reachable through dev-side verbs, and the room's
// "change in Customise → Sigil" caption pointed at a leaf that didn't
// exist. Restore-the-default-look is the LAST row - the inverse of
// customising, not its lead.
// ---------------------------------------------------------------------------

async function customisePalette(crumb: string): Promise<string | null> {
  const { loadConfig } = await import("../config/loader.js");
  let cfg: Awaited<ReturnType<typeof loadConfig>> | undefined;
  try {
    cfg = await loadConfig();
  } catch {
    cfg = undefined;
  }
  // Only a preset selection marks a row "(current)" / seeds the cursor;
  // a "custom" selection has no preset row to point at.
  const current: PaletteVariant | undefined =
    cfg && cfg.palette && cfg.palette !== "custom" ? cfg.palette : undefined;
  // The full register to restore on cancel - what the menu wears now,
  // custom hex map included.
  const savedPalette = resolvePalette(cfg?.palette, cfg?.custom_palette);

  repaintActionScreen(crumb + "  ›  Palette");
  const pick = await pickOne<PaletteVariant | "back">({
    message: "Palette - pick a preset, or build your own colours",
    options: [
      ...Object.values(PALETTES).map((p) => ({
        value: p.variant as PaletteVariant,
        label: p.variant + (p.variant === current ? "  (current)" : ""),
        hint: p.label,
      })),
      { separator: true },
      BACK_OPTION as { value: "back"; label: string },
    ],
    initialValue: current,
    // Live preview: the whole picker re-paints in the highlighted
    // register as the cursor moves - the menu IS the swatch. Resting
    // on Back shows the saved register again.
    onHighlight: (v) => {
      if (v === "back") setBrandPalette(savedPalette);
      else setBrandPalette(PALETTES[v]);
    },
  });
  if (isBack(pick)) {
    // Cancelled - take the preview off, wear the saved register.
    setBrandPalette(savedPalette);
    return null;
  }

  await setUserTheme({ palette: pick });
  setBrandPalette(PALETTES[pick]);
  return (
    brand.accent("saved.  ") +
    brand.dim(`palette is now ${pick} - the menu wears it already.`)
  );
}

// Me > Customise > Custom colours - the DIY per-role hex editor.
//
// The granular surface: set any of the twelve colour roles by hand and
// watch the whole menu re-tint as you go (the menu IS the swatch). Seeds
// from the colours currently in effect, applies live on every edit, and
// persists as `palette = "custom"` + a full `custom_palette` hex map so
// the choice survives restarts and feeds the shell prompt too.
async function customiseColours(crumb: string): Promise<string | null> {
  const { loadConfig } = await import("../config/loader.js");
  let cfg: Awaited<ReturnType<typeof loadConfig>> | undefined;
  try {
    cfg = await loadConfig();
  } catch {
    cfg = undefined;
  }
  // What the room wears now - the seed, and the restore-on-cancel state.
  const savedPalette = resolvePalette(cfg?.palette, cfg?.custom_palette);
  const working = paletteToColors(savedPalette);
  let dirty = false;

  // Apply the working set live so the editor itself shows the colours.
  const applyLive = () => setBrandPalette(buildCustomPalette(working));

  while (true) {
    applyLive();
    repaintActionScreen(crumb + "  ›  Custom colours");
    process.stdout.write(
      "  " + brand.faint("set any colour by hand; the menu re-tints as you go.") + "\n\n",
    );

    const roleRows = PALETTE_ROLE_SPECS.map((spec) => {
      const hex = working[spec.key];
      const chip = chalk.bgHex(hex)("  ");
      return {
        value: spec.key as string,
        label: `${spec.label.padEnd(14)} ${chip} ${hex}`,
        hint: spec.hint,
      };
    });

    const pick = await pickOne<string>({
      message: "Custom colours - your own register",
      options: [
        ...roleRows,
        { separator: true },
        { value: "__save", label: "Save these colours", hint: "persist as your custom palette" },
        { value: "__preset", label: "Start from a preset", hint: "seed every role from charcoal / ivory / oxblood" },
        { separator: true },
        BACK_OPTION as { value: string; label: string },
      ],
    });

    if (isBack(pick)) {
      // Cancel - drop any live preview, wear the saved register again.
      if (dirty) setBrandPalette(savedPalette);
      return null;
    }

    if (pick === "__save") {
      await setUserTheme({ palette: "custom", custom_palette: working });
      setBrandPalette(buildCustomPalette(working));
      return (
        brand.accent("saved.  ") +
        brand.dim("your own colours are in effect - the menu and shell prompt wear them.")
      );
    }

    if (pick === "__preset") {
      repaintActionScreen(crumb + "  ›  Custom colours  ›  Start from a preset");
      const base = await pickOne<PaletteVariant | "back">({
        message: "Seed every role from which preset?",
        options: [
          ...Object.values(PALETTES).map((p) => ({
            value: p.variant as PaletteVariant,
            label: p.variant,
            hint: p.label,
          })),
          { separator: true },
          BACK_OPTION as { value: "back"; label: string },
        ],
        onHighlight: (v) => {
          if (v !== "back") setBrandPalette(PALETTES[v]);
        },
      });
      if (!isBack(base)) {
        Object.assign(working, paletteToColors(PALETTES[base]));
        dirty = true;
      }
      continue;
    }

    // A role row: edit its hex. Live-apply on a valid value.
    const spec = PALETTE_ROLE_SPECS.find((s) => s.key === pick);
    if (!spec) continue;
    repaintActionScreen(crumb + "  ›  Custom colours  ›  " + spec.label);
    process.stdout.write(
      "  " + brand.faint(spec.hint) + "\n" +
        "  " + brand.faint("current  ") + chalk.bgHex(working[spec.key])("  ") +
        " " + brand.text(working[spec.key]) + "\n\n",
    );
    const entered = await textInput({
      message: `${spec.label} colour`,
      lockedPrefix: "#",
      initialValue: working[spec.key].replace(/^#/, ""),
      placeholder: "RRGGBB",
      validate: (v) =>
        /^#[0-9a-fA-F]{6}$/.test(v)
          ? undefined
          : "Six hex digits, e.g. #F9BE4A.",
    });
    if (entered !== null) {
      working[spec.key] = "#" + entered.replace(/^#/, "").toUpperCase();
      dirty = true;
    }
  }
}

async function customiseOpener(crumb: string): Promise<string | null> {
  const { loadConfig } = await import("../config/loader.js");
  let current: string | undefined;
  try {
    const opener = (await loadConfig()).opener;
    current = opener && "line" in opener ? opener.line : undefined;
  } catch {
    current = undefined;
  }

  repaintActionScreen(crumb + "  ›  Opening line");
  process.stdout.write(
    "  " + brand.faint("the line the menu greets you with. yours overrides the rotation;") + "\n" +
      "  " + brand.faint("leave it blank to return to the rotating openers.") + "\n\n",
  );

  const entered = await textInput({
    message: "Opening line",
    initialValue: current ?? "",
    placeholder: "yours to write",
    allowEmpty: true,
  });
  if (entered === null) return null;

  const line = entered.trim();
  await config(["set", "opener.line", line]);
  return (
    brand.accent("saved.  ") +
    (line.length > 0
      ? brand.dim("the menu now greets you with your line.")
      : brand.dim("back to the rotating openers."))
  );
}

async function restoreSignature(crumb: string): Promise<string | null> {
  repaintActionScreen(crumb + "  ›  Restore the default look");
  process.stdout.write(
    "  " +
      brand.titleDim("the tweak is the authorship") +
      brand.dim("  ·  ") +
      brand.faint("your config is yours. ~alter sets the defaults; you make it your own") +
      "\n\n",
  );

  // Show the signature register as a row of colour chips - what you're
  // about to restore.
  const sig = PALETTES[SIGNATURE.palette];
  const chips = [sig.title, sig.accent, sig.text, sig.border, sig.dim]
    .map((hex) => chalk.bgHex(hex)("  "))
    .join(" ");
  process.stdout.write("  " + brand.faint("signature  ") + chips + "\n\n");

  const ok = await confirmYesNo({
    message: "Restore the default colours? This overwrites your palette (preset or custom).",
    initialValue: false,
  });
  if (!ok) {
    return null;
  }

  // Reset the selection to the signature preset; the custom hex map (if
  // any) stays on disk, unused, so it can be returned to later.
  await setUserTheme({ palette: SIGNATURE.palette, sigil: SIGNATURE.sigil });
  // The menu wears the restored register immediately, same as Palette.
  setBrandPalette(PALETTES[SIGNATURE.palette]);

  return (
    brand.accent("saved.  ") +
    brand.dim("the signature colours are back - a hand-edited config always wins.")
  );
}

// ---------------------------------------------------------------------------
// Room > Visitors - local presence-feed read
// ---------------------------------------------------------------------------

const VISITORS_VIEW_LIMIT = 32;

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "-";
  const diff = Date.now() - then;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

async function visitorsView(): Promise<void> {
  const entries = readVisitorEntries().slice(0, VISITORS_VIEW_LIMIT);
  process.stdout.write("\n");
  if (entries.length === 0) {
    process.stdout.write(
      "  " + brand.faint("No visitors yet. Share your ") +
        brand.muted("~handle") +
        brand.faint(" for someone to drop by.") + "\n\n",
    );
    return;
  }
  for (const e of entries) {
    const sender = brand.handle(e.sender);
    const state = brand.accent(e.state);
    const when = brand.dim(formatRelative(e.sent_at));
    process.stdout.write(
      `  ${sender}  ${brand.dim("·")}  ${state}  ${brand.dim("·")}  ${when}\n`,
    );
  }
  process.stdout.write("\n");
}

// ---------------------------------------------------------------------------
// Me > Connected-source sharing - read both consent ledgers
//
// This is the STREAM/CONNECTOR consent surface: what each paired source
// (GitHub, vault) and each member-level grant may infer about you. It is
// deliberately distinct from Identity Income > "Who can query me", which is
// the PEER inbound-query grant list. Two different authorities; the labels
// and section headers below keep them from reading as one generic dashboard.
// ---------------------------------------------------------------------------

/**
 * Clamp every line of a multi-line block to `width` visible columns so a
 * table whose minimum width still exceeds the frame can never wrap past the
 * right edge - it truncates instead. ANSI-naive on purpose: the consent
 * formatters emit unstyled monospace rows, so a plain `.length` slice is
 * correct and avoids dragging the biosMenu ANSI-truncate into this module.
 */
function clampBlockWidth(block: string, width: number): string {
  return block
    .split("\n")
    .map((line) => (line.length > width ? line.slice(0, Math.max(0, width - 1)) + "…" : line))
    .join("\n");
}

async function streamConsentView(): Promise<void> {
  const merged = await fetchMergedConsent();
  // Size the tables to the menu's panel width (MAX_COLS), not the raw
  // terminal width. Every emitted row is indented two spaces and shares the
  // BIOS frame's visual width, so the usable budget is the panel/terminal
  // width LESS that indent (2) less a 1-col right safety margin. Sizing to
  // the raw terminalWidth() let wide terminals build a table that wrapped
  // past the frame; on narrow terminals a table whose *minimum* width still
  // overran the budget wrapped too - clampBlockWidth() below truncates any
  // such row so nothing ever wraps, on any terminal size.
  const cols = Math.min(terminalWidth(), MAX_COLS);
  const indent = 2;
  const budget = Math.max(20, cols - indent - 1);

  const writeTable = (block: string): void => {
    const clamped = clampBlockWidth(block, budget);
    process.stdout.write("  " + clamped.split("\n").join("\n  ") + "\n");
  };

  process.stdout.write("\n");
  process.stdout.write("  " + brand.titleDim("Member-level grants") + "\n");
  process.stdout.write(
    "  " + brand.faint("what you've declared at the account level") + "\n",
  );
  writeTable(formatConsentsAsTable(merged.consents, budget));
  process.stdout.write("\n");
  process.stdout.write(
    "  " + brand.titleDim("Per-source sharing (paired connectors)") + "\n",
  );
  process.stdout.write(
    "  " +
      brand.faint("each paired source and what it may infer - not peer queries") +
      "\n",
  );
  writeTable(formatStreamConsentsAsTable(merged.stream_consents, budget));
  process.stdout.write("\n");
}

// ===========================================================================
// Consent - one interactive sovereignty dashboard.
//
// Replaces the earlier link zone (eight child rows). This is a single screen
// that renders the member's whole consent posture at a glance AND lets them
// act on it inline, re-fetching after each action so the screen always
// reflects the current truth.
//
// Posture source: the `alter_consent` MCP tool (one call, every key), plus
// readPublicPresenceLocal() for the open sign and DAEMON_BEHAVIOURS /
// resolveDaemonState for the daemon section. Every action delegates to an
// EXISTING handler - msg (alter_message_grant/revoke), alignment
// (alter_alignment_grant/revoke), setPublicPresence (the open sign with its
// own disclosure), streamConsentView, consentRevoke (the consequence
// preview lives there), identityIncomeGetQueried, forget. Nothing here
// reimplements an MCP call.
// ---------------------------------------------------------------------------

/** Shape of the `alter_consent` posture payload (only the fields we read). */
interface ConsentGrant {
  target_tool?: string;
  scope?: string;
  grantor_handle?: string | null;
  grantee_handle?: string | null;
  status?: string;
  granted_at?: string | null;
  expires_at?: string | null;
}
interface ConsentPosture {
  consents?: Array<{ consent_type?: string; status?: string; granted_at?: string | null }>;
  stream_consents?: Array<{ stream?: string; purposes?: string[]; granted_at?: string | null }>;
  mcp_grants_authored?: ConsentGrant[];
  mcp_grants_received?: ConsentGrant[];
}

/** A grant whose scope is one of the messaging scopes. */
function isMessagingScope(scope: string | undefined): boolean {
  return (
    scope === "messaging.send" ||
    scope === "messaging.consent" ||
    scope === "alter_message.send"
  );
}
/** A grant whose scope is the alignment/query scope. */
function isQueryScope(scope: string | undefined): boolean {
  return scope === "alignment.query";
}

/**
 * Outcome of a posture fetch, kept distinct so the dashboard renders an
 * HONEST line. The old code collapsed every failure to `null`, so a
 * signed-in member whose `alter_consent` call returned null/threw was told
 * to "sign in" - misleading, because they already are. We now distinguish:
 *   - "ok"          : posture in hand (may legitimately have empty grants);
 *   - "signed-out"  : no member session at all (the only case where the
 *                     "sign in with alter login" line is truthful);
 *   - "unavailable" : signed in, but the posture could not be read right
 *                     now (no member key / signing kid, key mismatch, or
 *                     the MCP call threw) - say exactly that.
 */
type PostureFetch =
  | { kind: "ok"; posture: ConsentPosture }
  | { kind: "signed-out" }
  | { kind: "unavailable" };

/**
 * Fetch the consent posture from the `alter_consent` MCP tool. Reuses msg.ts's
 * authed-client builder and payload extractor (no new MCP plumbing).
 *
 * Login state is read straight off the session (getSession) rather than
 * inferred from requireAuthedClient's null collapse, so a member who IS
 * logged in but whose posture read fails is never told to "sign in".
 */
async function fetchConsentPosture(): Promise<PostureFetch> {
  // A member session present == signed in, regardless of whether the
  // posture read below succeeds.
  if (!getSession()) return { kind: "signed-out" };
  const authed = requireAuthedClient();
  if (!authed) return { kind: "unavailable" };
  try {
    const result = await authed.client.mcp.callTool("alter_consent", {});
    const posture = extractPayload<ConsentPosture>(result);
    if (!posture) return { kind: "unavailable" };
    return { kind: "ok", posture };
  } catch {
    return { kind: "unavailable" };
  }
}

/**
 * Posture line-builder. Section title + one faint subtitle, body lines under
 * it, then a blank spacer - all pushed onto `out`. The frame indents every
 * body row by two columns (the `│  …  │` chrome), so these lines carry no
 * leading frame indent themselves; a one-space inset distinguishes a section
 * body row from its title.
 */
function dashSection(out: string[], title: string, subtitle: string): void {
  out.push(brand.titleDim(title));
  if (subtitle) out.push(brand.faint(subtitle));
}
function dashLine(out: string[], text: string): void {
  out.push(" " + text);
}

/**
 * Build the whole posture as an array of display lines for the bordered frame
 * (showActionablePane). Scannable, not exhaustive: grants are grouped
 * (master/open vs per-peer) and capped; the pane scrolls if the posture
 * overruns the terminal height. Read-at-a-glance; the action picker follows.
 */
function buildPostureLines(fetched: PostureFetch): string[] {
  const out: string[] = [];
  if (fetched.kind === "signed-out") {
    out.push(
      brand.text("Posture unavailable - sign in with ") +
        brand.accent("alter login") +
        brand.text(" to read it."),
    );
    return out;
  }
  if (fetched.kind === "unavailable") {
    // Signed in, but the consent posture could not be read this moment.
    // Do NOT tell a logged-in member to sign in.
    out.push(
      brand.text("Couldn't read your consent posture right now. ") +
        brand.faint("Try again in a moment; your session is fine."),
    );
    return out;
  }

  const posture = fetched.posture;
  const authored = posture.mcp_grants_authored ?? [];
  const received = posture.mcp_grants_received ?? [];

  // Who can reach you (messaging grants authored).
  const msgGrants = authored.filter((g) => isMessagingScope(g.scope));
  const msgPeers = msgGrants
    .filter((g) => g.grantee_handle)
    .map((g) => g.grantee_handle as string);
  const msgMaster = msgGrants.some((g) => !g.grantee_handle);
  dashSection(out, "Who can reach you", "peers you let message your inbox");
  if (msgMaster) dashLine(out, brand.text("Open inbox: ") + brand.faint("master messaging consent is on"));
  if (msgPeers.length) {
    dashLine(out, brand.text(uniqueHandles(msgPeers).join("  ")));
  } else if (!msgMaster) {
    dashLine(out, brand.faint("no peers granted"));
  }
  out.push("");

  // Who can query you (alignment grants authored, per-peer + expiry).
  const queryGrants = authored.filter((g) => isQueryScope(g.scope) && g.grantee_handle);
  dashSection(out, "Who can query you", "peers you let run an alignment query");
  if (queryGrants.length) {
    for (const g of queryGrants.slice(0, 6)) {
      const exp = g.expires_at ? brand.faint("  expires " + shortDate(g.expires_at)) : "";
      dashLine(out, brand.text(g.grantee_handle as string) + exp);
    }
    if (queryGrants.length > 6) dashLine(out, brand.faint(`and ${queryGrants.length - 6} more`));
  } else {
    dashLine(out, brand.faint("no peers granted"));
  }
  out.push("");

  // The open sign (public presence).
  const presence = readPublicPresenceLocal();
  dashSection(out, "The open sign", "what verified strangers can read");
  dashLine(
    out,
    presence.public_enabled
      ? brand.accent("Up") + brand.text(" - strangers read open-or-closed only")
      : brand.dim("Down") + brand.text(" - only granted peers see your presence (the default)"),
  );
  out.push("");

  // What you share (per-source data grants).
  const streams = posture.stream_consents ?? [];
  dashSection(out, "What you share", "each paired source and what it may infer");
  if (streams.length) {
    for (const s of streams) {
      const purposes = (s.purposes ?? []).length
        ? brand.faint("  " + (s.purposes ?? []).join(", "))
        : brand.faint("  no inference purposes");
      dashLine(out, brand.text(s.stream ?? "source") + purposes);
    }
  } else {
    dashLine(out, brand.faint("no sources sharing yet"));
  }
  out.push("");

  // Your data consents (member-level ConsentType grants).
  const consents = (posture.consents ?? []).filter((c) => c.status !== "revoked");
  dashSection(out, "Your data consents", "account-level grants: assessment, matching, demographic");
  if (consents.length) {
    for (const c of consents) {
      dashLine(out, brand.text(c.consent_type ?? "consent") + brand.faint("  " + (c.status ?? "granted")));
    }
  } else {
    dashLine(out, brand.faint("none active"));
  }
  out.push("");

  // Granted to you (read-only).
  dashSection(out, "Granted to you", "peers who let you query or message them");
  if (received.length) {
    for (const g of received.slice(0, 6)) {
      const what = isQueryScope(g.scope) ? "query" : isMessagingScope(g.scope) ? "message" : "reach";
      dashLine(out, brand.text(g.grantor_handle ?? "~peer") + brand.faint(`  (${what})`));
    }
    if (received.length > 6) dashLine(out, brand.faint(`and ${received.length - 6} more`));
  } else {
    dashLine(out, brand.faint("none"));
  }
  out.push("");

  // Daemon activity: a READ-ONLY disclosure, visually distinct from the
  // actionable levers above. It lists what the local daemon does on the
  // member's behalf; it never writes runtime.yaml. The subtitle says so and
  // says why there is no toggle yet.
  dashSection(
    out,
    "What your daemon does on your behalf",
    "these run at daemon launch; change them under Consent",
  );
  const { toggles: savedSummary } = readDaemonToggles();
  for (const b of DAEMON_BEHAVIOURS) {
    const { on } = resolveDaemonState(b, savedSummary);
    const state = on ? brand.accent("on ") : brand.dim("off");
    dashLine(out, state + "  " + brand.text(b.label));
  }
  out.push("");

  // Actions cue: the levers above ARE actionable. The footer's "↵ act" is
  // easy to miss, so spell it out in-frame (the dashboard otherwise
  // reads as read-only). This is a prompt only; the picker still owns the
  // action list and how each one runs.
  dashSection(out, "Actions", "press Enter to change a consent below");
  dashLine(out, brand.faint("grant or revoke messaging and queries, the open sign,"));
  dashLine(out, brand.faint("source sharing, data consents, get queried, delete identity"));
  return out;
}

/** Dedupe + preserve order for a list of ~handles. */
function uniqueHandles(handles: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of handles) {
    if (!seen.has(h)) {
      seen.add(h);
      out.push(h);
    }
  }
  return out;
}

type ConsentAction =
  | "msg"
  | "query"
  | "open-sign"
  | "share"
  | "data-revoke"
  | "get-queried"
  | "forget"
  | "back";

/**
 * The interactive Consent dashboard. Stays inside the persistent alt-screen
 * frame end to end - it never calls exitAlt() and never writes raw lines to
 * the PTY (a prior version dropped to the raw terminal). Each pass:
 *   1. fetch the posture and paint it INSIDE the bordered, scrollable frame
 *      (showActionablePane - the same frame + scroll loop as the other
 *      read-out panes); Enter opens the action picker, q/esc/← leaves;
 *   2. run the action picker inline on a cleared alt-screen (the sanctioned
 *      presence-public in-frame pattern - pickOne paints at the cursor and
 *      never enters/exits the alt-screen);
 *   3. dispatch to an EXISTING handler, run in-frame, then re-paint.
 * Loops until the member picks Back.
 */
async function consentDashboard(crumb: string): Promise<void> {
  while (true) {
    const posture = await fetchConsentPosture();
    const postureLines = buildPostureLines(posture);

    // The posture renders inside the bordered frame and scrolls if it
    // overruns the terminal height. Enter -> open the picker; back -> leave.
    const choice = await showActionablePane(crumb, postureLines);
    if (choice === "back") return;

    // Picker on a cleared alt-screen (in-frame, never the raw PTY). The
    // header keeps brand context above the inline picker.
    drawActionHeader(crumb);
    // Grouped action list: four faint group headers (PickerSeparator labels),
    // grant/revoke collapsed into one option each (the Grant/Revoke choice is
    // a follow-on in-frame sub-pick), and label/hint padded into aligned
    // columns. padEnd is computed across the visible action labels so the
    // muted hints line up regardless of label length.
    const actionRows: { value: ConsentAction; label: string; hint: string }[] = [
      { value: "msg", label: "Who can message me", hint: "grant or revoke a peer" },
      { value: "query", label: "Who can query me", hint: "grant or revoke a peer" },
      { value: "open-sign", label: "The open sign", hint: "strangers read open-or-closed" },
      { value: "share", label: "Source sharing", hint: "what each paired source infers" },
      { value: "get-queried", label: "Get queried", hint: "be queryable, and earn" },
      { value: "data-revoke", label: "Withdraw a data consent", hint: "see the effect before you confirm" },
      { value: "forget", label: "Delete my identity", hint: "schedule erasure, 30-day cancel" },
    ];
    const labelWidth = Math.max(...actionRows.map((r) => r.label.length));
    const opt = (v: ConsentAction): PickerOption<ConsentAction> => {
      const r = actionRows.find((x) => x.value === v)!;
      return { value: r.value, label: r.label.padEnd(labelWidth), hint: r.hint };
    };
    const action = await pickOne<ConsentAction>({
      message: "Change a consent",
      options: [
        { separator: true, label: "People" },
        opt("msg"),
        opt("query"),
        { separator: true, label: "Visibility & sharing" },
        opt("open-sign"),
        opt("share"),
        { separator: true, label: "Your data" },
        opt("get-queried"),
        opt("data-revoke"),
        { separator: true, label: "Account" },
        opt("forget"),
        { separator: true },
        BACK_OPTION as PickerOption<ConsentAction>,
      ],
    });
    // Picker back returns to the posture pane (one level up), not out of the
    // dashboard; the posture pane's own back leaves.
    if (isBack(action)) continue;

    // Each branch delegates to an existing handler, all of which print via
    // console.log / process.stdout and read stdin (when they confirm) through
    // the inline picker primitives - every one of those works inside the
    // alt-screen, so runConsentSubAction runs them in-frame on a cleared
    // alt-screen WITHOUT dropping to the raw PTY. The open sign and source
    // sharing already render in-frame (pickOne / runLeafInPane).
    try {
      switch (action) {
        case "msg": {
          // Collapsed grant/revoke: an in-frame Grant/Revoke/Back sub-pick
          // (pickOne paints inline on the held alt-screen, never the raw PTY),
          // then the existing peer-handle prompt and messaging path.
          await runPeerGrantRevoke(
            crumb,
            "Who can message me",
            (verb, handle) => msg([verb, handle]),
          );
          break;
        }
        case "query": {
          await runPeerGrantRevoke(
            crumb,
            "Who can query me",
            (verb, handle) => alignment([verb, handle]),
          );
          break;
        }
        case "open-sign": {
          // Reuse the presence-public inline flow: setPublicPresence prints
          // its anti-extraction disclosure before turning the sign on.
          const current = readPublicPresenceLocal();
          const pick = await pickOne<"on" | "off" | "back">({
            message: current.public_enabled
              ? "The open sign is UP - verified strangers can read open-or-closed."
              : "The open sign is DOWN - only granted peers see your presence.",
            options: [
              { value: "on", label: "Put the sign up", hint: "verified strangers read open-or-closed only (free to them)" },
              { value: "off", label: "Take the sign down", hint: "strangers see nothing; back to peers-only (the default)" },
              BACK_OPTION as { value: "back"; label: string },
            ],
            initialValue: current.public_enabled ? "off" : "on",
          });
          if (pick && !isBack(pick)) {
            const result = await setPublicPresence(pick);
            process.stdout.write("\n" + result + "\n");
            await pressEnterToReturn();
          }
          break;
        }
        case "share":
          // Source-sharing view renders inside the alt-screen (pure read-out).
          await runLeafInPane(crumb + "  ›  Source sharing", () => streamConsentView());
          break;
        case "data-revoke":
          // consentRevoke owns the consequence preview + confirm. It
          // prints via console.log / clack, so it runs in the normal buffer.
          await runConsentSubAction(crumb, () => consentDataRevokeFlow());
          break;
        case "get-queried":
          await runConsentSubAction(crumb, () => identityIncomeGetQueried());
          break;
        case "forget":
          await runConsentSubAction(crumb, () => forget([]));
          break;
      }
    } catch (err: any) {
      // A failed sub-action must not tear the dashboard down; surface it and
      // loop back to a fresh render.
      process.stdout.write(
        "\n  " + brand.accentDeep("⚠  ") + brand.text(err?.message ?? String(err)) + "\n",
      );
      await pressEnterToReturn();
    }
  }
}

/**
 * Collapsed grant/revoke for a peer-scoped consent (messaging, alignment).
 * Runs an in-frame Grant/Revoke/Back sub-pick (pickOne paints inline on the
 * held alt-screen - never the raw PTY), then prompts the peer ~handle via the
 * existing promptPeerHandle helper and dispatches the supplied grant/revoke
 * path through runConsentSubAction (also in-frame). Back at either step pops
 * one level without touching the consent. The header is re-drawn before the
 * sub-pick so it carries the same brand context as the parent picker.
 */
async function runPeerGrantRevoke(
  crumb: string,
  title: string,
  apply: (verb: "grant" | "revoke", handle: string) => Promise<void>,
): Promise<void> {
  drawActionHeader(crumb);
  const choice = await pickOne<"grant" | "revoke" | "back">({
    message: title,
    options: [
      { value: "grant", label: "Grant a peer", hint: "allow a ~handle" },
      { value: "revoke", label: "Revoke a peer", hint: "remove a ~handle" },
      BACK_OPTION as PickerOption<"grant" | "revoke" | "back">,
    ],
  });
  if (isBack(choice)) return;
  const r = await promptPeerHandle(
    choice === "grant" ? "~handle to allow" : "~handle to revoke",
  );
  if (r.cancelled) return;
  await runConsentSubAction(crumb, () => apply(choice, r.handle));
}

/**
 * Run a sub-action IN-FRAME: clear the alt-screen, draw the breadcrumb header,
 * run the handler (its console.log / process.stdout output and any inline
 * picker confirm paint on the cleared alt-screen), then press-enter back to
 * the dashboard. It does NOT exitAlt() - the persistent alt-screen is held
 * throughout, so the sub-action never drops to the raw PTY (the prior
 * defect). Mirrors customiseHub's in-alt cust-prompt path
 * (repaintActionScreen -> run -> pressEnterToReturn), not the normal-buffer
 * exit pattern.
 */
async function runConsentSubAction(
  crumb: string,
  fn: () => Promise<void>,
): Promise<void> {
  drawActionHeader(crumb);
  try {
    await fn();
    await pressEnterToReturn();
  } catch (err: any) {
    process.stdout.write(
      "\n  " + brand.accentDeep("⚠  ") + brand.text(err?.message ?? String(err)) + "\n",
    );
    await pressEnterToReturn();
  }
}

/**
 * Withdraw a data consent: pick the type from the live posture, then hand to
 * consentRevoke (which fetches the server-authored consequence preview and
 * confirms before the flip). Reads the member-level consent types
 * from the posture rather than asking the member to type a raw type string.
 */
async function consentDataRevokeFlow(): Promise<void> {
  const fetched = await fetchConsentPosture();
  const posture = fetched.kind === "ok" ? fetched.posture : null;
  const consents = (posture?.consents ?? []).filter((c) => c.status !== "revoked");
  if (!consents.length) {
    console.log("");
    console.log("  No active data consents to withdraw.");
    console.log("");
    return;
  }
  // pickOne paints inline; it works in the normal buffer here (the dashboard
  // has already exited the alt-screen via runConsentSubAction).
  const options = consents.map((c) => ({
    value: c.consent_type ?? "",
    label: c.consent_type ?? "consent",
    hint: c.status ?? "granted",
  }));
  const pick = await pickOne<string>({
    message: "Which data consent to withdraw?",
    options: [...options, BACK_OPTION as PickerOption<string>],
  });
  if (isBack(pick) || !pick) return;
  // consentRevoke owns the consequence preview + confirm + the POST.
  await consentRevoke([pick]);
}

// ---------------------------------------------------------------------------
// Consent > Daemon activity - READ-ONLY state view.
//
// Lists each consent-bearing alter-runtime behaviour with its controlling
// env var (when it has one), whether that env var is currently set in this
// environment, and the documented default. It WRITES NOTHING: in particular
// it never touches ~/.config/alter/runtime.yaml (a shipped daemon refuses to
// start if that file exists without ALTER_RUNTIME_DEV=1, verified at
// alter-runtime config.py:1019-1031). Behaviours + defaults are read from
// alter-runtime config.py. Turning these on/off is not yet a CLI control -
// that lands as a separate cross-platform piece. Platform-agnostic: env
// reads only, no /proc, no platform-specific paths.
// ---------------------------------------------------------------------------

interface DaemonBehaviour {
  label: string;
  /** Controlling env var, or null when there is no toggle. */
  envVar: string | null;
  /** Documented default when the env var is unset. */
  defaultOn: boolean;
  /**
   * How the env var maps to "on". Most flags are on-when-truthy; the desktop
   * notifier inverts (the var DISABLES it). null when there is no toggle.
   */
  sense: "enable" | "disable" | null;
  /**
   * Config field this behaviour maps to in daemon-toggles.json, or null when
   * the daemon accepts no member-set value for it.
   */
  field: DaemonToggleField | null;
  note?: string;
}

const DAEMON_BEHAVIOURS: DaemonBehaviour[] = [
  { label: "Active-sessions publisher", envVar: "ALTER_RUNTIME_DO_PUBLISH_ENABLED", defaultOn: true, sense: "enable", field: "do_publish_enabled", note: "surfaces your live sessions to peers" },
  { label: "Presence-feed writer", envVar: "ALTER_RUNTIME_PRESENCE_FEED_WRITER", defaultOn: true, sense: "enable", field: "presence_feed_writer_enabled" },
  // The note here used to read "configured in runtime.yaml only", which was
  // wrong: the daemon reads ALTER_SESSION_PRESENCE_ENABLED into
  // session_presence_enabled (alter_runtime/config.py, the _sp_flag block).
  // Corrected rather than carried, because the note was the reason this row
  // looked untoggleable.
  { label: "Session-presence poller", envVar: "ALTER_SESSION_PRESENCE_ENABLED", defaultOn: true, sense: "enable", field: "session_presence_enabled" },
  { label: "Attunement refresher", envVar: "ALTER_RUNTIME_ATTUNEMENT_REFRESH", defaultOn: true, sense: "enable", field: "attunement_refresh_enabled" },
  { label: "Desktop notifier", envVar: "ALTER_DESKTOP_NOTIFIER_DISABLED", defaultOn: true, sense: "disable", field: "desktop_notifier_enabled" },
  { label: "Identity-field subscriber", envVar: null, defaultOn: true, sense: null, field: null, note: "always on, no toggle" },
];

/**
 * Resolve a behaviour's current on/off state, in the daemon's own precedence
 * order: an explicit environment variable, then the member's saved choice,
 * then the built-in default. Mirrors alter_runtime/config.py, where the
 * toggles file is applied before any env read so the environment still wins.
 */
function resolveDaemonState(
  b: DaemonBehaviour,
  saved: Partial<Record<DaemonToggleField, boolean>>,
): { on: boolean; source: "env" | "you" | "default" } {
  const savedValue = b.field ? saved[b.field] : undefined;
  const fallback: { on: boolean; source: "you" | "default" } =
    savedValue === undefined
      ? { on: b.defaultOn, source: "default" }
      : { on: savedValue, source: "you" };
  if (!b.envVar || b.sense === null) return fallback;
  const raw = process.env[b.envVar];
  if (raw === undefined || raw.trim() === "") return fallback;
  // Truthy parse: "1", "true", "yes", "on" (case-insensitive) read as set-true.
  const truthy = /^(1|true|yes|on)$/i.test(raw.trim());
  // "enable" sense: truthy env means on. "disable" sense inverts.
  const on = b.sense === "disable" ? !truthy : truthy;
  return { on, source: "env" };
}

async function daemonActivityView(): Promise<void> {
  process.stdout.write("\n");
  process.stdout.write("  " + brand.titleDim("Daemon activity") + "\n");
  process.stdout.write(
    "  " + brand.faint("what the local alter-runtime daemon does, and which behaviours are on.") + "\n\n",
  );

  const { toggles: saved, error: savedError } = readDaemonToggles();
  if (savedError) {
    // Shown rather than swallowed: the daemon treats this same condition as
    // fatal and will not start, so rendering defaults over the top of it would
    // describe a process that is not running.
    process.stdout.write(
      "  " + brand.marker("Your saved settings could not be read.") + "\n" +
      "  " + brand.faint(savedError) + "\n" +
      "  " + brand.faint("The daemon refuses to start on this rather than turn your") + "\n" +
      "  " + brand.faint("choices back on silently. Changing anything below rewrites the file.") + "\n\n",
    );
  }

  for (const b of DAEMON_BEHAVIOURS) {
    const { on, source } = resolveDaemonState(b, saved);
    const stateLabel = on ? brand.accent("on ") : brand.dim("off");
    const defaultLabel = brand.faint(`default ${b.defaultOn ? "on" : "off"}`);
    const sourceLabel =
      source === "env" && b.envVar
        ? brand.faint(` · set by ${b.envVar}`)
        : source === "you"
          ? brand.faint(" · you set this")
          : brand.faint(" · default");
    process.stdout.write(
      "  " + stateLabel + "  " + brand.text(b.label) +
        "  " + brand.dim("(") + defaultLabel + sourceLabel + brand.dim(")") + "\n",
    );
    if (b.note) {
      process.stdout.write("       " + brand.faint(b.note) + "\n");
    }
  }

  process.stdout.write("\n");

  const togglable = DAEMON_BEHAVIOURS.filter((b) => b.field !== null);
  const pinnedByEnv = togglable.filter(
    (b) => resolveDaemonState(b, saved).source === "env",
  );
  if (pinnedByEnv.length > 0) {
    process.stdout.write(
      "  " +
        brand.faint(
          "Rows marked 'set by' are pinned by an environment variable on this host,",
        ) +
        "\n  " +
        brand.faint("which outranks anything set here. Unset the variable to change them.") +
        "\n\n",
    );
  }

  const choice = await pickOne<string>({
    message: "Change a behaviour?",
    options: [
      ...togglable.map((b) => {
        const { on } = resolveDaemonState(b, saved);
        return {
          value: b.field as string,
          label: `Turn ${on ? "off" : "on"}  ${b.label}`,
        };
      }),
      BACK_OPTION,
    ],
  });
  if (choice === null || isBack(choice)) return;

  const target = togglable.find((b) => b.field === choice);
  if (!target || !target.field) return;
  const { on: currentlyOn } = resolveDaemonState(target, saved);

  try {
    setDaemonToggle(target.field, !currentlyOn);
  } catch (err) {
    process.stdout.write(
      "\n  " +
        brand.marker(`Could not save: ${(err as Error).message}`) +
        "\n  " +
        brand.faint(`Nothing changed. The file is ${daemonTogglesFile()}.`) +
        "\n\n",
    );
    return;
  }

  process.stdout.write(
    "\n  " +
      brand.accent(`${target.label} is now ${currentlyOn ? "off" : "on"}.`) +
      "\n",
  );
  // Said plainly because the daemon reads this file once, at startup. A member
  // who saw the line above and assumed it took effect immediately would be
  // wrong for as long as the current process lives, and the behaviour they
  // just turned off would keep running with nothing to say so.
  process.stdout.write(
    "  " +
      brand.faint("Takes effect when the daemon next starts, which is your next login") +
      "\n  " +
      brand.faint("unless you restart it now with alter-runtime start.") +
      "\n\n",
  );
}

// ---------------------------------------------------------------------------
// Shared handle-entry prompt. Every place the menu asks for a peer ~handle
// routes through here so the trill (~) is ALWAYS visible and can NEVER be
// edited away:
//
//  - `textInput` with `lockedPrefix: "~"` renders the trill as an accent
//    prefix the cursor cannot enter - backspace at the boundary is a no-op,
//    so the field shows "~handle" by construction rather than by post-hoc
//    re-normalisation (the prior prefill could be deleted).
//  - The input's footer SHOWS the way out (`⏎ confirm  esc back`) - the
//    prior clack prompt offered no visible navigation at all.
//  - `validate` runs on submit, so a malformed body is rejected in-field
//    with the canonical message rather than throwing at dispatch.
//
// Returns the normalised ~handle, or {cancelled:true} when the user pressed
// Esc. ensureTilde is the single normaliser (src/commands/handle.ts).
// ---------------------------------------------------------------------------

type HandlePromptResult =
  | { cancelled: true }
  | { cancelled: false; handle: string };

async function promptPeerHandle(message: string): Promise<HandlePromptResult> {
  const entered = await textInput({
    message,
    lockedPrefix: "~",
    placeholder: "handle",
    validate: (v) => {
      const s = v.trim();
      if (!s || s === "~") return "Type a handle after the ~, or press esc to go back.";
      if (!isValidHandle(ensureTilde(s))) {
        return "Enter a valid handle - letters, digits and hyphens only.";
      }
      return;
    },
  });
  if (entered === null) return { cancelled: true };
  // ensureTilde is the functional guarantee: lowercase + canonical form. It
  // cannot throw here - validate already accepted the value.
  return { cancelled: false, handle: ensureTilde(entered) };
}

// ---------------------------------------------------------------------------
// Room > Verify someone - pick the subject kind, prompt, delegate to verify()
// ---------------------------------------------------------------------------

async function verifyPeerFlow(): Promise<void> {
  // The locked-trill input cannot double as an email field, so the two
  // subject kinds split into an explicit picker - which also puts an
  // on-screen Back row in front of the flow.
  const kind = await pickOne<"handle" | "email" | "back">({
    message: "Verify someone",
    options: [
      { value: "handle", label: "By ~handle", hint: "is this ~handle known to the field?" },
      { value: "email", label: "By email", hint: "is this email known to the field?" },
      BACK_OPTION as { value: "back"; label: string },
    ],
  });
  if (isBack(kind)) return;

  let subject: string;
  if (kind === "handle") {
    const result = await promptPeerHandle("~handle to verify");
    if (result.cancelled) return;
    subject = result.handle;
  } else {
    const entered = await textInput({
      message: "Email to verify",
      placeholder: "name@example.com",
      validate: (v) => {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())) {
          return "Enter a valid email address.";
        }
        return;
      },
    });
    if (entered === null) return;
    subject = entered.trim();
  }
  // interactive: verify() throws instead of process.exit on error paths so
  // the menu's try/catch + pressEnterToReturn handles it without tearing
  // down the alt-screen.
  await verify([subject], { interactive: true });
}

// ---------------------------------------------------------------------------
// Room > Thread with peer - prompt for a ~handle then open the thread view
// ---------------------------------------------------------------------------

async function msgThreadFlow(): Promise<void> {
  // Trill-prefilled, cancellable handle entry (the ~ is visible from the
  // first frame; Esc returns cleanly to the menu without tearing the
  // alt-screen down). This is the entry form the user reported as missing
  // the visible ~.
  const result = await promptPeerHandle("Peer handle for thread view:");
  if (result.cancelled) return;
  // msg thread runs inside the biosMenu alt-screen and renders a
  // line-oriented thread listing inline (cmdThread in msg.ts) - it does NOT
  // open the full-screen messenger. ensureTilde already applied.
  await msg(["thread", result.handle]);
}

// ---------------------------------------------------------------------------
// Sources - the pairing hub. One screen answers "what's connected, what is
// each source feeding my identity, and am I queryable yet" before offering
// the actions (pair / sharing / disconnect). Reworked from a bare
// three-option picker. Data: the connections-status
// diagnostic endpoint (same source as `alter pair status`), falling back to
// the plain connections list when the diagnostic is unavailable.
// (manageTools is gone on both sides of the 2026-06-05 merge: Devs & agents
// dispatches wire/unwire directly as flat rows, and the starship binding
// lives in Customise › Shell prompt.)
// ---------------------------------------------------------------------------

interface SourcesHubConnection {
  platform: string;
  platform_username: string | null;
  // Human-readable display name (from profile_data.name), populated for
  // platforms that guarantee no stable handle (google, amazon). Optional
  // on the wire - older backends predate the field. Prefer this over
  // platform_username when present; fall back when absent.
  display_name?: string | null;
  connected_at: string | null;
  disconnected_at: string | null;
  profile_data_present: boolean;
  extracted_traits_count: number;
}

interface SourcesHubStatus {
  connections: SourcesHubConnection[];
  trait_vector: {
    exists: boolean;
    version: number | null;
    non_null_trait_count: number;
    computed_at: string | null;
  };
  summary: {
    paired_count: number;
    active_count: number;
    queryable_via_alter_alignment: boolean;
  };
}

async function fetchSourcesStatus(): Promise<SourcesHubStatus | null> {
  try {
    const { result } = await withLoadingCancel(async (signal) => {
      const resp = await apiCall("/api/v1/me/connections/status", { signal });
      if (resp && resp.ok) return (await resp.json()) as SourcesHubStatus;
      return null;
    });
    return result;
  } catch {
    // fall through to the plain-list fallback
  }
  return null;
}

/** Render the dashboard block above the action picker. */
function renderSourcesDashboard(status: SourcesHubStatus): void {
  const active = status.connections.filter((c) => !c.disconnected_at);

  process.stdout.write("\n");
  if (active.length === 0) {
    process.stdout.write(
      "  " + brand.faint("Nothing paired yet. Pairing a source is how ~Alter") + "\n" +
      "  " + brand.faint("starts reading you - GitHub and Obsidian are live today.") + "\n\n",
    );
  } else {
    for (const c of active) {
      const label = c.display_name ?? c.platform_username;
      const name = label ? `  ${brand.dim(`(${label})`)}` : "";
      const when = c.connected_at ? `  ${brand.dim(`paired ${shortDate(c.connected_at)}`)}` : "";
      process.stdout.write(
        "  " + brand.accent(c.platform) + name + "  " + brand.text("active") + when + "\n",
      );
      const feeds =
        c.extracted_traits_count > 0
          ? `feeds ${c.extracted_traits_count} trait${c.extracted_traits_count === 1 ? "" : "s"}`
          : "no traits inferred yet";
      const profile = c.profile_data_present ? " · profile data on file" : "";
      process.stdout.write("     " + brand.faint(feeds + profile) + "\n");
    }
    process.stdout.write("\n");

    const tv = status.trait_vector;
    if (tv.exists) {
      const computed = tv.computed_at ? ` · computed ${shortDate(tv.computed_at)}` : "";
      process.stdout.write(
        "  " + brand.text("identity profile     ") +
          brand.dim(`${tv.non_null_trait_count} traits${computed}`) + "\n",
      );
    } else {
      process.stdout.write(
        "  " + brand.text("identity profile     ") + brand.dim("not yet computed") + "\n",
      );
    }
    process.stdout.write(
      "  " + brand.text("ready to be queried  ") +
        (status.summary.queryable_via_alter_alignment
          ? brand.accent("yes") + brand.dim("  (peers can run alignment queries - you earn)")
          : brand.dim("not yet - pair more, or let what's paired finish inferring")) +
        "\n\n",
    );
  }
}

async function manageSources(): Promise<void> {
  // Hub loop: re-render the dashboard after every action so the screen
  // always reflects what just changed (pairing, disconnecting).
  //
  // The status fetch is CACHED across iterations and re-fetched only
  // after a mutating action (pair / unpair). The previous shape hit the
  // network at the top of EVERY loop pass - so backing out of a read-only
  // leaf stalled the hub for a full round-trip each time.
  let status: SourcesHubStatus | null = null;
  let pairedFallback: Awaited<ReturnType<typeof fetchPaired>> = [];
  let stale = true;
  while (true) {
    if (stale) {
      status = await fetchSourcesStatus();
      if (!status) {
        // Diagnostic endpoint unavailable - fall back to the plain list so
        // the hub still works (degraded, not dead).
        pairedFallback = await fetchPaired();
      }
      stale = false;
    }

    let activePlatforms: string[];
    if (status) {
      renderSourcesDashboard(status);
      activePlatforms = status.connections
        .filter((c) => !c.disconnected_at)
        .map((c) => c.platform);
    } else {
      process.stdout.write("\n");
      if (pairedFallback.length === 0) {
        process.stdout.write("  " + brand.faint("No sources paired yet.") + "\n\n");
      } else {
        for (const c of pairedFallback) {
          const label = c.display_name ?? c.platform_username;
          const name = label ? `  ${brand.dim(`(${label})`)}` : "";
          process.stdout.write("  " + brand.accent(c.platform) + name + "\n");
        }
        process.stdout.write("\n");
      }
      activePlatforms = pairedFallback.map((c) => c.platform);
    }

    const options: { value: string; label: string; hint?: string }[] = [
      { value: "pair", label: "Pair a new source", hint: "shows what's available to your account" },
      ...(activePlatforms.length > 0
        ? [{ value: "sharing", label: "Source sharing", hint: "what each paired source may infer" }]
        : []),
      ...activePlatforms.map((platform) => ({
        value: `unpair:${platform}`,
        label: `Disconnect ${platform}`,
        hint: "inference stops; inferred values stay",
      })),
      BACK_OPTION,
    ];

    const choice = await pickOne({
      message: "Sources - your identity-data streams",
      options,
    });
    if (isBack(choice)) return;

    if (choice === "pair") {
      await pairInteractive(null);
      stale = true;
      continue;
    }
    if (choice === "sharing") {
      await streamConsentView();
      continue;
    }
    if (choice.startsWith("unpair:")) {
      const platform = choice.slice("unpair:".length);
      const ok = await confirmYesNo({
        message: `Disconnect ${platform}? Trait inference from this stream stops; existing inferred values stay.`,
        initialValue: false,
      });
      if (!ok) continue;
      if (platform === "obsidian") {
        // unpairObsidian handles local plugin cleanup (data.json, token file)
        // in addition to the backend unpair. unpairPlatform is backend-only.
        await unpairObsidian({ yes: true });
      } else {
        await unpairPlatform(platform);
      }
      stale = true;
      continue;
    }
  }
}


// ---------------------------------------------------------------------------
// Account > Passkeys - list + add picker
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Account > Contact email - the email shown on your handle.
// Distinct from the private auth login email (which is unchanged here).
//
// OTP-verified: the claimed address must prove control before it is set -
// POST /auth/contact-email dispatches a 6-digit code to the address, and
// only /confirm persists it on the backend (the source of truth). The
// local config.toml [homepage].contact_email is a display cache written
// exclusively through this ceremony (`config set` rejects the key).
// ---------------------------------------------------------------------------

async function contactEmailFlow(): Promise<void> {
  const { apiCall } = await import("../auth.js");
  const { writeContactEmailCache } = await import("./config.js");
  const { apiErrorMessage } = await import("../lib/api-error.js");
  const { withLoadingCancel } = await import("../ui/biosMenu.js");

  process.stdout.write("\n");
  process.stdout.write(
    "  " + brand.titleDim("Contact email") + "\n\n" +
    "  " + brand.faint("This is the email shown on your ~handle - not your login email.") + "\n" +
    "  " + brand.faint("Your login email is unchanged. New addresses are verified with a code.") + "\n\n",
  );

  // The backend record is the source of truth - read it, never the local
  // cache (which self-heals from this read).
  const currentWait = await withLoadingCancel(
    (signal) => apiCall("/api/v1/auth/contact-email", { method: "GET", signal }),
    "contact email",
  );
  if (currentWait.cancelled) return;
  const currentRes = currentWait.result;
  if (!currentRes) {
    console.error("Session expired. Run `alter login` again.");
    return;
  }
  if (currentRes.status === 404) {
    // Older backend without the verify ceremony: do nothing rather than
    // fall back to an unverified local write.
    process.stdout.write(
      "  " +
        brand.faint(
          "Verified contact email isn't available on this server yet - nothing was changed.",
        ) +
        "\n\n",
    );
    return;
  }
  if (!currentRes.ok) {
    const textBody = await currentRes.text();
    console.error(
      apiErrorMessage("read your contact email", currentRes.status, textBody),
    );
    return;
  }
  const currentBody = (await currentRes.json()) as {
    email?: string | null;
    verified_at?: string | null;
  };
  const current = currentBody.email ?? null;
  // Self-heal the display cache against the backend record.
  await writeContactEmailCache(current, currentBody.verified_at ?? null);

  if (current) {
    process.stdout.write(
      "  " + brand.text("Current: ") + brand.accent(current) +
      " " + brand.faint("(verified)") + "\n\n",
    );
  } else {
    process.stdout.write("  " + brand.faint("Not set.") + "\n\n");
  }

  const entered = await textInput({
    message: "Contact email (leave blank to clear)",
    initialValue: current ?? "",
    placeholder: "you@example.com",
    allowEmpty: true,
    validate: (v) => {
      const t = v.trim();
      if (t === "") return undefined; // blank clears the field
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t))
        return "Must be a valid email address (or blank to clear).";
      return undefined;
    },
  });
  // textInput returns null on esc - bail without touching the record.
  // (The previous isCancel() check tested for clack's cancel symbol,
  // which textInput never returns - so esc fell through as an empty
  // value and DELETED the saved address. Esc must mean "leave it".)
  if (entered === null) return;
  const val = entered.trim();

  if (val === "") {
    if (!current) {
      process.stdout.write("  " + brand.faint("Nothing to clear.") + "\n\n");
      return;
    }
    const delWait = await withLoadingCancel(
      (signal) => apiCall("/api/v1/auth/contact-email", { method: "DELETE", signal }),
      "clearing contact email",
    );
    if (delWait.cancelled) return;
    const delRes = delWait.result;
    if (!delRes) {
      console.error("Session expired. Run `alter login` again.");
      return;
    }
    if (!delRes.ok) {
      const textBody = await delRes.text();
      console.error(
        apiErrorMessage("clear your contact email", delRes.status, textBody),
      );
      return;
    }
    await writeContactEmailCache(null, null);
    process.stdout.write("  " + brand.faint("Contact email cleared.") + "\n\n");
    return;
  }

  if (current && val.toLowerCase() === current.toLowerCase()) {
    process.stdout.write(
      "  " + brand.faint("That address is already verified - nothing to do.") + "\n\n",
    );
    return;
  }

  // Step 1 - request: the backend sends a 6-digit code to the CLAIMED
  // address. Nothing is shown on the handle until the code confirms.
  const reqWait = await withLoadingCancel(
    (signal) =>
      apiCall("/api/v1/auth/contact-email", {
        method: "POST",
        body: { email: val },
        signal,
      }),
    "requesting code",
  );
  if (reqWait.cancelled) return;
  const reqRes = reqWait.result;
  if (!reqRes) {
    console.error("Session expired. Run `alter login` again.");
    return;
  }
  if (reqRes.status === 429) {
    console.error(
      "Too many requests - contact email can be requested 3 times an hour. Try again later.",
    );
    return;
  }
  if (reqRes.status === 422) {
    console.error("That email's domain can't receive mail. Check the address.");
    return;
  }
  if (!reqRes.ok) {
    const textBody = await reqRes.text();
    console.error(
      apiErrorMessage("set your contact email", reqRes.status, textBody),
    );
    return;
  }

  process.stdout.write(
    "\n  " +
      brand.text(`A 6-digit code was sent to ${val}.`) +
      "\n  " +
      brand.faint("It expires in 15 minutes. Enter it to verify the address.") +
      "\n\n",
  );

  // Step 2 - confirm: the code proves control of the address.
  const code = await textInput({
    message: "Verification code",
    placeholder: "123456",
    validate: (v) =>
      /^\d{6}$/.test(v.trim()) ? undefined : "Enter the 6-digit code.",
  });
  if (code === null) {
    process.stdout.write(
      "  " + brand.faint("Verification abandoned - nothing was changed.") + "\n\n",
    );
    return;
  }

  const confirmWait = await withLoadingCancel(
    (signal) =>
      apiCall("/api/v1/auth/contact-email/confirm", {
        method: "POST",
        body: { code: String(code).trim() },
        signal,
      }),
    "verifying code",
  );
  if (confirmWait.cancelled) return;
  const confirmRes = confirmWait.result;
  if (!confirmRes) {
    console.error("Session expired. Run `alter login` again.");
    return;
  }
  // 403 here is an OTP failure (wrong/expired code or attempts cap), not an
  // auth failure - intercept before the generic apiErrorMessage mapping,
  // whose 403 line reads as a session problem.
  if (confirmRes.status === 403) {
    const detail = await confirmRes.text();
    if (detail.includes("Too many failed attempts")) {
      console.error("Too many failed attempts - start again to get a new code.");
    } else {
      console.error(
        "That code didn't match (or it expired). Start again to get a new code.",
      );
    }
    return;
  }
  if (!confirmRes.ok) {
    const textBody = await confirmRes.text();
    console.error(
      apiErrorMessage("verify your contact email", confirmRes.status, textBody),
    );
    return;
  }

  await writeContactEmailCache(val, new Date().toISOString());
  process.stdout.write(
    "\n  " +
      brand.accent("Verified. ") +
      brand.text(`${val} now shows on your handle.`) +
      "\n\n",
  );
}

async function passkeysFlow(): Promise<void> {
  const choice = await pickOne({
    message: "Passkeys",
    options: [
      { value: "list", label: "List passkeys", hint: "what's currently bound" },
      { value: "add", label: "Add a passkey", hint: "browser ceremony" },
      BACK_OPTION,
    ],
  });
  if (isBack(choice)) return;
  if (choice === "add") {
    await passkey(["add"]);
    return;
  }
  await passkey(["list"]);
}
