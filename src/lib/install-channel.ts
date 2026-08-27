/**
 * install-channel - detect how alter-cli was installed (brew/aur/npm/binary/
 * pipx/scoop/winget/nix/unknown), including AUR helper detection
 * (yay/paru/pamac).
 *
 * Returns one of nine channels: `brew | aur | npm | binary | pipx | scoop |
 * winget | nix | unknown`. `unknown` is a permitted fallback - the backend
 * serves a `(channel = unknown)` floor row that maps to the conservative
 * MAX(named-channel-floors) (channel-spoof neutralised server-side; we never
 * lock out a mis-detected install client-side).
 *
 * Detection ordering matters: package-manager paths (Linuxbrew, macOS brew,
 * AUR, scoop, winget, nix) MUST run before the npm-family probe, otherwise a
 * Linuxbrew-installed alter-cli that also has an npm prefix on the same
 * machine is misclassified as `npm`.
 *
 * Pure module modulo the injectable `Deps` surface - every IO path is mocked
 * in tests so detection can be verified without touching the host shell.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** This package's own name, used to recognise its source checkout. */
const PACKAGE_NAME = "@truealter/cli";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InstallChannel =
  | "dev"
  | "brew"
  | "aur"
  | "npm"
  | "binary"
  | "pipx"
  | "scoop"
  | "winget"
  | "nix"
  | "unknown";

/** AUR helper detected on the host; informs upgrade_cmd prompt construction. */
export type AurHelper = "yay" | "paru" | "pamac" | "makepkg-only" | null;

export interface InstallChannelDeps {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  execPath?: string;
  platform?: NodeJS.Platform;
  /** Run a command; returns { code, stdout, stderr }. Used for `pacman -Qi`, `which`, etc. */
  runCommand?: (cmd: string, args: string[]) => {
    code: number;
    stdout: string;
    stderr: string;
  };
  /**
   * Path of the running CLI SCRIPT (`process.argv[1]`), NOT the node binary.
   * `execPath` is the interpreter (`/usr/bin/node`) and therefore says nothing
   * about where the CLI itself came from, which is why a source checkout was
   * invisible to every probe before the `dev` channel existed.
   */
  scriptPath?: string;
  /** Resolve symlinks. A dev install is reached THROUGH a symlink, so the raw path lies. */
  realpath?: (p: string) => string;
  fileExists?: (p: string) => boolean;
  readFile?: (p: string) => string;
}

interface RequiredDeps extends Required<InstallChannelDeps> {}

// ---------------------------------------------------------------------------
// Detection ordering
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Process-level memo
// ---------------------------------------------------------------------------

/**
 * Cached result of the most recent no-deps call. Populated on the first
 * call that uses real process state (no injected deps). Callers that
 * inject deps (tests, floor-preflight with a custom env) always bypass
 * the cache, so the injectable surface is unaffected.
 *
 * Why: detectInstallChannel() may shell out to `npm config get prefix`
 * via spawnSync on the npm-family path. client-headers.ts and
 * floor-preflight.ts both call it on the hot path (every API request
 * header build) without injecting deps, so without this cache the npm
 * subprocess was spawned once per network call - the root cause of the
 * traits-section lag (~500-2000 ms per call on slow npm setups).
 *
 * The result is stable for the life of the process: the exec path,
 * platform, and package-manager environment do not change at runtime.
 */
let _defaultChannelMemo: InstallChannel | null = null;

/**
 * Detect the install channel from runtime state. Returns one of the nine
 * channel labels; `unknown` is the safe fallback.
 *
 * When called with no deps (the default, production path) the result is
 * memoised per process so the npm subprocess spawns at most once.
 * Injecting deps bypasses the memo - tests and floor-preflight's custom
 * env override continue to work exactly as before.
 *
 * Ordering rationale:
 *   1. Linuxbrew + macOS brew - `/linuxbrew/`, `/opt/homebrew/`, `/usr/local/Cellar/`.
 *      Must precede npm because brew installs land with an npm-resolvable prefix.
 *   2. AUR - pacman-owned exec path OR `pacman -Qi truealter-cli` succeeds.
 *   3. Scoop / winget - Windows package managers, exec-path or env-var detection.
 *   4. Nix - `/nix/store/` or `NIX_PROFILES` env var.
 *   5. npm family - nvm, Volta, pnpm, Yarn globals, asdf-vm, fnm, plain npm prefix.
 *      All emit `npm` regardless of which manager actually planted the binary.
 *   6. pipx - `~/.local/pipx/venvs/truealter/` OR `PIPX_HOME` env var.
 *   7. binary - curl-install fallback paths (`/usr/local/bin/alter`, `~/.local/bin/alter`,
 *      `$XDG_BIN_HOME`).
 *   8. unknown - fall-through default.
 */
