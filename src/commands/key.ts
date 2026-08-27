/**
 * alter key - unified credential surface.
 *
 *   alter key member rotate           Mint a new member API key (writes to session)
 *   alter key member revoke           Revoke all active member keys for this account
 *   alter key signing list            List agent signing keys (requires member API key)
 *   alter key signing add             Generate ES256 keypair, register public half, store private
 *   alter key signing revoke <kid>    Tombstone a signing key
 *   alter key device register         Register this device's Ed25519 signing key
 *   alter key device show             Show this device's did:key, if registered
 *   alter key list                    Aggregate view
 *
 * Member keys authenticate this CLI to the public MCP server as "acting on
 * your own behalf". Signing keys sign each tools/call invocation so the
 * MCP gate (Q5c) can verify invocation authenticity.
 */

import { cancel, password as clackPassword, isCancel } from "@clack/prompts";
import { confirmYesNo } from "../ui/picker.js";
import * as fs from "fs";
import * as path from "path";
import { apiCall, failNotLoggedIn, getSession, httpCall, readSession, requireSessionOrExit, writeSession, ALTER_CONFIG_DIR } from "../auth.js";
import { withLoadingCancel } from "../ui/biosMenu.js";
import { deriveDeviceLabel } from "../lib/device-label.js";
import { apiErrorMessage } from "../lib/api-error.js";
import { generateSigningKeypair } from "../signing.js";
import {
  generateX25519Keypair,
  writeX25519PrivateKeyPem,
} from "../x25519.js";
import {
  generateDeviceKeypair,
  loadDeviceKeypair,
  signWithDeviceKey,
  writeDevicePrivateKeyPem,
} from "../device-key.js";
import {
  decodeRootSeed,
  encodeRootSeed,
  ensureRootSeed,
  readRootSeed,
  writeRootSeed,
} from "../root-seed.js";

interface MemberKeyResponse {
  member_api_key: string;
  display_prefix: string;
  scope: string;
  rotated: boolean;
  expires_at: string;
}

interface AgentKeyResponse {
  id: string;
  kid: string;
  alg: string;
  api_key_id: string;
  handle: string | null;
  created_at: string;
  revoked_at: string | null;
}

function printHelp(): void {
  console.log(
    "Usage: alter key {member {rotate|revoke}|signing {list|add|revoke <kid>}|list}\n" +
      "\n" +
      "Manage member and agent-signing credentials.\n" +
      "  member rotate           mint a fresh member API key (revokes the old one)\n" +
      "  member revoke           revoke all active member keys for this account\n" +
      "  signing list            list registered agent signing keys\n" +
      "  signing add             generate ES256 keypair, register public half, store private\n" +
      "  signing revoke <kid>    tombstone a signing key\n" +
      "  device register         register this device's Ed25519 signing key\n" +
      "  device show             show this device's did:key, if registered\n" +
      "  seed export             show this member's root seed, to write down\n" +
      "  seed import             restore a root seed onto this machine\n" +
      "  list                    aggregate view of member + signing keys\n",
  );
}

export async function key(args: string[]): Promise<void> {
  const [sub, verb, ...rest] = args;
  if (sub === "--help" || sub === "-h" || sub === "help") {
    printHelp();
    return;
  }
  if (sub === "member" && verb === "rotate") return memberRotate();
  if (sub === "member" && verb === "revoke") return memberRevoke();
  if (sub === "signing" && verb === "list") return signingList();
  if (sub === "signing" && verb === "add") return signingAdd();
  if (sub === "signing" && verb === "revoke") return signingRevoke(rest[0]);
  if (sub === "device" && verb === "register") return deviceRegister(rest);
  if (sub === "device" && verb === "show") return deviceShow();
  if (sub === "seed" && verb === "export") return seedExport();
  if (sub === "seed" && verb === "import") return seedImport(rest);
  if (sub === "list") return listAll();
  console.log(
    "Usage: alter key {member {rotate|revoke}|signing {list|add|revoke <kid>}|device {register|show}|seed {export|import}|list}"
  );
  process.exitCode = 1;
}

