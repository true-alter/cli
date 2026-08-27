/**
 * Cosmetic-inscription state - parallel to SDK's wire-state but
 * scoped to alter-cli (avoids cross-repo coupling with @truealter/sdk).
 *
 * Persisted at ~/.config/alter/cosmetic-state.json. Owns the record of
 * every surface alter wire has inscribed for the active handle, the
 * marker pair used, and the pre-insert backup hash so unwire can
 * verify reversibility.
 *
 * Multi-handle safe: inscriptions are namespaced by handle; multiple
 * handles on the same machine each get their own block in the same
 * surface file (separate marker pairs).
 */

import * as fs from "fs";
import * as path from "path";
import { ALTER_CONFIG_DIR } from "../../auth.js";

export const COSMETIC_STATE_VERSION = 1 as const;
export const COSMETIC_STATE_FILE = path.join(
  ALTER_CONFIG_DIR,
  "cosmetic-state.json",
);

export type SurfaceId =
  | "cc-statusline"
  | "starship"
  | "tmux"
  | "shellrc"
  | "fastfetch"
  | "pfetch"
  | "neofetch"
  | "kitty"
  | "alacritty"
  | "polybar";

export interface Inscription {
  surface: SurfaceId;
  /** Absolute path written or modified. */
  path: string;
  /** Marker that opens the ALTER block in the file. */
  markerStart: string;
  /** Marker that closes the ALTER block in the file. */
  markerEnd: string;
  /** sha256 of the file before insert; null if file did not exist. */
  backupSha256: string | null;
  /** ISO8601 timestamp of the inscription. */
  inscribedAt: string;
}

export interface CosmeticState {
  version: typeof COSMETIC_STATE_VERSION;
  /** The handle these inscriptions belong to. One file = one active handle. */
  handle: string;
  inscriptions: Inscription[];
}

export function readCosmeticState(): CosmeticState | null {
  try {
    const raw = fs.readFileSync(COSMETIC_STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as CosmeticState;
    if (parsed.version !== COSMETIC_STATE_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeCosmeticState(state: CosmeticState): void {
  fs.mkdirSync(ALTER_CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${COSMETIC_STATE_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, COSMETIC_STATE_FILE);
}

export function clearCosmeticState(): void {
  try {
    fs.unlinkSync(COSMETIC_STATE_FILE);
  } catch {
    // already gone
  }
}
