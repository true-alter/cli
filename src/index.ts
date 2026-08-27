#!/usr/bin/env node

/**
 * ALTER CLI -- identity infrastructure. Where your identity earns.
 *
 * Run `alter` with no arguments for an interactive menu. Power-user
 * verbs stay available for scripting:
 *
 *   alter register           -- create a new member in-terminal (no browser)
 *   alter login              -- authenticate via browser (OAuth PKCE)
 *   alter update             -- force a self-update check (npm channel)
 *   alter audit              -- print exactly what beat 1 reads (no auth)
 *   alter whoami             -- show current identity
 *   alter status             -- full identity + org status (--since-last for diff)
 *   alter about              -- installed version, build, where it lives
 *   alter help [topic]       -- command reference + topic deep-dives
 *                               (getting-started | earning | concepts)
 *   alter wire               -- install ALTER into your MCP clients
 *   alter unwire             -- reverse a previous wire
 *   alter hooks install      -- install Claude Code substrate hooks
 *   alter hooks uninstall    -- remove the substrate hooks
 *   alter skills install     -- install Claude Code skills + slash-commands
 *   alter skills uninstall   -- remove the bundled skills + commands
 *   alter pair [id]          -- pair an identity-data source
 *   alter pair status        -- pairing-pipeline diagnostic
 *   alter unpair <id>        -- disconnect a paired platform
 *   alter connections        -- list paired connections
 *   alter alignment ...      -- peer-to-peer trait queries (grant/query/revoke)
 *   alter passkey ...        -- manage passkeys
 *   alter password ...       -- rotate or reset the password
 *   alter sessions ...       -- session management
 *   alter logout             -- revoke session and clean up
 *   alter forget             -- schedule erasure of your identity record
 *                               (30-day grace; `--cancel` stops it)
 *   alter mfa ...            -- TOTP multi-factor lifecycle
 *   alter key ...            -- member and agent-signing credentials
 *   alter handle ...         -- ~handle availability and soft reservation
 *   alter wallet ...         -- payout setup (bank | crypto) + withdraw
 *   alter earnings ...       -- balance, ledger, annual summary
 *   alter consent list       -- show consent grants on your profile
 *   alter consent automated-decisions
 *                            -- read the Article 22 disclosure on matching,
 *                               and acknowledge or withdraw
 *   alter contest            -- dispute a decision or restriction Alter
 *                               recorded about you
 *   alter contest status <ref> -- read a lodged claim back: its standing,
 *                               and whether a triggered recompute finished
 *   alter accord ...         -- cryptographic agreements (initiate/respond/
 *                               sign/status) between two bound ~handles
 *   alter portfolio          -- your trait portfolio (member self-read)
 *   alter style              -- your cognitive/communication style profile
 *   alter traits             -- how your trait vector has evolved
 *   alter queries            -- audit log of x402 queries hit on you
 *   alter thread             -- Golden Thread (agents joined to the field)
 *   alter verify <subject>   -- verify whether a person is on ALTER (needs login)
 *   alter creds ...          -- diagnose + auto-fix credential problems
 *                               (verify | doctor | refresh)
 *   alter doctor             -- environment diagnose + self-heal
 *   alter config ...         -- layered TOML configuration (get/set/edit)
 *   alter prompt install     -- bind ~handle into shell prompt
 *   alter cc                 -- Path-1 PTY wrapper for Claude Code
 *                               (prefill scaffold)
 */

