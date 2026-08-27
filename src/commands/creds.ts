/**
 * alter creds -- one-shot credential diagnostic + auto-fix.
 *
 *   alter creds verify     Quick health check (session JWT alive? member key?)
 *                          Exit 0 if all green, non-zero otherwise.
 *   alter creds doctor     Full diagnostic + auto-fix:
 *                            - validate session.json shape + freshness
 *                            - rotate access token via refresh-token grant if stale
 *                            - probe the capability-issuance + member-key surfaces
 *                          Prints layered [OK] / [FAIL] / [WARN] summary with
 *                          remediation pointers.
 *   alter creds refresh    Manually rotate access token via refresh-token grant.
 *
 * The Cloudflare Access service-token surface (~/.config/alter/cf-access.env
 * + the CF Access edge probe) is an OPERATOR-only diagnostic, gated behind
 * `--admin`. A normal member is bearer-first (the backend tries the member
 * bearer before any CF Access verifier) and never holds a CF Access token,
 * so no member-facing path checks for, or instructs minting of, one.
 *
 * Solves the recurring "is this CF Access expiry? capability-issuance
 * failure? refresh-token expired?" three-way ambiguity. One command,
 * ordered checks, remediation per failure.
 *
 * Re-uses `loadSession`/`ensureFreshSession`/`SESSION_FILE` from
 * `auth.ts`. No raw `fetch()` -- routes the two-curl probe through
 * the centralised `httpCall` wrapper so the AbortSignal contract
 * holds.
 *
 * No emoji in status output. Status lines use the literal
 * `[OK]`, `[FAIL]`, `[WARN]` tokens.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  ensureFreshSession,
  httpCall,
  isSentinelSession,
  readSession,
} from "../auth.js";
import { secureStore } from "../secure-store.js";
import { parseCommandString, CommandParseError } from "../lib/parse-cmd.js";
import {
  type Status,
  type CheckLine,
  tag,
  print,
  summarise,
} from "../lib/check-report.js";
import { bounceDaemon } from "../lib/daemon-bounce.js";

// ---------------------------------------------------------------------------
// Paths (lazy XDG resolution -- mirrors auth.ts so tests pointing
// XDG_CONFIG_HOME at a tmp dir exercise this code path too)
// ---------------------------------------------------------------------------

function activeConfigDir(): string {
  const xdg =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdg, "alter");
}

function activeSessionFile(): string {
  return path.join(activeConfigDir(), "session.json");
}

function activeCfAccessEnvFile(): string {
  return path.join(activeConfigDir(), "cf-access.env");
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// CF Access surface probe target (Probe 1). Kept at mcp.truealter.com because
// that is the CF-gated surface. The probe is admin/operator diagnostic only:
// members never need a CF service token; if the CF Access env is absent, the
// probe is skipped. The bearer-first member path (api.truealter.com) requires
// no CF Access credential at all.
const MCP_PROBE_URL = "https://mcp.truealter.com/api/v1/mcp";
// Bearer-first MCP endpoint used by the member-API-key probe (Probe 3).
// api.truealter.com authenticates via X-ALTER-API-Key only; no CF Access
// service token is needed or sent. A bogus / revoked key gets a 401;
// a valid key gets a 200 initialize result; no key gets a 403.
const MCP_RPC_URL = "https://api.truealter.com/api/v1/mcp";
const MCP_INITIALIZE_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "alter-creds-doctor-probe", version: "0" },
  },
});
const CAPABILITY_ISSUANCE_PATH = "/api/v1/org-alter/caps";

// CF Access env keys `creds` checks: the canonical bare
// `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` service-token pair the
// stdio bridges and the CLI's own HTTP calls (`lib/cf-access-headers.ts`)
// read from process.env, set ambiently by setup-dev / the local
// cf-access.env. A namespaced alias for the same value may also live in
// that file; `cf-access-headers.ts` resolves it by shape. `creds` probes
// the bare pair because that is what the running bridges + the CLI consume.
const CF_ACCESS_KEYS = [
  "CF_ACCESS_CLIENT_ID",
  "CF_ACCESS_CLIENT_SECRET",
] as const;

// Session refreshes ~60s before expiry; flag anything inside that window
// as stale so `verify` can warn before `doctor` rotates.
const STALE_BUFFER_MS = 60_000;

// ---------------------------------------------------------------------------
// CF Access env file
// ---------------------------------------------------------------------------

interface CfAccessProbe {
  exists: boolean;
  mode: number | null;
  /** True when *both* required keys are present and non-empty. */
  hasRequiredKeys: boolean;
  missingKeys: string[];
}

