/**
 * doctor/checks/identity.ts -- auth session and key diagnostic checks.
 *
 * All checks in this module are LOCAL (no network) except jwt-fresh, which
 * only reads on-disk state. Every check that touches keys is DIAGNOSE-ONLY
 * for missing/corrupt (doctor never regenerates keys); perms-only fixes
 * are SAFE-AUTOHEAL via chmod.
 *
 * Reads from:
 *   src/auth.ts      -- SESSION_FILE, ALTER_CONFIG_DIR, readSession,
 *                       isExpired, getSessionInfo, AlterSession
 *   src/signing.ts   -- SIGNING_KEY_FILE
 *   src/x25519.ts    -- X25519_PRIVATE_KEY_FILE
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  ALTER_CONFIG_DIR,
  readSession,
  diagnoseSession,
  getSessionInfo,
  SESSION_FILE,
} from "../../auth.js";
import {
  SIGNING_KEY_FILE,
  readPrivateKeyPem,
  sweepSigningPlaintextResidue,
} from "../../signing.js";
import {
  X25519_PRIVATE_KEY_FILE,
  readX25519PrivateKeyPem,
  sweepX25519PlaintextResidue,
} from "../../x25519.js";
import { secureStore } from "../../secure-store.js";

import type {
  Check,
  CheckResult,
  HealResult,
  DoctorCtx,
} from "../../lib/check-report.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve config dir at call time, honouring XDG_CONFIG_HOME so tests
 * can redirect to a tmp dir. Mirrors the pattern in auth.ts.
 */
function activeConfigDir(): string {
  const xdg =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdg, "alter");
}

function activeSessionFile(): string {
  return path.join(activeConfigDir(), "session.json");
}

function activeSigningKeyFile(): string {
  const xdg =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdg, "alter", "signing-key.pem");
}

function activeX25519KeyFile(): string {
  const xdg =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdg, "alter", "x25519-private-key.pem");
}

/** Read file mode bits (lower 9 bits). Returns null if file absent. */
function fileMode(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mode & 0o777;
  } catch {
    return null;
  }
}

