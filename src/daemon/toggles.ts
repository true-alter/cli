/**
 * toggles.ts -- the member's own on/off choices for daemon behaviours.
 *
 * The daemon's consent-bearing behaviours (does this host announce its live
 * sessions to peers, write a presence feed, raise a desktop notification) have
 * always been switchable, and until this file existed the only way to switch
 * one was to export an environment variable into whatever launches the daemon.
 * That is not an answer a person gives, so the menu could only ever show the
 * state and say so.
 *
 * This module writes the file the daemon reads at
 * `$XDG_CONFIG_HOME/alter/daemon-toggles.json` (default
 * `~/.config/alter/daemon-toggles.json`). Both sides resolve that path the same
 * way on every platform, macOS included: the daemon's `config_dir()` is
 * `_xdg_path("XDG_CONFIG_HOME", ".config") / "alter"` and the CLI's idiom here
 * is the same, so neither ever writes where the other is not looking.
 *
 * Precedence on the daemon side is env > this file > built-in default, so a
 * host that pins a behaviour with an explicit ALTER_* variable keeps winning
 * and nothing set by a fleet operator is quietly overridden by a member's file.
 *
 * WHAT THIS FILE MAY CONTAIN is a closed set of booleans, mirrored from the
 * daemon's own allowlist. That is the whole reason the daemon can read it
 * without the `ALTER_RUNTIME_DEV=1` gate its neighbour `runtime.yaml` needs:
 * runtime.yaml blind-setattrs every key it finds, so any local process could
 * drop one on disk and repoint an endpoint at a host it controlled. A file of
 * booleans cannot reach an endpoint. If a value here ever stops being a bool,
 * that argument stops holding on both sides at once.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Behaviour fields the daemon accepts from this file, mirroring
 * `BEHAVIOUR_TOGGLE_FIELDS` in alter_runtime/config.py.
 *
 * A name here that the daemon does not know is skipped by it rather than
 * refused, and a name it knows that is missing here simply cannot be set from
 * the menu. Neither direction breaks a member, which is what lets the two
 * repositories ship independently.
 */
export const DAEMON_TOGGLE_FIELDS = [
  "do_publish_enabled",
  "presence_feed_writer_enabled",
  "session_presence_enabled",
  "attunement_refresh_enabled",
  "desktop_notifier_enabled",
] as const;

export type DaemonToggleField = (typeof DAEMON_TOGGLE_FIELDS)[number];

/** Resolved at call time so tests can repoint XDG_CONFIG_HOME mid-process. */
export function daemonTogglesFile(): string {
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdg, "alter", "daemon-toggles.json");
}

export interface ReadResult {
  /** Field to member-set value. Absent fields were never set. */
  toggles: Partial<Record<DaemonToggleField, boolean>>;
  /**
   * Set when the file exists but could not be read as the expected shape.
   *
   * The caller must SHOW this rather than swallow it. The daemon treats the
   * same condition as fatal and refuses to start, so a member whose file is
   * corrupt has a daemon that is down, and a menu that quietly rendered
   * defaults would be describing a process that is not running.
   */
  error?: string;
}

export function readDaemonToggles(): ReadResult {
  const file = daemonTogglesFile();
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { toggles: {} };
    return { toggles: {}, error: `${file} could not be read: ${e.message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { toggles: {}, error: `${file} is not valid JSON: ${(err as Error).message}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { toggles: {}, error: `${file} must contain a JSON object of true/false values.` };
  }

  const toggles: Partial<Record<DaemonToggleField, boolean>> = {};
  for (const field of DAEMON_TOGGLE_FIELDS) {
    const value = (parsed as Record<string, unknown>)[field];
    if (typeof value === "boolean") toggles[field] = value;
    else if (value !== undefined) {
      return {
        toggles: {},
        error: `${file}: ${field} must be true or false, found ${JSON.stringify(value)}.`,
      };
    }
  }
  return { toggles };
}

/**
 * Set one behaviour and persist the whole file.
 *
 * Written to a sibling temp file and renamed, because rename is atomic within
 * a directory on every platform we ship to. A daemon starting mid-write would
 * otherwise read a truncated file, and since it treats an unparseable file as
 * fatal, a half-written save would take the daemon down rather than merely
 * losing the setting.
 *
 * Mode 0600: this records what a member chose not to broadcast, so it is not
 * other local accounts' business. Windows ignores the mode argument, where the
 * per-user profile directory is the actual boundary.
 *
 * Unknown keys already in the file are PRESERVED. A member may be running a
 * newer daemon than this CLI, and dropping a toggle we do not recognise would
 * silently revert a behaviour they had turned off.
 */
export function setDaemonToggle(field: DaemonToggleField, on: boolean): void {
  const file = daemonTogglesFile();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
    // A file we cannot parse is deliberately NOT merged: preserving fragments
    // of it would carry the corruption forward into a file the daemon then
    // refuses again. Overwriting with a known-good object is the repair.
  } catch {
    existing = {};
  }

  existing[field] = on;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
