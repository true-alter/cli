/**
 * Detect Obsidian installation + vault list across macOS, Linux,
 * and Windows. Reads the canonical `obsidian.json` config file
 * Obsidian writes whenever it is opened - the file lists every
 * vault the user has ever opened.
 *
 * Cross-platform paths (per Obsidian docs):
 *   macOS  : ~/Library/Application Support/obsidian/obsidian.json
 *   Linux  : ~/.config/obsidian/obsidian.json
 *            ~/.var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json (Flatpak)
 *   Windows: %APPDATA%\obsidian\obsidian.json
 *
 * The `vaults` map keys are opaque ids; each entry has a `path`
 * (canonical absolute path) and optional `ts` (last opened) and
 * `open` (currently open) flags.
 *
 * The detection is pure I/O - no network - and never throws.
 * Callers see `{ installed: false, vaults: [] }` when no config is
 * found, which is the same response shape returned for an installed
 * but vault-less Obsidian. The CLI surfaces the install hint in
 * either case.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ObsidianVault {
  /** Stable id Obsidian uses internally - opaque to us. */
  id: string;
  /** Absolute, normalised vault path on disk. */
  path: string;
  /** Last-opened millisecond timestamp, if Obsidian recorded one. */
  ts?: number;
  /** True when this vault is the currently open one. */
  open?: boolean;
}

export interface ObsidianDetection {
  installed: boolean;
  /** First config path that resolved successfully, for debugging. */
  configPath: string | null;
  vaults: ObsidianVault[];
}

interface ObsidianJson {
  vaults?: Record<
    string,
    { path?: string; ts?: number; open?: boolean }
  >;
}

/**
 * Resolve the candidate `obsidian.json` paths for the given
 * platform. Earlier candidates win; the Linux branch checks the
 * native install before the Flatpak sandbox.
 */
export function obsidianConfigCandidates(
  platform: NodeJS.Platform,
  home: string,
  appData: string | undefined,
): string[] {
  if (platform === "darwin") {
    return [
      path.join(
        home,
        "Library",
        "Application Support",
        "obsidian",
        "obsidian.json",
      ),
    ];
  }
  if (platform === "win32") {
    const appDataDir = appData ?? path.join(home, "AppData", "Roaming");
    return [path.join(appDataDir, "obsidian", "obsidian.json")];
  }
  // Linux + everything else: native first, then Flatpak.
  return [
    path.join(home, ".config", "obsidian", "obsidian.json"),
    path.join(
      home,
      ".var",
      "app",
      "md.obsidian.Obsidian",
      "config",
      "obsidian",
      "obsidian.json",
    ),
  ];
}

/**
 * Parse a vault map into the public {@link ObsidianVault} shape.
 * Skips entries without a usable `path`. Sorts by `ts` descending
 * so the most-recently-opened vault is first - that's the picker's
 * default selection.
 */
export function parseVaults(json: ObsidianJson): ObsidianVault[] {
  const map = json.vaults ?? {};
  const out: ObsidianVault[] = [];
  for (const [id, entry] of Object.entries(map)) {
    const p = entry?.path;
    if (typeof p !== "string" || p.length === 0) continue;
    out.push({
      id,
      path: path.normalize(p),
      ts: typeof entry.ts === "number" ? entry.ts : undefined,
      open: entry.open === true,
    });
  }
  out.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  return out;
}

export interface DetectOptions {
  /** Override the platform - primarily for tests. */
  platform?: NodeJS.Platform;
  /** Override the home directory - primarily for tests. */
  home?: string;
  /** Override `%APPDATA%` - primarily for win32 tests. */
  appData?: string;
  /** Override the fs read function - primarily for tests. */
  readFile?: (p: string) => string;
}

/**
 * Detect Obsidian and enumerate vaults. Always resolves; never
 * throws. When no config is found returns `{ installed: false,
 * vaults: [] }`.
 */
export function detectObsidian(
  options: DetectOptions = {},
): ObsidianDetection {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const appData = options.appData ?? process.env.APPDATA;
  const readFile =
    options.readFile ?? ((p: string) => fs.readFileSync(p, "utf8"));

  const candidates = obsidianConfigCandidates(platform, home, appData);
  for (const candidate of candidates) {
    let raw: string;
    try {
      raw = readFile(candidate);
    } catch {
      continue;
    }
    let parsed: ObsidianJson;
    try {
      parsed = JSON.parse(raw) as ObsidianJson;
    } catch {
      continue;
    }
    return {
      installed: true,
      configPath: candidate,
      vaults: parseVaults(parsed),
    };
  }
  return { installed: false, configPath: null, vaults: [] };
}

/**
 * Stable, filesystem-safe slug for a vault path. Used as the key
 * for token persistence and any other per-vault state the CLI
 * writes under `~/.config/alter/obsidian/`. SHA-256 is overkill
 * for a slug but keeps the surface uniform with the rest of the
 * ALTER stack and avoids collision concerns when a user has two
 * vaults with the same basename in different directories.
 */
export function vaultHash(vaultPath: string): string {
  const canonical = path.resolve(vaultPath);
  return crypto
    .createHash("sha256")
    .update(canonical)
    .digest("hex")
    .slice(0, 16);
}
