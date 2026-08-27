/**
 * alter discover - the onboarding surface after `alter login`.
 *
 * Lists identity-data connectors from the backend registry and walks
 * the user through pairing one. One connection is enough to seed a
 * legible identity. Identity Income starts flowing the moment another
 * alter's first trait query lands.
 *
 * Flows:
 *   OAuth - credentialed-self stream
 *     github, discord
 *   OAuth - locked / coming soon (hidden from the picker)
 *     twitter
 *     → POST {api}/api/v1/me/connections/{platform}
 *     → open returned authorization_url in the browser
 *     → server-side callback completes the exchange; tokens land in
 *       the paired-identity record. Next `alter status` reflects the
 *       new depth contribution.
 *   Local vault (obsidian)
 *     → Real local pairing via `pairObsidian()`: detects vaults,
 *       installs the community plugin + Local REST API, writes
 *       per-vault tokens. Bypasses the backend ingestion gate - the
 *       vault stays on-device until the server-side stream flips on.
 *
 * Flags:
 *   --json         emit registry (or --list output) as JSON and exit
 *   --pick <id>    pair a connector by id
 *   --list         list currently paired connections instead of the registry
 *   --unpair <id>  disconnect a paired platform
 */

import { pickOne, BACK_OPTION, isBack } from "../ui/picker.js";
import { apiCall, getSession } from "../auth.js";
import { withLoadingCancel } from "../ui/biosMenu.js";
import { openBrowser } from "../browser.js";
import { pairObsidian } from "./pair-obsidian.js";
import { emitSessionHeartbeat } from "../lib/active-sessions-emit.js";
import { shortDate } from "../lib/format-date.js";

type ConnectionShape = "oauth" | "local_vault";

export interface ConnectorDescriptor {
  id: string;
  display_name: string;
  icon: string;
  description: string;
  connection_shape: ConnectionShape;
  confidence_contribution: number;
  trust_tier: string;
  available: boolean;
}

interface ConnectorRegistryResponse {
  connectors: ConnectorDescriptor[];
}

interface ParsedArgs {
  json: boolean;
  pick: string | null;
  list: boolean;
  unpair: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  let json = false;
  let pick: string | null = null;
  let list = false;
  let unpair: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--list") list = true;
    else if (a === "--pick") {
      pick = argv[++i] ?? null;
      if (!pick) throw new Error("--pick requires a connector id");
    } else if (a === "--unpair") {
      unpair = argv[++i] ?? null;
      if (!unpair) throw new Error("--unpair requires a connector id");
    } else throw new Error(`Unknown flag: ${a}`);
  }
  return { json, pick, list, unpair };
}

// Connector ids the CLI hides from the user, even if the backend
// registry advertises them. The Personal Website connector was
// retired from the picker 2026-04-26; the backend route persists
// for any tooling that still posts to it directly.
const HIDDEN_CONNECTOR_IDS = new Set<string>(["website"]);

// OAuth connectors that are wired backend-side but not yet polished
// enough to expose. The CLI marks them available=false so D7 hides them
// from the picker (they are not rendered greyed-out - they are absent).
const COMING_SOON_OAUTH_IDS = new Set<string>(["twitter"]);

// Connectors whose pairing flow lives entirely client-side and works
// regardless of the backend availability gate. Currently just the
// Obsidian local-vault sideload (`pairObsidian()` detects vaults,
// installs the plugin, persists tokens - no server round-trip). The
// CLI shows these as available so the picker doesn't mislabel a
// fully-functional flow as "coming soon".
const LOCAL_AVAILABLE_IDS = new Set<string>(["obsidian"]);

// CLI-side display-name overrides. Backend ships marketing copy
// ("Pair your vault") that doesn't match the picker's noun-list
// register; the picker wants the platform name itself.
const DISPLAY_NAME_OVERRIDES: Record<string, string> = {
  obsidian: "Obsidian",
};

function applyClientOverrides(
  connectors: ConnectorDescriptor[],
): ConnectorDescriptor[] {
  const out: ConnectorDescriptor[] = [];
  for (const c of connectors) {
    if (HIDDEN_CONNECTOR_IDS.has(c.id)) continue;
    let next: ConnectorDescriptor = c;
    if (DISPLAY_NAME_OVERRIDES[c.id]) {
      next = { ...next, display_name: DISPLAY_NAME_OVERRIDES[c.id] };
    }
    if (COMING_SOON_OAUTH_IDS.has(c.id)) {
      out.push({ ...next, available: false });
      continue;
    }
    if (LOCAL_AVAILABLE_IDS.has(c.id)) {
      out.push({ ...next, available: true });
      continue;
    }
    out.push(next);
  }
  return out;
}