function probeCfAccessEnv(file = activeCfAccessEnvFile()): CfAccessProbe {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return {
      exists: false,
      mode: null,
      hasRequiredKeys: false,
      missingKeys: [...CF_ACCESS_KEYS],
    };
  }

  const mode = stat.mode & 0o777;
  let content = "";
  try {
    content = fs.readFileSync(file, "utf-8");
  } catch {
    return {
      exists: true,
      mode,
      hasRequiredKeys: false,
      missingKeys: [...CF_ACCESS_KEYS],
    };
  }

  const found = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).replace(/^export\s+/, "").trim();
    const rawValue = trimmed.slice(eq + 1).trim();
    if (rawValue.length === 0) continue;
    found.add(key);
  }

  const missingKeys = CF_ACCESS_KEYS.filter((k) => !found.has(k));
  return {
    exists: true,
    mode,
    hasRequiredKeys: missingKeys.length === 0,
    missingKeys,
  };
}

/**
 * Whether to emit the mode-0600 WARN for the CF Access env file.
 *
 * POSIX mode bits are only meaningful on POSIX platforms. On Windows, Node
 * reports a synthetic mode (typically 0o666) and `chmod` is a no-op, so a
 * `mode !== 0o600` comparison fires unconditionally - a false positive that
 * tells the user to run a `chmod` that changes nothing. On Windows the file's
 * confidentiality is governed by NTFS ACLs (owner + Administrators by
 * default), not mode bits, so the check is skipped there. Mirrors the
 * "POSIX only" gate on floor-preflight's A4 ownership check. `platform` is
 * injectable so the win32 branch is unit-testable on POSIX CI.
 */
export function shouldWarnCfAccessMode(
  cf: Pick<CfAccessProbe, "mode">,
  platform: NodeJS.Platform = process.platform,
): cf is Pick<CfAccessProbe, "mode"> & { mode: number } {
  return cf.mode !== null && cf.mode !== 0o600 && platform !== "win32";
}

// ---------------------------------------------------------------------------
// Session checks
// ---------------------------------------------------------------------------

interface SessionProbe {
  hasFile: boolean;
  parses: boolean;
  handle: string | null;
  api: string | null;
  expiresAt: Date | null;
  refreshExpiresAt: Date | null;
  /** Layer-0 member API key (empty string when the session lacks one). */
  memberKey: string;
}

function probeSession(): SessionProbe {
  const empty: SessionProbe = {
    hasFile: false,
    parses: false,
    handle: null,
    api: null,
    expiresAt: null,
    refreshExpiresAt: null,
    memberKey: "",
  };
  // `hasFile`: true when the session exists in EITHER the OS secure store
  // OR the legacy plaintext session.json. This preserves the diagnostic
  // "file present but corrupt" state (hasFile=true, parses=false).
  // readSession() reads the secure store first then migrates from the
  // plaintext file - we replicate that priority for the hasFile check.
  const hasStoreEntry = secureStore.getSecret("session") !== null;
  const hasLegacyFile = !hasStoreEntry && fs.existsSync(activeSessionFile());
  const hasFile = hasStoreEntry || hasLegacyFile;

  if (!hasFile) return empty;

  const session = readSession();
  if (!session) return { ...empty, hasFile: true };

  return {
    hasFile: true,
    parses: true,
    handle: session.handle,
    api: session.api,
    expiresAt: new Date(session.jwt_expires_at),
    refreshExpiresAt: session.refresh_expires_at
      ? new Date(session.refresh_expires_at)
      : null,
    memberKey: session.member_api_key ?? "",
  };
}