async function memberRotate(): Promise<void> {
  // Device-label compose: rotate mints a FRESH X25519
  // keypair AND scopes the singleton-revoke to this device. Backend
  // overwrites the previous public half against the rotated member-key
  // row (so alter_peer_devices() always surfaces the current device's
  // live key) and restricts revoke by device_label (so rotating on
  // desktop does not 401 Android, and vice versa).
  const x25519 = generateX25519Keypair();
  const rotateWait = await withLoadingCancel(
    (signal) =>
      apiCall("/api/v1/auth/member-key", {
        method: "POST",
        body: {
          x25519_public_key: x25519.publicKeyHex,
          device_label: deriveDeviceLabel(),
        },
        signal,
      }),
    "rotating member key",
  );
  if (rotateWait.cancelled) {
    cancel(
      "Cancelled. Run 'alter key list' to check whether the key rotated - if it did, run 'alter key member rotate' again so the local key matches.",
    );
    return;
  }
  const res = rotateWait.result;
  if (!res) {
    failNotLoggedIn();
    return;
  }
  if (!res.ok) {
    console.error(apiErrorMessage("rotate your member key", res.status, await res.text()));
    process.exitCode = 1;
    return;
  }
  const data = (await res.json()) as MemberKeyResponse;

  // Server recorded the new public half; safe to overwrite the on-disk
  // private half. Atomic temp-and-rename means a crash mid-write leaves
  // either the old private intact or the new private complete -- never
  // a truncated file.
  writeX25519PrivateKeyPem(x25519.privateKeyPem);

  const session = readSession();
  if (session) {
    session.member_api_key = data.member_api_key;
    session.member_api_key_display_prefix = data.display_prefix;
    writeSession(session);
  }

  console.log(`Member key rotated. Prefix: ${data.display_prefix}. Expires: ${data.expires_at}`);
  console.log("Plaintext key is shown only once - it is now stored in this device's credential store.");
}

async function memberRevoke(): Promise<void> {
  if (!requireSessionOrExit()) return;
  const ok = await confirmYesNo({
    message: "Revoke all active member keys? Any MCP client using them will 401.",
    initialValue: false,
  });
  if (!ok) {
    cancel("Aborted.");
    return;
  }

  const revokeWait = await withLoadingCancel(
    (signal) =>
      apiCall("/api/v1/auth/member-key/revoke", { method: "POST", signal }),
    "revoking member keys",
  );
  if (revokeWait.cancelled) {
    cancel("Cancelled. Run 'alter key list' to check whether the keys were revoked.");
    return;
  }
  const res = revokeWait.result;
  if (!res) {
    failNotLoggedIn();
    return;
  }
  if (!res.ok) {
    console.error(apiErrorMessage("revoke your member key", res.status, await res.text()));
    process.exitCode = 1;
    return;
  }
  const data = (await res.json()) as { revoked: number };

  const session = readSession();
  if (session) {
    delete session.member_api_key;
    delete session.member_api_key_display_prefix;
    writeSession(session);
  }

  console.log(`${data.revoked} member key(s) revoked`);
}

function requireMemberKey(): { api: string; memberKey: string } | null {
  const session = getSession();
  if (!session) {
    failNotLoggedIn();
    return null;
  }
  if (!session.member_api_key) {
    console.error("No member API key on this session. Run `alter key member rotate` first.");
    process.exitCode = 1;
    return null;
  }
  return { api: session.api, memberKey: session.member_api_key };
}