import {
  failNotLoggedIn,
  getSession,
  sweepSessionPlaintextResidue,
} from "./auth.js";
import { affirmKeyringRuntime } from "./secure-store.js";
import { sweepSigningPlaintextResidue } from "./signing.js";
import { sweepX25519PlaintextResidue } from "./x25519.js";
import { login } from "./commands/login.js";
import { register } from "./commands/register.js";
import { audit } from "./commands/audit.js";
import { whoami } from "./commands/whoami.js";
import { status } from "./commands/status.js";
import { logout } from "./commands/logout.js";
import { forget } from "./commands/forget.js";
import { brief } from "./commands/brief.js";
import { passkey } from "./commands/passkey.js";
import { mfa } from "./commands/mfa.js";
import { password } from "./commands/password.js";
import { sessions } from "./commands/sessions.js";
import { key } from "./commands/key.js";
import { handle } from "./commands/handle.js";
import { wire } from "./commands/wire.js";
import { unwire } from "./commands/unwire.js";
import { hooks } from "./commands/hooks.js";
import { skills } from "./commands/skills.js";
import { wallet } from "./commands/wallet.js";
import { consent } from "./commands/consent.js";
import { contest } from "./commands/contest.js";
import { accord } from "./commands/accord.js";
import { config } from "./commands/config.js";
import { prompt } from "./commands/prompt.js";
import { room } from "./commands/room.js";
import { msg } from "./commands/msg.js";
import { agent } from "./commands/agent.js";
import { signals } from "./commands/signals.js";
import { coord } from "./commands/coord.js";
import { earnings } from "./commands/earnings.js";
import { cashOut } from "./commands/cash-out.js";
import { help as helpCommand } from "./commands/help.js";
import {
  pairInteractive,
  fetchPaired,
  renderPaired,
  unpairPlatform,
} from "./commands/discover.js";
import { unpairObsidianFromArgs } from "./commands/pair-obsidian.js";
import {
  pairGithubFromArgs,
  unpairGithubFromArgs,
} from "./commands/pair-github.js";
import { pairStatus } from "./commands/pair-status.js";
import { alignment } from "./commands/alignment.js";
import { ingest } from "./commands/ingest.js";
import { excitations } from "./commands/excitations.js";
import { menu } from "./commands/menu.js";
import { portfolio } from "./commands/portfolio.js";
import { style } from "./commands/style.js";
import { traits } from "./commands/traits.js";
import { queries } from "./commands/queries.js";
import { thread } from "./commands/thread.js";
import { verify } from "./commands/verify.js";
import { ask } from "./commands/ask.js";
import { discovery } from "./commands/discovery.js";
import { org } from "./commands/org.js";
import { creds } from "./commands/creds.js";
import { doctor } from "./commands/doctor.js";
import { about } from "./commands/about.js";
import { doctrine } from "./commands/doctrine.js";
import { uninstall } from "./commands/uninstall.js";
import { runCcWrapper } from "./cc-wrapper/index.js";
import { mcpBridge } from "./commands/mcp-bridge.js";
import { runtime } from "./commands/runtime.js";
import { appendFileSync, mkdirSync, realpathSync } from "fs";
import { fileURLToPath } from "node:url";
import {
  getAutoUpdateStatus,
  maybeAutoUpdate,
  pickMode,
  setAutoUpdate,
} from "./lib/self-update.js";
import { getCliVersion } from "./lib/version.js";
import {
  checkNodeFloor,
  ensureNodeFloorForSelfUpdate,
} from "./lib/node-floor.js";
import { preflightFloorForCli } from "./lib/floor-preflight.js";
import { runSessionNoticeCheck } from "./lib/session-notices.js";
import {
  parseOutputFormatFlag,
  shouldEmitJsonEnvelope,
} from "./lib/output-format.js";

// Parse --output-format BEFORE command dispatch so it can flow into the
// preflight.
const { format: outputFormatFlag, args: dispatchArgs } = parseOutputFormatFlag(
  process.argv.slice(2),
);
const args = dispatchArgs;
const command = args[0];