function describeAge(at: Date | null): string {
  if (!at) return "unknown";
  const ms = at.getTime() - Date.now();
  if (ms <= 0) return `expired ${Math.abs(Math.round(ms / 60000))}m ago`;
  if (ms < 3600_000) return `${Math.round(ms / 60000)}m left`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h left`;
  return `${Math.round(ms / 86_400_000)}d left`;
}

// ---------------------------------------------------------------------------
// Two-curl probe
// ---------------------------------------------------------------------------

interface ProbeResult {
  status: Status;
  detail: string;
  remedy?: string;
}

/**
 * Probe 1 -- CF Access surface. Bogus Bearer + real CF-Access headers;
 * a healthy CF Access posture returns a 401 from the upstream Worker
 * (CF Access passed; the app rejected the bogus Bearer). 403 means
 * CF Access itself denied the request -- env keys are wrong / expired.
 */
async function probeCfAccess(env: Record<string, string>): Promise<ProbeResult> {
  const id = env.CF_ACCESS_CLIENT_ID;
  const secret = env.CF_ACCESS_CLIENT_SECRET;
  if (!id || !secret) {
    return {
      status: "FAIL",
      detail: "CF Access env missing -- skipped probe",
      remedy:
        "run `alter login` to refresh your member credential; if access is " +
        "still denied, contact your administrator to re-provision it.",
    };
  }
  let resp: Response;
  try {
    resp = await httpCall(MCP_PROBE_URL, {
      method: "POST",
      headers: {
        "CF-Access-Client-Id": id,
        "CF-Access-Client-Secret": secret,
        Authorization: "Bearer alter-creds-doctor-probe",
        "Content-Type": "application/json",
      },
      body: "{}",
      timeoutMs: 10_000,
    });
  } catch (err) {
    return {
      status: "FAIL",
      detail: `network error: ${(err as Error).message}`,
      remedy: "check connectivity to mcp.truealter.com",
    };
  }
  // Anything other than 403 means CF Access let the request through to the
  // Worker. CF Access denial is the only 403 path; 200/401/4xx-from-app are
  // all "CF Access OK, app handled the request its own way". The probe's
  // job is to confirm CF Access posture, not to assert upstream semantics.
  if (resp.status === 401) {
    return { status: "OK", detail: "401 (CF Access passed; app rejected probe Bearer as expected)" };
  }
  if (resp.status === 200) {
    return { status: "OK", detail: "200 (CF Access passed; app accepted probe POST)" };
  }
  if (resp.status === 403) {
    return {
      status: "FAIL",
      detail: "403 -- CF Access denied",
      remedy:
        "run `alter login` to refresh your member credential; if that does not " +
        "clear it, contact the admin to re-provision. You never need a Cloudflare token.",
    };
  }
  // 5xx and unexpected codes -- inconclusive but not a CF Access denial.
  return {
    status: "WARN",
    detail: `${resp.status} (inconclusive -- non-403 so CF Access not denied)`,
  };
}

/**
 * Probe 2 -- capability-issuance surface. Calls /api/v1/org-alter/caps
 * with the session JWT. 200/201 means the JWT is alive and capability
 * issuance works. 401 means the session JWT is rejected (typically a
 * short-lived token that has aged out; refresh OR re-login).
 */
async function probeCapabilityIssuance(
  api: string,
  jwt: string,
): Promise<ProbeResult> {
  const url = `${api}${CAPABILITY_ISSUANCE_PATH}`;
  let resp: Response;
  try {
    resp = await httpCall(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      // Minimal body -- backend rejects empty body before auth in some
      // paths; we want to reach the auth check. The exact shape is
      // intentionally invalid so we never accidentally provision a real
      // cap, only exercise the auth gate.
      body: JSON.stringify({ probe: true }),
      timeoutMs: 10_000,
    });
  } catch (err) {
    return {
      status: "FAIL",
      detail: `network error: ${(err as Error).message}`,
      remedy: "check connectivity to api.truealter.com",
    };
  }
  if (resp.status === 200 || resp.status === 201) {
    return { status: "OK", detail: `${resp.status} (capability issuance reachable; session accepted)` };
  }
  if (resp.status === 400 || resp.status === 422) {
    // Body validation failed AFTER auth passed -- proves JWT is alive.
    return { status: "OK", detail: `${resp.status} (auth passed; body rejected as expected)` };
  }
  if (resp.status === 401) {
    return {
      status: "FAIL",
      detail: "401 -- session token was rejected",
      remedy: "run `alter creds refresh`; if it fails, run `alter login`",
    };
  }
  if (resp.status === 403) {
    // Cap is server-signed. Worker rejecting our cap as forged means the
    // backend signing key and the Worker verification key drifted apart.
    return {
      status: "WARN",
      detail: "403 -- signing-key mismatch",
      remedy:
        "contact an Alter operator to re-provision the messaging signing " +
        "keypair.",
    };
  }
  return {
    status: "WARN",
    detail: `${resp.status} (unexpected; probe inconclusive)`,
  };
}

/**
 * Probe 3 -- personal MCP bridge surface. POSTs a JSON-RPC
 * `initialize` to the bearer-first MCP endpoint (api.truealter.com) with
 * the session member_api_key as X-ALTER-API-Key. No CF Access token is
 * needed or sent: api.truealter.com authenticates via the member bearer only.
 * 200 means the key is accepted; 401 means it is stale or revoked (rotate
 * the member key, then restart the bridge); 403 means the member credential
 * was absent or the backend policy rejected the call.
 */
async function probeMemberKey(memberKey: string): Promise<ProbeResult> {
  if (!memberKey) {
    // A missing member_api_key means the MCP layer has no key to authenticate
    // with and will always present as L1. This is a hard fail, not a warning:
    // the session cannot function as an authenticated member credential.
    return {
      status: "FAIL",
      detail: "no member_api_key in session - MCP bridge cannot authenticate",
      remedy:
        "run `alter login` (or `alter key member rotate` if you have a session but no member key)",
    };
  }
  let resp: Response;
  try {
    resp = await httpCall(MCP_RPC_URL, {
      method: "POST",
      headers: {
        "X-ALTER-API-Key": memberKey,
        "Content-Type": "application/json",
      },
      body: MCP_INITIALIZE_BODY,
      timeoutMs: 10_000,
    });
  } catch (err) {
    return {
      status: "WARN",
      detail: `member-key probe inconclusive (${(err as Error).message})`,
    };
  }
  if (resp.status === 200) {
    return {
      status: "OK",
      detail: "member API key accepted by MCP (initialize 200)",
    };
  }
  if (resp.status === 401) {
    return {
      status: "FAIL",
      detail: "member API key rejected (401) - stale or revoked",
      remedy: "run `alter key member rotate`, then restart the MCP bridge",
    };
  }
  if (resp.status === 403) {
    return {
      status: "WARN",
      detail: "member-key probe returned 403 - credential absent or backend policy rejected it",
      remedy:
        "run `alter login` to refresh your member credential, then re-run `alter creds doctor`",
    };
  }
  return {
    status: "WARN",
    detail: `member-key probe inconclusive (${resp.status})`,
  };
}

// ---------------------------------------------------------------------------
// Subcommand: verify
// ---------------------------------------------------------------------------

export async function credsVerify(admin = false): Promise<void> {
  const checks: CheckLine[] = [];

  const session = probeSession();
  if (!session.hasFile) {
    checks.push({
      status: "FAIL",
      label: "session.json present",
      detail: `not found at ${activeSessionFile()}`,
      remedy: "run `alter login`",
    });
  } else if (!session.parses) {
    checks.push({
      status: "FAIL",
      label: "session.json valid",
      detail: "shape validation failed",
      remedy: "run `alter login` to repair",
    });
  } else {
    const expMs = session.expiresAt!.getTime() - Date.now();
    if (expMs <= 0) {
      checks.push({
        status: "FAIL",
        label: "session JWT alive",
        detail: `expired (${describeAge(session.expiresAt)})`,
        remedy: "run `alter creds refresh`",
      });
    } else if (expMs <= STALE_BUFFER_MS) {
      checks.push({
        status: "WARN",
        label: "session JWT alive",
        detail: `near expiry (${describeAge(session.expiresAt)})`,
        remedy: "run `alter creds refresh`",
      });
    } else {
      checks.push({
        status: "OK",
        label: "session JWT alive",
        detail: `${session.handle} (${describeAge(session.expiresAt)})`,
      });
    }
  }

  // CF Access env is an operator-only surface. A normal member is
  // bearer-first and never holds a CF Access service token, so the check
  // runs only under `--admin`. This keeps the member verdict free of any
  // CF Access FAIL the member could not (and must not) act on.
  if (admin) {
    const cf = probeCfAccessEnv();
    if (!cf.exists) {
      checks.push({
        status: "FAIL",
        label: "CF Access env present",
        detail: `not found at ${activeCfAccessEnvFile()}`,
        remedy:
          "operator diagnostic only; contact your administrator to provision " +
          "operator access. Members are bearer-first and never need this.",
      });
    } else if (shouldWarnCfAccessMode(cf)) {
      checks.push({
        status: "WARN",
        label: "CF Access env mode 0600",
        detail: `current mode ${(cf.mode & 0o777).toString(8).padStart(3, "0")}`,
        remedy: `chmod 600 ${activeCfAccessEnvFile()}`,
      });
    } else if (!cf.hasRequiredKeys) {
      checks.push({
        status: "FAIL",
        label: "CF Access env keys",
        detail: `missing: ${cf.missingKeys.join(", ")}`,
        remedy:
          "operator diagnostic only; contact your administrator to re-provision " +
          "operator access. Members are bearer-first and never need this.",
      });
    } else {
      checks.push({
        status: "OK",
        label: "CF Access env present",
        detail:
          process.platform === "win32"
            ? "both keys set (mode ACL-governed on Windows)"
            : "both keys set, mode 0600",
      });
    }
  }

  // member_api_key presence - `verify` stays local-only/fast (no network
  // round-trip); `doctor` runs the live `probeMemberKey` against the MCP
  // endpoint to tell a stale/revoked key apart from a healthy one.
  if (session.parses) {
    if (session.memberKey) {
      checks.push({
        status: "OK",
        label: "member_api_key present",
        detail: "session carries a member API key (run `alter creds doctor` to probe it)",
      });
    } else {
      checks.push({
        status: "WARN",
        label: "member_api_key present",
        detail: "session has no member API key - the MCP bridge can't authenticate",
        remedy:
          "run `alter login` (or `alter key member rotate` if you have a session but no member key)",
      });
    }
  }

  for (const line of checks) print(line);
  const verdict = summarise(checks);
  if (verdict !== "OK") process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Subcommand: refresh
// ---------------------------------------------------------------------------

export async function credsRefresh(force = false): Promise<void> {
  const before = readSession();
  if (!before) {
    console.error(
      "[FAIL] no session on disk. Run `alter login` to authenticate.",
    );
    process.exitCode = 1;
    return;
  }
  // Sentinel guard: a far-future or keyless session must not be handed back
  // as "already fresh". Force a real network exchange so the server is the
  // authority on whether this credential is live.
  if (isSentinelSession(before)) {
    console.error(
      "[FAIL] session is a sentinel or test fixture (far-future expiry or missing member_api_key). " +
        "Run `alter login` to obtain a real session.",
    );
    process.exitCode = 1;
    return;
  }
  // `--force` rotates regardless of remaining access-token lifetime. The
  // proactive-renew daemon uses it to rotate a few minutes before expiry,
  // while the token is still inside the freshness buffer and a plain
  // refresh would otherwise no-op.
  const after = await ensureFreshSession({ force });
  if (!after) {
    console.error(
      "[FAIL] refresh failed -- refresh token expired or rejected. Run `alter login`.",
    );
    process.exitCode = 1;
    return;
  }
  const rotated = after.jwt !== before.jwt;
  if (rotated) {
    console.log(
      `[OK] access token rotated. New expiry: ${after.jwt_expires_at} (${describeAge(new Date(after.jwt_expires_at))})`,
    );
    // Bounce the daemon so the SessionRefresher picks up the new session
    // from disk and arms its next wake against the freshly-rotated expiry.
    // This is a no-op when the unit is absent or inactive.
    bounceDaemon();
  } else {
    console.log(
      `[OK] access token already fresh. Expiry: ${after.jwt_expires_at} (${describeAge(new Date(after.jwt_expires_at))})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Subcommand: doctor
// ---------------------------------------------------------------------------

function loadCfAccessEnv(file = activeCfAccessEnvFile()): Record<string, string> {
  const env: Record<string, string> = {};
  let content: string;
  try {
    content = fs.readFileSync(file, "utf-8");
  } catch {
    return env;
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).replace(/^export\s+/, "").trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip matching surrounding quotes -- never log this value.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value.length > 0) env[key] = value;
  }
  return env;
}

