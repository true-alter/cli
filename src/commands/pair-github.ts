/**
 * `alter pair github` - OAuth device-code flow (RFC 8628).
 *
 * The CLI is the canonical pairing surface (no web flow). We mint a
 * user_code via `POST /api/v1/connectors/github/device/init`, surface
 * it + the verification URI to the user, optionally launch their
 * browser, then poll `/device/finalize` until the backend returns
 * `paired` (or one of the terminal states `expired` / `denied`).
 */

import { openBrowser } from "../browser.js";

import { intro, outro, log, cancel, spinner } from "@clack/prompts";
import chalk from "chalk";

import { apiCall, getSession } from "../auth.js";
import { withKeyListenerCancel } from "../ui/biosMenu.js";
import { unpairPlatform } from "./discover.js";

interface ConnectorDescriptor {
  id: string;
  available: boolean;
}

interface DeviceInitResponse {
  user_code: string;
  device_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

interface DeviceFinalizeResponse {
  status: "paired" | "pending" | "slow_down" | "expired" | "denied";
  platform: string;
  username?: string | null;
  profile_url?: string | null;
  connection_id?: string | null;
}

function platformIsTty(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

/** Probe `/connectors` for github availability. Throws on backend error. */
async function checkAvailability(): Promise<boolean> {
  const resp = await apiCall("/api/v1/connectors");
  if (!resp) {
    throw new Error("not logged in. Run 'alter login' first.");
  }
  if (!resp.ok) {
    throw new Error(
      `could not load connectors (${resp.status} ${resp.statusText})`,
    );
  }
  const body = (await resp.json()) as { connectors?: ConnectorDescriptor[] };
  const github = body.connectors?.find((c) => c.id === "github");
  return Boolean(github?.available);
}

async function deviceInit(): Promise<DeviceInitResponse> {
  const resp = await apiCall("/api/v1/connectors/github/device/init", {
    method: "POST",
  });
  if (!resp) {
    throw new Error("not logged in. Run 'alter login' first.");
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `device init failed (${resp.status})${text ? `: ${text}` : ""}`,
    );
  }
  return (await resp.json()) as DeviceInitResponse;
}

async function deviceFinalize(
  deviceCode: string,
): Promise<{ status: number; body: DeviceFinalizeResponse | null; raw: string }> {
  const resp = await apiCall("/api/v1/connectors/github/device/finalize", {
    method: "POST",
    body: { device_code: deviceCode },
  });
  if (!resp) {
    throw new Error("not logged in. Run 'alter login' first.");
  }
  const raw = await resp.text();
  let body: DeviceFinalizeResponse | null = null;
  try {
    body = raw ? (JSON.parse(raw) as DeviceFinalizeResponse) : null;
  } catch {
    body = null;
  }
  return { status: resp.status, body, raw };
}

function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(t);
        resolve(true);
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          resolve(true);
        },
        { once: true },
      );
    }
  });
}

interface PollOutcome {
  status: "paired" | "expired" | "denied" | "cancelled" | "error";
  body?: DeviceFinalizeResponse | null;
  detail?: string;
}

async function pollUntilDone(
  init: DeviceInitResponse,
  signal: AbortSignal,
): Promise<PollOutcome> {
  let intervalSec = init.interval > 0 ? init.interval : 5;
  const deadline = Date.now() + init.expires_in * 1000;
  while (Date.now() < deadline) {
    if (signal.aborted) return { status: "cancelled" };
    const sleepMs = Math.min(intervalSec * 1000, Math.max(0, deadline - Date.now()));
    if (sleepMs > 0) {
      const interrupted = await sleep(sleepMs, signal);
      if (interrupted) return { status: "cancelled" };
    }
    if (Date.now() >= deadline) break;
    let resp;
    try {
      resp = await deviceFinalize(init.device_code);
    } catch (err) {
      return { status: "error", detail: (err as Error).message };
    }
    if (resp.status === 410) {
      return { status: "expired", detail: resp.raw };
    }
    if (resp.status === 403) {
      return { status: "denied", detail: resp.raw };
    }
    if (resp.status >= 400) {
      return {
        status: "error",
        detail: `unexpected ${resp.status}: ${resp.raw.slice(0, 200)}`,
      };
    }
    const body = resp.body;
    if (!body) {
      return { status: "error", detail: "empty response body" };
    }
    if (body.status === "paired") {
      return { status: "paired", body };
    }
    if (body.status === "slow_down") {
      intervalSec += 5;
    }
    // pending / slow_down → keep polling
  }
  return { status: "expired", detail: "local timeout reached" };
}