const SELF_UPDATE_BYPASS_COMMANDS = new Set<string>([
  "version",
  "--version",
  "-v",
  "help",
  "--help",
  "-h",
  "update",
  "audit",
  // `about` is a local read (version, install path, runtime); no need
  // to gate it behind a self-update network ping.
  "about",
  // `creds` runs the credential diagnostic; piping it through a
  // self-update check would muddy a fast "is my session alive?"
  // probe with unrelated network I/O.
  "creds",
  // `doctor` must run even when the self-update preflight is what is
  // broken -- that is a core use case for the diagnostic.
  "doctor",
  // `signals` and `coord` are local-read verbs (daemon-owned JSONL).
  // No network needed for the happy path; bypass the self-update
  // ping so they stay snappy and offline-friendly.
  "signals",
  "coord",
  // `doctrine` with --if-stale is a near-instant no-op when cache is fresh.
  // Bypass the self-update ping so hook-invoked syncs don't stall.
  "doctrine",
  "mcp-bridge",
  // `runtime verify` is the alter-runtime apply-step's tight verify-before-exec
  // shell-out. Piping it through a self-update check would let a background
  // self-install fire as a side effect of a security-critical verification
  // call; keep it offline-friendly and side-effect-free.
  "runtime",
  // Detached background self-update worker: it must never trigger a self-update
  // check on itself, or it would recursively spawn.
  "__bg-update",
]);

// Same shape as SELF_UPDATE_BYPASS_COMMANDS but kept as its own list rather
// than shared: the two checks are unrelated (version ping vs. legal-notice
// ping) and a future edit to one bypass reason should never silently change
// the other. Excludes the same fast/local/offline-friendly verbs, plus the
// pre-auth and session-ending verbs where a notices fetch is either
// impossible (no session yet) or pointless (session about to end).
const SESSION_NOTICE_BYPASS_COMMANDS = new Set<string>([
  "version",
  "--version",
  "-v",
  "help",
  "--help",
  "-h",
  "update",
  "audit",
  "about",
  "creds",
  "doctor",
  "signals",
  "coord",
  "doctrine",
  "mcp-bridge",
  "runtime",
  "__bg-update",
  "login",
  "register",
  "logout",
  "forget",
]);

/**
 * Best-effort session-start check for the served Terms section 14
 * "notice within the Service" channel. Fire-and-forget, exactly like
 * `runSelfUpdateCheck`: never awaited by a caller that needs to gate on
 * it, never lets a slow/offline endpoint delay the active command.
 *
 * Deliberately NOT called for the interactive-menu path - see the
 * doc-comment on `runSessionNoticeCheck` in session-notices.ts for why
 * (the menu's alt-screen would wipe a stderr notice before it's seen; the
 * menu instead carries a static Account > Notices row).
 */
async function runNoticeCheck(): Promise<void> {
  if (command !== undefined && SESSION_NOTICE_BYPASS_COMMANDS.has(command)) {
    return;
  }
  try {
    await runSessionNoticeCheck();
  } catch {
    // Best-effort; never block the active command.
  }
}

function printVersion(): void {
  console.log(`alter ${getCliVersion()}`);
}

function printHelp(args: string[] = []): void {
  helpCommand(args);
}

async function runSelfUpdateCheck(): Promise<void> {
  if (command !== undefined && SELF_UPDATE_BYPASS_COMMANDS.has(command)) {
    return;
  }
  // The background auto-update ends in a sigstore verification, which needs the
  // Node self-update floor. On an older runtime, silently skip the check so the
  // active command runs clean and unguarded (no verifier noise); the explicit
  // `alter update` command surfaces the upgrade prompt instead.
  if (checkNodeFloor().belowFloor) {
    return;
  }
  const mode = pickMode(command);
  try {
    await maybeAutoUpdate({
      currentVersion: getCliVersion(),
      command,
      mode,
    });
  } catch {
    // Self-update is best-effort; never block the active command.
  }
}

