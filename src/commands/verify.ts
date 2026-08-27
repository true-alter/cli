/**
 * alter verify - verify whether a person is registered on ALTER.
 *
 * Wraps `GET /api/v1/identity/verify?subject=...`. Subject may be a
 * member UUID, an email address, or a sovereign `~handle`. Foreign
 * `~handle` resolution is rejected with a clear error until the handles
 * service ships; the same error comes back from the server, so the CLI
 * does not pre-validate.
 *
 * Authentication: this endpoint is member-session-authenticated, no
 * longer an anonymous lookup. `GET /api/v1/identity/verify` is gated
 * behind a member session - anonymous
 * email→identity resolution had no per-member opt-in by construction and
 * was the largest single enumeration surface in the codebase. `alter
 * verify` therefore requires `alter login`. It is still free of x402
 * charge; repeated lookups against the same subject are throttled
 * server-side (per-target counter), and the email branch carries a
 * tighter per-caller ceiling.
 *
 * Anti-enumeration: the server returns a structurally-identical
 * not-registered response shape regardless of *why* the lookup failed
 * (invalid UUID, unknown email hash, malformed input, throttle hit). The
 * CLI preserves that posture - it does not try to differentiate.
 */

import {
  apiCall,
  getSession,
  getSessionInfo,
  NOT_LOGGED_IN_MESSAGE,
} from "../auth.js";
import { brand, drawFrame, enterAlt, exitAlt } from "../ui/biosMenu.js";
import {
  createInputSession,
  type DecodedKey,
  type InputSession,
} from "../ui/rawKeys.js";
import { ensureTilde, isValidHandle } from "./handle.js";

interface VerifyResponse {
  registered?: boolean;
  member_id?: string | null;
  account_status?: string | null;
  engagement_level?: number | null;
  archetype?: string | null;
  verified_at?: string;
  is_stub?: boolean;
  has_claim_code?: boolean;
  [key: string]: unknown;
}

const ENDPOINT = "/api/v1/identity/verify";

function printHelp(): void {
  console.log(
    "Usage: alter verify <subject> [--json]\n" +
      "\n" +
      "Verify whether a person is registered on ~Alter. <subject> may be:\n" +
      "  · a member UUID                e.g. 6f3c…d901\n" +
      "  · an email address             e.g. alice@example.com\n" +
      "  · your own ~handle             e.g. ~yourname\n" +
      "\n" +
      "Foreign ~handle resolution is not yet supported and will be\n" +
      "rejected with a clear error.\n" +
      "\n" +
      "Requires a signed-in session - run 'alter login' first. The lookup\n" +
      "is free of x402 charge, but repeated lookups against the same\n" +
      "subject are throttled (anti-enumeration), and the server returns\n" +
      "the same response shape regardless of why a lookup failed.\n" +
      "\n" +
      "Options:\n" +
      "  --json     Emit the raw response as JSON for scripting.\n" +
      "  --help     Show this message.\n",
  );
}

/**
 * Render the verify result to a list of lines. Shared by the print-and-exit
 * CLI path (`prettyPrint`) and the interactive alt-screen renderer so both
 * surfaces show identical content.
 */
function formatVerify(subject: string, data: VerifyResponse): string[] {
  const lines: string[] = [];
  lines.push("");
  if (data.registered) {
    lines.push(`Verify - ${subject}: REGISTERED`);
    if (data.member_id) lines.push(`Member ID: ${data.member_id}`);
    if (data.account_status) lines.push(`Status: ${data.account_status}`);
    if (typeof data.engagement_level === "number") {
      lines.push(`Engagement Level: L${data.engagement_level}`);
    }
    if (data.archetype) lines.push(`Archetype: ${data.archetype}`);
    if (data.is_stub) {
      lines.push("");
      lines.push("Account is a stub (created bot-first, awaiting claim).");
    }
  } else {
    lines.push(`Verify - ${subject}: NOT REGISTERED`);
    if (data.verified_at) lines.push(`Verified at: ${data.verified_at}`);
  }
  lines.push("");
  return lines;
}

function prettyPrint(subject: string, data: VerifyResponse): void {
  console.log(formatVerify(subject, data).join("\n"));
}

/**
 * Interactive verify screen - mirrors the canonical interactive pattern in
 * `room.ts runInteractive()` (enterAlt/exitAlt + a shared raw-byte key
 * decoder where q/escape/left returns to the caller). The result stays on
 * screen until the user navigates back, so the menu surface behaves like the
 * rest of the interactive screens rather than print-and-exit.
 */
