/**
 * alter logout - revoke session and clean up local state.
 */

import * as fs from "fs";
import {
  getSessionInfo,
  deleteSession,
  httpCall,
  isSentinelSession,
  readSessionFresh,
} from "../auth.js";
import { removeManagedSigningArtefacts } from "../signing.js";
import { X25519_PRIVATE_KEY_FILE } from "../x25519.js";

function printHelp(): void {
  console.log(
    "Usage: alter logout\n" +
      "\n" +
      "Revoke the current session server-side (best effort) and remove\n" +
      "~/.config/alter/session.json. Safe to run when not logged in.\n",
  );
}

/**
 * Best-effort server-side revocation that surfaces a non-2xx response instead
 * of silently treating it as success. httpCall returns the Response (it never
 * throws on a 4xx/5xx), so a revoke that the server REJECTED would otherwise
 * be indistinguishable from one it honoured. Local cleanup still proceeds
 * regardless - the local wipe is what logs the user out on this device - but
 * the user is warned that the token may remain valid server-side.
 */
async function revokeBestEffort(
  label: string,
  url: string,
  init: Parameters<typeof httpCall>[1],
): Promise<void> {
  try {
    const res = await httpCall(url, init);
    if (!res.ok) {
      process.stderr.write(
        `alter: WARNING: server-side ${label} revocation returned HTTP ${res.status}; ` +
          `the ${label} may remain valid server-side until it expires.\n`,
      );
    }
  } catch {
    // Server unreachable or timed out - still clean up locally.
    process.stderr.write(
      `alter: WARNING: server-side ${label} revocation could not be reached (offline or timed out); ` +
        `the ${label} may remain valid server-side until it expires.\n`,
    );
  }
}

export async function logout(args: string[] = []): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  const session = getSessionInfo();

  if (!session) {
    console.log("Not logged in.");
    return;
  }

  // GUARD 3b: sentinel logout path.
  // A sentinel / fixture session has no real server-side tokens to revoke.
  // Calling the revoke endpoint with a far-future sentinel JWT hangs because
  // the backend rejects or times out on the unrecognised token, and without a
  // short per-request ceiling the logout command freezes (incident 2026-06-17).
  // When the loaded session is a sentinel: skip ALL server revocations and go
  // directly to local cleanup. The 5s ceiling on each revoke call below is
  // an independent belt-and-braces guard for the non-sentinel path so a
  // slow/unreachable backend can never freeze logout regardless.
  const isSentinel = isSentinelSession(session);
  if (isSentinel) {
    process.stderr.write(
      `alter: WARNING: session is a sentinel/fixture. Skipping server revocation and removing local state only.\n`,
    );
  }

  // Attempt server-side revocation - best effort; local cleanup proceeds regardless.
  // Each httpCall carries a short timeout (5s) so a slow/unreachable backend can
  // never freeze logout. httpCall's defaultApiTimeoutMs() is 15s; we override to
  // 5s here because logout revocation is fire-and-forget best-effort and the user
  // should not wait.

  // 1. Revoke the refresh token. This was once omitted, which left the
  //    refresh token valid for its full lifetime after logout.
  if (!isSentinel && session.refresh_token) {
    await revokeBestEffort(
      "refresh token",
      `${session.api}/api/v1/oauth/revoke`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Bearer ${session.jwt}`,
        },
        body: new URLSearchParams({
          token: session.refresh_token,
          token_type_hint: "refresh_token",
        }).toString(),
        timeoutMs: 5000,
      },
    );
  }

  // 2. Revoke the member API key so MCP calls signed with it are rejected
  //    server-side. signing_kid was once never tombstoned on logout.
  //    This MUST run before the access-token revoke below: this call authorises
  //    with `Bearer session.jwt`, and revoking the access token triggers a
  //    server-side full session kill that invalidates that same JWT. Ordered
  //    after the access-token revoke, this call 401s and the member key is
  //    never tombstoned, leaving it valid server-side until natural expiry.
  if (!isSentinel && session.member_api_key) {
    await revokeBestEffort(
      "member API key",
      `${session.api}/api/v1/auth/member-key/revoke`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.jwt}`,
        },
        body: JSON.stringify({ api_key: session.member_api_key }),
        timeoutMs: 5000,
      },
    );
  }

  // 3. Revoke the access token LAST. This triggers the server-side full session
  //    kill (revoked_before marker), so session.jwt can no longer authorise any
  //    request after this point; nothing below depends on it.
  if (!isSentinel && session.jwt) {
    await revokeBestEffort(
      "access token",
      `${session.api}/api/v1/oauth/revoke`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Bearer ${session.jwt}`,
        },
        body: new URLSearchParams({
          token: session.jwt,
          token_type_hint: "access_token",
        }).toString(),
        timeoutMs: 5000,
      },
    );
  }

  if (session.granted_scopes && args.includes("--verbose")) {
    const scopes = session.granted_scopes.split(" ").filter(Boolean);
    console.log("  Scopes revoked:");
    for (const s of scopes) {
      console.log(`    ${s}`);
    }
    console.log("");
  }

  // 4. Tombstone the local signing key. signing_kid was once left on disk
  //    after logout, allowing post-logout MCP invocation signatures to be
  //    crafted locally even if the server-side kid is later revoked.
  //    removeManagedSigningArtefacts() covers EVERY plaintext artefact the
  //    CLI manages: signing-key.pem, its atomic-write temp leftovers, and
  //    the per-kid signing-keys/<kid>.pem variants. The encrypted-store
  //    entries ('signing-key', 'x25519-key', 'session') are removed by
  //    deleteSession() below.
  removeManagedSigningArtefacts();

  // 5. Tombstone the x25519 private key (MCP-GTM-H-4: x25519-private-key.pem
  //    was previously left on disk after logout; a stolen-laptop or local
  //    attacker with post-logout disk access could recover the key and decrypt
  //    attachments encrypted to this device's registered public half).
  try {
    fs.unlinkSync(X25519_PRIVATE_KEY_FILE);
  } catch {
    // File absent - nothing to tombstone
  }

  // VERIFIED, LOUD, COMPLETE WIPE.
  // deleteSession() wipes the session from BOTH the selected backend and the
  // encrypted-file mirror and throws SecureStoreDeleteError if a copy survives
  // the read-back (the split-brain enc-file case a keyring-only re-read would
  // miss). Belt-and-braces, we then re-read the session UNCACHED: a surviving
  // session in the selected backend means the next `alter login` would silently
  // short-circuit instead of forcing a fresh login - the launch-blocker this
  // fix exists to kill. On either signal we tell the user they are NOT logged
  // out and exit non-zero, rather than printing a false "Logged out".
  let wipeError: unknown;
  try {
    deleteSession();
  } catch (err) {
    wipeError = err;
  }

  const survivor = readSessionFresh();
  if (wipeError !== undefined || survivor !== null) {
    const detail =
      wipeError instanceof Error
        ? wipeError.message
        : survivor !== null
          ? `a local session copy survived for ${survivor.handle ?? "this account"}`
          : "the local credential wipe could not be verified";
    process.stderr.write(
      `alter: ERROR: logout failed to fully clear local credentials: ${detail}. ` +
        `You may NOT be logged out on this device. Re-run 'alter logout', or remove ` +
        `~/.config/alter manually, before trusting this device.\n`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Logged out. Session for ${session.handle} removed.`);
}
