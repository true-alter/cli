/**
 * alter runtime - verify an alter-runtime OS binary against the signed,
 * sigstore-attested release manifest before it is executed.
 *
 * The runtime apply-step downloads a platform tarball from
 * releases.truealter.com and then shells out to:
 *
 *   alter runtime verify --platform <key> --version <v> --file <localpath>
 *                        [--releases-base <url>]
 *
 * This is the FAIL-CLOSED gate that binds the bytes on disk to the digest the
 * sigstore signature covers, closing the TOCTOU window between download and
 * exec:
 *
 *   1. Compute sha256 of the local file at <localpath>.
 *   2. Run verifyRelease({version, platformKey, releasesBase}) - the full
 *      per-platform identity-floor + sigstore verification.
 *   3. Exit 0 (and print a JSON verdict to stdout) ONLY IF the verdict is
 *      "verified" AND sha256(localfile) === the manifest-bound, signature-
 *      covered digest in the verdict. On ANY other outcome (unavailable,
 *      rejected, missing file, digest mismatch) print the reason and exit
 *      non-zero. There is no path to exit 0 on unverified bytes.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { verifyRelease, type VerifyVerdict } from "../lib/verify-release.js";

interface RuntimeVerifyArgs {
  platform?: string;
  version?: string;
  file?: string;
  releasesBase?: string;
}

function parseFlags(args: string[]): RuntimeVerifyArgs {
  const out: RuntimeVerifyArgs = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = (): string | undefined => args[++i];
    switch (a) {
      case "--platform":
        out.platform = next();
        break;
      case "--version":
        out.version = next();
        break;
      case "--file":
        out.file = next();
        break;
      case "--releases-base":
        out.releasesBase = next();
        break;
      default:
        // Ignore unknown flags rather than guess; the gate is fail-closed on
        // missing required flags below.
        break;
    }
  }
  return out;
}

const USAGE =
  "Usage: alter runtime verify --platform <key> --version <v> --file <localpath> [--releases-base <url>]";

/** Emit a JSON line to stdout. */
function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/** Fail closed: print a JSON reason to stdout, set a non-zero exit code. */
function fail(reason: string): void {
  emit({ ok: false, status: "rejected", reason });
  process.exitCode = 1;
}

async function runtimeVerify(args: string[]): Promise<void> {
  const opts = parseFlags(args);

  if (args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(USAGE + "\n");
    return;
  }
  if (!opts.platform || !opts.version || !opts.file) {
    process.stderr.write(USAGE + "\n");
    fail("missing required flag: --platform, --version and --file are all required");
    return;
  }

  // 1. sha256 of the local bytes ------------------------------------------
  let localSha256: string;
  try {
    const bytes = readFileSync(opts.file);
    localSha256 = createHash("sha256").update(bytes).digest("hex");
  } catch (err) {
    fail(`cannot read --file ${opts.file}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // 2. Full per-platform sigstore verification -----------------------------
  let verdict: VerifyVerdict;
  try {
    verdict = await verifyRelease({
      version: opts.version,
      platformKey: opts.platform,
      releasesBase: opts.releasesBase,
    });
  } catch (err) {
    // A throw in the verifier must NEVER pass the gate.
    fail(`verification error: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // 3. Fail closed on anything that is not a clean "verified" --------------
  if (verdict.status !== "verified") {
    emit({ ok: false, status: verdict.status, reason: verdict.reason });
    process.exitCode = 1;
    return;
  }

  // The verified verdict must carry the signature-covered digest, and the
  // local bytes must match it exactly. This binds disk -> manifest -> sig.
  if (!verdict.sha256) {
    fail("verified verdict carried no sha256 to bind against");
    return;
  }
  if (verdict.sha256 !== localSha256) {
    emit({
      ok: false,
      status: "rejected",
      reason: "local file sha256 does not match the signature-covered manifest digest",
      expected: verdict.sha256,
      actual: localSha256,
    });
    process.exitCode = 1;
    return;
  }

  // Verified AND bound. Exit 0.
  emit({
    ok: true,
    status: "verified",
    platform: opts.platform,
    version: verdict.version,
    sha256: verdict.sha256,
  });
}

export async function runtime(args: string[]): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case "verify":
      await runtimeVerify(args.slice(1));
      break;
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(
        "Usage: alter runtime <verb>\n\n" +
          "Verbs:\n" +
          "  verify   Verify a downloaded alter-runtime OS binary against the\n" +
          "           signed release manifest before it is executed.\n\n" +
          USAGE +
          "\n",
      );
      break;
    default:
      process.stderr.write(`alter runtime: unknown verb '${sub}'\n${USAGE}\n`);
      process.exitCode = 1;
      break;
  }
}
