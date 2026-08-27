/**
 * alter menu - tree construction, gated on MemberDepth (iterative-unlock).
 *
 * Extracted from menu.ts so the disclosure ladder is unit-testable without
 * pulling the whole command-handler graph. menu.ts owns the control flow
 * (alt-screen, leaf dispatch); this module owns the tree DATA and which
 * leaves are revealed at which member depth.
 *
 * Six-zone layout: Me / Queries / Identity Income /
 * Messages (top-level leaf) / Account / Devs & agents above a single rule;
 * below it the meta/exit footer (About zone, Log out, Exit). The Room zone
 * rows (presence, open sign, thread-with-a-peer) and the quota row
 * (ii-status) are deferred: rows hidden, handlers kept in menu.ts.
 *
 * Two disclosure modes:
 *  - GROW  - a row is absent until it has content, then appears (empty
 *            content-surfaces: Identity profile, Who queried me, Earnings).
 *  - RIPEN - a row is always present; its hint flips from an honest
 *            "still accruing, opens at Augmented" line to the live action
 *            (Pay-out method, Withdraw). Keeps the room from hiding the
 *            truth that Identity Income accrues before it can be withdrawn.
 *
 * Recognition over Qualification: no levels earned, no progress %, no badge.
 * A capability surfaces because it became real, not as a reward.
 */

import { brand, type MenuNode } from "../ui/biosMenu.js";
import type { MemberDepth } from "../lib/member-depth.js";
import { FIAT_RAIL_LIVE } from "./wallet.js";

/** Sub-Augmented (below L3) ripen hints for the income action rows. */
const PAYOUT_HINT_PRE_L3 =
  "Identity Income accrues now - set where it lands at Augmented";
const PAYOUT_HINT_L3 = FIAT_RAIL_LIVE
  ? "bank account or crypto destination"
  : "the wallet your income settles to";
const WITHDRAW_HINT_PRE_L3 =
  "withdraw opens at Augmented; your earnings accrue until then";
const WITHDRAW_HINT_L3 = "to your configured pay-out method";

/**
 * Build the menu tree, revealing capabilities by member depth. The working
 * zones (Me, Queries, Identity Income, Messages, Account, Devs & agents)
 * sit above a single rule; below it sits the meta/exit region (About,
 * Log out, Exit) - rows about the program itself or that leave it.
 * Pure: same depth → same tree. No I/O.
 */
