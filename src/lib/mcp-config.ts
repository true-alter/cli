/**
 * MCP host config writer for alter-cli.
 *
 * In-tree (NOT in @truealter/sdk) by deliberate scoping: `alter pair
 * org-alter` writes a stdio MCP server entry - the public SDK only
 * knows how to wire the HTTP-transport ALTER endpoint, and extending
 * it for org-alter would couple two artefacts that should ship
 * independently. The atomic-JSON-merge primitive is duplicated here
 * because the SDK keeps it internal.
 *
 * Surface:
 *
 *   defaultMcpHosts()        Host descriptors for the four MCP clients
 *                            we wire by default (Claude Code via CLI,
 *                            Cursor / Claude Desktop / VS Code via JSON).
 *   resolveOrgAlterBin()     Walk-up resolver from the running CLI's
 *                            location to the collective MCP build under a
 *                            sibling checkout. No sibling checkout resolves
 *                            to `{ kind: "unavailable" }` - the collective
 *                            MCP is a local development tool, not an npm
 *                            package, so there is no npx fallback.
 *   atomicJsonMerge()        Read → merge → atomic rename, with a
 *                            per-run timestamped backup sibling.
 *   restoreFromBackup()      Reverse a single host's wire step.
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";
import { env } from "node:process";

// ---------------------------------------------------------------------------
// Host descriptors
// ---------------------------------------------------------------------------

export type McpHostId =
  | "claude-code"
  | "cursor"
  | "claude-desktop"
  | "vscode";

export interface McpHostFile {
  id: Exclude<McpHostId, "claude-code">;
  label: string;
  /** The JSON file we mutate. */
  configPath: string;
  /** A sibling directory whose presence counts as "installed". */
  probeDir: string;
  /** Root key to merge under (e.g. `mcpServers`, `servers`). */
  rootKey: string;
}

export interface McpHostCli {
  id: "claude-code";
  label: string;
  /** Absolute path to the user-scoped Claude Code config (probe-only). */
  probeDir: string;
}

export type McpHost = McpHostFile | McpHostCli;

const PLAT = platform() as NodeJS.Platform;

function home(): string {
  // Resolved at call time so tests that override `HOME` between
  // calls (and runtime callers that reset it after a chroot or
  // similar) see the new value.
  return env.HOME ?? homedir();
}

function appData(): string {
  return env.APPDATA ?? join(home(), "AppData", "Roaming");
}

function xdgConfig(): string {
  return env.XDG_CONFIG_HOME ?? join(home(), ".config");
}

function macAppSupport(): string {
  return join(home(), "Library", "Application Support");
}

function claudeDesktopDir(): string {
  if (PLAT === "darwin") return join(macAppSupport(), "Claude");
  if (PLAT === "win32") return join(appData(), "Claude");
  return join(xdgConfig(), "Claude");
}

function vscodeUserDir(): string {
  if (PLAT === "darwin") return join(macAppSupport(), "Code", "User");
  if (PLAT === "win32") return join(appData(), "Code", "User");
  return join(xdgConfig(), "Code", "User");
}

/**
 * Default host list. Resolved at call time so a test that overrides
 * `HOME` / `XDG_CONFIG_HOME` between calls sees the new paths.
 */
export function defaultMcpHosts(): readonly McpHost[] {
  const h = home();
  const cursorDir = join(h, ".cursor");
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      probeDir: join(h, ".claude"),
    },
    {
      id: "cursor",
      label: "Cursor",
      configPath: join(cursorDir, "mcp.json"),
      probeDir: cursorDir,
      rootKey: "mcpServers",
    },
    {
      id: "claude-desktop",
      label: "Claude Desktop",
      configPath: join(claudeDesktopDir(), "claude_desktop_config.json"),
      probeDir: claudeDesktopDir(),
      rootKey: "mcpServers",
    },
    {
      id: "vscode",
      label: "VS Code",
      configPath: join(vscodeUserDir(), "mcp.json"),
      probeDir: vscodeUserDir(),
      // VS Code uses `servers`, not `mcpServers`.
      rootKey: "servers",
    },
  ];
}