/** True if the file exists. */
function fileExists(filePath: string): boolean {
  try {
    fs.statSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/** True if the file contains valid PEM data (starts with -----BEGIN). */
function isPemValid(filePath: string): boolean {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return content.includes("-----BEGIN");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// identity.config-dir
// ---------------------------------------------------------------------------

const configDir: Check = {
  id: "identity.config-dir",
  category: "identity",
  label: "config dir present and 0o700",
  healClass: "SAFE-AUTOHEAL",
  async run(_ctx: DoctorCtx): Promise<CheckResult> {
    const dir = activeConfigDir();
    if (!fileExists(dir)) {
      return {
        status: "FAIL",
        detail: `${dir} does not exist`,
        remedy: "run `alter doctor --fix` to create it, or run `alter login`",
      };
    }
    if (process.platform !== "win32") {
      const mode = fileMode(dir);
      if (mode !== null && mode !== 0o700) {
        return {
          status: "WARN",
          detail: `${dir} mode ${mode.toString(8).padStart(3, "0")} (expected 700)`,
          remedy: `chmod 700 ${dir}`,
        };
      }
    }
    return { status: "OK", detail: dir };
  },
  async heal(_ctx: DoctorCtx): Promise<HealResult> {
    const dir = activeConfigDir();
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") {
        fs.chmodSync(dir, 0o700);
      }
      return { applied: true, status: "OK", detail: `created ${dir} (0o700)` };
    } catch (err) {
      return {
        applied: false,
        status: "FAIL",
        detail: `could not create ${dir}: ${(err as Error).message}`,
      };
    }
  },
};

// ---------------------------------------------------------------------------
// identity.session-present
// ---------------------------------------------------------------------------

const sessionPresent: Check = {
  id: "identity.session-present",
  category: "identity",
  label: "session present (secure store or legacy file)",
  healClass: "CONFIRM-FIRST",
  async run(_ctx: DoctorCtx): Promise<CheckResult> {
    const file = activeSessionFile();
    const legacyExists = fileExists(file);
    // Read through the same accessor the runtime uses: secure store first,
    // with one-time migration of a legacy plaintext session.json. Checking
    // the raw file path alone false-FAILed every secure-store user after
    // the secure-store move: doctor said "run alter login"
    // while creds verify showed a live session.
    //
    // diagnoseSession(), not readSession(): a bare null cannot tell "nothing is
    // stored" from "something is stored and will not read back", and this check
    // used to report the first about both. Saying "no session in the secure
    // store" about a store that holds an undecryptable blob is a false
    // statement made by the one tool whose whole job is telling the truth about
    // state, and it sends the reader looking for the wrong problem.
    const diagnosis = diagnoseSession();
    if (diagnosis.state === "unreadable") {
      // The reason names its own location (which store, which file), because
      // the credential may be unreadable in the secure store OR in a legacy
      // plaintext file. Naming a location here instead would re-commit this
      // check's original sin in a new place.
      return {
        status: "FAIL",
        detail: `a session credential is present but cannot be read: ${diagnosis.reason}`,
        remedy: "run `alter login` to replace the unreadable credential",
      };
    }
    if (diagnosis.state === "absent") {
      if (legacyExists) {
        return {
          status: "FAIL",
          detail: `${file} exists but is not a readable, valid session`,
          remedy: "run `alter login` to repair",
        };
      }
      return {
        status: "FAIL",
        detail: `no session in the secure store (${secureStore.backendName()}) and no legacy ${file}`,
        remedy: "run `alter login`",
      };
    }
    // Permissions hygiene only applies while a legacy plaintext file is
    // still on disk (POSIX only).
    if (legacyExists && process.platform !== "win32") {
      const mode = fileMode(file);
      if (mode !== null && mode !== 0o600) {
        return {
          status: "WARN",
          detail: `${file} mode ${mode.toString(8).padStart(3, "0")} (expected 600)`,
          remedy: `chmod 600 ${file}`,
        };
      }
    }
    return {
      status: "OK",
      detail: legacyExists
        ? file
        : `secure store (${secureStore.backendName()})`,
    };
  },
  async heal(_ctx: DoctorCtx): Promise<HealResult> {
    const file = activeSessionFile();
    const mode = fileMode(file);
    // If it exists but has bad perms, fix that (POSIX only).
    if (process.platform !== "win32" && mode !== null && mode !== 0o600) {
      try {
        fs.chmodSync(file, 0o600);
        return { applied: true, status: "OK", detail: "chmod 600 applied" };
      } catch (err) {
        return {
          applied: false,
          status: "FAIL",
          detail: `chmod failed: ${(err as Error).message}`,
        };
      }
    }
    // Missing or corrupt -- route to `alter login`.
    return {
      applied: false,
      status: "FAIL",
      detail: "run `alter login` to create a fresh session",
    };
  },
};

// ---------------------------------------------------------------------------
// identity.session-shape
// ---------------------------------------------------------------------------

const sessionShape: Check = {
  id: "identity.session-shape",
  category: "identity",
  label: "session shape valid (handle/api/jwt/date)",
  healClass: "DIAGNOSE-ONLY",
  async run(_ctx: DoctorCtx): Promise<CheckResult> {
    const session = readSession();
    if (!session) {
      // If no session at all, the session-present check will cover it.
      return {
        status: "WARN",
        detail: "no session to validate (see identity.session-present)",
        remedy: "run `alter login`",
      };
    }
    // readSession() runs validateSessionShape internally; if it returned
    // a session, the shape is valid. Handles are stored with the leading
    // tilde; normalise defensively so we never render a double-tilde.
    const handle = session.handle.startsWith("~")
      ? session.handle
      : `~${session.handle}`;
    return { status: "OK", detail: handle };
  },
};

// ---------------------------------------------------------------------------
// identity.jwt-fresh
// ---------------------------------------------------------------------------

const jwtFresh: Check = {
  id: "identity.jwt-fresh",
  category: "identity",
  label: "JWT not expired",
  healClass: "DIAGNOSE-ONLY",
  async run(_ctx: DoctorCtx): Promise<CheckResult> {
    const session = getSessionInfo();
    if (!session) {
      return {
        status: "WARN",
        detail: "no session on disk",
        remedy: "run `alter login`",
      };
    }
    const exp = new Date(session.jwt_expires_at);
    const now = Date.now();
    if (exp.getTime() <= now) {
      return {
        status: "FAIL",
        detail: `expired at ${session.jwt_expires_at}`,
        remedy:
          "run `alter creds refresh` (or `alter login` if the refresh token is also expired)",
      };
    }
    return {
      status: "OK",
      detail: `valid until ${session.jwt_expires_at}`,
    };
  },
};

// ---------------------------------------------------------------------------
// identity.refresh-valid
// ---------------------------------------------------------------------------

const refreshValid: Check = {
  id: "identity.refresh-valid",
  category: "identity",
  label: "refresh token present and valid",
  healClass: "DIAGNOSE-ONLY",
  async run(_ctx: DoctorCtx): Promise<CheckResult> {
    const session = getSessionInfo();
    if (!session) {
      return {
        status: "WARN",
        detail: "no session on disk",
        remedy: "run `alter login`",
      };
    }
    if (!session.refresh_token) {
      return {
        status: "WARN",
        detail: "no refresh_token in session (legacy session)",
        remedy: "run `alter login` to get a session with a refresh token",
      };
    }
    if (session.refresh_expires_at) {
      const exp = new Date(session.refresh_expires_at);
      if (exp.getTime() <= Date.now()) {
        return {
          status: "FAIL",
          detail: `refresh token expired at ${session.refresh_expires_at}`,
          remedy: "run `alter login`",
        };
      }
    }
    return { status: "OK", detail: "refresh token present" };
  },
};

// ---------------------------------------------------------------------------
// identity.member-key
// ---------------------------------------------------------------------------

const memberKey: Check = {
  id: "identity.member-key",
  category: "identity",
  label: "member_api_key present in session",
  healClass: "CONFIRM-FIRST",
  async run(_ctx: DoctorCtx): Promise<CheckResult> {
    const session = getSessionInfo();
    if (!session) {
      return {
        status: "WARN",
        detail: "no session on disk",
        remedy: "run `alter login`",
      };
    }
    if (!session.member_api_key) {
      return {
        status: "WARN",
        detail: "session has no member_api_key (MCP bridge cannot authenticate)",
        remedy:
          "run `alter login` to obtain a member key, or `alter key member rotate` if already logged in",
      };
    }
    return {
      status: "OK",
      detail: `present (prefix: ${session.member_api_key.slice(0, 8)}...)`,
    };
  },
  async heal(_ctx: DoctorCtx): Promise<HealResult> {
    // Generating a member key requires an authenticated API call -- route
    // to `alter login` which handles the full provisioning sequence.
    return {
      applied: false,
      status: "WARN",
      detail: "run `alter login` (or `alter key member rotate`) to provision",
    };
  },
};

// ---------------------------------------------------------------------------
// identity.signing-key
// ---------------------------------------------------------------------------

const signingKey: Check = {
  id: "identity.signing-key",
  category: "identity",
  label: "signing key present (secure store or legacy file)",
  healClass: "SAFE-AUTOHEAL",   // perms-only fix; missing/corrupt -> DIAGNOSE-ONLY path
  async run(_ctx: DoctorCtx): Promise<CheckResult> {
    const file = activeSigningKeyFile();
    const legacyExists = fileExists(file);
    // Store-first via the runtime's own reader (migrates a legacy plaintext
    // file when found). The raw-path check false-FAILed secure-store users
    // after the secure-store move.
    const pem = readPrivateKeyPem();
    if (pem === null) {
      return {
        status: "FAIL",
        detail: `no signing key in the secure store (${secureStore.backendName()}) or at ${file}`,
        remedy:
          "run `alter login` -- login re-provisions the signing key (doctor never regenerates keys)",
      };
    }
    if (!pem.includes("-----BEGIN")) {
      return {
        status: "FAIL",
        detail: "stored signing key is not valid PEM",
        remedy: "run `alter login` to re-provision the signing key",
      };
    }
    if (legacyExists && process.platform !== "win32") {
      const mode = fileMode(file);
      if (mode !== null && mode !== 0o600) {
        return {
          status: "WARN",
          detail: `${file} mode ${mode.toString(8).padStart(3, "0")} (expected 600)`,
          remedy: `chmod 600 ${file}`,
        };
      }
    }
    return {
      status: "OK",
      detail: legacyExists
        ? file
        : `secure store (${secureStore.backendName()})`,
    };
  },
  async heal(_ctx: DoctorCtx): Promise<HealResult> {
    const file = activeSigningKeyFile();
    const pem = readPrivateKeyPem();
    if (pem === null || !pem.includes("-----BEGIN")) {
      // Doctor never regenerates keys.
      return {
        applied: false,
        status: "FAIL",
        detail:
          "signing key missing or corrupt -- run `alter login` to re-provision (doctor never regenerates keys)",
      };
    }
    if (!fileExists(file)) {
      // Key lives in the secure store; there is no file to chmod.
      return { applied: false, status: "OK", detail: "no perms fix needed (secure store)" };
    }
    // Perms-only fix.
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(file, 0o600);
        return { applied: true, status: "OK", detail: "chmod 600 applied" };
      } catch (err) {
        return {
          applied: false,
          status: "FAIL",
          detail: `chmod failed: ${(err as Error).message}`,
        };
      }
    }
    return { applied: false, status: "OK", detail: "no perms fix needed on Windows" };
  },
};