export function buildMenuTree(depth: MemberDepth): MenuNode[] {
  const onboardingIncomplete = !depth.onboardingSettled;
  const augmented = depth.engagementLevel >= 3;

  return [
    ...(onboardingIncomplete
      ? [
          {
            value: "resume-onboarding",
            label: "Finish setting up ~alter",
            hint: "pick up where you left off - pairing, tools, the rest",
          },
        ]
      : []),
    {
      value: "me",
      label: "Me",
      hint: "who you are, what's been observed",
      children: [
        { value: "status", label: "Status", hint: "your identity now: attunement, standing, what's changed" },
        // GROW: Identity profile appears once there is a vector to show
        // (trait_count / attunement / level ≥ 2) - not merely once a source
        // is paired. Opening it cold would land on nothing. The leaf opens
        // a two-row picker in menu.ts (tiers & archetype / how they've
        // shifted); the old separate "Traits over time" row is consolidated
        // into it.
        ...(depth.hasVector
          ? [{ value: "identity-profile", label: "Identity profile", hint: "trait tiers, archetype, style, and how they've shifted" }]
          : []),
        // Observations is the grounded record of what ~Alter has observed
        // (trace); menu.ts opens it directly in the bordered scroll pane. The
        // old "Log a moment" / Looking Log row was removed.
        { value: "observations", label: "Observations", hint: "the grounded record of what ~alter has observed" },
        // Customise nests under Me as a picker flow in menu.ts (biosMenu
        // renders one nesting level only); the seven customisation rows
        // keep their labels and hints verbatim inside the picker.
        { value: "customise", label: "Customise", hint: "make it yours" },
      ],
    },
    {
      value: "queries-zone",
      label: "Queries",
      hint: "ask the Identity Field, and see who asked about you",
      children: [
        { value: "verify-peer", label: "Verify someone", hint: "free check: is this ~handle known to the Identity Field" },
        // The field query: you describe the shape of who you're looking for
        // and the opted-in Field is ranked - the subject is NOT known. Peer
        // alignment (a query against a KNOWN ~handle) is the row below.
        { value: "ii-query", label: "Query the Identity Field", hint: "describe who you need, the Field is ranked" },
        { value: "ii-align", label: "Query someone", hint: "alignment with a ~handle you know, price shown before you confirm" },
        // GROW: Who-queried-me appears once you have actually been queried.
        ...(depth.hasBeenQueried
          ? [{ value: "queries", label: "Who queried me", hint: "who looked you up, and what each query earned you" }]
          : []),
        // ii-grants ("Who can query me") and ii-get-queried ("Get queried")
        // moved into the Consent zone: they are consent
        // levers, so they sit with the other consent controls. Their menu.ts
        // dispatch cases are unchanged - same handlers, reached from Consent.
      ],
    },
    {
      value: "identity-income",
      label: "Identity Income",
      hint: "what your identity earns, and where it lands",
      children: [
        // GROW: Earnings ledger appears once there is something in it - you
        // have been queried, or you are Augmented (income-capable).
        ...(depth.hasBeenQueried || augmented
          ? [{ value: "ii-earnings", label: "Earnings", hint: "30-day window, ledger, totals" }]
          : []),
        // RIPEN: pay-out stays present so accrual is never hidden; the hint
        // flips to the live action at Augmented (L3). Withdraw is a fiat-only
        // verb, so the row rides the phase gate with the Stripe rail - on the
        // crypto rail settlement is per-query, there is nothing to withdraw.
        { value: "ii-payout", label: "Pay-out method", hint: augmented ? PAYOUT_HINT_L3 : PAYOUT_HINT_PRE_L3 },
        // Cash out appears once income is relevant: it turns settled USDC into
        // local currency via a licensed provider the member chooses. Unlike
        // Withdraw (a fiat-rail verb behind the phase gate) this rides no gate,
        // because it moves no money through Alter - it is a hand-off to the
        // provider's own site, so it is always safe to surface.
        ...(depth.hasBeenQueried || augmented
          ? [{ value: "ii-cashout", label: "Cash out", hint: "turn settled USDC into cash via a licensed provider you choose" }]
          : []),
        ...(FIAT_RAIL_LIVE
          ? [{ value: "ii-withdraw", label: "Withdraw", hint: augmented ? WITHDRAW_HINT_L3 : WITHDRAW_HINT_PRE_L3 }]
          : []),
      ],
    },
    // Consent is one interactive dashboard, not a list of links.
    // A single leaf opens a sovereignty-dashboard view: it renders the
    // whole consent posture at a glance (who can reach you, who can query you,
    // the open sign, what you share, your data consents, what was granted to
    // you, daemon activity) and lets you act on it inline. The earlier link
    // zone with eight child rows was not a hub, just scattered links; this
    // replaces it. The underlying handlers it calls (grant/revoke, the open
    // sign, source sharing, get-queried, forget) are unchanged - the dashboard
    // is their single front door.
    { value: "consent", label: "Consent", hint: "your whole consent posture, and act on it in one place" },
    // Messages rides as a top-level leaf, not a zone: the messenger already
    // holds threads, live view, and compose.
    { value: "messages", label: "Messages", hint: "conversations, live threads, compose" },
    {
      value: "account",
      label: "Account",
      hint: "sign-in and session control",
      children: [
        // Sign-in credentials first (passkeys, password, login email), then
        // the public-facing address, then session control; lookup last.
        { value: "passkeys", label: "Passkeys", hint: "add or list" },
        { value: "password", label: "Password", hint: "change" },
        { value: "email", label: "Login email", hint: "change the email you sign in with" },
        { value: "contact-email", label: "Contact email", hint: "the email shown on your handle - verified before it's set" },
        { value: "sessions", label: "Sessions", hint: "sign out of all devices (you'll sign in again here)" },
        // Static row (not GROW-gated): the section 14 in-Service notice
        // channel. Always present so a member can check even when nothing
        // pinged them - the leaf fetches live on open and says "No
        // notices" when the list is empty.
        { value: "notices", label: "Notices", hint: "in-Service account and legal notices" },
        // Static row (not GROW-gated): the section 14 acceptance ledger -
        // distinct from Notices above (one-off pings) - which version of
        // the Terms and Privacy Policy you've accepted, and read/accept
        // the current one. Always present; the leaf fetches live on open.
        { value: "legal", label: "Terms & Privacy", hint: "which version you've accepted, read and accept the current one" },
        // "Handle availability" removed: a pre-signup
        // concern with no post-login value. The `alter handle check` verb
        // remains for the command line.
      ],
    },
    // Devs & agents rides with the working zones above the rule - it is
    // still a place you go to DO something. Sources consolidates here
    // (2026-06-06): pairing, readiness, and sharing are the inbound side
    // of the same surface whose outbound side is the MCP client installs.
    {
      value: "devs-agents",
      label: "Devs & agents",
      hint: "sources feeding identity in, tools reading it out",
      children: [
        { value: "sources", label: "Connected sources", hint: "what's paired, pair more, disconnect" },
        { value: "pair-status", label: "Source readiness", hint: "is each source feeding your profile yet" },
        // "Source sharing" (stream-consent) moved into the Consent zone:
        // per-source sharing is a consent lever, so it
        // sits with the other consent controls. Same handler, reached from
        // Consent. The Sources hub still surfaces it inline as a sub-action.
        ...(!depth.substrateActive
          ? [{ value: "cutover", label: "Quick connect", hint: "one click: Claude, Cursor, and VS Code" }]
          : []),
        { value: "wire", label: "Install ~Alter into MCP clients", hint: "Claude, Cursor, Claude Desktop, VS Code, OpenClaw" },
        { value: "unwire", label: "Uninstall from all MCP clients", hint: "removes ~Alter everywhere, type the name to confirm" },
      ],
    },
    // Rule-separated meta/exit footer: rows about the program itself
    // (About) or that leave the room (Log out, Exit) - not another zone.
    { value: "__rule__", label: brand.borderDim("─────") },
    {
      value: "about-zone",
      label: "About",
      hint: "what ~alter is",
      children: [
        { value: "orientation", label: "What is ~alter?", hint: "what this is, how it works, what's next" },
        { value: "about", label: "Version", hint: "version, build, where it's installed" },
        { value: "update", label: "Check for updates", hint: "check for a newer version and install it" },
        { value: "doctor", label: "Doctor", hint: "diagnose the install - identity, MCP, runtime, config" },
      ],
    },
    { value: "logout", label: "Log out", hint: "sign out of this device" },
    { value: "exit", label: "Exit", hint: "close ~alter" },
  ];
}
