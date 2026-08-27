/**
 * Persist Obsidian-pairing tokens in the user-private ALTER config
 * tree at `~/.config/alter/obsidian/<vault-hash>/tokens.json`. The
 * file is mode 0o600 - only the user can read it - and never
 * leaves the device.
 *
 * Tokens are produced by the alter-runtime daemon during the
 * pairing ceremony and shipped back through the plugin into a
 * `~Alter/PAIRING.md` marker file inside the vault. The CLI reads
 * that marker at the tail end of `alter pair obsidian` and copies
 * the tokens to its own private store so subsequent
 * `alter unpair obsidian` invocations have something to revoke
 * without prompting the user to paste opaque secrets.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { vaultHash } from "./detect.js";

/**
 * Resolve the ALTER config dir lazily, so tests that override
 * `XDG_CONFIG_HOME` *after* this module loads still pick up the
 * override on every call. Mirrors the constant in `src/auth.ts`
 * but never caches the value at module-init time.
 */
function configDir(): string {
  const xdg =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdg, "alter");
}

export interface ObsidianTokens {
  /** ALTER ~handle the vault is paired to. */
  handle: string;
  /** Subtags currently granted (e.g. `journal`, `manual-note`). */
  subtags: string[];
  /**
   * Per-subtag SHA-256 revocation-token hashes. Keyed by subtag name.
   * The plugin shows the plaintext revocation tokens once each at
   * grant time inside Obsidian and never persists them; only the
   * hashes reach PAIRING.md. The CLI mirrors those hashes here so
   * `alter unpair obsidian` can address individual grants on the
   * daemon by their hash without prompting the user to paste an
   * opaque secret.
   */
  subtagTokenHashes: Record<string, string>;
  /** Vault path the tokens belong to. */
  vaultPath: string;
  /** ISO-8601 timestamp the pairing landed. */
  pairedAt: string;
}

function tokensRoot(): string {
  return path.join(configDir(), "obsidian");
}

export function tokensPath(vaultPath: string): string {
  return path.join(tokensRoot(), vaultHash(vaultPath), "tokens.json");
}

export function writeTokens(tokens: ObsidianTokens): void {
  const file = tokensPath(tokens.vaultPath);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(tokens, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.chmodSync(file, 0o600);
}

export function readTokens(vaultPath: string): ObsidianTokens | null {
  const file = tokensPath(vaultPath);
  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw) as ObsidianTokens;
  } catch {
    return null;
  }
}

export function deleteTokens(vaultPath: string): boolean {
  const file = tokensPath(vaultPath);
  try {
    fs.unlinkSync(file);
    // Clean the empty parent directory if possible.
    try {
      fs.rmdirSync(path.dirname(file));
    } catch {
      // best-effort
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the pairing marker the plugin drops into
 * `<vault>/~Alter/PAIRING.md` at the end of the ceremony. Format
 * is the canonical front-matter block the plugin's `writePairing`
 * in the Obsidian plugin emits:
 *
 *   ---
 *   handle: ~yourname
 *   vault_path_hash: <hex>
 *   granted_at: 2026-05-15T08:31:11.262254+00:00
 *   purposes: ["mirror_reflection", "identity_income", ...]
 *   subtag_token_hashes:
 *     "journal": <sha256-hex>
 *     "manual-note": <sha256-hex>
 *   managed_by: alter-obsidian-plugin
 *   ---
 *
 * The plaintext revocation tokens are shown once each in the plugin
 * UI and never persisted; only their hashes reach this file. The
 * subtag list is recovered from the keys of the `subtag_token_hashes`
 * block.
 *
 * Returns `null` when the file is missing, malformed, or doesn't
 * yet carry the required keys (the plugin writes the file in two
 * passes; we tolerate the early-poll race).
 */
/**
 * Cap on how many bytes of `PAIRING.md` we will read. The marker is
 * a tiny YAML-ish front-matter block; anything larger is either a
 * mistake or a hostile vault attempting to coax the CLI into
 * loading a multi-megabyte file into memory on every poll. We read
 * the first chunk only and refuse the file if it exceeds the cap.
 */
const PAIRING_MARKER_MAX_BYTES = 64 * 1024;

export function readPairingMarker(
  vaultPath: string,
): Pick<
  ObsidianTokens,
  "handle" | "subtags" | "subtagTokenHashes" | "pairedAt"
> | null {
  const file = path.join(vaultPath, "~Alter", "PAIRING.md");
  let raw: string;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    if (st.size > PAIRING_MARKER_MAX_BYTES) {
      // File exists but is implausibly large - refuse rather than
      // streaming megabytes through the regex matcher on every poll.
      return null;
    }
    // Bounded read: open + read first N bytes only. Even if statSync
    // raced with a writer that grew the file, we never load more
    // than the cap into memory.
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(PAIRING_MARKER_MAX_BYTES);
      const n = fs.readSync(fd, buf, 0, PAIRING_MARKER_MAX_BYTES, 0);
      raw = buf.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const fence = raw.split(/^---\s*$/m);
  // ["", "<frontmatter>", "<rest>"] when well-formed.
  if (fence.length < 3) return null;
  const fm = fence[1];

  const lines = fm.split(/\r?\n/);
  let handle: string | null = null;
  const subtagTokenHashes: Record<string, string> = {};
  let pairedAt: string | null = null;
  let inHashesBlock = false;

  const unquote = (s: string) => s.replace(/^["']|["']$/g, "");

  for (const line of lines) {
    // Entry to a nested block: `subtag_token_hashes:` with no value on
    // the same line. Subsequent indented lines are members until a
    // non-indented key terminates the block.
    if (/^subtag_token_hashes:\s*$/.test(line)) {
      inHashesBlock = true;
      continue;
    }

    // Indented member of the nested hashes block: `  "<subtag>": <hash>`.
    if (inHashesBlock && /^\s+/.test(line)) {
      const m = line.match(/^\s+(?:"([^"]+)"|([\w-]+))\s*:\s*(\S+)\s*$/);
      if (m) {
        const subtag = m[1] ?? m[2];
        subtagTokenHashes[subtag] = unquote(m[3]);
      }
      continue;
    }

    // Any non-indented line terminates the nested block before being
    // parsed as a top-level key.
    inHashesBlock = false;

    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim();
    if (key === "handle") {
      handle = unquote(value);
    } else if (key === "granted_at" || key === "paired-at" || key === "pairedAt") {
      // Canonical plugin field is `granted_at`. `paired-at` / `pairedAt`
      // kept as aliases so a hand-edited or older marker still parses.
      pairedAt = unquote(value);
    }
  }

  const subtags = Object.keys(subtagTokenHashes);
  if (!handle || subtags.length === 0) return null;

  return {
    handle,
    subtags,
    subtagTokenHashes,
    pairedAt: pairedAt ?? new Date().toISOString(),
  };
}

/** Resolve the path to the personal alter Obsidian state root. */
export function obsidianStateRoot(): string {
  // Hoisted so callers (mostly tests) can show the path without
  // having to recreate the join.
  return tokensRoot();
}

// Re-export os for callers that want the homedir without pulling
// node:os themselves.
export { os };