// ---------------------------------------------------------------------------
// identity.x25519-key
// ---------------------------------------------------------------------------

const x25519Key: Check = {
  id: "identity.x25519-key",
  category: "identity",
  label: "x25519 key present (secure store or legacy file)",
  healClass: "SAFE-AUTOHEAL",  // perms-only fix; missing/corrupt -> DIAGNOSE-ONLY path
  async run(_ctx: DoctorCtx): Promise<CheckResult> {
    const file = activeX25519KeyFile();
    const legacyExists = fileExists(file);
    // Store-first via the runtime's own reader (migrates a legacy plaintext
    // file when found). The raw-path check false-FAILed secure-store users
    // after the secure-store move.
    const pem = readX25519PrivateKeyPem();
    if (pem === null) {
      return {
        status: "FAIL",
        detail: `no x25519 key in the secure store (${secureStore.backendName()}) or at ${file}`,
        remedy:
          "run `alter login` -- login re-provisions the x25519 key (doctor never regenerates keys)",
      };
    }
    if (!pem.includes("-----BEGIN")) {
      return {
        status: "FAIL",
        detail: "stored x25519 key is not valid PEM",
        remedy: "run `alter login` to re-provision the x25519 key",
      };
    }
    if (legacyExists && process.platform !== "win32") {
      const mode = fileMode(file);
      if (mode !== null && mode !== 0o600) {
        return {
          status: "WARN",
          detail: `${file} mode ${mode.toString(8).padStart(3, "0")} (expected 600)`,
          remedy: `chmod 600 ${file}`,
        };
      }
    }
    return {
      status: "OK",
      detail: legacyExists
        ? file
        : `secure store (${secureStore.backendName()})`,
    };
  },
  async heal(_ctx: DoctorCtx): Promise<HealResult> {
    const file = activeX25519KeyFile();
    const pem = readX25519PrivateKeyPem();
    if (pem === null || !pem.includes("-----BEGIN")) {
      return {
        applied: false,
        status: "FAIL",
        detail:
          "x25519 key missing or corrupt -- run `alter login` to re-provision (doctor never regenerates keys)",
      };
    }
    if (!fileExists(file)) {
      // Key lives in the secure store; there is no file to chmod.
      return { applied: false, status: "OK", detail: "no perms fix needed (secure store)" };
    }
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(file, 0o600);
        return { applied: true, status: "OK", detail: "chmod 600 applied" };
      } catch (err) {
        return {
          applied: false,
          status: "FAIL",
          detail: `chmod failed: ${(err as Error).message}`,
        };
      }
    }
    return { applied: false, status: "OK", detail: "no perms fix needed on Windows" };
  },
};

