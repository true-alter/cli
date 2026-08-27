/**
 * verify-release - cryptographic verify-before-exec for the ALTER CLI's
 * silent auto-update.
 *
 * "install once, never think about it". An earlier holding measure added an
 * interactive y/N prompt before every npm self-install because a silent
 * install over a compromised npm publish (or a poisoned channel.json) is
 * supply-chain-RCE territory. This module removes the need for that prompt on
 * the happy path by cryptographically verifying, BEFORE install, that the
 * version we are about to pull is the exact artefact ALTER's CI signed - using
 * sigstore-keyless (Fulcio) attestation against an ALTER-controlled trust
 * anchor at releases.truealter.com.
 *
 * THREE-VERDICT CONTRACT (consumed by self-update.maybeAutoUpdate):
 *   - "verified"     -> safe to install SILENTLY (no prompt).
 *   - "rejected"     -> a real cryptographic / integrity failure. NEVER install,
 *                       NEVER prompt - prompting would let a user click through a
 *                       crypto reject and install poisoned bytes.
 *   - "unavailable"  -> verification could not be COMPLETED (substrate not yet
 *                       populated, network timeout, packaging gap). Caller falls
 *                       back to the existing y/N prompt. No worse than today.
 *
 * DEFAULT-DENY (core security invariant): the ONLY path to "verified"
 * is an explicit `outcome: "ok"` from the sigstore verifier. Any throw, any
 * ambiguous shape, any missing field anywhere collapses to "rejected" or
 * "unavailable" - never "verified". An always-failing verifier degrades every
 * user to the prompt (safe); an always-passing verifier is catastrophic (RCE),
 * so every branch defaults to not-verified.
 *
 * IDENTITY FLOOR (defence-in-depth): the expected CI signing identity is pinned
 * BOTH in the live trust anchor (keys.json `sigstore[]`) AND hard-coded here.
 * keys.json can rotate / add identities for operational flexibility, but it can
 * NEVER widen the trust below the hard floor: every accepted identity must be
 * issued by the GitHub Actions OIDC issuer for the true-alter/alter-cli release
 * workflow. A tampered keys.json that injects a foreign identity is rejected by
 * the floor before it ever reaches the verifier.
 *
 * Trust root: the sigstore public-good Fulcio/Rekor/CT roots are VENDORED at
 * `sigstore/trusted-root.json` (copied into dist at build) and parsed offline.
 * We deliberately do NOT perform a live TUF refresh on every invocation - that
 * would make `alter login` depend on sigstore.dev being reachable. The vendored
 * root is refreshed when we cut CLI releases.
 *
 * Every IO + crypto path is injectable (`VerifyReleaseDeps`) so the orchestration
 * and the default-deny logic are unit-tested offline without touching the
 * network or real sigstore.
 */

import { createHash } from "crypto";
import { readFileSync } from "fs";
import { dirname, resolve as pathResolve } from "path";
import { fileURLToPath } from "url";

import { bundleFromJSON } from "@sigstore/bundle";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { Verifier, toSignedEntity, toTrustMaterial } from "@sigstore/verify";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RELEASES_BASE_PROD = "https://releases.truealter.com";

/**
 * The release host. Any other base is rejected - the substrate URL space is
 * locked so a caller can't be pointed at an attacker-controlled host. The
 * published build allows the prod substrate only.
 */
const ALLOWED_RELEASE_BASES: ReadonlySet<string> = new Set([
  RELEASES_BASE_PROD,
]);

/** The manifest platform key carrying the npm tarball the CLI self-installs. */
const NPM_TARBALL_KEY = "npm-tarball";

const NETWORK_TIMEOUT_MS = 4000;

/** Refuse absurdly large downloads - the CLI tarball is well under this. */
const MAX_TARBALL_BYTES = 32 * 1024 * 1024;

/**
 * Hard identity FLOOR, PER-PLATFORM. keys.json can never widen trust below
 * this. The signing cert MUST be issued by GitHub Actions OIDC, and its SAN
 * MUST begin with the prefix of the repo whose CI signs THAT platform:
 *   - the npm tarball is signed by the alter-cli release workflow;
 *   - the OS binaries (linux-* / darwin-*) are signed by the alter-runtime
 *     release workflow (Fulcio keyless OIDC binds the SAN to the running repo).
 * A platform key with NO floor entry is DEFAULT-DENIED (no signing identity is
 * accepted for it); the verdict for an unmapped key is "unavailable".
 */