async function runBackgroundUpdate(): Promise<void> {
  // Detached worker spawned by the async self-update path. Verifies and
  // silently installs a newer release, then exits. No user-facing output;
  // diagnostics append to ~/.cache/alter/self-update.log.
  // The background worker's whole job is the sigstore-verified install, which
  // needs the Node self-update floor. On an older runtime there is nothing safe
  // to do, so exit quietly rather than exercise the verifier.
  if (checkNodeFloor().belowFloor) {
    return;
  }
  const logLine = (line: string): void => {
    try {
      const cacheRoot =
        process.env.XDG_CACHE_HOME ?? `${process.env.HOME ?? ""}/.cache`;
      const dir = `${cacheRoot}/alter`;
      mkdirSync(dir, { recursive: true });
      appendFileSync(
        `${dir}/self-update.log`,
        `${new Date().toISOString()} ${line}\n`,
      );
    } catch {
      // Logging is best-effort.
    }
  };
  try {
    await maybeAutoUpdate({
      currentVersion: getCliVersion(),
      command: "__bg-update",
      mode: "background",
      force: true,
      deps: { stderr: logLine },
    });
  } catch {
    // Never throw from the background worker.
  }
}

export async function runPublicCommand(args: string[]): Promise<void> {
  const command = args[0];
  switch (command) {
    case undefined:
      if (process.stdout.isTTY && process.stdin.isTTY) {
        await menu();
      } else {
        printHelp();
      }
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp(args.slice(1));
      break;
    case "version":
    case "--version":
    case "-v":
      printVersion();
      break;
    case "__bg-update":
      // Detached background self-update worker (spawned by the async path).
      await runBackgroundUpdate();
      break;
    case "update":
      {
        // `alter update auto off|on|status` - persist the auto-update opt-out.
        if (args[1] === "auto") {
          const verb = args[2];
          if (verb === "off") {
            setAutoUpdate(false);
            console.log(
              "alter: automatic updates disabled. Re-enable with `alter update auto on`.",
            );
          } else if (verb === "on") {
            setAutoUpdate(true);
            console.log("alter: automatic updates enabled.");
          } else {
            console.log(
              `alter: automatic updates are ${getAutoUpdateStatus()}.`,
            );
          }
          break;
        }
        // Self-update downloads a release and sigstore-verifies it, which needs
        // Node 22.22.2+. Gate ONLY this path: below floor, print a clean upgrade
        // prompt and exit non-zero. Every other command runs on any Node.
        if (!ensureNodeFloorForSelfUpdate()) {
          process.exitCode = 1;
          break;
        }
        const result = await maybeAutoUpdate({
          currentVersion: getCliVersion(),
          command,
          mode: "sync",
          force: true,
        });
        if (!result.result) {
          console.log(
            "alter: update check skipped (ALTER_CLI_AUTO_UPDATE=0).",
          );
        } else if (result.result.installMethod === "source") {
          // maybeAutoUpdate has already explained that this is a local build
          // and how to update it. Saying "already on the latest version" on top
          // of that would contradict it: a source build's version is whatever
          // the working tree last compiled, which is not a claim about npm.
        } else if (!result.result.shouldUpdate) {
          console.log(
            `alter: already on the latest @${result.result.channel} version (${result.result.current}).`,
          );
        }
      }
      break;
    case "login":
      await login(args.slice(1));
      break;
    case "register":
      await register(args.slice(1));
      break;
    case "audit":
      audit(args.slice(1));
      break;
    case "whoami":
      await whoami(args.slice(1));
      break;
    case "status":
      await status(args.slice(1));
      break;
    case "about":
      await about(args.slice(1));
      break;
    case "logout":
      await logout(args.slice(1));
      break;
    case "forget":
      await forget(args.slice(1));
      break;
    case "brief":
      await brief(args.slice(1));
      break;
    case "passkey":
      await passkey(args.slice(1));
      break;
    case "mfa":
      await mfa(args.slice(1));
      break;
    case "password":
      await password(args.slice(1));
      break;
    case "sessions":
      await sessions(args.slice(1));
      break;
    case "pair":
      if (args[1] === "--help" || args[1] === "-h") {
        console.log(
          "Usage: alter pair [connector-id]\n" +
            "       alter pair status [--json]\n" +
            "\n" +
            "Pair an identity-data source. Omit [connector-id] for the\n" +
            "interactive picker, which lists what's live for your\n" +
            "account (run 'alter pair' to see current ids).\n" +
            "\n" +
            "Sub-verbs:\n" +
            "  status            Pipeline diagnostic - paired sources +\n" +
            "                    merged trait-vector state + readiness for\n" +
            "                    alter alignment.\n",
        );
        break;
      }
      if (args[1] === "status") {
        await pairStatus(args.slice(2));
        break;
      }
      if (args[1] === "github") {
        await pairGithubFromArgs(args.slice(2));
        break;
      }
      await pairInteractive(args[1] ?? null);
      break;
    case "alignment":
      await alignment(args.slice(1));
      break;
    case "unpair":
      if (args[1] === "--help" || args[1] === "-h") {
        console.log(
          "Usage: alter unpair <connector-id> [...flags]\n" +
            "\n" +
            "Disconnect a previously-paired connector. Run 'alter\n" +
            "connections' to see the ids currently paired.\n" +
            "\n" +
            "Connector-specific flags:\n" +
            "  obsidian  --subtag <name>      revoke a single subtag\n" +
            "            --remove-plugin      delete the plugin folder\n" +
            "            --yes, -y            skip the confirm prompt\n",
        );
        break;
      }
      if (!args[1]) {
        console.error("Usage: alter unpair <id>");
        process.exitCode = 1;
        return;
      }
      if (args[1] === "obsidian") {
        await unpairObsidianFromArgs(args.slice(2));
        break;
      }
      if (args[1] === "github") {
        await unpairGithubFromArgs(args.slice(2));
        break;
      }
      await unpairPlatform(args[1]);
      break;
    case "connections":
      if (args[1] === "--help" || args[1] === "-h") {
        console.log(
          "Usage: alter connections\n" +
            "\n" +
            "List every identity-data source currently paired to this\n" +
            "account. Use 'alter pair' to add one, 'alter unpair <id>'\n" +
            "to remove one.\n",
        );
        break;
      }
      // Canonical logged-out guard: fetchPaired would otherwise throw and
      // reach main().catch's hard exit, which races libuv teardown on
      // Windows. Gate up front and soft-exit instead.
      if (!getSession()) {
        failNotLoggedIn();
        break;
      }
      renderPaired(await fetchPaired());
      break;
    case "wallet":
      await wallet(args.slice(1));
      break;
    case "earnings":
      await earnings(args.slice(1));
      break;
    case "cash-out":
    case "cashout":
      await cashOut(args.slice(1));
      break;
    case "consent":
      await consent(args.slice(1));
      break;
    case "contest":
      await contest(args.slice(1));
      break;
    case "accord":
      await accord(args.slice(1));
      break;
    case "discover":
      // D2: `discover` is now `pair`. Alias kept for one release.
      if (args[1] === "--help" || args[1] === "-h") {
        console.log(
          "Usage: alter pair [connector-id]\n" +
            "\n" +
            "`alter discover` is now `alter pair` - the alias is kept for\n" +
            "one release. Pair an identity-data source; omit [connector-id]\n" +
            "for the interactive picker, which lists what's live for your\n" +
            "account (run 'alter pair' to see current ids).\n",
        );
        break;
      }
      console.error("alter: `discover` is now `pair` - please update your scripts.");
      await pairInteractive(args[1] ?? null);
      break;
    case "portfolio":
      await portfolio(args.slice(1));
      break;
    case "style":
      await style(args.slice(1));
      break;
    case "traits":
      await traits(args.slice(1));
      break;
    case "queries":
      await queries(args.slice(1));
      break;
    case "thread":
      await thread(args.slice(1));
      break;
    case "verify":
      await verify(args.slice(1));
      break;
    case "ask":
      await ask(args.slice(1));
      break;
    case "discovery":
      await discovery(args.slice(1));
      break;
    case "org":
      await org(args.slice(1));
      break;
    case "creds":
      await creds(args.slice(1));
      break;
    case "doctor":
      await doctor(args.slice(1));
      break;
    case "key":
      await key(args.slice(1));
      break;
    case "handle":
      await handle(args.slice(1));
      break;
    case "wire":
      await wire(args.slice(1));
      break;
    case "unwire":
      await unwire(args.slice(1));
      break;
    case "hooks":
      await hooks(args.slice(1));
      break;
    case "skills":
      await skills(args.slice(1));
      break;
    case "doctrine":
      await doctrine(args.slice(1));
      break;
    case "uninstall":
      await uninstall(args.slice(1));
      break;
    case "config":
      await config(args.slice(1));
      break;
    case "prompt":
      await prompt(args.slice(1));
      break;
    case "room":
      await room(args.slice(1));
      break;
    case "msg":
      await msg(args.slice(1));
      break;
    case "agent":
      await agent(args.slice(1));
      break;
    case "signals":
      await signals(args.slice(1));
      break;
    case "coord":
      await coord(args.slice(1));
      break;
    case "cc":
      {
        // Path-1 PTY wrapper for the Claude Code binary.
        const code = await runCcWrapper(args.slice(1));
        // Soft exit: propagate child exit code without a hard process.exit()
        // that could race libuv teardown on Windows.
        if (code !== 0) { process.exitCode = code; return; }
      }
      break;
    // Hidden programmatic verb - machine-only ingest entry point.
    // Deliberately omitted from `alter --help`, the menu, and the
    // header docstring.
    case "ingest":
      await ingest(args.slice(1));
      break;
    // Hidden programmatic verb - machine-only spool-flush entry point.
    // Deliberately omitted from `alter --help` and the menu, same as ingest.
    case "excitations":
      await excitations(args.slice(1));
      break;
    case "mcp-bridge":
      mcpBridge();
      break;
    // Runtime OS-binary verify-before-exec. The alter-runtime apply-step shells
    // out to `alter runtime verify ...` to bind downloaded bytes to the
    // sigstore-verified manifest digest before executing them.
    case "runtime":
      await runtime(args.slice(1));
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error("Run 'alter help' for usage.");
      process.exitCode = 1;
      return;
  }
}

