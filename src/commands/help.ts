/**
 * alter help - flat command reference + topic deep-dives.
 *
 * `alter help` (no topic) prints the command list with a leading
 * "How you earn" narrative - the first thing a new user needs.
 * Topic args render a focused walkthrough:
 *
 *   alter help getting-started   First-run flow, end to end
 *   alter help earning           How Identity Income actually works
 *   alter help concepts          Vocabulary (~handle, attunement, etc.)
 *   alter help advanced          MCP wiring, space, peers, and more
 *
 * Topics are deliberately terminal-shaped. No URLs as primary CTAs;
 * every action shown is something the user can run from this CLI.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * D3: Detect whether the alter-runtime daemon or org-MCP is available.
 *
 * Shell-free PATH walk - mirrors which.ts but kept local to avoid a
 * circular dependency through the help module. Returns true when either:
 *   - ALTER_ORG_MCP_CMD is set (org-MCP configured), or
 *   - `alter-runtime` is found on $PATH (daemon installed).
 *
 * Used to gate daemon-required commands from the main help listing.
 */
function hasDaemonOrOrgMcp(): boolean {
  if (process.env.ALTER_ORG_MCP_CMD) return true;
  const pathEnv = process.env.PATH ?? "";
  const binary = "alter-runtime";
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      try {
        fs.accessSync(path.join(dir, binary + ext), fs.constants.F_OK);
        return true;
      } catch {
        // try next
      }
    }
  }
  return false;
}

const GETTING_STARTED = `
Getting started with Alter

  Alter is identity infrastructure: a verified vector that represents
  who you are, queryable by AI agents, organisations, and yourself.
  When something pays for that query, you earn.

  The whole flow lives in this terminal.

  1. Get a ~handle
       alter register
     No browser, no passkey. Pick a ~handle, confirm you are 18 or
     older, and you are in. Already have a ~handle? Run 'alter login'
     instead: it opens the browser once for OAuth + passkey ceremony.
     Either way a session lands in ~/.config/alter/session.json, and
     every other Alter tool reads from there.

  2. Pair an identity source
       alter pair
     Picks an identity-data source (GitHub, Obsidian) to connect.
     Each source contributes evidence - that's what makes your vector
     legible to agents that pay to query it.

  3. Turn earning on, then watch it work
       alter discovery enable
       alter status --since-last
       alter earnings
     You start OUTSIDE the field: until you run 'alter discovery enable'
     no caller can resolve you, and an unverified email blocks query
     earnings (verify it from the readiness check in the 'alter' menu).
     Once you are discoverable and your email is verified, income accrues
     as agents query you - then status and earnings show it moving.

  4. Set up a payout when you are ready
       alter wallet register
     Payout settles on-chain to a wallet you control; a bank off-ramp
     arrives in a later phase. Earnings accrue from the first query
     either way; the payout step opens at Augmented (L3).

  Tips
    alter help earning      How Identity Income actually flows
    alter help concepts     Vocabulary (~handle, attunement, ...)
`.trim();

const EARNING = `
How Identity Income works

  When an external agent or organisation pays to query your identity
  vector, 75% accrues to you as a licensing royalty. You see the
  running total in 'alter earnings', including what is still settling.

  How payout works

    Income settles on-chain, directly to a wallet you control - funds
    are never held by Alter. Set your payout address with:
      alter wallet register
    Earning never waits on this step: royalties accrue to your ledger
    from the first paying query, and settle to your address once it is
    on file and settlement is live.

    To turn settled USDC into your local currency, run:
      alter cash-out
    It points you to licensed providers you choose from; you sell on
    their site and they pay you. Alter holds no funds and takes no fee.

    A bank off-ramp (no crypto required) arrives in a later phase, as
    a non-custodial path where a licensed intermediary holds the
    balance, never Alter.

  What earns you money

    • External AI agents querying your identity vector via the
      public MCP server.
    • Organisations paying for verified attestations (capability
      milestones, role fit, reference checks).
    • The cooperative split is fixed and enforced in code:
      75% goes to you. The rest keeps the protocol honest.

  How to grow it

    More signal makes your vector more legible - and more legible
    vectors are queried more.

       alter pair          Pair a new identity source
       alter status        Identity record - attunement, engagement, traits
       alter earnings      See what's already arrived

  What you can do from the terminal

       alter wallet              Show current payout method + status
       alter wallet register     Set or change your payout wallet
       alter earnings            Balance, recent activity, totals
       alter earnings ledger     Full paginated ledger
       alter earnings summary    Annual financial-year summary
       alter cash-out            Convert settled USDC to cash via a
                                 licensed provider you choose
`.trim();

