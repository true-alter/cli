/**
 * XDG-compliant paths for ALTER CLI configuration layers.
 *
 * Layer precedence (lowest → highest): defaults → system → user → session.
 * Defaults are in-memory (see `defaults.ts`). System, user, and session
 * layers are TOML files on disk, each optional.
 */

import * as os from "os";
import * as path from "path";

function xdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
}

export const USER_CONFIG_DIR = path.join(xdgConfigHome(), "alter");

export const USER_CONFIG_FILE = path.join(USER_CONFIG_DIR, "config.toml");

/**
 * System layer: readable by any member of the host's operators group,
 * intended for installation-wide defaults (e.g. palette forced on kiosk
 * installs). Absent by default.
 */
export const SYSTEM_CONFIG_FILE =
  process.env.ALTER_SYSTEM_CONFIG ?? "/etc/alter/config.toml";

/**
 * Session layer: overrides user and system for a single `alter` process
 * tree. Set by `alter` harness or by the user ad-hoc. Absent by default.
 */
export function sessionConfigFile(): string | null {
  return process.env.ALTER_CONFIG_FILE ?? null;
}