// ---------------------------------------------------------------------------
// identity.plaintext-key-residue
// ---------------------------------------------------------------------------

/** True when the secure store holds a value for `account` (read errors → false). */
function storeHasSecret(account: string): boolean {
  try {
    return secureStore.getSecret(account) !== null;
  } catch {
    return false;
  }
}

/**
 * Key-hygiene residue check: a plaintext private key
 * lingering beside a POPULATED secure store is a FAIL, not a WARN - the
 * migration (or login) should have removed it, and every read resolves
 * store-first so the plaintext is pure disclosure surface. Mirrors the
 * cross-platform suite's credentials checks: x25519 residue fails on file
 * existence; signing residue fails when the file holds PRIVATE KEY material.
 * A plaintext key with an EMPTY store is the legal pre-migration state and
 * stays OK here (identity.signing-key / identity.x25519-key cover it).
 */
const plaintextKeyResidue: Check = {
  id: "identity.plaintext-key-residue",
  category: "identity",
  label: "no plaintext private key beside the populated secure store",
  healClass: "SAFE-AUTOHEAL", // store copy verified before any removal
  async run(_ctx: DoctorCtx): Promise<CheckResult> {
    const offenders: string[] = [];

    const xFile = activeX25519KeyFile();
    if (fileExists(xFile) && storeHasSecret("x25519-key")) {
      offenders.push(xFile);
    }

    const sFile = activeSigningKeyFile();
    if (storeHasSecret("signing-key")) {
      try {
        const content = fs.readFileSync(sFile, "utf-8");
        if (content.includes("PRIVATE KEY")) offenders.push(sFile);
      } catch {
        // absent or unreadable - no plaintext signing residue
      }
    }

    if (offenders.length > 0) {
      return {
        status: "FAIL",
        detail:
          `plaintext private key lingers beside the populated secure store ` +
          `(${secureStore.backendName()}): ${offenders.join(", ")}`,
        remedy:
          "run `alter doctor --fix` to securely remove the plaintext residue " +
          "(the secure-store copy is verified before anything is deleted)",
      };
    }
    return {
      status: "OK",
      detail: "no plaintext private key beside the secure store",
    };
  },
  async heal(_ctx: DoctorCtx): Promise<HealResult> {
    // Verified removal: each sweep confirms the secure store holds a
    // well-formed key through the store's own read path BEFORE deleting.
    sweepX25519PlaintextResidue();
    sweepSigningPlaintextResidue();

    const leftovers: string[] = [];
    const xFile = activeX25519KeyFile();
    if (fileExists(xFile) && storeHasSecret("x25519-key")) {
      leftovers.push(xFile);
    }
    const sFile = activeSigningKeyFile();
    if (storeHasSecret("signing-key")) {
      try {
        if (fs.readFileSync(sFile, "utf-8").includes("PRIVATE KEY")) {
          leftovers.push(sFile);
        }
      } catch {
        // absent - healed
      }
    }
    if (leftovers.length > 0) {
      return {
        applied: false,
        status: "FAIL",
        detail:
          `could not remove plaintext residue: ${leftovers.join(", ")} ` +
          "(secure-store copy unverifiable or file locked) -- " +
          "run `alter login` to re-provision, then delete the file manually",
      };
    }
    return {
      applied: true,
      status: "OK",
      detail: "plaintext residue securely removed (store copy verified first)",
    };
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const checks: Check[] = [
  configDir,
  sessionPresent,
  sessionShape,
  jwtFresh,
  refreshValid,
  memberKey,
  signingKey,
  x25519Key,
  plaintextKeyResidue,
];