/**
 * Below-floor preflight.
 *
 * Runs BEFORE command dispatch. On below-floor, prints the human-readable
 * upgrade prompt to stderr; if headless OR --output-format=json was passed,
 * additionally emits the canonical client_below_floor envelope to stdout.
 * Exit code 4 - `client_below_floor` distinct from generic exit 1.
 *
 * Allowlist: `--version`, `--help`, `alter update` (and its
 * sub-verbs) run regardless of floor state. The allowlist is enforced inside
 * `preflightFloorForCli` (BELOW_FLOOR_COMMAND_ALLOWLIST).
 */
async function runFloorPreflight(): Promise<void> {
  // Kill switch for emergency override + test isolation.
  if (process.env.ALTER_FLOOR_PREFLIGHT === "0") return;

  let result;
  try {
    result = await preflightFloorForCli({
      clientVersion: getCliVersion(),
      command,
    });
  } catch {
    // Defensive: preflight failures NEVER block. Server-side gate is the
    // authoritative reject; client-side preflight is UX polish.
    return;
  }

  if (result.warn) {
    process.stderr.write(`alter: ${result.warn}\n`);
  }

  if (result.ok) return;

  // Below-floor - emit prompt + envelope + exit.
  if (result.upgradePrompt) {
    process.stderr.write(result.upgradePrompt + "\n");
  }
  if (
    result.envelope &&
    shouldEmitJsonEnvelope({ outputFormatFlag })
  ) {
    process.stdout.write(JSON.stringify(result.envelope) + "\n");
  }
  // PRESERVE: version-floor hard exit. Fires BEFORE any async I/O
  // is opened, so no libuv handles are in-flight. Hard exit is intentional.
  process.exit(4);
}