const ADVANCED = `
Advanced commands

  Runtime (requires alter-runtime daemon or ALTER_ORG_MCP_CMD)
    alter signals tail            Stream live identity signals from the daemon
    alter coord status            Active-session state from the daemon cache
    alter brief                   Morning brief from Org Alter (needs
                                  ALTER_ORG_MCP_CMD set)

  MCP wiring
    alter wire                    Install Alter into your MCP clients
                                  (Claude, Cursor, Claude Desktop, VS Code)
    alter unwire                  Reverse a previous wire

  Claude Code tooling
    alter hooks install           Install the curated CC substrate hooks
    alter hooks uninstall         Remove the substrate hooks
    alter skills install          Install CC skills + slash-commands
                                  (homework, go, handover, lessons-audit)
    alter skills uninstall        Remove the bundled skills + commands

  Space
    alter room                    Inhabited content panel - your identity
                                  card on top, granted-peer presence below
    alter room emit [state]       Broadcast presence as a ceremony
                                  (here | focus | open | quiet)
    alter msg                     Inbox - list unread messages
    alter msg send ~peer "text"   Send (requires prior grant from peer)
    alter msg thread ~peer        Bidirectional thread history
    alter msg grant ~peer         Allow peer to send to your inbox
    alter msg revoke ~peer        Revoke a prior grant
    alter config get [key]        Read layered TOML config
    alter config set <key> <val>  Write to the user layer
    alter config edit             Open $EDITOR on the user config file
    alter prompt install          Bind ~handle into your starship prompt

  Peers
    alter alignment grant ~peer   Authorise ~peer to query alignment with you
    alter alignment revoke ~peer  Revoke a prior grant
    alter alignment query ~peer   Compute alignment with ~peer (requires
                                  their grant first); --context defaults to
                                  peer_recognition (collaboration_fit |
                                  co_founder_signal also accepted).
                                  Routes via ALTER_MCP_CMD.
    alter pair status             Pipeline diagnostic - paired sources,
                                  merged trait-vector state, and whether
                                  you are queryable via alter_alignment.

  Other
    alter logout                  Sign out and clean up
    alter forget                  Schedule erasure of your identity record
                                  (30-day grace; alter forget --cancel stops it)
    alter login --dry-run         Walk first-run setup without writing session
    alter login --bridge          OAuth, then run a localhost browser-setup
                                  bridge for pairing / wiring
    alter login --resume          Pick up a browser-first setup the
                                  browser already signed you in for
`.trim();

const CONCEPTS = `
Alter vocabulary

  ~handle              Your sovereign-tier identity. Three-tier
                       namespace: ~yourname is sovereign,
                       *.bot is bot tier, and instrument handles are
                       instrument tier.
                       Resolves via DNS TXT or the alter MCP server.

  Attunement           How deeply the identity field has read your identity record. Grows
                       through conversations, paired sources, and
                       agent self-audit. Levels: nascent → growing →
                       attuned → deep.

  Discovery            The assessment experience - never "test" or
                       "quiz". Adaptive, multi-channel.
                       ~25 seconds for The Encounter.

  Belonging            The measure of fit between people, teams, or
  Probability          contexts. Never "culture fit".

  Identity Income      Royalties from queries against your vector.
                       75% goes to you. The rest keeps the
                       protocol honest.

  Engagement Levels    L1 Explorer → L2 Learner → L3 Augmented →
                       L4 Deployed. Payout setup requires L3+.

  The Mirror           Day-2 shadow reveal. Typing effect, intimate
                       register. Ceremony-gated, not on demand.

  Naming Ceremony      L2 → L3 consent upgrade with a 4-phase visual
                       reveal binding your ~handle.

  Inferred identity    Your traits aren't declared, they're observed
                       in the patterns of how you engage.

  See more
       alter help getting-started
       alter help earning
`.trim();

export function help(args: string[]): void {
  const topic = args[0];

  if (!topic || topic === "--help" || topic === "-h") {
    printDefaultHelp();
    return;
  }

  switch (topic) {
    case "getting-started":
    case "start":
    case "first-run":
      console.log("");
      console.log(GETTING_STARTED);
      console.log("");
      return;
    case "earning":
    case "earnings":
    case "income":
      console.log("");
      console.log(EARNING);
      console.log("");
      return;
    case "concepts":
    case "vocab":
    case "vocabulary":
      console.log("");
      console.log(CONCEPTS);
      console.log("");
      return;
    case "advanced":
    case "adv":
      console.log("");
      console.log(ADVANCED);
      console.log("");
      return;
    default:
      console.error(`No help topic '${topic}'.`);
      console.error("");
      console.error("Topics: getting-started · earning · concepts · advanced");
      console.error("Run 'alter help' (no topic) for the full command list.");
      process.exitCode = 1;
      return;
  }
}