export interface PairGithubOptions {
  /** Skip browser launch. */
  noBrowser?: boolean;
}

export async function pairGithub(
  options: PairGithubOptions = {},
): Promise<void> {
  if (!getSession()) {
    throw new Error("not logged in. Run 'alter login' first.");
  }

  const interactive = platformIsTty();
  if (interactive) intro("alter pair github - device-code flow");

  const available = await checkAvailability();
  if (!available) {
    throw new Error(
      "GitHub connector not yet available on your account. Contact support if you expected access.",
    );
  }

  const init = await deviceInit();

  console.log("");
  console.log(
    `  Open ${chalk.bold(init.verification_uri)} and enter this code:`,
  );
  console.log("");
  console.log(`      ${chalk.bold(init.user_code)}`);
  console.log("");
  console.log("  Your GitHub account login may be required.");
  console.log("");

  if (!options.noBrowser) {
    openBrowser(init.verification_uri);
  }

  const s = interactive ? spinner() : null;
  s?.start(
    `Waiting for GitHub to confirm (up to ${Math.round(init.expires_in / 60)} min · press q to cancel)…`,
  );
  const { result, cancelled } = await withKeyListenerCancel((signal) =>
    pollUntilDone(init, signal),
  );
  if (cancelled) {
    s?.stop(chalk.yellow("Pairing cancelled."));
    if (interactive) outro("Run 'alter pair github' again when you're ready.");
    return;
  }

  // Below: pairing did NOT happen. Each of these sets a failing exit code,
  // because the identity was not linked and a caller reading the exit code must
  // not be told otherwise. The `cancelled` path above deliberately does not:
  // there the user asked to stop, knows nothing was paired, and nothing claimed
  // it was. Authorisation being refused, or the code expiring, is a different
  // thing entirely: the operation was attempted and it failed.
  const outcome = result!;
  if (outcome.status === "expired") {
    s?.stop(chalk.yellow("Device code expired before authorisation."));
    cancel("Restart with 'alter pair github'.");
    process.exitCode = 1;
    return;
  }
  if (outcome.status === "denied") {
    s?.stop(chalk.red("GitHub authorisation refused."));
    cancel("Run 'alter pair github' again to retry.");
    process.exitCode = 1;
    return;
  }
  if (outcome.status === "error") {
    s?.stop(chalk.red(`Pairing failed: ${outcome.detail ?? "unknown"}`));
    process.exitCode = 1;
    return;
  }

  const username = outcome.body?.username ?? "(unknown)";
  s?.stop(`Paired GitHub as ${chalk.bold(username)}.`);
  console.log("");
  console.log(
    `  Run '${chalk.bold("alter pair status")}' to confirm connector state and consent grants.`,
  );
  console.log("");
  if (interactive) outro("GitHub connector live.");
}

export async function pairGithubFromArgs(argv: string[]): Promise<void> {
  let noBrowser = false;
  for (const a of argv) {
    if (a === "--no-browser") {
      noBrowser = true;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: alter pair github [--no-browser]\n" +
          "\n" +
          "OAuth device-code pairing for GitHub. Surfaces a user_code\n" +
          "and verification URL, optionally opens your browser, then\n" +
          "polls until you authorise the request on github.com.\n",
      );
      return;
    } else {
      throw new Error(`Unknown flag: ${a}`);
    }
  }
  await pairGithub({ noBrowser });
}

export async function unpairGithubFromArgs(argv: string[]): Promise<void> {
  for (const a of argv) {
    if (a === "--help" || a === "-h") {
      console.log(
        "Usage: alter unpair github\n" +
          "\n" +
          "Disconnect the paired GitHub account. Revokes the OAuth token\n" +
          "at GitHub (best-effort) and clears the local SocialConnection.\n",
      );
      return;
    }
    throw new Error(`Unknown flag: ${a}`);
  }
  if (!getSession()) {
    throw new Error("not logged in. Run 'alter login' first.");
  }
  await unpairPlatform("github");
  log.success("GitHub disconnected.");
}