/**
 * Startup plaintext-credential residue sweep.
 *
 * When the secure store already holds a credential AND its legacy plaintext
 * twin (x25519-private-key.pem / signing-key.pem / session.json) still
 * exists beside it, securely remove the plaintext. Each sweep verifies the
 * store entry through the store's own read path BEFORE deleting, never
 * throws, and gates on a cheap existsSync so the common no-residue case
 * costs microseconds (it never delays the menu's first paint).
 *
 * `alter doctor` is exempt so the diagnostic observes the machine as-is and
 * reports the residue (identity.plaintext-key-residue FAILs); `doctor --fix`
 * heals it through the same verified-removal sweeps.
 */
function sweepPlaintextCredentialResidue(): void {
  try {
    sweepX25519PlaintextResidue();
    sweepSigningPlaintextResidue();
    sweepSessionPlaintextResidue();
  } catch {
    // Sweeps are individually non-throwing; this is belt-and-braces only.
  }
}

async function main(): Promise<void> {
  if (command !== "doctor") {
    sweepPlaintextCredentialResidue();
  }

  // The bare `alter` interactive menu is a long-lived alt-screen surface.
  // Blocking its FIRST PAINT on the floor preflight (≤4s on a stale cache)
  // and the self-update ping (≤4s once the 1h throttle expires) added up to
  // ~8s of dead time before anything rendered - the headline "the CLI is
  // very slow to open" symptom. For the menu we therefore:
  //   - skip the self-update network call (its "newer version" stderr notice
  //     is cleared by enterAlt's screen-wipe and never seen anyway), and
  //   - warm the floor disk cache in the BACKGROUND rather than awaiting it.
  // The server-side floor gate (the authoritative reject - the client
  // preflight is explicitly "UX polish")
  // still rejects a below-floor client on the first real leaf API call, so
  // the version-floor contract is preserved.
  const isInteractiveMenu =
    command === undefined && !!process.stdout.isTTY && !!process.stdin.isTTY;

  if (isInteractiveMenu) {
    if (process.env.ALTER_FLOOR_PREFLIGHT !== "0") {
      void preflightFloorForCli({
        clientVersion: getCliVersion(),
        command,
      }).catch(() => {
        // Background cache-warm only; never surface or block.
      });
    }
    await runPublicCommand(args);
    return;
  }

  // Non-menu verbs: the floor preflight is AWAITED because it may
  // process.exit(4) on a below-floor client and must gate dispatch. The
  // self-update check is fire-and-forget: it never affects the active command
  // (its only output is a "newer version" stderr notice), yet awaiting it
  // added up to ~4s of per-command stall on Windows where the npm-prefix probe
  // shells out. Detached, the command dispatches as soon
  // as the floor clears; any update lands on a later invocation.
  void runSelfUpdateCheck();
  void runNoticeCheck();
  await runFloorPreflight();
  await runPublicCommand(args);
}