async function signingList(): Promise<void> {
  const ctx = requireMemberKey();
  if (!ctx) return;

  const listWait = await withLoadingCancel(
    (signal) =>
      httpCall(`${ctx.api}/api/v1/agents/keys`, {
        headers: { "X-ALTER-API-Key": ctx.memberKey },
        signal,
      }),
    "loading signing keys",
  );
  if (listWait.cancelled) return;
  const res = listWait.result!;
  if (!res.ok) {
    console.error(apiErrorMessage("list your signing keys", res.status, await res.text()));
    process.exitCode = 1;
    return;
  }
  const rows = (await res.json()) as AgentKeyResponse[];
  if (rows.length === 0) {
    console.log("No signing keys registered.");
    return;
  }
  console.log("kid".padEnd(32) + "alg".padEnd(8) + "created_at");
  console.log("-".repeat(72));
  for (const r of rows) {
    console.log(`${r.kid.padEnd(32)}${r.alg.padEnd(8)}${r.created_at}`);
  }
}

function signingKeysDir(): string {
  return path.join(ALTER_CONFIG_DIR, "signing-keys");
}

function writePerKidPrivateKey(kid: string, pem: string): string {
  const dir = signingKeysDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // MCP-GTM-H-3: server-assigned `kid` is used as a filename component.
  // A compromised backend or MITM could deliver `kid="../../../…"` and
  // path.join would resolve it outside the signing-keys dir.
  // Sanitise first (collapse any non-allowlist chars to "_"), then
  // assert the final path stays within the intended directory.
  const safekid = kid.replace(/[^A-Za-z0-9._-]/g, "_");
  const target = path.join(dir, `${safekid}.pem`);
  if (!target.startsWith(dir + path.sep)) {
    throw new Error(
      `kid "${kid}" resolves outside the signing-keys directory; refusing to write.`,
    );
  }

  fs.writeFileSync(target, pem, { encoding: "utf-8", mode: 0o600 });
  fs.chmodSync(target, 0o600);
  return target;
}

/**
 * Remove the local private PEM for a kid after it has been revoked
 * server-side. Leaving the private half on disk once the server rejects the
 * key is an orphaned secret. Best-effort: a missing file means there is
 * nothing to clean up; any other failure is reported so the caller can warn
 * that the secret may still be on disk. Mirrors writePerKidPrivateKey's
 * path-traversal guard.
 */
function deletePerKidPrivateKey(
  kid: string,
): { removed: boolean; path: string | null; error?: string } {
  const dir = signingKeysDir();
  const safekid = kid.replace(/[^A-Za-z0-9._-]/g, "_");
  const target = path.join(dir, `${safekid}.pem`);
  if (!target.startsWith(dir + path.sep)) {
    return {
      removed: false,
      path: null,
      error: `kid "${kid}" resolves outside the signing-keys directory`,
    };
  }
  try {
    if (!fs.existsSync(target)) return { removed: false, path: target };
    fs.rmSync(target, { force: true });
    return { removed: true, path: target };
  } catch (err) {
    return { removed: false, path: target, error: (err as Error).message };
  }
}

async function signingAdd(): Promise<void> {
  const ctx = requireMemberKey();
  if (!ctx) return;

  // Strict ordering (never invert):
  //   1. Generate the ES256 keypair in-memory only.
  //   2. POST the public half to /api/v1/agents/keys.
  //   3. On 2xx, write the private PEM to disk (mode 0600) under the
  //      server-assigned kid.
  //   4. On failure, log and exit 1 WITHOUT touching disk. An orphaned
  //      private key on disk with a kid the server never acknowledged
  //      would appear usable but sign invocations that the MCP gate
  //      would reject -- worst kind of silent breakage.
  const { privateKeyPem, publicKeyPem } = generateSigningKeypair();

  const addWait = await withLoadingCancel(
    (signal) =>
      httpCall(`${ctx.api}/api/v1/agents/keys`, {
        method: "POST",
        headers: {
          "X-ALTER-API-Key": ctx.memberKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ public_key_pem: publicKeyPem }),
        signal,
      }),
    "registering signing key",
  );
  if (addWait.cancelled) {
    // No disk write on cancel - identical safety posture to the failure
    // branch below: the private PEM dies with this frame, and any row the
    // server may have created is unusable without it. signing list + a
    // fresh `signing add` recover cleanly.
    cancel("Cancelled. Run 'alter key signing list' to check for a stray registration.");
    return;
  }
  const res = addWait.result!;

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 409) {
      console.error(
        "Signing key registration conflicted (409): kid already in use. " +
          "Re-run `alter key signing add` to let the server assign a fresh kid, " +
          "or pick a different kid explicitly.",
      );
    } else {
      console.error(apiErrorMessage("register that signing key", res.status, body));
    }
    // No disk write. Private PEM stays in memory and is garbage-collected
    // with this function frame -- the server has no record of the paired
    // public half, so nothing on this machine could ever authenticate
    // with it.
    process.exitCode = 1;
    return;
  }

  const row = (await res.json()) as AgentKeyResponse;
  const target = writePerKidPrivateKey(row.kid, privateKeyPem);
  console.log(`Signing key added: kid=${row.kid}`);
  console.log(`Private key stored at ${target} (mode 0600)`);
}