export function detectInstallChannel(
  deps?: InstallChannelDeps,
): InstallChannel {
  // Fast path: no injected deps, return the cached result.
  if (!deps && _defaultChannelMemo !== null) {
    return _defaultChannelMemo;
  }
  const d = withDefaults(deps);

  // Classify from the CLI's OWN entrypoint, falling back to the interpreter.
  //
  // Every probe below matches a path against a known install layout, and every
  // layout in DETECTION_PATH_HINTS is an ALTER path (`/usr/bin/alter`,
  // `.../bin/alter`, `.../@truealter/cli/dist/index.js`), never a node one. So
  // the probes always meant the entrypoint; `process.execPath` was simply the
  // wrong thing to feed them. It is the NODE INTERPRETER, and on a stock Linux
  // box that is `/usr/bin/node` no matter how alter itself was installed, which
  // is how an AUR or source install came to be classified npm-managed and
  // eligible for a self-update that would `npm install -g` over the top of it.
  //
  // The fallback keeps a bundled single-file binary (where the interpreter IS
  // the CLI) working, and keeps every injected-deps fixture that supplies only
  // `execPath` meaning exactly what it meant before.
  const exec = d.scriptPath || d.execPath;

  let result: InstallChannel;

  // 0. dev - running from the CLI's own source checkout. MUST precede every
  //    public probe: a dev install is normally reached via a symlink under
  //    ~/.local/bin, which `isBinary` would claim by path alone.
  if (isDev(d)) { result = "dev"; }
  // 1. brew (Linuxbrew + macOS).
  else if (isBrew(exec)) { result = "brew"; }
  // 2. AUR (Arch + derivatives).
  else if (isAur(d, exec)) { result = "aur"; }
  // 3. scoop / winget (Windows package managers).
  else if (isScoop(d, exec)) { result = "scoop"; }
  else if (isWinget(d, exec)) { result = "winget"; }
  // 4. Nix.
  else if (isNix(d, exec)) { result = "nix"; }
  // 5. npm family - all aliases classify as npm.
  else if (isNpmFamily(d, exec)) { result = "npm"; }
  // 6. pipx (Python).
  else if (isPipx(d, exec)) { result = "pipx"; }
  // 7. binary (curl-install).
  else if (isBinary(d, exec)) { result = "binary"; }
  else { result = "unknown"; }

  // Store in memo only for the no-deps (production) path.
  if (!deps) {
    _defaultChannelMemo = result;
  }
  return result;
}

/**
 * Detect which AUR helper is available (for upgrade-prompt construction).
 * Only meaningful when channel === "aur". Returns null if no helper is found
 * but pacman is present (caller falls back to the makepkg path); returns
 * "makepkg-only" if pacman is present but no helper; null otherwise.
 */
export function detectAurHelper(deps?: InstallChannelDeps): AurHelper {
  const d = withDefaults(deps);
  if (which(d, "yay")) return "yay";
  if (which(d, "paru")) return "paru";
  if (which(d, "pamac")) return "pamac";
  if (which(d, "pacman")) return "makepkg-only";
  return null;
}

// ---------------------------------------------------------------------------
// Per-channel predicates
// ---------------------------------------------------------------------------

function isBrew(exec: string): boolean {
  // Linuxbrew - `/home/linuxbrew/.linuxbrew/` or any `/linuxbrew/` segment.
  if (exec.includes("/linuxbrew/")) return true;
  // macOS Homebrew - Apple-silicon path or older Intel path.
  if (exec.startsWith("/opt/homebrew/")) return true;
  if (exec.includes("/usr/local/Cellar/")) return true;
  // Brew's bin symlink farm.
  if (exec.startsWith("/opt/homebrew/bin/") || exec.startsWith("/usr/local/bin/")) {
    // Don't classify generic /usr/local/bin/ as brew - only Cellar/Homebrew
    // paths above are reliably brew. Generic /usr/local/bin is curl-install
    // territory (handled by `isBinary`). Returning false here lets the
    // binary detector pick it up.
  }
  return false;
}