function printDefaultHelp(): void {
  // D3: only surface daemon-required commands when the environment has them.
  const daemonAvailable = hasDaemonOrOrgMcp();
  const daemonSection = daemonAvailable
    ? `\nRuntime  (requires alter-runtime or org-MCP)
  alter signals tail            Stream live identity signals
  alter coord status            Active session coordinator status
  alter brief                   Morning brief from Org Alter\n`
    : "";

  console.log(`
alter -- identity, in your hands.

Run 'alter' with no arguments for an interactive menu.

How you earn  (turn it on once, then it accrues)
  1. alter register             Claim your ~handle in the terminal, no
                                browser. Already have one? alter login
  2. alter pair                 Pair a source (GitHub, Obsidian) so agents
                                that pay to query you can read your vector
  3. alter discovery enable     Enter the field - you start outside it; no
                                caller can resolve you until you do
  4. alter earnings             Income accrues as you are queried; watch it

  Verify your email too: an unverified email blocks query earnings
  (verify it from the readiness check in the 'alter' menu).
  Payout comes later: 'alter wallet register' sets your payout wallet.
  It opens at Augmented (L3); earnings accrue until then.

Topic deep-dives
  alter help getting-started    First-run walkthrough
  alter help earning            How Identity Income actually works
  alter help concepts           Vocabulary (~handle, attunement, ...)
  alter help advanced           MCP wiring, space, peers, and more

Identity
  alter register                Claim a ~handle - no browser, no passkey.
                                --handle ~name --i-am-18 --accept-terms
                                registers headlessly, with no prompts
  alter login                   Sign in when you already have a ~handle
  alter status [--since-last]   Identity, attunement, paired sources;
                                --since-last shows what changed
  alter whoami                  ~handle + session metadata
  alter consent list            Show consent grants on your profile
  alter consent automated-decisions
                                Read how matching decides about you, and
                                acknowledge or withdraw. Until you
                                acknowledge, matching does not run for you
  alter contest                 Dispute a decision, score or restriction
                                Alter recorded about you. Asks what is wrong
                                in plain words; every step after is mechanical
  alter contest status <ref>    Read a lodged claim back: its standing, and
                                whether a triggered recompute has finished
  alter portfolio               Trait portfolio (categories, archetype)
  alter style                   Cognitive/communication style profile
  alter traits                  How your trait vector has evolved over time
  alter verify <subject>        Verify a UUID, email or ~self (needs login)
  alter ask --trait c:w ...     Query the field by situation, not by name
                                (needs login; ask your AI assistant for the
                                natural-language version). Costs $1.00/call
  alter discovery status        Choose what a field caller can see of you;
                                graduated per-attribute consent (needs login)
  alter discovery preview       What a caller sees + your Identity Income
  alter audit                   Print local signals first-run reads -
                                never authenticates, never writes,
                                never uploads

Sources
  alter pair [id]               Pair a source. Omit [id] for an
                                interactive picker showing what's
                                live for your account
  alter pair github             GitHub OAuth device-code flow (no web)
  alter connections             Show paired sources
  alter unpair <id>             Disconnect a paired source

Income
  alter earnings                Balance + last 10 ledger entries
  alter earnings ledger         Full paginated ledger (--limit N)
  alter earnings summary        Annual financial-year summary (AU FY)
  alter wallet                  Show current payout method + status
  alter wallet register         Set your payout wallet (EVM address)
  alter wallet register --crypto <0x...>   Same, with the address inline
  alter wallet clear            Clear the registered EVM address

Account
  alter passkey add | list | remove <id>
  alter password change | reset
  alter sessions revoke-all
  alter mfa setup | status | disable | authenticate
  alter key ...                 Member and agent-signing credentials
  alter handle ...              Handle availability and soft reservation
  alter creds verify            Quick credential health check
  alter creds doctor            Full credential diagnostic + auto-fix
  alter creds refresh           Rotate access token via refresh-token grant
${daemonSection}
More
  alter help advanced           MCP wiring, space, peers, config, and more

Login once. Authenticated everywhere - MCP servers, CC hooks, git
helpers all read ~/.config/alter/session.json.
`);
}
