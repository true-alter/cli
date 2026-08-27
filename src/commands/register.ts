/**
 * alter register - browserless, terminal-native member registration.
 *
 * The ceremony-free human door: create a real ~alter member from the terminal
 * with NO browser and NO passkey ceremony, the way `gh auth login` device flow
 * feels but fully in-terminal. It pairs with `alter login` (which authenticates
 * an EXISTING member): `register` is for someone who has no ~handle yet.
 *
 * Flow:
 *   1. Pick a ~handle (interactive prompt, or --handle for headless).
 *   2. Confirm 18+ and acknowledge the member terms (interactive, or the
 *      explicit --i-am-18 / --accept-terms flags for headless). A ceremony-free
 *      flow is NOT a consent-free flow: these are always captured.
 *   3. Solve a single-use proof-of-work challenge in-process (the terminal's
 *      substitute for the browser's Turnstile bot-signal). Same server-side
 *      machinery the autonomous-agent self-mint uses.
 *   4. POST the solution to /api/v1/auth/register/terminal, which mints a real
 *      member and returns an access token.
 *   5. Persist the session via the same storeSession() path `alter login` uses
 *      (member-key mint + signing-key registration).
 *
 * Flags:
 *   --handle ~name      the ~handle to claim (skips the interactive prompt).
 *   --i-am-18           confirm you are 18 or older (required in headless mode).
 *   --accept-terms      acknowledge the member terms (required in headless mode).
 *   --api <url>         backend base URL override (allow-list validated).
 *   -h, --help          show this help.
 */

import { createHash } from "node:crypto";
import {
  cancel as clackCancel,
  confirm as clackConfirm,
  isCancel,
  spinner as clackSpinner,
  text as clackText,
} from "@clack/prompts";
import stripAnsi from "strip-ansi";

import { apiErrorMessage } from "../lib/api-error.js";
import { fetchWithRetry } from "../lib/fetch-with-retry.js";
import { HANDLE_RE } from "../lib/handle-re.js";
import { getCliVersion } from "../lib/version.js";
import { readSession, isSentinelSession } from "../auth.js";
import { DEFAULT_API, storeSession, validateApiOverride } from "./login.js";

interface ChallengeResponse {
  challenge: string;
  difficulty: number;
  expires_at: number;
  hint: string;
}

interface RegisterResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  user?: { id: string; role: string; email: string | null };
}

function printHelp(): void {
  console.log(
    [
      "alter register - create a new ~alter member from the terminal.",
      "",
      "  No browser, no passkey. Pick a ~handle, confirm you're 18+, and",
      "  you're in. If you already have a ~handle, run `alter login` instead.",
      "",
      "Usage:",
      "  alter register [--handle ~name] [--i-am-18] [--accept-terms]",
      "",
      "Flags:",
      "  --handle ~name    the ~handle to claim (skips the prompt)",
      "  --i-am-18         confirm you are 18 or older (required when headless)",
      "  --accept-terms    acknowledge the member terms (required when headless)",
      "  --api <url>       backend base URL override",
      "  -h, --help        show this help",
    ].join("\n"),
  );
}

/** Read `--flag value` from args, or null. */
function flagValue(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  if (i === -1 || i + 1 >= args.length) return null;
  return args[i + 1];
}

/**
 * Count leading zero BITS of a big-endian digest buffer, matching the
 * backend's `_leading_zero_bits` (app/security/proof_of_work.py).
 */
function leadingZeroBits(digest: Buffer): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    // clz32 of an 8-bit value returns 24..31; the leading zeros within the
    // byte are that minus the 24 high zero bits of the 32-bit register.
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

/**
 * Solve the proof-of-work: find a nonce whose sha256(challenge:nonce) digest
 * has at least `difficulty` leading zero bits. Yields to the event loop
 * periodically so the spinner renders and Ctrl-C stays responsive.
 */