export interface HostProbe {
  host: McpHost;
  installed: boolean;
}

/** Return one entry per known host with its install state. */
export function probeMcpHosts(hosts: readonly McpHost[] = defaultMcpHosts()): HostProbe[] {
  return hosts.map((h) => ({ host: h, installed: existsSync(h.probeDir) }));
}

// ---------------------------------------------------------------------------
// Collective MCP binary resolver
// ---------------------------------------------------------------------------

export interface OrgAlterBinLocal {
  kind: "local";
  /** Absolute path to `dist/index.js`. */
  path: string;
  /** Absolute path to the package root. */
  packageDir: string;
}

/**
 * No local collective MCP build was resolved. The collective MCP
 * is a local development tool distributed only as a sibling checkout - it
 * is not an npm package, so there is no `npx` fallback. Callers that need
 * to spawn the binary must refuse with a clear message when they see this
 * kind.
 */
export interface OrgAlterBinUnavailable {
  kind: "unavailable";
}

export type OrgAlterBin = OrgAlterBinLocal | OrgAlterBinUnavailable;

/**
 * Walk upward from `import.meta.url` looking for the collective MCP build
 * under a sibling checkout. At each level the sibling-checkout root is
 * scanned and the collective MCP build is matched on a generic directory
 * pattern, so no specific package name is baked into the resolver. The
 * walk-up finds the sibling build within a couple of steps.
 *
 * Hardening: the resolved absolute path is validated against a set of
 * trusted prefixes (HOME, XDG_DATA_HOME, the npm/node_modules global
 * prefix) before being accepted. An attacker who places a `dist/index.js`
 * under a matching directory in a world-writable ancestor (e.g. `/tmp`)
 * would otherwise have that file picked up by the walk-up. The
 * trusted-prefix check refuses any candidate that does not reside under a
 * user-controlled directory.
 *
 * Installs with no sibling checkout resolve to `{ kind: "unavailable" }`.
 * The collective MCP is a local development tool, not an npm package, so
 * there is no `npx` fallback. Callers must refuse to wire (with a clear
 * message) rather than emit a dead spawn target.
 */

/**
 * Return the set of path prefixes that are considered trusted for a
 * local `dist/index.js` resolution. A candidate path MUST start with
 * at least one of these prefixes; otherwise it is skipped and the
 * walk-up continues (ultimately resolving to `{ kind: "unavailable" }`).
 *
 * Exported for tests.
 */
export function trustedBinPrefixes(): string[] {
  const h = home();
  const prefixes: string[] = [h];
  // XDG_DATA_HOME / npm global prefix are also user-owned locations
  // where a legitimate checkout may live.
  const xdgData = env.XDG_DATA_HOME ?? join(h, ".local", "share");
  prefixes.push(xdgData);
  // npm root (e.g. /home/user/.npm-global or /usr/local/lib/node_modules)
  const npmRoot = env.npm_config_prefix;
  if (npmRoot) prefixes.push(npmRoot);
  return prefixes;
}

/**
 * Match a sibling-checkout directory that holds the collective MCP build.
 * Matched on a generic descriptor pattern rather than a hardcoded package
 * name, so the resolver carries no specific package identity. Other
 * sibling builds (the personal MCP, the CLI itself, etc.) are skipped.
 */
function looksLikeCollectiveBuild(dirName: string): boolean {
  return /collective|org-alter/.test(dirName);
}

