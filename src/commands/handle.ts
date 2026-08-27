/**
 * alter handle - check ~handle availability pre-ceremony.
 *
 *   alter handle check <~foo>     Availability + normalised form
 *
 * The check endpoint is unauthenticated. Actual binding happens via the
 * Naming Ceremony post-login. Soft-reservation is not a user-facing flow.
 */

import { text, isCancel } from "@clack/prompts";
import { getSessionInfo, httpCall } from "../auth.js";
import { apiErrorMessage } from "../lib/api-error.js";
import { HANDLE_RE } from "../lib/handle-re.js";
import { withLoadingCancel } from "../ui/biosMenu.js";

interface HandleCheckResponse {
  handle: string;
  normalised: string;
  available: boolean;
  reason: string | null;
}

function printHelp(): void {
  console.log(
    "Usage: alter handle check <~handle>\n" +
      "\n" +
      "Check ~handle availability pre-ceremony.\n" +
      "  check <~foo>     availability + normalised form\n" +
      "\n" +
      "The endpoint is unauthenticated. Actual binding happens via the\n" +
      "Naming Ceremony post-login.\n",
  );
}

export async function handle(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "--help" || sub === "-h" || sub === "help") {
    printHelp();
    return;
  }
  if (sub === "check") return check(args.slice(1));
  console.log("Usage: alter handle check <~handle>");
  process.exitCode = 1;
}

function apiBase(): string {
  return getSessionInfo()?.api ?? "https://api.truealter.com";
}

// HANDLE_RE imported from lib/handle-re.ts - canonical backend-aligned pattern.

/**
 * Canonical handle normaliser for the CLI. Accepts a handle with or without
 * the ~ sigil, prepends ~ when absent so "yourhandle" becomes "~yourhandle",
 * lowercases the body. This is a PURE normaliser: it never throws and returns
 * "" for empty/whitespace input. Required-ness and validity are the caller's
 * concern (see isValidHandle) so a caller can safely normalise a handle for
 * display without risking an exception.
 */
export function ensureTilde(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const withTilde = trimmed.startsWith("~") ? trimmed : `~${trimmed}`;
  return "~" + withTilde.slice(1).toLowerCase();
}

/**
 * Coerce raw input to a ~handle. When allowEmail is set, an address
 * containing "@" passes through untouched; everything else gets the trill.
 */
export function coerceHandle(raw: string, allowEmail = false): string {
  const trimmed = raw.trim();
  if (allowEmail && trimmed.includes("@")) return trimmed;
  return ensureTilde(trimmed);
}

/**
 * Prompt for a peer ~handle with the trill ALREADY in the field, so the
 * sigil is visible as the user types the name after it - never a bare
 * placeholder they have to remember to prefix. Bare input is coerced to
 * ~handle on submit as a safety net (if they delete the ~). For a field
 * that also accepts an email (verify), pass allowEmail: true - the ~ is
 * not pre-filled and an address containing "@" passes through.
 *
 * Returns the clack cancel symbol when the user presses Esc; callers must
 * guard with isCancel() exactly as they did with the raw text() prompt.
 */
export async function promptHandle(opts: {
  message: string;
  allowEmail?: boolean;
}): Promise<string | symbol> {
  const res = await text({
    message: opts.message,
    placeholder: opts.allowEmail ? "~handle or email" : "~handle",
    initialValue: opts.allowEmail ? "" : "~",
    validate: (v) => {
      const t = String(v ?? "").trim();
      if (!t || t === "~") {
        return opts.allowEmail
          ? "Enter a ~handle or email, or press Esc to cancel."
          : "Enter a ~handle, or press Esc to cancel.";
      }
      return undefined;
    },
  });
  if (isCancel(res)) return res;
  return coerceHandle(String(res), opts.allowEmail);
}

/**
 * Validate a (preferably already-normalised) ~handle against the canonical
 * shape ~[a-z0-9][a-z0-9-]{1,31}. Input surfaces normalise with ensureTilde
 * then gate on this, so every surface rejects malformed handles identically
 * without coupling validation into the normaliser.
 */
export function isValidHandle(handle: string): boolean {
  return HANDLE_RE.test(handle);
}

function validateHandle(raw: string | undefined): string | null {
  if (!raw || !raw.trim()) {
    console.error("Handle required. Example: alter handle check ~yourname");
    process.exitCode = 1;
    return null;
  }
  const normalised = ensureTilde(raw);
  if (!isValidHandle(normalised)) {
    console.error(
      `malformed handle "${raw}" - must start with ~ then letters/digits, hyphens allowed in the middle`,
    );
    process.exitCode = 1;
    return null;
  }
  return normalised;
}

async function check(args: string[]): Promise<void> {
  const h = validateHandle(args[0]);
  if (!h) return;

  const url = `${apiBase()}/api/v1/handles/check?h=${encodeURIComponent(h)}`;
  // httpCall (not raw fetch) so the request carries the default timeout, and
  // withLoadingCancel so esc aborts it - a hung backend must never strand
  // the availability check.
  const wait = await withLoadingCancel(
    (signal) => httpCall(url, { signal }),
    "checking availability",
  );
  if (wait.cancelled) return;
  const res = wait.result!;
  if (!res.ok) {
    console.error(apiErrorMessage("check that handle", res.status, await res.text()));
    process.exitCode = 1;
    return;
  }
  const data = (await res.json()) as HandleCheckResponse;
  if (data.available) {
    console.log(`${data.normalised} available`);
  } else {
    console.log(`${data.normalised} unavailable: ${data.reason ?? "no reason given"}`);
  }
}