async function signingRevoke(kid: string | undefined): Promise<void> {
  if (!kid) {
    console.error("Usage: alter key signing revoke <kid>");
    process.exitCode = 1;
    return;
  }
  const ctx = requireMemberKey();
  if (!ctx) return;

  const ok = await confirmYesNo({
    message: `Revoke signing key ${kid}? Invocations signed with this kid will be rejected.`,
    initialValue: false,
  });
  if (!ok) {
    cancel("Aborted.");
    return;
  }

  const delWait = await withLoadingCancel(
    (signal) =>
      httpCall(`${ctx.api}/api/v1/agents/keys/${encodeURIComponent(kid)}`, {
        method: "DELETE",
        headers: { "X-ALTER-API-Key": ctx.memberKey },
        signal,
      }),
    "revoking signing key",
  );
  if (delWait.cancelled) {
    cancel("Cancelled. Run 'alter key signing list' to check whether the key was revoked.");
    return;
  }
  const res = delWait.result!;
  if (!res.ok) {
    console.error(apiErrorMessage("revoke that signing key", res.status, await res.text()));
    process.exitCode = 1;
    return;
  }
  console.log(`Key ${kid} revoked.`);

  // The server has rejected the key; remove the orphaned private half locally.
  const cleanup = deletePerKidPrivateKey(kid);
  if (cleanup.removed) {
    console.log(`Local private key removed: ${cleanup.path}`);
  } else if (cleanup.error) {
    console.error(
      `Warning: could not remove the local private key` +
        `${cleanup.path ? ` at ${cleanup.path}` : ""}: ${cleanup.error}`,
    );
    console.error(
      "The key is revoked server-side, but the private half may still be on disk - remove it manually.",
    );
  }
}

/**
 * Register this device's Ed25519 signing key with the identity field.
 *
 * Three round trips at most: fetch a single-use nonce, sign its RAW
 * bytes, post the did:key with the signature. The private half is
 * written to the secure store only AFTER the server has accepted the
 * public half, so a failed registration never leaves a key on this
 * machine that the field has never heard of.
 *
 * Idempotent by the server's own uniqueness rule: a second run with the
 * same key answers 409, which is reported as already-registered rather
 * than an error, matching the Android client's behaviour on the same
 * endpoint.
 */