export async function fetchRegistry(
  signal?: AbortSignal,
): Promise<ConnectorDescriptor[]> {
  const resp = await apiCall("/api/v1/connectors", { signal });
  if (!resp) {
    throw new Error("not logged in. Run 'alter login' first.");
  }
  if (!resp.ok) {
    throw new Error(
      `could not load connectors (${resp.status} ${resp.statusText})`,
    );
  }
  const body = (await resp.json()) as ConnectorRegistryResponse;
  return applyClientOverrides(body.connectors ?? []);
}

function renderList(connectors: ConnectorDescriptor[]): void {
  // D7: hide coming-soon connectors - only list live, available sources.
  const live = connectors.filter((c) => c.available);
  console.log("");
  console.log("  Pair a source. One is enough to begin.");
  console.log("  ========================================");
  console.log("");
  for (const [idx, c] of live.entries()) {
    const tag = c.connection_shape === "local_vault" ? "[local]" : "[oauth]";
    const boost =
      c.confidence_contribution > 0
        ? ` +${Math.round(c.confidence_contribution * 100)}% depth`
        : "";
    console.log(`  ${idx + 1}. ${c.display_name}  ${tag}${boost}`);
    console.log(`     ${c.description}`);
    console.log(`     (${c.trust_tier})`);
    console.log("");
  }
  console.log("  Run 'alter pair --pick <id>' to connect one.");
  console.log("  Connector ids: " + live.map((c) => c.id).join(", "));
  console.log("");
}

interface PairedConnection {
  id: string;
  platform: string;
  platform_username?: string | null;
  // Human-readable display name (from profile_data.name), populated for
  // platforms that guarantee no stable handle (google, amazon). Optional
  // on the wire - older backends predate the field. Prefer this over
  // platform_username when present; fall back when absent.
  display_name?: string | null;
  profile_url?: string | null;
  confidence_contribution?: number | null;
  connected_at?: string | null;
}

export async function fetchPaired(
  signal?: AbortSignal,
): Promise<PairedConnection[]> {
  const resp = await apiCall("/api/v1/me/connections", { signal });
  if (!resp) {
    throw new Error("not logged in. Run 'alter login' first.");
  }
  if (!resp.ok) {
    throw new Error(
      `could not fetch paired connections (${resp.status} ${resp.statusText}).`,
    );
  }
  return (await resp.json()) as PairedConnection[];
}

export function renderPaired(connections: PairedConnection[]): void {
  console.log("");
  if (connections.length === 0) {
    console.log("  No connections paired yet.");
    console.log("  Run 'alter pair' to see what's available.");
    console.log("");
    return;
  }
  console.log("  Paired connections");
  console.log("  ==================");
  console.log("");
  for (const c of connections) {
    const boost =
      c.confidence_contribution && c.confidence_contribution > 0
        ? ` +${Math.round(c.confidence_contribution * 100)}% depth`
        : "";
    const name = c.display_name ?? c.platform_username ?? c.profile_url ?? "";
    console.log(`  ${c.platform}${name ? ` (${name})` : ""}${boost}`);
    if (c.connected_at) {
      console.log(`     paired ${shortDate(c.connected_at)}`);
    }
  }
  console.log("");
  console.log("  Run 'alter unpair <id>' to disconnect.");
  console.log("");
}

export async function unpairPlatform(
  platform: string,
  signal?: AbortSignal,
): Promise<void> {
  const resp = await apiCall(
    `/api/v1/me/connections/${platform}`,
    { method: "DELETE", signal },
  );
  if (!resp) {
    throw new Error("not logged in. Run 'alter login' first.");
  }
  if (resp.status === 404) {
    throw new Error(`no paired '${platform}' connection to unpair.`);
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `could not unpair ${platform} (${resp.status})${text ? `: ${text}` : ""}`,
    );
  }
  console.log("");
  console.log(`  Unpaired ${platform}.`);
  console.log("");
}

