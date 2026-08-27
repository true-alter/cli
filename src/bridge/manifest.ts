/**
 * Signed verb manifest.
 *
 * Browser pre-flights `GET /manifest` before issuing any verb call.
 * Manifest is signed by the member's session signing key (the same
 * P-256 key registered at `alter login` for `Mcp-Invocation-Signature`)
 * so the browser can prove the bridge it just discovered belongs to
 * the expected handle - closes the residual "did I open someone
 * else's bridge?" gap on a contested loopback port.
 */

import * as crypto from "node:crypto";

import type { AlterSession } from "../auth.js";
import {
  canonicalStringify,
  resolveBoundSigningKey,
  SigningKeyMismatchError,
} from "../signing.js";
import { ALLOWED_VERBS } from "./types.js";

// ---------------------------------------------------------------------------
// Wire shape
// ---------------------------------------------------------------------------

/**
 * Manifest payload signed by the member's session signing key. Mirrors
 * the JWS-compact-ish shape we use for invocation signatures - the
 * browser verifies via the same kid the backend hands out at login.
 */
export interface BridgeManifest {
  verbs: readonly string[];
  version: string;
  handle: string;
  kid?: string;
  issued_at: string;
  expires_at: string;
  signed: boolean;
  /** ES256 signature over canonicalStringify({ verbs, version, handle, kid, issued_at, expires_at }). */
  signature?: string;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

const MANIFEST_VERSION = "1";
const MANIFEST_TTL_MS = 5 * 60 * 1000;

/**
 * Build the manifest for `session`. If a session signing key is on
 * disk and `session.signing_kid` is set, sign the manifest. Otherwise
 * return the unsigned shape with `signed: false` - Phase 3 server
 * verification can require `signed: true` once the cohort with
 * signing keys is the only one reaching the bridge.
 */
export function buildManifest(session: AlterSession): BridgeManifest {
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + MANIFEST_TTL_MS);

  const base = {
    verbs: ALLOWED_VERBS as readonly string[],
    version: MANIFEST_VERSION,
    handle: session.handle,
    kid: session.signing_kid,
    issued_at: issuedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
  };

  // Bound resolution: refuses (throws) when the resolved key is not the
  // one session.signing_kid was issued against. On mismatch we surface
  // the error loudly and serve the manifest UNSIGNED; we never sign with
  // a key the kid does not pair with (the 2026-06-06 split-brain produced
  // exactly that: signatures that verified against the wrong public half).
  let privateKeyPem: string | null;
  try {
    privateKeyPem = resolveBoundSigningKey(session);
  } catch (err) {
    if (err instanceof SigningKeyMismatchError) {
      console.error(`alter bridge: ${err.message}`);
      return { ...base, signed: false };
    }
    throw err;
  }
  if (!privateKeyPem || !session.signing_kid) {
    return { ...base, signed: false };
  }

  try {
    const signingInput = canonicalStringify(base);
    const signer = crypto.createSign("SHA256");
    signer.update(signingInput, "utf-8");
    const sig = signer.sign({
      key: privateKeyPem,
      dsaEncoding: "ieee-p1363",
    });
    if (sig.length !== 64) {
      return { ...base, signed: false };
    }
    return {
      ...base,
      signed: true,
      signature: sig.toString("base64url"),
    };
  } catch {
    return { ...base, signed: false };
  }
}