async function solveProofOfWork(
  challenge: string,
  difficulty: number,
  expiresAt: number,
  onProgress: (hashes: number) => void,
): Promise<string> {
  let n = 0;
  const BATCH = 50_000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (let i = 0; i < BATCH; i++) {
      const nonce = String(n);
      const digest = createHash("sha256")
        .update(`${challenge}:${nonce}`)
        .digest();
      if (leadingZeroBits(digest) >= difficulty) {
        return nonce;
      }
      n++;
    }
    onProgress(n);
    if (Date.now() / 1000 > expiresAt) {
      throw new Error(
        "The proof-of-work challenge expired before it was solved. Run " +
          "`alter register` again.",
      );
    }
    // Yield so the spinner paints and SIGINT is handled between batches.
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function normaliseHandle(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  return trimmed.startsWith("~") ? trimmed : `~${trimmed}`;
}

export async function register(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  let api: string;
  try {
    api = args.includes("--api")
      ? validateApiOverride(args[args.indexOf("--api") + 1])
      : DEFAULT_API;
  } catch (err) {
    // validateApiOverride throws on a missing or blocked --api value; refuse to
    // send anything to an unvalidated host and exit cleanly (mirror `alter login`).
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
    return;
  }

  // Already-logged-in guard: a live session means this machine already has a
  // member. Registering again would clobber it. Mirror `alter login`.
  const prior = readSession();
  if (
    prior &&
    !isSentinelSession(prior) &&
    new Date(prior.jwt_expires_at) > new Date()
  ) {
    console.log(`You are already signed in as ${prior.handle}.`);
    console.log(
      "Run `alter logout` first, or `alter login` to re-authenticate.",
    );
    return;
  }

  const headless = !process.stdin.isTTY;
  const userAgent = `alter-cli/${getCliVersion()}`;

  // --- 1. Handle -----------------------------------------------------------
  let handle = flagValue(args, "--handle");
  if (!handle) {
    if (headless) {
      console.error(
        "alter register: no terminal detected. Pass --handle ~name " +
          "--i-am-18 --accept-terms to register non-interactively.",
      );
      process.exitCode = 2;
      return;
    }
    const answer = await clackText({
      message: "Choose your ~handle",
      placeholder: "~yourname",
      validate: (value) => {
        const h = normaliseHandle(value ?? "");
        if (!HANDLE_RE.test(h)) {
          return "A ~handle is letters, numbers, and hyphens, starting with a letter or number.";
        }
        return undefined;
      },
    });
    if (isCancel(answer)) {
      clackCancel("Registration cancelled.");
      return;
    }
    handle = answer as string;
  }
  handle = normaliseHandle(handle);
  if (!HANDLE_RE.test(handle)) {
    console.error(
      `alter register: '${handle}' is not a valid ~handle (letters, numbers, ` +
        "and hyphens, starting with a letter or number).",
    );
    process.exitCode = 2;
    return;
  }

  // --- 2. Age + consent (never skipped) ------------------------------------
  let is18 = args.includes("--i-am-18");
  let acceptTerms = args.includes("--accept-terms");

  if (!is18) {
    if (headless) {
      console.error(
        "alter register: pass --i-am-18 to confirm you are 18 or older.",
      );
      process.exitCode = 2;
      return;
    }
    const answer = await clackConfirm({ message: "Are you 18 or older?" });
    if (isCancel(answer)) {
      clackCancel("Registration cancelled.");
      return;
    }
    is18 = answer === true;
  }
  if (!is18) {
    console.error("alter register: you must be 18 or older to register.");
    process.exitCode = 1;
    return;
  }

  if (!acceptTerms) {
    if (headless) {
      console.error(
        "alter register: pass --accept-terms to acknowledge the member terms.",
      );
      process.exitCode = 2;
      return;
    }
    const answer = await clackConfirm({
      message:
        "Do you acknowledge the member terms and consent to your ~handle " +
        "being your identity on ~Alter?",
    });
    if (isCancel(answer)) {
      clackCancel("Registration cancelled.");
      return;
    }
    acceptTerms = answer === true;
  }
  if (!acceptTerms) {
    console.error(
      "alter register: registration needs your acknowledgement of the terms.",
    );
    process.exitCode = 1;
    return;
  }

  // --- 3. Proof-of-work challenge ------------------------------------------
  const spin = clackSpinner();
  spin.start("Requesting a registration challenge");
  let challenge: ChallengeResponse;
  try {
    const resp = await fetchWithRetry(
      `${api}/api/v1/auth/register/terminal/challenge`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": userAgent,
        },
        body: JSON.stringify({}),
      },
    );
    if (!resp.ok) {
      const body = stripAnsi(await resp.text());
      spin.stop("Could not start registration.");
      console.error(
        apiErrorMessage("start registration", resp.status, body.slice(0, 200)),
      );
      process.exitCode = 1;
      return;
    }
    challenge = (await resp.json()) as ChallengeResponse;
  } catch (err) {
    spin.stop("Could not reach ~Alter.");
    console.error(`alter register: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  // --- 4. Solve it ---------------------------------------------------------
  spin.message("Proving you're a person (this takes a few seconds)");
  let nonce: string;
  try {
    nonce = await solveProofOfWork(
      challenge.challenge,
      challenge.difficulty,
      challenge.expires_at,
      (hashes) => {
        spin.message(
          `Proving you're a person (${(hashes / 1_000_000).toFixed(1)}M tries)`,
        );
      },
    );
  } catch (err) {
    spin.stop("Challenge expired.");
    console.error(`alter register: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  // --- 5. Mint the member --------------------------------------------------
  spin.message("Creating your ~alter");
  let minted: RegisterResponse;
  try {
    const resp = await fetchWithRetry(`${api}/api/v1/auth/register/terminal`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": userAgent,
      },
      body: JSON.stringify({
        preferred_handle: handle,
        age_attestation_18_plus: true,
        consent_acknowledged: true,
        challenge: challenge.challenge,
        nonce,
      }),
    });
    if (!resp.ok) {
      const body = stripAnsi(await resp.text());
      spin.stop("Registration failed.");
      // A taken handle is the common, actionable case: name it plainly.
      if (resp.status === 409) {
        console.error(
          `alter register: the ~handle ${handle} is already taken. ` +
            "Run `alter register --handle ~another-name` to try a different one.",
        );
      } else {
        console.error(
          apiErrorMessage("register", resp.status, body.slice(0, 200)),
        );
      }
      process.exitCode = 1;
      return;
    }
    minted = (await resp.json()) as RegisterResponse;
  } catch (err) {
    spin.stop("Registration failed.");
    console.error(`alter register: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  // --- 6. Persist the session (member-key mint + signing key) --------------
  spin.message("Setting up your credentials");
  try {
    await storeSession(api, {
      access_token: minted.access_token,
      expires_in: minted.expires_in,
    });
  } catch (err) {
    spin.stop("Almost there.");
    console.error(
      "alter register: your ~alter was created, but saving the local " +
        `session failed (${(err as Error).message}). Run \`alter login\` to ` +
        "finish setting up this device.",
    );
    process.exitCode = 1;
    return;
  }

  spin.stop(`Welcome to ~Alter, ${handle}.`);
  console.log("");
  console.log("You're in. No browser, no password.");
  console.log("  alter whoami     see who you are here");
  console.log("  alter status     check your session");
}
