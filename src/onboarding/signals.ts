/**
 * Local signal readers for first-run beat 1.
 *
 * Every function here is a PURE, LOCAL read. Nothing written, nothing
 * uploaded, nothing logged beyond the current process. Signals inform
 * archetype classification only - they never become a trait vector and
 * never cross the network.
 *
 * Green-list - exactly what we look at and nothing else:
 *   - ~/.gitconfig for git user.name / user.email / ctime year /
 *     whether the file itself is a symlink into a dotfiles layout
 *   - `gh auth status` exit code (binary: logged-in or not)
 *   - Presence of editor config dirs (~/.config/nvim, ~/.vscode, ~/.config/helix)
 *   - `command -v` for language runtimes (python, node, rustc, go, ruby)
 *   - ~/.claude/ directory exists + its ctime year (when first opened)
 *   - MCP configs at known paths (~/.config/claude/mcp_config.json, Cursor, Cline)
 *   - Dotfiles layout (~/.dotfiles, ~/.yadm, ~/.chezmoi)
 *   - $SHELL and the process timezone
 *   - Current working directory's project manifest (package.json / pyproject.toml / Cargo.toml)
 *
 * Red lines (NEVER read, not even to discard):
 *   - Shell history files (.bash_history, .zsh_history, fish_history, etc.)
 *   - Home-directory traversal beyond the specific paths above
 *   - Keyring, ssh private keys, gpg secrets
 *   - Running process list
 *   - Bluetooth / Wi-Fi state
 *   - Browser history, profiles, cookies
 *
 * If you add a new signal, extend this file. New signals must land
 * through a PR reviewed against the red-line list above.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";

// ---------------------------------------------------------------------------
// Profile shape
// ---------------------------------------------------------------------------

export interface GitConfigSignal {
  userName: string | null;
  userEmail: string | null;
  /** Earliest plausible git-use year, extracted from ~/.gitconfig ctime. */
  configYear: number | null;
  /**
   * True when ~/.gitconfig is a symlink whose target sits inside a
   * dotfiles-shaped directory (name contains 'dotfile', 'yadm', 'chezmoi',
   * or '.cfg'). Strong signal that the user version-controls their shell
   * state end-to-end.
   */
  configSymlinkIntoDotfiles: boolean;
}

export interface EditorSignal {
  neovim: boolean;
  vscode: boolean;
  helix: boolean;
  emacs: boolean;
  sublime: boolean;
}

export interface RuntimeSignal {
  python: boolean;
  node: boolean;
  rustc: boolean;
  go: boolean;
  ruby: boolean;
  /** List of detected runtimes, in check order - useful for copy. */
  present: string[];
}

export interface McpClientSignal {
  claudeCode: boolean;
  cursor: boolean;
  cline: boolean;
  /** Count of MCP server entries across all detected clients. */
  serverCount: number;
}

export interface DotfilesSignal {
  dotfilesDir: boolean;
  yadm: boolean;
  chezmoi: boolean;
  stow: boolean;
  /** Bare-repo pattern (~/.cfg, ~/.dotfiles.git) or ~/dotfiles no-dot layout. */
  bareRepo: boolean;
  /** At least one HOME-level symlink points into a dotfiles-shaped directory. */
  symlinkCurated: boolean;
}

export interface ShellSignal {
  shell: string | null;
  timezone: string | null;
}

export interface ProjectSignal {
  packageJson: boolean;
  pyprojectToml: boolean;
  cargoToml: boolean;
  goMod: boolean;
  /** The manifest kind, if any, for copy variants. */
  kind: "node" | "python" | "rust" | "go" | null;
}

export interface SignalProfile {
  git: GitConfigSignal;
  gh: { loggedIn: boolean };
  editor: EditorSignal;
  runtime: RuntimeSignal;
  claudeCode: boolean;
  /**
   * ctime year of ~/.claude/ itself - placed the user on the early-adopter
   * curve when non-null. Null when the directory does not exist or ctime
   * is unreadable.
   */
  claudeCodeCtimeYear: number | null;
  mcp: McpClientSignal;
  dotfiles: DotfilesSignal;
  shell: ShellSignal;
  project: ProjectSignal;
  /** Total signals that fired - used to distinguish "fresh machine" archetype. */
  signalCount: number;
}

