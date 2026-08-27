/**
 * Node runtime floor for the self-update path.
 *
 * The bundled release-signature verifier (@sigstore/verify, reached through the
 * self-update import chain) needs Node 22.22.2 or newer to actually run a
 * verification. Every OTHER command works fine on older Node -- only the
 * download-and-sigstore-verify path has the floor. So this module does NOT run
 * as an import side effect; it exports a callable the self-update path invokes
 * for itself, leaving `--version`, `--help`, `doctor`, `login`, and every other
 * command unguarded on any Node.
 *
 * Keep this module dependency-free: it must not import anything that pulls the
 * signing chain, so the check stays cheap and side-effect-free to import.
 */

const MIN_MAJOR = 22;
const MIN_MINOR = 22;
const MIN_PATCH = 2;

/** Human-readable floor label, e.g. "22.22.2". */
export const SELF_UPDATE_MIN_NODE = `${MIN_MAJOR}.${MIN_MINOR}.${MIN_PATCH}`;

export interface NodeFloorStatus {
  /** True when the runtime is below the self-update floor. */
  belowFloor: boolean;
  /** The observed runtime version string (e.g. process.version). */
  current: string;
  /** The required floor label. */
  required: string;
}

function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

/**
 * Pure floor check. Defaults to the running runtime's version. An unparseable
 * version is treated as at-or-above floor (never block on a version we can't
 * read; the runtime-level try/catch around the verifier is the real backstop).
 */
export function checkNodeFloor(
  version: string = process.version,
): NodeFloorStatus {
  const parsed = parseVersion(version);
  if (!parsed) {
    return { belowFloor: false, current: version, required: SELF_UPDATE_MIN_NODE };
  }
  const [major, minor, patch] = parsed;
  const belowFloor =
    major < MIN_MAJOR ||
    (major === MIN_MAJOR && minor < MIN_MINOR) ||
    (major === MIN_MAJOR && minor === MIN_MINOR && patch < MIN_PATCH);
  return { belowFloor, current: version, required: SELF_UPDATE_MIN_NODE };
}

/**
 * Gate for the explicit `alter update` command. On a below-floor runtime it
 * writes a clean upgrade prompt to stderr and returns false so the caller can
 * stop before the @sigstore/verify chain is exercised. Returns true when the
 * runtime meets the floor and the update may proceed.
 */
export function ensureNodeFloorForSelfUpdate(): boolean {
  const status = checkNodeFloor();
  if (status.belowFloor) {
    process.stderr.write(
      `alter self-update requires Node ${status.required} or newer; you have ${status.current}. Please upgrade.\n`,
    );
    return false;
  }
  return true;
}