export async function initiateOauth(
  platform: string,
  signal?: AbortSignal,
): Promise<void> {
  const resp = await apiCall(
    `/api/v1/me/connections/${platform}`,
    { method: "POST", signal },
  );
  if (!resp) {
    throw new Error("not logged in. Run 'alter login' first.");
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `could not start ${platform} connection (${resp.status})${text ? `: ${text}` : ""}`,
    );
  }
  const body = (await resp.json()) as { authorization_url?: string };
  const url = body.authorization_url;
  if (!url) {
    throw new Error(`${platform} returned no authorization_url.`);
  }
  console.log("");
  console.log(`  Opening ${platform} in your browser.`);
  console.log("  If it does not open, paste this URL:");
  console.log("");
  console.log(`    ${url}`);
  console.log("");
  try {
    openBrowser(url);
  } catch {
    // Non-fatal - the URL is already printed above.
  }
  console.log(
    "  Once you return, run 'alter status' to confirm the connection.",
  );
  console.log("");
}

function printHelp(): void {
  console.log(
    // `discover` is kept as an alias for one release; prefer `alter pair`.
    "Usage: alter pair [--pick <platform>] [--list]\n" +
      "                 [--unpair <platform>] [--json]\n" +
      "\n" +
      "Interactive connector picker (omit all flags for the menu) or\n" +
      "scripted pair/unpair of identity-data sources.\n" +
      "\n" +
      "Flags:\n" +
      "  --pick <id>       pair a specific connector (run without --pick\n" +
      "                    to see current ids for your account)\n" +
      "  --list            print the paired-connection summary and exit\n" +
      "  --unpair <id>     unpair a specific connector\n" +
      "  --json            emit JSON instead of prose output\n",
  );
}