// ---------------------------------------------------------------------------
// Safe filesystem helpers
// ---------------------------------------------------------------------------

function exists(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function readIfFile(p: string): string | null {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    if (st.size > 64 * 1024) return null;
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

function statCtimeYear(p: string): number | null {
  try {
    const st = fs.statSync(p);
    return st.ctime.getFullYear();
  } catch {
    return null;
  }
}

function which(binary: string): boolean {
  // Pure shell-free `command -v` equivalent - never invokes a shell, never
  // passes user-controlled arguments. The allow-list is hard-coded above.
  const pathEnv = process.env.PATH ?? "";
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    for (const ext of extensions) {
      if (dir && exists(path.join(dir, binary + ext))) return true;
    }
  }
  return false;
}

/**
 * Return true iff the given file is a symlink whose target resolves into
 * a directory whose name (any ancestor) matches a dotfiles-shaped
 * pattern. Bounded check - one lstat + one readlink, no traversal.
 */
function symlinkIntoDotfilesShape(p: string): boolean {
  try {
    const st = fs.lstatSync(p);
    if (!st.isSymbolicLink()) return false;
    const target = fs.readlinkSync(p);
    return /dotfiles?|yadm|chezmoi|\.cfg(?:\/|$)/i.test(target);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Individual readers
// ---------------------------------------------------------------------------

export function readGitConfig(): GitConfigSignal {
  const gitconfigPath = path.join(os.homedir(), ".gitconfig");
  const content = readIfFile(gitconfigPath);
  if (!content) {
    return {
      userName: null,
      userEmail: null,
      configYear: null,
      configSymlinkIntoDotfiles: false,
    };
  }

  const nameMatch = content.match(/^\s*name\s*=\s*(.+?)\s*$/m);
  const emailMatch = content.match(/^\s*email\s*=\s*(.+?)\s*$/m);

  return {
    userName: nameMatch ? nameMatch[1] : null,
    userEmail: emailMatch ? emailMatch[1] : null,
    configYear: statCtimeYear(gitconfigPath),
    configSymlinkIntoDotfiles: symlinkIntoDotfilesShape(gitconfigPath),
  };
}

export function readGhAuth(): { loggedIn: boolean } {
  if (!which("gh")) return { loggedIn: false };
  try {
    execFileSync("gh", ["auth", "status"], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 2000,
    });
    return { loggedIn: true };
  } catch {
    return { loggedIn: false };
  }
}

export function readEditors(): EditorSignal {
  const home = os.homedir();
  const xdgConfig =
    process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  return {
    neovim: exists(path.join(xdgConfig, "nvim")),
    vscode:
      exists(path.join(home, ".vscode")) ||
      exists(path.join(xdgConfig, "Code")),
    helix: exists(path.join(xdgConfig, "helix")),
    emacs:
      exists(path.join(home, ".emacs.d")) ||
      exists(path.join(xdgConfig, "emacs")),
    sublime: exists(path.join(xdgConfig, "sublime-text")),
  };
}

export function readRuntimes(): RuntimeSignal {
  const candidates = ["python3", "node", "rustc", "go", "ruby"] as const;
  const hits = candidates.filter(which);
  return {
    python: hits.includes("python3"),
    node: hits.includes("node"),
    rustc: hits.includes("rustc"),
    go: hits.includes("go"),
    ruby: hits.includes("ruby"),
    present: hits.map((c) => (c === "python3" ? "python" : c)),
  };
}

export function readClaudeCode(): boolean {
  return exists(path.join(os.homedir(), ".claude"));
}

/**
 * Read the ctime year of ~/.claude/ when present. Null when the directory
 * does not exist or ctime is unreadable. Non-traversal - single stat.
 */
export function readClaudeCodeCtimeYear(): number | null {
  const p = path.join(os.homedir(), ".claude");
  if (!exists(p)) return null;
  return statCtimeYear(p);
}

export function readMcpClients(): McpClientSignal {
  const home = os.homedir();
  const xdgConfig =
    process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");

  // Each candidate path is a known MCP-client config file. We only peek at
  // server *counts*, never at server URLs, auth tokens, or command lines.
  const candidates: { path: string; label: "claudeCode" | "cursor" | "cline" }[] =
    [
      { path: path.join(home, ".claude", ".mcp.json"), label: "claudeCode" },
      { path: path.join(xdgConfig, "claude", "mcp_config.json"), label: "claudeCode" },
      { path: path.join(home, ".cursor", "mcp.json"), label: "cursor" },
      { path: path.join(home, ".cline", "mcp.json"), label: "cline" },
    ];

  let claudeCode = false;
  let cursor = false;
  let cline = false;
  let serverCount = 0;

  for (const c of candidates) {
    const content = readIfFile(c.path);
    if (!content) continue;
    try {
      const parsed = JSON.parse(content);
      const servers = (parsed.mcpServers ?? parsed.servers ?? {}) as Record<
        string,
        unknown
      >;
      const n = Object.keys(servers).length;
      if (n === 0) continue;
      serverCount += n;
      if (c.label === "claudeCode") claudeCode = true;
      if (c.label === "cursor") cursor = true;
      if (c.label === "cline") cline = true;
    } catch {
      // Malformed config - skip without flagging. Not our business.
    }
  }

  return { claudeCode, cursor, cline, serverCount };
}

export function readDotfiles(): DotfilesSignal {
  const home = os.homedir();

  const dotfilesDir =
    exists(path.join(home, ".dotfiles")) || exists(path.join(home, "dotfiles"));
  const yadm = exists(path.join(home, ".yadm"));
  const chezmoi =
    exists(path.join(home, ".local", "share", "chezmoi")) ||
    exists(path.join(home, ".config", "chezmoi"));
  const stow = exists(path.join(home, ".stow-local-ignore"));

  // Bare-repo pattern: ~/.cfg (popular Atlassian-tutorial layout) or
  // ~/.dotfiles.git. Mature users who run `git --git-dir=$HOME/.cfg` won't
  // otherwise match any detector - we check the dir exists and looks like
  // a git bare-repo (HEAD file present).
  const bareRepoCandidates = [
    path.join(home, ".cfg"),
    path.join(home, ".dotfiles.git"),
  ];
  const bareRepo = bareRepoCandidates.some(
    (c) => exists(c) && exists(path.join(c, "HEAD")),
  );

  // HOME-level symlinks that point into a dotfiles-shaped directory are a
  // strong signal. We look at well-known config filenames and check only
  // whether they are symlinks whose target basename contains "dotfile"
  // or sits under a `dotfiles/` ancestor. Bounded filename list - we do
  // NOT traverse the home directory.
  const CANDIDATE_NAMES = [
    ".bashrc",
    ".bash_profile",
    ".zshrc",
    ".profile",
    ".gitconfig",
    ".tmux.conf",
    ".vimrc",
  ];
  let symlinkCurated = false;
  for (const name of CANDIDATE_NAMES) {
    const p = path.join(home, name);
    if (symlinkIntoDotfilesShape(p)) {
      symlinkCurated = true;
      break;
    }
  }

  return { dotfilesDir, yadm, chezmoi, stow, bareRepo, symlinkCurated };
}

export function readShell(): ShellSignal {
  const shellPath = process.env.SHELL ?? null;
  const shell = shellPath ? path.basename(shellPath) : null;

  let timezone: string | null = null;
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    timezone = process.env.TZ ?? null;
  }

  return { shell, timezone };
}

export function readProject(cwd: string = process.cwd()): ProjectSignal {
  const hasPackageJson = exists(path.join(cwd, "package.json"));
  const hasPyproject = exists(path.join(cwd, "pyproject.toml"));
  const hasCargo = exists(path.join(cwd, "Cargo.toml"));
  const hasGoMod = exists(path.join(cwd, "go.mod"));

  let kind: ProjectSignal["kind"] = null;
  if (hasPackageJson) kind = "node";
  else if (hasPyproject) kind = "python";
  else if (hasCargo) kind = "rust";
  else if (hasGoMod) kind = "go";

  return {
    packageJson: hasPackageJson,
    pyprojectToml: hasPyproject,
    cargoToml: hasCargo,
    goMod: hasGoMod,
    kind,
  };
}

// ---------------------------------------------------------------------------
// Aggregate read - the ONE function beat 1 calls
// ---------------------------------------------------------------------------

export function readProfile(): SignalProfile {
  const git = readGitConfig();
  const gh = readGhAuth();
  const editor = readEditors();
  const runtime = readRuntimes();
  const claudeCode = readClaudeCode();
  const claudeCodeCtimeYear = readClaudeCodeCtimeYear();
  const mcp = readMcpClients();
  const dotfiles = readDotfiles();
  const shell = readShell();
  const project = readProject();

  // Count non-zero signal groups - a crude but serviceable "this machine is
  // fresh" detector. Fresh-machine archetype fires when fewer than three
  // groups have any hit.
  let signalCount = 0;
  if (git.userName || git.userEmail) signalCount++;
  if (gh.loggedIn) signalCount++;
  if (Object.values(editor).some(Boolean)) signalCount++;
  if (runtime.present.length > 0) signalCount++;
  if (claudeCode) signalCount++;
  if (mcp.serverCount > 0) signalCount++;
  if (Object.values(dotfiles).some(Boolean)) signalCount++;
  if (shell.shell) signalCount++;
  if (project.kind) signalCount++;

  return {
    git,
    gh,
    editor,
    runtime,
    claudeCode,
    claudeCodeCtimeYear,
    mcp,
    dotfiles,
    shell,
    project,
    signalCount,
  };
}

// ---------------------------------------------------------------------------
// Audit - exposed via `alter audit` and `alter login --audit-signals`
// ---------------------------------------------------------------------------

/**
 * Return a redacted summary of what was read, suitable for printing to the
 * user. Never includes raw signal *contents* - only the keys that fired.
 * This is the transparency surface for privacy-conscious users.
 */
export function summariseProfile(profile: SignalProfile): string[] {
  const lines: string[] = [];
  if (profile.git.userName || profile.git.userEmail) {
    const parts = ["~/.gitconfig name/email read (used for handle suggestion)"];
    if (profile.git.configYear !== null) {
      parts.push(`config year: ${profile.git.configYear}`);
    }
    if (profile.git.configSymlinkIntoDotfiles) {
      parts.push("symlink target resolves into a dotfiles layout");
    }
    lines.push(`  git · ${parts.join("; ")}`);
  }
  if (profile.gh.loggedIn) {
    lines.push("  gh · `gh auth status` exit code read (used for archetype)");
  }
  const editors = Object.entries(profile.editor)
    .filter(([, v]) => v)
    .map(([k]) => k);
  if (editors.length > 0) {
    lines.push(`  editor · presence of ${editors.join(", ")} config dir`);
  }
  if (profile.runtime.present.length > 0) {
    lines.push(`  runtime · \`command -v\` for ${profile.runtime.present.join(", ")}`);
  }
  if (profile.claudeCode) {
    const suffix =
      profile.claudeCodeCtimeYear !== null
        ? ` (ctime year: ${profile.claudeCodeCtimeYear})`
        : "";
    lines.push(`  claude · ~/.claude/ directory presence${suffix}`);
  }
  if (profile.mcp.serverCount > 0) {
    lines.push(`  mcp · ${profile.mcp.serverCount} server entries across known configs`);
  }
  const dotfiles = Object.entries(profile.dotfiles)
    .filter(([, v]) => v)
    .map(([k]) => k);
  if (dotfiles.length > 0) {
    lines.push(`  dotfiles · ${dotfiles.join(", ")} layout detected`);
  }
  if (profile.shell.shell) {
    lines.push(`  shell · $SHELL = ${profile.shell.shell}, tz = ${profile.shell.timezone ?? "unknown"}`);
  }
  if (profile.project.kind) {
    lines.push(`  project · ${profile.project.kind} manifest in cwd`);
  }
  if (lines.length === 0) {
    lines.push("  (no green-list signals matched)");
  }
  return lines;
}