async function deviceRegister(rest: string[]): Promise<void> {
  if (!requireSessionOrExit()) return;

  const nameFlag = rest.indexOf("--name");
  const deviceName =
    nameFlag >= 0 && rest[nameFlag + 1] ? rest[nameFlag + 1] : deriveDeviceLabel();

  // Reuse this device's existing key when it has one. Minting a second
  // key would register a second Device row for one machine, and the
  // member would then hold two identities where they meant to hold one.
  const existing = loadDeviceKeypair();
  const keypair = existing ?? generateDeviceKeypair();

  const nonceWait = await withLoadingCancel(
    (signal) => apiCall("/api/v1/identity/devices/nonce", { signal }),
    "requesting a registration nonce",
  );
  if (nonceWait.cancelled) {
    cancel("Cancelled. Nothing was registered; run the command again when ready.");
    return;
  }
  const nonceRes = nonceWait.result;
  if (!nonceRes) {
    failNotLoggedIn();
    return;
  }
  if (!nonceRes.ok) {
    console.error(
      apiErrorMessage("request a registration nonce", nonceRes.status, await nonceRes.text()),
    );
    process.exitCode = 1;
    return;
  }
  const { nonce } = (await nonceRes.json()) as { nonce: string };

  // The signature covers the raw nonce BYTES. Signing the hex text
  // verifies nowhere and the server answers 400 without saying why.
  let signature: string;
  try {
    signature = signWithDeviceKey(Buffer.from(nonce, "hex"), keypair.privateKeyPem);
  } catch (err) {
    console.error(
      `Could not sign the registration nonce: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return;
  }

  const postWait = await withLoadingCancel(
    (signal) =>
      apiCall("/api/v1/identity/devices", {
        method: "POST",
        body: {
          did_key: keypair.didKey,
          signature,
          nonce,
          device_name: deviceName,
        },
        signal,
      }),
    "registering this device",
  );
  if (postWait.cancelled) {
    cancel(
      "Cancelled. Run 'alter key device show' to check whether the registration landed before re-running.",
    );
    return;
  }
  const res = postWait.result;
  if (!res) {
    failNotLoggedIn();
    return;
  }
  if (res.status === 409) {
    // Already on file. The local key is the one the field knows, so
    // persist it (a fresh install re-deriving the same key cannot
    // happen, but a store that lost the secret can be re-seeded here).
    writeDevicePrivateKeyPem(keypair.privateKeyPem);
    console.log(`This device is already registered: ${keypair.didKey}`);
    announceRootSeed();
    return;
  }
  if (!res.ok) {
    console.error(apiErrorMessage("register this device", res.status, await res.text()));
    process.exitCode = 1;
    return;
  }

  writeDevicePrivateKeyPem(keypair.privateKeyPem);
  console.log(`Device registered as ${deviceName}.`);
  console.log(`did:key: ${keypair.didKey}`);
  console.log(
    "The private half stays in this device's credential store and is never sent anywhere.",
  );
  announceRootSeed();
}

/**
 * Mint this member's root seed if they hold none, and show it exactly
 * once, at the moment it is minted.
 *
 * Shown here rather than left for the member to go and find, because
 * the seed is registered nowhere and there is no run of any command
 * that will tell them they should have written it down. Silent on every
 * later run: an unchanging secret reprinted on every registration is a
 * secret that ends up in a scrollback buffer, a terminal recording or a
 * screen share.
 */
function announceRootSeed(): void {
  // Never let this fail the registration around it. By the time this runs the
  // device key is registered with the field and written locally, so a store
  // that refuses here has cost the seed and nothing else. Throwing would
  // report a registration that genuinely succeeded as a failure, and the
  // member would re-run it chasing a problem that is not the one they have.
  let seed: Buffer;
  let minted: boolean;
  try {
    ({ seed, minted } = ensureRootSeed());
  } catch (err) {
    console.error("");
    console.error(
      `Could not mint a root seed: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(
      "The device key registered fine. Run `alter key device register` again once the",
    );
    console.error("credential store is available, and the seed will be minted then.");
    return;
  }
  if (!minted) return;
  console.log("");
  console.log("This member's root seed, shown once and never again:");
  console.log("");
  console.log(`  ${encodeRootSeed(seed)}`);
  console.log("");
  console.log(
    "Write it down and keep it somewhere safe. No server holds it, so nobody can reissue",
  );
  console.log(
    "it for you. Run `alter key seed export` to see it again on this machine, and",
  );
  console.log("`alter key seed import` to put it back on a new one.");
}

/** Show this device's did:key, or say plainly that it holds none. */
async function deviceShow(): Promise<void> {
  const keypair = loadDeviceKeypair();
  if (!keypair) {
    console.log("This device holds no signing key. Run `alter key device register`.");
    return;
  }
  console.log(`did:key: ${keypair.didKey}`);
  console.log(
    readRootSeed() !== null
      ? "Root seed: held on this machine (`alter key seed export` to write it down)."
      : "Root seed: none on this machine (`alter key seed import` to restore one).",
  );
}

/**
 * Show the root seed again, behind a confirm.
 *
 * The confirm is the whole point of the command being separate from
 * `device show`: printing a secret is a deliberate act, and a member
 * who typed this by accident, or was talked into typing it, gets one
 * plain question naming what is about to appear before it does.
 */
async function seedExport(): Promise<void> {
  const seed = readRootSeed();
  if (seed === null) {
    console.log(
      "This machine holds no root seed. Run `alter key device register` to mint one, or",
    );
    console.log("`alter key seed import` to restore the one you already have.");
    return;
  }
  // `null` is a cancel, and it lands in the same branch as "no" on
  // purpose: every answer that is not an explicit yes leaves the secret
  // unprinted.
  const ok = await confirmYesNo({
    message:
      "Print this member's root seed to the terminal? Anyone who can see this screen, or read its scrollback, can take it.",
    initialValue: false,
  });
  if (ok !== true) {
    console.log("Nothing was printed.");
    return;
  }
  console.log("");
  console.log(`  ${encodeRootSeed(seed)}`);
  console.log("");
}

/**
 * Restore a root seed onto this machine from its written-down form.
 *
 * Refuses to overwrite an existing seed without a confirm that says
 * what the overwrite costs. A member with one seed on this machine and
 * a different one in their hand is in the one situation where a silent
 * write loses key material for good.
 */
async function seedImport(rest: string[]): Promise<void> {
  // SECURITY: the root seed never travels through argv. Argv is readable by
  // every other process via /proc/<pid>/cmdline and lands in shell history,
  // and this seed is held by no server and can never be reissued, so an
  // exposure here is permanent and has no revocation. `alter login --token`
  // already refuses argv for a lower-value, expiring secret; the same refusal
  // applies with more force here. Import runs on a machine whose history is
  // fresh, which is exactly when a written-down secret is worth most.
  if (rest.length > 0) {
    console.error(
      "alter key seed import: refusing to read the seed from argv.\n" +
        "A seed passed on the command line is exposed to /proc/<pid>/cmdline\n" +
        "and tends to land in shell history, and nothing can reissue it.\n" +
        "Re-run as `alter key seed import` and type it at the masked prompt.",
    );
    process.exitCode = 1;
    return;
  }

  const entered = await clackPassword({
    message: "Type the root seed you wrote down",
    mask: "•",
  });
  if (isCancel(entered)) {
    console.log("Nothing changed.");
    return;
  }
  const text = String(entered).trim();
  if (!text) {
    console.error("No seed entered. Nothing changed.");
    process.exitCode = 1;
    return;
  }

  const seed = decodeRootSeed(text);
  if (seed === null) {
    console.error(
      "That is not a valid root seed. Check it against what you wrote down - the seed carries",
    );
    console.error("its own checksum, so a single wrong character is caught here.");
    process.exitCode = 1;
    return;
  }

  const existing = readRootSeed();
  if (existing !== null) {
    if (existing.equals(seed)) {
      console.log("This machine already holds that root seed. Nothing changed.");
      return;
    }
    const ok = await confirmYesNo({
      message:
        "This machine already holds a DIFFERENT root seed. Replace it? The one held here will be gone, and nothing can reissue it.",
      initialValue: false,
    });
    if (ok !== true) {
      console.log("Nothing changed.");
      return;
    }
  }

  writeRootSeed(seed);
  console.log("Root seed restored to this machine's credential store.");
}

async function listAll(): Promise<void> {
  const session = getSession();
  if (session?.member_api_key_display_prefix) {
    console.log(`Member key: ${session.member_api_key_display_prefix}`);
  } else if (session) {
    console.log("Member key: (none - run `alter key member rotate`)");
  }
  console.log("");
  console.log("Signing keys:");
  await signingList();
}