async function runVerifyInteractive(subject: string, data: VerifyResponse): Promise<void> {
  const stdin = process.stdin;

  enterAlt();

  return new Promise<void>((resolve) => {
    let session: InputSession | null = null;
    const cleanup = (): void => {
      session?.dispose();
      process.stdout.removeListener("resize", redraw);
      exitAlt();
    };

    const finish = (): void => {
      cleanup();
      resolve();
    };

    const redraw = (): void => {
      const footer = brand.muted("←/q/esc") + brand.dim(" back");
      drawFrame({
        title:
          brand.title("~Alter") + brand.dim(" · ") + brand.titleDim("Verify"),
        body: formatVerify(subject, data),
        footer,
      });
    };

    const onKey = (key: DecodedKey): void => {
      if (key.ctrl && key.name === "c") {
        finish();
        return;
      }
      // Verify is a leaf - q / escape / left all return to the caller
      // (the menu), matching room.ts.
      if (key.name === "q" || key.name === "escape" || key.name === "left") {
        finish();
        return;
      }
    };

    session = createInputSession(stdin, onKey);
    process.stdout.on("resize", redraw);
    redraw();
  });
}

export async function verify(
  args: string[] = [],
  opts: { interactive?: boolean } = {},
): Promise<void> {
  // In standalone (CLI) mode every error path exits non-zero so scripts
  // can branch on it. In interactive (menu) mode a raw process.exit would
  // tear down the whole alt-screen, so we throw instead and let the menu's
  // own try/catch + pressEnterToReturn surface the message.
  const fail = (message: string): void => {
    if (opts.interactive) throw new Error(message);
    console.error(message);
    process.exitCode = 1;
  };

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  // Subject is the first non-flag arg.
  let subject = args.find((a) => !a.startsWith("--") && !a.startsWith("-"));
  if (!subject) {
    if (!opts.interactive) printHelp();
    return fail("alter verify: provide a ~handle or email to verify.");
  }

  // Interactive (menu) entry: the user typed a bare handle, email, or UUID
  // into the menu prompt. Normalise bare-handle input to a ~handle via the
  // canonical CLI normaliser so "yourhandle" → "~yourhandle" before lookup.
  // Emails and
  // UUIDs are passed through untouched - only handle-shaped subjects (no @,
  // no hyphen-heavy UUID shape) are tilde-normalised.
  if (opts.interactive) {
    const looksLikeEmail = subject.includes("@");
    const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(subject);
    if (!looksLikeEmail && !looksLikeUuid) {
      const normalised = ensureTilde(subject);
      if (!isValidHandle(normalised)) {
        return fail(
          `alter verify: malformed handle "${subject}" - must match ~[a-z0-9][a-z0-9-]{1,31}`,
        );
      }
      subject = normalised;
    }
  }

  const json = args.includes("--json");

  // `GET /api/v1/identity/verify` is a member-session-authenticated
  // endpoint. There is no anonymous fallback - bail with an actionable message
  // rather than letting the request 401 with an opaque "lookup failed".
  if (!getSession()) {
    const message = getSessionInfo()
      ? "alter verify: session expired. Run 'alter login' to re-authenticate."
      : NOT_LOGGED_IN_MESSAGE;
    if (opts.interactive) throw new Error(message);
    // Canonical logged-out exit path: soft exit so the loop drains -
    // a hard process.exit() here races libuv teardown on Windows.
    console.error(message);
    process.exitCode = 1;
    return;
  }

  const resp = await apiCall(
    `${ENDPOINT}?subject=${encodeURIComponent(subject)}`,
  );
  if (!resp) {
    return fail("alter verify: could not reach the Identity Field.");
  }
  if (resp.status === 400) {
    const body = (await resp.json().catch(() => ({}))) as { detail?: string };
    return fail(`alter verify: ${body.detail ?? "bad request"}`);
  }
  if (resp.status === 401 || resp.status === 403) {
    return fail(
      "alter verify: session expired or unauthorized. Run 'alter login' to re-authenticate.",
    );
  }
  if (resp.status === 429) {
    return fail(
      "alter verify: rate limit reached. Repeated lookups against a subject are throttled - try again later.",
    );
  }
  if (resp.status >= 500) {
    return fail(`alter verify: server error (${resp.status} ${resp.statusText}).`);
  }
  if (!resp.ok) {
    return fail(`alter verify: lookup failed (${resp.status} ${resp.statusText}).`);
  }
  const data = (await resp.json().catch(() => null)) as VerifyResponse | null;
  if (!data) {
    return fail("alter verify: malformed response from backend.");
  }
  if (json) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    return;
  }
  // Interactive (menu) mode on a real terminal: render inside the alt-screen
  // and stay interactive until q/escape/left, mirroring room.ts. The CLI /
  // non-TTY paths keep their print-and-exit behaviour so scripts and pipes
  // are unaffected.
  if (opts.interactive && process.stdout.isTTY && process.stdin.isTTY) {
    await runVerifyInteractive(subject, data);
    return;
  }
  prettyPrint(subject, data);
}