function isAur(d: RequiredDeps, exec: string): boolean {
  // Heuristic 1: exec path lives under a pacman-owned location. The PKGBUILD
  // for truealter-cli installs to `/usr/bin/alter` - same path many distros
  // use, so the path alone is not authoritative; combine with the package
  // query below.
  // Heuristic 2: `pacman -Qi truealter-cli` exit-code 0 means the package is
  // installed via the system package manager. This is the canonical check.
  if (d.platform === "linux") {
    const result = d.runCommand("pacman", ["-Qi", "truealter-cli"]);
    if (result.code === 0) return true;
  }
  // Heuristic 3 (weaker): exec path includes `/usr/bin/alter` AND pacman is
  // present on the host. Conservative - many non-AUR Linux installs also land
  // at /usr/bin/alter. Only used as a last-resort signal.
  if (
    d.platform === "linux" &&
    (exec === "/usr/bin/alter" || exec.endsWith("/usr/bin/alter")) &&
    which(d, "pacman")
  ) {
    return true;
  }
  return false;
}

function isScoop(d: RequiredDeps, exec: string): boolean {
  if (d.env.SCOOP) return true;
  // Scoop shims land under `<scoop-root>\shims\` (default `~\scoop\shims\`).
  if (exec.includes("\\scoop\\shims\\") || exec.includes("/scoop/shims/")) {
    return true;
  }
  return false;
}

function isWinget(_d: RequiredDeps, exec: string): boolean {
  // winget installs land under `%LOCALAPPDATA%\Microsoft\WinGet\Packages\`.
  if (
    exec.includes("\\Microsoft\\WinGet\\") ||
    exec.includes("/Microsoft/WinGet/")
  ) {
    return true;
  }
  return false;
}

/**
 * Nix-managed, decided from WHERE THE EXECUTABLE SITS and never from the
 * environment alone.
 *
 * `NIX_PROFILES` is set by nix's own shell integration for the whole session,
 * so it is present in every shell on a machine that has nix at all - including
 * one where this CLI came from `npm install -g` and lives under a node prefix.
 * Believing it classified such an install "nix", and `alter update` then
 * refused to npm-update a user it could have updated, telling them to use a
 * package manager that has never heard of the package. The variable says nix
 * exists; only the path says nix put this here.
 *
 * So the env var is kept as a NARROWING signal rather than a deciding one: it
 * still catches a profile symlinked somewhere unrecognisable, but only when
 * the executable is under a directory that variable actually names.
 */
function isNix(d: RequiredDeps, exec: string): boolean {
  if (exec.startsWith("/nix/store/")) return true;
  // A per-user or system profile, both of which are nix's own layout.
  if (exec.includes("/.nix-profile/") || exec.includes("/nix/var/nix/profiles/")) {
    return true;
  }
  const profiles = d.env.NIX_PROFILES;
  if (profiles) {
    // Space-separated list of profile roots, per nix's own shell integration.
    for (const profile of profiles.split(/\s+/)) {
      if (profile.length === 0) continue;
      const prefix = profile.endsWith("/") ? profile : `${profile}/`;
      if (exec.startsWith(prefix)) return true;
    }
  }
  return false;
}

function isNpmFamily(d: RequiredDeps, exec: string): boolean {
  // nvm.
  if (exec.includes("/.nvm/versions/node/")) return true;
  // Volta - installs land under `~/.volta/tools/image/node/.../bin`.
  if (
    exec.includes("/.volta/tools/") ||
    exec.includes("\\Volta\\tools\\") ||
    d.env.VOLTA_HOME
  ) {
    return true;
  }
  // pnpm globals.
  const pnpmHome = d.env.PNPM_HOME;
  if (pnpmHome && exec.startsWith(pnpmHome)) return true;
  // Yarn globals - `$(yarn global dir)/node_modules/.bin/`.
  if (exec.includes("/Yarn/Data/global/") || exec.includes("/.yarn/global/")) {
    return true;
  }
  // asdf-vm.
  if (exec.includes("/.asdf/shims/") || exec.includes("/.asdf/installs/")) {
    return true;
  }
  // fnm.
  if (
    exec.includes("/.local/share/fnm/") ||
    exec.includes("\\fnm\\") ||
    d.env.FNM_DIR
  ) {
    return true;
  }
  // Plain npm - `npm config get prefix` and check the exec lives under it.
  // Require a trailing path separator so `/usr` doesn't shadow `/usr/local/`.
  const prefix = getNpmPrefix(d);
  if (prefix) {
    const sep = prefix.includes("\\") ? "\\" : "/";
    const normalised = prefix.endsWith(sep) ? prefix : prefix + sep;
    if (exec.startsWith(normalised)) return true;
  }
  // Common system-npm prefixes when we can't query npm directly.
  if (
    exec.startsWith("/usr/lib/node_modules/") ||
    exec.startsWith("/usr/local/lib/node_modules/")
  ) {
    return true;
  }
  return false;
}

