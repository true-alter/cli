/**
 * Local-signals cache reader.
 *
 * The alter-runtime daemon writes `~/.cache/alter/local-signals.json`
 * pre-login (the day-0 seed sequence). The CLI reads it once at orientation
 * render-time; nothing else touches it.
 *
 * Schema (forward-compatible - daemon and CLI evolve together):
 *   {
 *     "signal_keys": ["signal_documents_cluster", "signal_mcp_count_high"],
 *     "captured_at": "2026-05-13T03:00:00Z"
 *   }
 *
 * Missing file, malformed JSON, or absent `signal_keys` array all collapse
 * to an empty list - every consumer renders the `default` observation
 * line. Silent skip is the locked graceful-degradation floor: never invent
 * content the substrate didn't ground.
 *
 * Honours `XDG_CACHE_HOME` so e2e tests can point the env at a tmp dir
 * without poking the developer's real cache (mirrors the pattern in
 * `ui/ambientHeader.ts::identityCachePath`).
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface LocalSignals {
  /** Signal keys that fired pre-login. Empty when daemon is absent. */
  signalKeys: string[];
  /** ISO-8601 capture timestamp from the daemon, or null when unknown. */
  capturedAt: string | null;
}

/**
 * Resolve the local-signals cache path. Honours `XDG_CACHE_HOME` for
 * test redirection; matches the path alter-runtime's signal-writer
 * subscriber will land at post-launch.
 */
export function localSignalsCachePath(
  homeDir: string = os.homedir(),
): string {
  const xdg = process.env.XDG_CACHE_HOME ?? path.join(homeDir, ".cache");
  return path.join(xdg, "alter", "local-signals.json");
}

/**
 * Read the local-signals cache. Returns an empty-list snapshot on any
 * failure mode (missing file, malformed JSON, wrong shape). Never
 * throws - orientation MUST render whether or not
 * the daemon is up.
 */
export function readLocalSignals(
  cachePath: string = localSignalsCachePath(),
): LocalSignals {
  let raw: string;
  try {
    raw = fs.readFileSync(cachePath, "utf8");
  } catch {
    return { signalKeys: [], capturedAt: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { signalKeys: [], capturedAt: null };
  }
  if (!parsed || typeof parsed !== "object") {
    return { signalKeys: [], capturedAt: null };
  }
  const obj = parsed as Record<string, unknown>;
  const rawKeys = obj["signal_keys"];
  const signalKeys: string[] = Array.isArray(rawKeys)
    ? rawKeys.filter((k): k is string => typeof k === "string" && k.length > 0)
    : [];
  const rawCaptured = obj["captured_at"];
  const capturedAt =
    typeof rawCaptured === "string" && rawCaptured.length > 0
      ? rawCaptured
      : null;
  return { signalKeys, capturedAt };
}