export async function credsDoctor(admin = false): Promise<void> {
  const checks: CheckLine[] = [];
  console.log("alter creds doctor -- running full credential diagnostic\n");

  // 1. Session shape ---------------------------------------------------------
  const session0 = probeSession();
  if (!session0.hasFile) {
    checks.push({
      status: "FAIL",
      label: "session.json present",
      detail: `not found at ${activeSessionFile()}`,
      remedy: "run `alter login`",
    });
    for (const line of checks) print(line);
    process.exitCode = 1;
    return;
  }
  if (!session0.parses) {
    checks.push({
      status: "FAIL",
      label: "session.json valid",
      detail: "shape validation failed",
      remedy: "run `alter login` to repair",
    });
    for (const line of checks) print(line);
    process.exitCode = 1;
    return;
  }
  checks.push({
    status: "OK",
    label: "session.json valid",
    detail: `${session0.handle} -> ${session0.api}`,
  });

  // 1b. Sentinel guard -------------------------------------------------------
  // A session with a far-future expiry or missing member_api_key must not be
  // treated as live. Detect it before the refresh step so doctor does not
  // report "already fresh" for a fixture session that was never real.
  const rawSession = readSession();
  if (rawSession && isSentinelSession(rawSession)) {
    const sentinelYear = new Date(rawSession.jwt_expires_at).getUTCFullYear();
    const sentinelReason = sentinelYear >= 2090
      ? `jwt_expires_at year ${sentinelYear} is a test-fixture sentinel`
      : "member_api_key is absent (session degrades to L1)";
    checks.push({
      status: "FAIL",
      label: "session is a live credential",
      detail: `session rejected: ${sentinelReason}`,
      remedy: "run `alter login` to obtain a real session",
    });
    for (const line of checks) print(line);
    process.exitCode = 1;
    return;
  }

  // 2. Refresh access token if stale ----------------------------------------
  const expMs0 = session0.expiresAt!.getTime() - Date.now();
  let session = readSession()!;
  if (expMs0 <= STALE_BUFFER_MS) {
    const refreshed = await ensureFreshSession();
    if (refreshed) {
      checks.push({
        status: "OK",
        label: "session JWT refreshed",
        detail: `new expiry ${refreshed.jwt_expires_at}`,
      });
      session = refreshed;
    } else {
      const refreshExpired =
        session0.refreshExpiresAt !== null &&
        session0.refreshExpiresAt.getTime() <= Date.now();
      checks.push({
        status: "FAIL",
        label: "session JWT refreshable",
        detail: refreshExpired
          ? "refresh token also expired"
          : "refresh-token grant rejected",
        remedy: "run `alter login` to re-authenticate",
      });
      for (const line of checks) print(line);
      process.exitCode = 1;
      return;
    }
  } else {
    checks.push({
      status: "OK",
      label: "session JWT alive",
      detail: describeAge(session0.expiresAt),
    });
  }

  // 3. CF Access env file (operator-only) -----------------------------------
  // The CF Access service-token surface is an admin diagnostic. A normal
  // member is bearer-first -- the backend tries the member bearer before any
  // CF Access verifier -- so a member never holds a CF Access token and the
  // whole env-file + CF Access probe section is skipped unless `--admin` is
  // passed. This keeps the member verdict free of any CF Access FAIL the
  // member could not (and must not) act on, and free of any token guidance.
  if (admin) {
    const cf = probeCfAccessEnv();
    if (!cf.exists) {
      checks.push({
        status: "FAIL",
        label: "CF Access env present",
        detail: `not found at ${activeCfAccessEnvFile()}`,
        remedy:
          "operator diagnostic only; contact your administrator to provision " +
          "operator access. Members are bearer-first and never need this.",
      });
      for (const line of checks) print(line);
      process.exitCode = 1;
      return;
    }
    if (shouldWarnCfAccessMode(cf)) {
      checks.push({
        status: "WARN",
        label: "CF Access env mode 0600",
        detail: `current mode ${(cf.mode & 0o777).toString(8).padStart(3, "0")}`,
        remedy: `chmod 600 ${activeCfAccessEnvFile()}`,
      });
    } else {
      checks.push({
        status: "OK",
        label: "CF Access env mode 0600",
        ...(process.platform === "win32"
          ? { detail: "ACL-governed on Windows (owner + Administrators)" }
          : {}),
      });
    }
    if (!cf.hasRequiredKeys) {
      checks.push({
        status: "FAIL",
        label: "CF Access env keys",
        detail: `missing: ${cf.missingKeys.join(", ")}`,
        remedy:
          "operator diagnostic only; contact your administrator to re-provision " +
          "operator access. Members are bearer-first and never need this.",
      });
      for (const line of checks) print(line);
      process.exitCode = 1;
      return;
    }
    checks.push({
      status: "OK",
      label: "CF Access env keys",
      detail: "both keys set",
    });

    // 4a. CF Access probe (operator-only) -----------------------------------
    const env = loadCfAccessEnv();
    const cfProbe = await probeCfAccess(env);
    checks.push({
      status: cfProbe.status,
      label: "CF Access probe (mcp.truealter.com)",
      detail: cfProbe.detail,
      remedy: cfProbe.remedy,
    });
  }

  // 4b. Member-credential probes (always run) -------------------------------
  const capProbe = await probeCapabilityIssuance(session.api, session.jwt);
  checks.push({
    status: capProbe.status,
    label: "Capability-issuance probe (api.truealter.com)",
    detail: capProbe.detail,
    remedy: capProbe.remedy,
  });
  const memberProbe = await probeMemberKey(session0.memberKey);
  checks.push({
    status: memberProbe.status,
    label: "Member-key probe (api.truealter.com)",
    detail: memberProbe.detail,
    remedy: memberProbe.remedy,
  });

  // 5. MCP server entrypoints -----------------------------------------------
  // `alter brief` + `alter alignment query` spawn local MCP servers via
  // env-var-supplied absolute paths. Missing env-vars don't break creds
  // themselves, but they silently break two menu features at the moment
  // of use - surface them here so a doctor run discovers them up front.
  for (const [envName, label, binHint] of [
    [
      "ALTER_ORG_MCP_CMD",
      "alter brief MCP entrypoint",
      "the org MCP server",
    ],
    [
      "ALTER_MCP_CMD",
      "alter alignment MCP entrypoint",
      "the personal MCP server",
    ],
  ] as const) {
    const value = process.env[envName];
    if (!value) {
      checks.push({
        status: "WARN",
        label,
        detail: `${envName} not set`,
        remedy: `install ${binHint} then export ${envName}=<absolute-path-to-the-server-binary>`,
      });
      continue;
    }
    try {
      const tokens = parseCommandString(value);
      const [bin] = tokens;
      if (!bin || !path.isAbsolute(bin)) {
        checks.push({
          status: "FAIL",
          label,
          detail: `${envName} must start with an absolute path`,
          remedy: `set ${envName} to an absolute path (e.g. /usr/local/bin/<mcp-server>)`,
        });
        continue;
      }
      if (!fs.existsSync(bin)) {
        checks.push({
          status: "FAIL",
          label,
          detail: `${envName} points at ${bin} which does not exist`,
          remedy: `install ${binHint} or correct ${envName}`,
        });
        continue;
      }
      checks.push({
        status: "OK",
        label,
        detail: bin,
      });
    } catch (err) {
      const message =
        err instanceof CommandParseError ? err.message : String(err);
      checks.push({
        status: "FAIL",
        label,
        detail: `${envName} is invalid (${message})`,
        remedy: `use an absolute path with optional space-separated args - no shell metacharacters`,
      });
    }
  }

  // 6. Summary --------------------------------------------------------------
  console.log("");
  for (const line of checks) print(line);
  const verdict = summarise(checks);
  console.log("");
  if (verdict === "OK") {
    console.log("[OK] all credential layers healthy.");
    return;
  }
  if (verdict === "WARN") {
    console.log("[WARN] credential surface is degraded but functional. See remedies above.");
    return;
  }
  console.log("[FAIL] credential surface broken. Follow remedies above.");
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(
    "Usage: alter creds {verify|doctor|refresh} [--admin]\n" +
      "\n" +
      "Diagnose and auto-fix credential problems across the session JWT,\n" +
      "refresh token, member API key, and capability issuance.\n" +
      "\n" +
      "  verify    Quick check (session alive? member key present?). Exit 0 if green.\n" +
      "  doctor    Full diagnostic + auto-fix. Refreshes the access token\n" +
      "            if stale, probes capability issuance and member-key health,\n" +
      "            prints remediation for every failure path.\n" +
      "  refresh   Manually rotate the access token via the refresh-token grant.\n" +
      "            Pass --force to rotate even when the token is still fresh\n" +
      "            (the proactive-renew daemon uses this before expiry).\n" +
      "\n" +
      "  --admin   Operator-only: also run the extended operator diagnostics.\n" +
      "            Members never need this.\n",
  );
}