// Only auto-run when THIS module is the process entrypoint. The internal /
// A separate internal entrypoint, not part of the public build, imports
// `runPublicCommand` from here
// for its public-verb fallthrough; without this guard that import ALSO ran
// main() against the internal argv (e.g. `release publish v…`), which the
// public dispatcher rejected as an unknown command and answered with a sticky
// `process.exitCode = 1`. That reddened an otherwise-successful internal
// `release publish` run even after every frame printed [ok]. realpathSync on
// both sides so an npm-global bin symlink (argv[1] = the .bin symlink,
// import.meta.url = the resolved dist path) still matches; try/catch degrades
// to "not entrypoint" if argv[1] is absent or unresolvable.
function isProcessEntrypoint(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(invoked);
  } catch {
    return false;
  }
}

if (isProcessEntrypoint()) {
  // A human ran `alter`. This is the ONLY affirmation that opens the OS keyring
  // to this process; the secure store is default-closed on it otherwise, so any
  // test runner (including one nobody has invented yet) is refused the keyring
  // without the store having to recognise it. See secure-store.ts,
  // keyringRefusalReason(). Must precede main(): the store resolves its backend
  // lazily on first use, which happens inside command dispatch.
  affirmKeyringRuntime();

  main().catch((err) => {
    console.error("alter:", err.message ?? err);
    // Soft exit: set exit code and let the event loop drain rather than calling
    // process.exit(1), which races libuv handle teardown on Windows.
    process.exitCode = 1;
  });
}