const EXPECTED_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const ALTER_CLI_SUBJECT_PREFIX =
  "https://github.com/true-alter/alter-cli/.github/workflows/";
const ALTER_RUNTIME_SUBJECT_PREFIX =
  "https://github.com/true-alter/alter-runtime/.github/workflows/";

/**
 * Resolve the hard subject-prefix floor for a platform key. DEFAULT-DENY:
 * returns null for any key with no explicit mapping, which the caller turns
 * into an "unavailable" verdict (never a permissive/empty floor).
 */
function subjectPrefixFloorFor(platformKey: string): string | null {
  if (platformKey === NPM_TARBALL_KEY) return ALTER_CLI_SUBJECT_PREFIX;
  if (/^(linux|darwin)-/.test(platformKey)) return ALTER_RUNTIME_SUBJECT_PREFIX;
  return null;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const NPM_INTEGRITY_RE = /^sha512-[A-Za-z0-9+/=]+$/;

// ---------------------------------------------------------------------------
// Public verdict + dependency types
// ---------------------------------------------------------------------------

export type VerifyVerdict =
  | {
      status: "verified";
      version: string;
      /** Present for the npm-tarball platform; the integrity the CLI pins on install. */
      npmIntegrity?: string;
      /** The manifest-bound, signature-covered digest of the verified artefact. */
      sha256?: string;
    }
  | { status: "rejected"; reason: string }
  | { status: "unavailable"; reason: string };

/**
 * Outcome of a single sigstore verification attempt against one identity pin.
 *   - "ok"          -> signature valid AND identity matches the pin.
 *   - "fail"        -> a real verification rejection (bad chain, bad signature,
 *                      identity mismatch). Contributes to a "rejected" verdict.
 *   - "infra-error" -> the verifier could not run to a decision (trusted root
 *                      unreadable, bundle unparseable). Contributes to an
 *                      "unavailable" verdict. NEVER "ok".
 */
export type SigstoreVerifyOutcome = {
  outcome: "ok" | "fail" | "infra-error";
  san?: string;
  detail?: string;
};

export type SigstoreVerifyFn = (input: {
  bundleJson: unknown;
  artifact: Buffer;
  expectedIssuer: string;
  expectedSubjectPattern: string;
}) => SigstoreVerifyOutcome | Promise<SigstoreVerifyOutcome>;

export interface VerifyReleaseDeps {
  /** Fetch impl, defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Sigstore verifier, defaults to the real @sigstore/verify wiring. */
  verifyImpl?: SigstoreVerifyFn;
  /** Stderr writer (best-effort diagnostics). */
  stderr?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// Read-only wire shapes (a subset of the canonical release-worker types,
// re-declared here. If the worker schema changes, this must follow.)
// ---------------------------------------------------------------------------

interface PlatformEntrySubset {
  latest_version: string;
  url: string;
  sha256: string;
  sigstore_bundle?: string;
  npm_integrity?: string;
}

interface SigstorePin {
  fulcio_issuer: string;
  fulcio_subject_pattern: string;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Verify that `version` is an authentically ALTER-CI-signed release, suitable
 * for a silent self-install. See the three-verdict contract above.
 */
export async function verifyRelease(opts: {
  version: string;
  /**
   * Which manifest platform to verify. Defaults to "npm-tarball" so existing
   * self-update callers are unchanged. OS-binary keys (linux-* / darwin-*) are
   * floored against the alter-runtime signer.
   */
  platformKey?: string;
  releasesBase?: string;
  deps?: VerifyReleaseDeps;
}): Promise<VerifyVerdict> {
  const fetchImpl = opts.deps?.fetchImpl ?? fetch;
  const verifyImpl = opts.deps?.verifyImpl ?? defaultSigstoreVerify;
  const platformKey = opts.platformKey ?? NPM_TARBALL_KEY;
  const isNpmTarball = platformKey === NPM_TARBALL_KEY;

  // PER-PLATFORM hard identity floor. DEFAULT-DENY: an unmapped platform key
  // has no accepted signing identity and can never reach "verified".
  const subjectPrefixFloor = subjectPrefixFloorFor(platformKey);
  if (!subjectPrefixFloor) {
    return {
      status: "unavailable",
      reason: `no identity floor for platform key: ${platformKey}`,
    };
  }

  const base = opts.releasesBase ?? RELEASES_BASE_PROD;
  if (!ALLOWED_RELEASE_BASES.has(base)) {
    return { status: "unavailable", reason: `release base not allowed: ${base}` };
  }

  // 1. Manifest -------------------------------------------------------------
  const manifest = await fetchJson(`${base}/manifest.json`, fetchImpl);
  if (!manifest) return { status: "unavailable", reason: "manifest unreachable" };

  const entry = readPlatformEntry(manifest, platformKey);
  if (!entry) {
    return { status: "unavailable", reason: `no ${platformKey} release entry` };
  }
  if (entry.latest_version !== opts.version) {
    return {
      status: "unavailable",
      reason: `manifest version ${entry.latest_version} != target ${opts.version}`,
    };
  }
  if (!entry.sigstore_bundle) {
    return { status: "unavailable", reason: "entry missing sigstore bundle" };
  }
  // npm_integrity is required ONLY for the npm-tarball platform (the CLI pins
  // it on `npm install`). OS binaries are integrity-bound by sha256 alone.
  if (isNpmTarball && !entry.npm_integrity) {
    return { status: "unavailable", reason: "entry missing npm_integrity" };
  }
  if (!isHttpsUnder(entry.url, base)) {
    return { status: "unavailable", reason: "entry url not on the release substrate" };
  }
  if (!isHttpsUnder(entry.sigstore_bundle, base)) {
    return { status: "unavailable", reason: "bundle url not on the release substrate" };
  }
  if (!SHA256_RE.test(entry.sha256)) {
    return { status: "unavailable", reason: "entry sha256 malformed" };
  }
  if (isNpmTarball && !NPM_INTEGRITY_RE.test(entry.npm_integrity as string)) {
    return { status: "unavailable", reason: "npm_integrity malformed" };
  }

  // 2. Trust-anchor identity pins (with hard floor) -------------------------
  const keys = await fetchJson(`${base}/.well-known/keys.json`, fetchImpl);
  if (!keys) return { status: "unavailable", reason: "keys.json unreachable" };

  const pins = readSigstorePins(keys).filter(
    (p) =>
      p.fulcio_issuer === EXPECTED_OIDC_ISSUER &&
      p.fulcio_subject_pattern.startsWith(subjectPrefixFloor),
  );
  if (pins.length === 0) {
    return {
      status: "unavailable",
      reason: "no trust-anchor identity pin (empty or below identity floor)",
    };
  }

  // 3. Fetch the bundle + the exact tarball bytes the signature covers ------
  const bundleJson = await fetchJson(entry.sigstore_bundle, fetchImpl);
  if (!bundleJson) return { status: "unavailable", reason: "sigstore bundle unreachable" };

  const tarball = await fetchBytes(entry.url, fetchImpl);
  if (!tarball) return { status: "unavailable", reason: "release tarball unreachable" };

  // 4. Integrity binding: manifest.sha256 must equal sha256(tarball) --------
  const digest = createHash("sha256").update(tarball).digest("hex");
  if (digest !== entry.sha256) {
    return { status: "rejected", reason: "tarball digest does not match manifest" };
  }

  // 5. Sigstore verification against each surviving identity pin ------------
  // DEFAULT-DENY: only an explicit "ok" reaches "verified". A throw is caught
  // and treated as infra-error, never as success.
  let sawRealFailure = false;
  for (const pin of pins) {
    let result: SigstoreVerifyOutcome;
    try {
      result = await Promise.resolve(
        verifyImpl({
          bundleJson,
          artifact: tarball,
          expectedIssuer: pin.fulcio_issuer,
          expectedSubjectPattern: pin.fulcio_subject_pattern,
        }),
      );
    } catch (err) {
      result = { outcome: "infra-error", detail: errText(err) };
    }

    if (result && result.outcome === "ok") {
      return {
        status: "verified",
        version: opts.version,
        sha256: entry.sha256,
        ...(isNpmTarball ? { npmIntegrity: entry.npm_integrity } : {}),
      };
    }
    if (result && result.outcome === "fail") {
      sawRealFailure = true;
    }
  }

  if (sawRealFailure) {
    return { status: "rejected", reason: "signature or identity verification failed" };
  }
  return { status: "unavailable", reason: "verification could not be completed" };
}

// ---------------------------------------------------------------------------
// Default real sigstore verifier (offline trust root + identity policy)
// ---------------------------------------------------------------------------

/**
 * Real verification via @sigstore/verify against the vendored trust root.
 * Synchronous (the underlying Verifier is sync). Returns a structured outcome;
 * NEVER throws to the caller - any unexpected error becomes "infra-error".
 */
export function defaultSigstoreVerify(input: {
  bundleJson: unknown;
  artifact: Buffer;
  expectedIssuer: string;
  expectedSubjectPattern: string;
}): SigstoreVerifyOutcome {
  try {
    let trustMaterial;
    try {
      const raw = readFileSync(trustedRootPath(), "utf8");
      trustMaterial = toTrustMaterial(TrustedRoot.fromJSON(JSON.parse(raw)));
    } catch (err) {
      // Packaging gap / unreadable root -> cannot verify -> degrade to prompt.
      return { outcome: "infra-error", detail: `trusted root unavailable: ${errText(err)}` };
    }

    let entity;
    try {
      entity = toSignedEntity(bundleFromJSON(input.bundleJson), input.artifact);
    } catch (err) {
      // A bundle we can't even parse is more likely schema skew / corruption
      // than a forgery; degrade to prompt rather than hard-reject.
      return { outcome: "infra-error", detail: `bundle unparseable: ${errText(err)}` };
    }

    let signer;
    try {
      signer = new Verifier(trustMaterial).verify(entity, {
        extensions: { issuer: input.expectedIssuer },
      });
    } catch (err) {
      // A real verification rejection: bad chain, bad signature, no tlog
      // inclusion, or issuer-extension mismatch.
      return { outcome: "fail", detail: `verify rejected: ${errText(err)}` };
    }

    const san = signer.identity?.subjectAlternativeName;
    if (!san) {
      return { outcome: "fail", detail: "signing certificate carries no SAN" };
    }
    if (!globToRegExp(input.expectedSubjectPattern).test(san)) {
      return { outcome: "fail", detail: "certificate SAN does not match identity pin" };
    }
    return { outcome: "ok", san };
  } catch (err) {
    // Belt-and-braces: any unexpected throw is infra-error, never "ok".
    return { outcome: "infra-error", detail: errText(err) };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Absolute path to the vendored sigstore trust root (copied into dist at build). */
export function trustedRootPath(): string {
  return pathResolve(
    dirname(fileURLToPath(import.meta.url)),
    "sigstore",
    "trusted-root.json",
  );
}

async function fetchJson(
  url: string,
  fetchImpl: typeof fetch,
): Promise<unknown | null> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function fetchBytes(
  url: string,
  fetchImpl: typeof fetch,
): Promise<Buffer | null> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  try {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_TARBALL_BYTES) return null;
    return buf;
  } catch {
    return null;
  }
}

function readPlatformEntry(
  manifest: unknown,
  platformKey: string,
): PlatformEntrySubset | null {
  if (!manifest || typeof manifest !== "object") return null;
  const platforms = (manifest as { platforms?: unknown }).platforms;
  if (!platforms || typeof platforms !== "object") return null;
  const entry = (platforms as Record<string, unknown>)[platformKey];
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.latest_version !== "string") return null;
  if (typeof e.url !== "string") return null;
  if (typeof e.sha256 !== "string") return null;
  return {
    latest_version: e.latest_version,
    url: e.url,
    sha256: e.sha256,
    sigstore_bundle:
      typeof e.sigstore_bundle === "string" ? e.sigstore_bundle : undefined,
    npm_integrity:
      typeof e.npm_integrity === "string" ? e.npm_integrity : undefined,
  };
}

function readSigstorePins(keys: unknown): SigstorePin[] {
  if (!keys || typeof keys !== "object") return [];
  const arr = (keys as { sigstore?: unknown }).sigstore;
  if (!Array.isArray(arr)) return [];
  const pins: SigstorePin[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const i = item as Record<string, unknown>;
    if (
      typeof i.fulcio_issuer === "string" &&
      typeof i.fulcio_subject_pattern === "string"
    ) {
      pins.push({
        fulcio_issuer: i.fulcio_issuer,
        fulcio_subject_pattern: i.fulcio_subject_pattern,
      });
    }
  }
  return pins;
}

/** True if `url` is an https URL under `${base}/`. */
function isHttpsUnder(url: string, base: string): boolean {
  return url.startsWith(`${base}/`) && url.startsWith("https://");
}

/**
 * Convert a subject pattern using only the `*` wildcard into an anchored
 * RegExp. Every other character is matched literally (regex-escaped).
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withWildcard = escaped.replace(/\\\*/g, ".*");
  return new RegExp(`^${withWildcard}$`);
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