export async function discover(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }
  try {
    emitSessionHeartbeat({
      sessionId: String(process.pid),
      workingOn: "alter discover",
    });
  } catch { /* silent - must not block command */ }
  const opts = parseArgs(argv);

  if (!getSession()) {
    console.error("alter pair: not logged in. Run 'alter login' first.");
    process.exitCode = 1;
    return;
  }

  if (opts.unpair) {
    const wait = await withLoadingCancel(
      (signal) => unpairPlatform(opts.unpair!, signal),
      "unpairing",
    );
    if (wait.cancelled) {
      console.log("  Cancelled. Run 'alter pair --list' to check whether it unpaired.");
    }
    return;
  }

  if (opts.list) {
    const pairedWait = await withLoadingCancel(
      (signal) => fetchPaired(signal),
      "loading connections",
    );
    if (pairedWait.cancelled) return;
    const paired = pairedWait.result!;
    if (opts.json) {
      console.log(JSON.stringify(paired, null, 2));
      return;
    }
    renderPaired(paired);
    return;
  }

  const registryWait = await withLoadingCancel(
    (signal) => fetchRegistry(signal),
    "loading connectors",
  );
  if (registryWait.cancelled) return;
  const connectors = registryWait.result!;
  if (opts.json && !opts.pick) {
    console.log(JSON.stringify(connectors, null, 2));
    return;
  }

  if (!opts.pick) {
    renderList(connectors);
    return;
  }

  const target = connectors.find((c) => c.id === opts.pick);
  if (!target) {
    // List only pairable connectors - the same set `renderList` and the
    // interactive picker show. Surfacing the full backend registry here
    // leaked coming-soon ids (twitter, discord) that the help never
    // advertises, so the error and the help disagreed on what's pairable.
    const pairable = connectors.filter((c) => c.available).map((c) => c.id);
    console.error(
      `alter pair: unknown connector '${opts.pick}'. ` +
        `Known: ${pairable.join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }

  if (target.connection_shape === "local_vault") {
    if (target.id === "obsidian") {
      await pairObsidian();
      return;
    }
    console.error(
      `alter pair: local-vault flow for '${target.id}' not wired.`,
    );
    process.exitCode = 1;
    return;
  }

  if (!target.available) {
    console.error(
      `alter pair: '${target.id}' is not available yet.`,
    );
    process.exitCode = 1;
    return;
  }

  await initiateOauthCancellable(target.id);
}

/**
 * initiateOauth behind the leaf-side cancel idiom: esc aborts the in-flight
 * authorization-url request before any browser opens. Shared by the shell
 * verb and the interactive picker so both stay escapable.
 */
async function initiateOauthCancellable(platform: string): Promise<void> {
  const wait = await withLoadingCancel(
    (signal) => initiateOauth(platform, signal),
    "starting pairing",
  );
  if (wait.cancelled) {
    console.log("  Cancelled - nothing paired.");
  }
}

/**
 * Pair a connector end-to-end, interactively if no id is given.
 *
 * Shared entry point used by both `alter pair [id]` and the top-level
 * interactive menu. When `id` is null, renders a clack select over the
 * available registry and dispatches based on shape:
 *  - obsidian → run the local-vault sideload (`pairObsidian`)
 *  - oauth    → open authorization_url in the browser
 *
 * Unavailable connectors (missing server-side env config, feature
 * flag off, or hard-locked client-side via COMING_SOON_OAUTH_IDS)
 * are marked "(coming soon)" and disabled in the picker.
 */
export async function pairInteractive(id: string | null): Promise<void> {
  if (!getSession()) {
    throw new Error("not logged in. Run 'alter login' first.");
  }

  // Obsidian sideload is purely local - bypass the connector
  // registry entirely so the command works on a host with no
  // backend reachability. The registry probe is best-effort
  // and surfaced inside pairObsidian itself.
  if (id === "obsidian") {
    await pairObsidian();
    return;
  }
  // org-alter pairing is handled in a separate build and is not exposed here.

  const loadWait = await withLoadingCancel(
    (signal) =>
      Promise.all([
        fetchRegistry(signal),
        fetchPaired(signal).catch(() => [] as PairedConnection[]),
      ]),
    "loading connectors",
  );
  if (loadWait.cancelled) return;
  const [connectors, paired] = loadWait.result!;
  // Already-paired OAuth connectors don't belong in the pair-new picker -
  // re-pairing an OAuth source is `/me/connections` (manage), not pair.
  // Local-vault connectors are pass-through (Obsidian sideloads
  // independent vaults - re-pair semantics differ from OAuth).
  const pairedOauthIds = new Set(
    paired
      .filter((p) => p.platform)
      .map((p) => p.platform.toLowerCase()),
  );
  const isPairedOauth = (c: ConnectorDescriptor): boolean =>
    c.connection_shape === "oauth" && pairedOauthIds.has(c.id.toLowerCase());

  let target: ConnectorDescriptor | undefined;

  if (id) {
    target = connectors.find((c) => c.id === id);
    if (!target) {
      // Only advertise pairable connectors (parity with the help + picker);
      // the full registry leaked coming-soon ids the help never lists.
      const pairable = connectors.filter((c) => c.available).map((c) => c.id);
      throw new Error(
        `unknown connector '${id}'. Known: ${pairable.join(", ")}`,
      );
    }
    if (isPairedOauth(target)) {
      console.log("");
      console.log(
        `  ${target.display_name} is already paired. Run 'alter connections' to view, or 'alter unpair ${target.id}' to disconnect.`,
      );
      console.log("");
      return;
    }
  } else {
    // D7: hide coming-soon connectors - only offer live, available sources.
    const pickable = connectors.filter((c) => !isPairedOauth(c) && c.available);
    if (pickable.length === 0) {
      console.log("");
      console.log("  Every available source is already paired.");
      console.log("  Run 'alter connections' to review, or 'alter unpair <id>' to disconnect.");
      console.log("");
      return;
    }
    const options = pickable.map((c) => {
      const tag = c.connection_shape === "local_vault" ? "local" : "oauth";
      const boost =
        c.confidence_contribution > 0
          ? `  +${Math.round(c.confidence_contribution * 100)}% depth`
          : "";
      return {
        value: c.id,
        label: `${c.display_name}  [${tag}]${boost}`,
        hint: c.description,
      };
    });

    const picked = await pickOne({
      message: "Which source would you like to pair?",
      options: [...options, BACK_OPTION],
    });
    if (isBack(picked)) {
      console.log("  Nothing paired.");
      return;
    }
    target = connectors.find((c) => c.id === picked);
    if (!target) return; // unreachable
  }

  // Obsidian sideload is purely local - backend ingestion gate
  // (`available: false`) is orthogonal to plugin install. Route
  // to the dedicated pairing flow before the generic available
  // gate so users on the gate-off backend still install fine.
  if (target.connection_shape === "local_vault" && target.id === "obsidian") {
    await pairObsidian();
    return;
  }

  if (!target.available) {
    console.log("");
    console.log(`  ${target.display_name} isn't available yet.`);
    console.log("");
    return;
  }

  if (target.connection_shape === "local_vault") {
    throw new Error(`local-vault flow for '${target.id}' not wired.`);
  }

  await initiateOauthCancellable(target.id);
}