export async function creds(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    printHelp();
    return;
  }
  // `--admin` opts in to the operator-only CF Access service-token probes.
  // A normal member is bearer-first (the backend tries the member bearer
  // before any CF Access verifier) and never holds a CF Access token, so
  // the CF Access surface is skipped for members and surfaced only here.
  const admin = args.slice(1).includes("--admin");
  switch (sub) {
    case "verify":
      await credsVerify(admin);
      return;
    case "doctor":
      await credsDoctor(admin);
      return;
    case "refresh": {
      // `--force` rotates the access token even when it is still fresh
      // (used by the proactive-renew daemon a few minutes before expiry).
      const force = args.slice(1).includes("--force");
      await credsRefresh(force);
      return;
    }
    default:
      console.error(`alter creds: unknown subcommand: ${sub}`);
      printHelp();
      process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Test seams (exported for tests/test_creds.ts; not part of the public API)
// ---------------------------------------------------------------------------

export const __testing__ = {
  probeCfAccess,
  probeCfAccessEnv,
  probeCapabilityIssuance,
  probeSession,
  probeMemberKey,
  describeAge,
  loadCfAccessEnv,
  activeCfAccessEnvFile,
  activeSessionFile,
  shouldWarnCfAccessMode,
  STALE_BUFFER_MS,
};