function isPipx(d: RequiredDeps, exec: string): boolean {
  if (exec.includes("/.local/pipx/venvs/truealter/")) return true;
  if (exec.includes("/pipx/venvs/truealter/")) return true;
  if (d.env.PIPX_HOME && exec.startsWith(d.env.PIPX_HOME)) return true;
  return false;
}

function isBinary(d: RequiredDeps, exec: string): boolean {
  // curl-install canonical paths.
  if (exec === "/usr/local/bin/alter") return true;
  if (exec.endsWith("/.local/bin/alter")) return true;
  const xdgBin = d.env.XDG_BIN_HOME;
  if (xdgBin && exec.startsWith(xdgBin)) return true;
  // macOS curl-install lands at /usr/local/bin too.
  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function which(d: RequiredDeps, cmd: string): boolean {
  const probe = d.platform === "win32" ? "where" : "which";
  const result = d.runCommand(probe, [cmd]);
  return result.code === 0 && result.stdout.trim().length > 0;
}

function getNpmPrefix(d: RequiredDeps): string | null {
  const result = d.runCommand("npm", ["config", "get", "prefix"]);
  if (result.code === 0 && result.stdout) {
    return result.stdout.trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function withDefaults(deps?: InstallChannelDeps): RequiredDeps {
  // `scriptPath` is the ONLY dep that reaches outside the process's own config
  // and onto the filesystem, so it defaults differently to the rest.
  //
  // With NO deps object we are the production path: read the real entrypoint.
  // With a deps object the CALLER controls the inputs (a test, or a caller
  // classifying a specific known path), and silently substituting the host's
  // own `argv[1]` would leak the running environment into a controlled one. It
  // did exactly that: every `detectInstallChannel({env, execPath})` fixture in
  // the suite resolved argv[1] to the test runner, which lives inside this very
  // checkout, so every case detected as `dev` no matter what path it injected.
  // An omitted `scriptPath` on an injected call therefore means "no entrypoint
  // to inspect", not "go and find one".
  const injected = deps !== undefined;
  return {
    env: deps?.env ?? process.env,
    homedir: deps?.homedir ?? (() => os.homedir()),
    execPath: deps?.execPath ?? process.execPath,
    platform: deps?.platform ?? process.platform,
    runCommand: deps?.runCommand ?? defaultRunCommand,
    scriptPath:
      deps?.scriptPath ?? (injected ? "" : (process.argv[1] ?? "")),
    realpath: deps?.realpath ?? ((p) => fs.realpathSync(p)),
    fileExists: deps?.fileExists ?? ((p) => fs.existsSync(p)),
    readFile: deps?.readFile ?? ((p) => fs.readFileSync(p, "utf8")),
  };
}

/** How far up from the entrypoint we look for the package root. */
const _DEV_ROOT_SEARCH_DEPTH = 6;

/**
 * A DEV install: the CLI is running from its own SOURCE CHECKOUT, not from
 * anything a package manager put there.
 *
 * This is the principal's build, and it is a distinct class from every public
 * channel. It exists so local work (builds that are not on npm, and surfaces
 * that are not part of the public build) can be run locally without ever
 * touching, or being touched by, a public release.
 *
 * It MUST be probed first. A source checkout is typically reached through a
 * symlink on PATH (`~/.local/bin/alter` -> `<repo>/dist/index.js`), and
 * `isBinary()` matches `~/.local/bin/alter` by path alone, so a dev install
 * otherwise classifies as a curl-installed `binary` and becomes eligible for a
 * self-update that would `npm install -g` the PUBLIC build straight over it.
 *
 * The discriminator is `.git`. A published npm tarball also carries a
 * package.json naming this package, but it has no repository beside it; a
 * source checkout does. So we resolve the entrypoint through its symlinks, walk
 * up to the package root, and require BOTH the package identity and the repo.
 */
function isDev(d: RequiredDeps): boolean {
  // Explicit override, for a checkout laid out in some way this cannot infer.
  if (d.env.ALTER_DEV_CLI === "1") return true;
  if (d.env.ALTER_DEV_CLI === "0") return false;

  if (!d.scriptPath) return false;
  let real: string;
  try {
    real = d.realpath(d.scriptPath);
  } catch {
    return false; // Cannot resolve it: fall through to the public probes.
  }

  let dir = path.dirname(real);
  for (let i = 0; i < _DEV_ROOT_SEARCH_DEPTH; i++) {
    const manifest = path.join(dir, "package.json");
    if (d.fileExists(manifest)) {
      // First package.json going up IS the package root. Whatever it says, we
      // stop here: a nested one further up would belong to a different package.
      try {
        const name = JSON.parse(d.readFile(manifest))?.name;
        if (name !== PACKAGE_NAME) return false;
      } catch {
        return false; // Unreadable manifest: not a source tree we can vouch for.
      }
      // `.git` is a directory in a normal clone and a FILE in a worktree, so
      // test for presence, never for a directory.
      return d.fileExists(path.join(dir, ".git"));
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // Hit the filesystem root.
    dir = parent;
  }
  return false;
}

function defaultRunCommand(
  cmd: string,
  args: string[],
): { code: number; stdout: string; stderr: string } {
  try {
    const result = spawnSync(cmd, args, {
      encoding: "utf8",
      timeout: 2000,
    });
    return {
      code: typeof result.status === "number" ? result.status : 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } catch {
    return { code: 1, stdout: "", stderr: "" };
  }
}

// ---------------------------------------------------------------------------
// Compatibility - map 9-value channel down to self-update's 3-value enum.
// ---------------------------------------------------------------------------

/**
 * `self-update.ts::detectInstallMethod()` returns a 3-value enum
 * (`npm | external | unknown`) that gates whether auto-update may invoke
 * `npm install -g`. The widened channel detection above can be projected onto
 * that surface so the existing auto-update logic keeps working without
 * change.
 */
export function channelToInstallMethod(
  channel: InstallChannel,
): "npm" | "external" | "source" | "unknown" {
  // A dev checkout is updated by rebuilding it, never by installing anything.
  // It is its own method, not "external": an external channel has an upgrade
  // command we can name (`brew upgrade`, `yay -S`), and a source tree does not.
  if (channel === "dev") return "source";
  if (channel === "npm") return "npm";
  if (channel === "unknown") return "unknown";
  // Everything else (brew/aur/binary/pipx/scoop/winget/nix) is package-manager
  // territory - auto-update must NOT npm-install over the top.
  return "external";
}

// Path constants exported for tests that need to construct synthetic exec
// paths matching the detection ordering above.
export const DETECTION_PATH_HINTS = {
  linuxbrew: "/home/linuxbrew/.linuxbrew/Cellar/alter/0.7.3/bin/alter",
  macosBrew: "/opt/homebrew/Cellar/alter/0.7.3/bin/alter",
  aur: "/usr/bin/alter",
  scoop: "C:\\Users\\test\\scoop\\shims\\alter.exe",
  winget: "C:\\Users\\test\\AppData\\Local\\Microsoft\\WinGet\\Packages\\truealter.alter\\alter.exe",
  nix: "/nix/store/abc123-alter-0.7.3/bin/alter",
  npmGlobal: "/usr/lib/node_modules/@truealter/cli/dist/index.js",
  nvm: "/home/test/.nvm/versions/node/v22.0.0/bin/alter",
  pnpm: "/home/test/.local/share/pnpm/alter",
  asdf: "/home/test/.asdf/shims/alter",
  fnm: "/home/test/.local/share/fnm/node-versions/v22.0.0/installation/bin/alter",
  pipx: "/home/test/.local/pipx/venvs/truealter/bin/alter",
  binaryUsrLocal: "/usr/local/bin/alter",
  binaryLocal: "/home/test/.local/bin/alter",
} as const;