export function resolveOrgAlterBin(startFrom?: string): OrgAlterBin {
  const start = startFrom
    ? startFrom
    : dirname(fileURLToPath(import.meta.url));
  const trusted = trustedBinPrefixes();
  let dir = start;
  for (let i = 0; i < 8; i++) {
    const siblingRoot = join(dir, ".repos");
    let entries: string[] = [];
    try {
      entries = readdirSync(siblingRoot).filter(looksLikeCollectiveBuild).sort();
    } catch {
      // No sibling-checkout root at this level - continue the walk-up.
      entries = [];
    }
    for (const entry of entries) {
      const candidate = join(siblingRoot, entry, "dist", "index.js");
      if (existsSync(candidate)) {
        // Verify the resolved path is within a trusted prefix
        // before returning it. This prevents an attacker-placed
        // `dist/index.js` in a world-writable ancestor from being
        // picked up by the walk-up.
        const isTrusted = trusted.some(
          (prefix) => candidate.startsWith(prefix + "/") || candidate.startsWith(prefix + "\\"),
        );
        if (!isTrusted) {
          // Skip this candidate silently - continue scanning.
          continue;
        }
        return {
          kind: "local",
          path: candidate,
          packageDir: join(siblingRoot, entry),
        };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { kind: "unavailable" };
}

// ---------------------------------------------------------------------------
// Atomic JSON merge
// ---------------------------------------------------------------------------

export interface AtomicMergeResult {
  path: string;
  /** Backup sibling, or null if the target did not exist before. */
  backupPath: string | null;
  preSha256: string | null;
  postSha256: string;
  noop: boolean;
}

export interface AtomicMergeOptions {
  path: string;
  /** Per-run timestamp threaded into tmp / backup sibling names. */
  timestamp: string;
  /** Receives parsed existing object (or {} if absent); returns new object. */
  merge: (existing: Record<string, unknown>) => Record<string, unknown>;
}

export function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function atomicJsonMerge(opts: AtomicMergeOptions): AtomicMergeResult {
  const { path, timestamp, merge } = opts;
  const tmpPath = `${path}.alter-tmp-${timestamp}`;
  const backupPath = `${path}.alter-backup-${timestamp}`;

  let existed = false;
  let preBytes: string | null = null;
  let parsed: Record<string, unknown> = {};

  if (existsSync(path)) {
    existed = true;
    preBytes = readFileSync(path, "utf8");
    if (preBytes.trim().length > 0) {
      try {
        // Tolerate a UTF-8 BOM: PowerShell 5.1 Out-File and some editors
        // prepend U+FEFF, which JSON.parse rejects. Found live on Win11
        // where a BOM'd mcp.json made wiring refuse until hand-fixed.
        parsed = JSON.parse(preBytes.replace(/^\uFEFF/, "")) as Record<string, unknown>;
      } catch (err) {
        throw new Error(
          `refusing to write ${path}: existing file is not valid JSON ` +
            `(${(err as Error).message}). Hand-fix and re-run.`,
        );
      }
      if (typeof parsed !== "object" || Array.isArray(parsed) || parsed === null) {
        throw new Error(
          `refusing to write ${path}: existing JSON root is not an object`,
        );
      }
    }
  }

  const merged = merge(parsed);
  const serialised = JSON.stringify(merged, null, 2) + "\n";

  if (preBytes !== null && preBytes === serialised) {
    return {
      path,
      backupPath: null,
      preSha256: sha256(preBytes),
      postSha256: sha256(preBytes),
      noop: true,
    };
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmpPath, serialised, { mode: 0o600 });
  try {
    if (existed) copyFileSync(path, backupPath);
    renameSync(tmpPath, path);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }

  return {
    path,
    backupPath: existed ? backupPath : null,
    preSha256: preBytes === null ? null : sha256(preBytes),
    postSha256: sha256(serialised),
    noop: false,
  };
}

/**
 * Reverse a previous merge.
 *
 *   - `backupPath === null`: the target did not exist before our
 *     write, so we unlink it now.
 *   - `backupPath` exists on disk: rename it back over `path`.
 *   - `backupPath` is set but missing: throw - the wire-state is
 *     inconsistent and silent recovery would mask the bug.
 */
export function restoreFromBackup(path: string, backupPath: string | null): void {
  if (backupPath === null) {
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  if (!existsSync(backupPath)) {
    throw new Error(`cannot restore ${path}: backup missing at ${backupPath}`);
  }
  renameSync(backupPath, path);
}
