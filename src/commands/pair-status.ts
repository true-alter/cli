/**
 * alter pair status - pairing-pipeline diagnostic.
 *
 * Wraps `GET /api/v1/me/connections/status`. Surfaces three layers in
 * one call so members can self-diagnose the most likely identity-income
 * failure mode: "I thought I paired but the OAuth callback errored
 * silently and no SocialConnection / MemberTraitVector exists."
 *
 *   * per-connector - platform / username / connected at / disconnected at
 *                     / profile_data_present / fields read from the account
 *                     / extracted-trait names
 *   * merged trait-vector - exists / signal_tier / phase / overall_confidence
 *                           / non-null trait count / computed at
 *   * summary - paired_count / active_count /
 *               queryable_via_alter_alignment (mirrors the alignment
 *               compute's MIN_SHARED_TRAITS = 3 floor)
 *
 * Member self-read; L0 free.
 *
 * Pairs with the alignment subcommand surface (alter alignment grant /
 * revoke / query) - when alignment query rejects with `indeterminate`,
 * `alter pair status` shows whether the gap is "no vector yet" vs
 * "vector present but not enough non-null traits."
 */

import {
  apiCall,
  failNotLoggedIn,
  getSession,
  NOT_LOGGED_IN_MESSAGE,
} from "../auth.js";
import { confidenceTier } from "../lib/cosmetics/confidence-tier.js";
import { shortDate } from "../lib/format-date.js";
import { withLoadingCancel } from "../ui/biosMenu.js";

const ENDPOINT = "/api/v1/me/connections/status";

interface ConnectionItem {
  platform: string;
  platform_username: string | null;
  // Human-readable display name (from profile_data.name), populated for
  // platforms that guarantee no stable handle (google, amazon). Optional
  // on the wire - older backends predate the field. Prefer this over
  // platform_username when present; fall back when absent.
  display_name?: string | null;
  connected_at: string | null;
  disconnected_at: string | null;
  profile_data_present: boolean;
  extracted_traits_count: number;
  extracted_trait_names: string[];
  // Top-level field NAMES the connector captured (bio, public_metrics,
  // created_at, ...). Names only, never raw values. Older backends that
  // predate the field omit this key, so treat it as optional.
  fields_read?: string[];
}

interface TraitVectorStatus {
  exists: boolean;
  version: number | null;
  signal_tier: string | null;
  overall_confidence: number | null;
  phase: string | null;
  non_null_trait_count: number;
  computed_at: string | null;
}

interface ConnectionsStatusSummary {
  paired_count: number;
  active_count: number;
  queryable_via_alter_alignment: boolean;
}

interface ConnectionsStatusResponse {
  connections: ConnectionItem[];
  trait_vector: TraitVectorStatus;
  summary: ConnectionsStatusSummary;
}

function formatStatus(data: ConnectionsStatusResponse): string {
  const lines: string[] = [];
  const { connections, trait_vector: tv, summary } = data;

  lines.push("");
  lines.push("Pair status - connection diagnostic");
  lines.push("");

  // ── Connections ────────────────────────────────────────────────
  lines.push("Connections");
  if (connections.length === 0) {
    lines.push(
      "  (none paired yet - run 'alter pair' to add an identity source)",
    );
  } else {
    for (const c of connections) {
      const status = c.disconnected_at ? "disconnected" : "active";
      const label = c.display_name ?? c.platform_username;
      const username = label ? ` (${label})` : "";
      lines.push(`  ${c.platform}${username} - ${status}`);
      lines.push(`    connected:        ${shortDate(c.connected_at)}`);
      if (c.disconnected_at) {
        lines.push(`    disconnected:     ${shortDate(c.disconnected_at)}`);
      }
      lines.push(
        `    profile data:     ${c.profile_data_present ? "yes" : "no"}`,
      );
      // "What we read from your account" - the captured field NAMES, read at
      // connect time above. Names only; raw values are never surfaced. Guard
      // Array.isArray so an older backend (no fields_read key) or a mis-shaped
      // response degrades quietly rather than printing "[object Object]".
      const fieldsRead = Array.isArray(c.fields_read)
        ? c.fields_read.filter((n): n is string => typeof n === "string")
        : [];
      if (fieldsRead.length > 0) {
        lines.push(`    read from account: ${fieldsRead.join(", ")}`);
      } else if (!c.profile_data_present) {
        lines.push(`    read from account: nothing (no profile captured)`);
      }
      lines.push(`    traits from this connector: ${c.extracted_traits_count}`);
      // L2 fix: guard Array.isArray so a mis-shaped response (object keys)
      // never renders as "deriver, summary, traits". Only join real string arrays.
      const traitNames = Array.isArray(c.extracted_trait_names)
        ? c.extracted_trait_names.filter((n): n is string => typeof n === "string")
        : [];
      if (traitNames.length > 0) {
        lines.push(`    trait names:      ${traitNames.join(", ")}`);
      }
    }
  }
  lines.push("");

  // ── Identity profile ───────────────────────────────────────────
  lines.push("Identity profile");
  if (!tv.exists) {
    lines.push("  (not yet computed - pair at least one connector to bootstrap)");
  } else {
    lines.push(`  exists:               yes (version ${tv.version ?? "?"})`);
    lines.push(`  evidence level:       ${tv.signal_tier === "preliminary" ? "building - deepens as you complete Discovery" : (tv.signal_tier ?? "-")}`);
    lines.push(`  phase:                ${tv.phase ?? "-"}`);
    lines.push(`  archetype confidence: ${confidenceTier(tv.overall_confidence)}`);
    lines.push(`  traits in your merged profile: ${tv.non_null_trait_count}`);
    lines.push(`  computed at:          ${shortDate(tv.computed_at)}`);
  }
  lines.push("");

  // ── Summary ────────────────────────────────────────────────────
  lines.push("Summary");
  lines.push(`  paired connections:   ${summary.paired_count}`);
  lines.push(`  active connections:   ${summary.active_count}`);
  lines.push("");

  const verdict = summary.queryable_via_alter_alignment ? "Yes" : "No";
  lines.push(`Ready for peer matching: ${verdict}`);
  if (!summary.queryable_via_alter_alignment) {
    if (!tv.exists) {
      lines.push(
        "  Reason: no identity profile yet. Pair an identity source - " +
          "then re-run.",
      );
    } else if (tv.non_null_trait_count < 3) {
      lines.push(
        `  Peer matching needs at least 3 traits. Pair more sources, then check again.`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

function printHelp(): void {
  console.log(
    "Usage: alter pair status [--json]\n" +
      "\n" +
      "Print the post-pairing pipeline diagnostic - paired connections,\n" +
      "merged trait-vector state, and whether you are queryable via\n" +
      "alter_alignment yet. Member self-read; L0 free.\n" +
      "\n" +
      "Options:\n" +
      "  --json    Emit the raw JSON response (machine-readable).\n" +
      "  --help    Show this message.\n",
  );
}

export async function pairStatus(
  argv: string[],
  opts: { interactive?: boolean } = {},
): Promise<void> {
  // In interactive (menu) mode, throw instead of process.exit so the
  // menu's try/catch can handle errors without killing the whole process.
  function fail(msg: string): void {
    if (opts.interactive) throw new Error(msg);
    console.error(msg);
    process.exitCode = 1;
  }

  let json = false;
  for (const a of argv) {
    if (a === "--json") json = true;
    else if (a === "--help" || a === "-h") {
      printHelp();
      return;
    } else {
      fail(`alter pair status: unknown argument: ${a}`);
      return;
    }
  }

  // Defensive: provide a clearer error than apiCall's null-on-no-session
  // for first-run users who haven't logged in yet.
  const session = await getSession();
  if (!session) {
    // Canonical logged-out guard: soft exit in CLI mode; throw in
    // interactive (menu) mode so the alt-screen survives.
    if (opts.interactive) throw new Error(NOT_LOGGED_IN_MESSAGE);
    failNotLoggedIn();
    return;
  }

  const pairWait = await withLoadingCancel(
    (signal) => apiCall(ENDPOINT, { signal }),
    "loading pair status",
  );
  if (pairWait.cancelled) return;
  const resp = pairWait.result;
  if (!resp) {
    fail("alter pair status: session not authenticated. Run 'alter login'.");
    return;
  }
  if (resp.status === 401 || resp.status === 403) {
    fail("alter pair status: session not authenticated. Run 'alter login'.");
    return;
  }
  if (resp.status >= 500) {
    fail(
      `alter pair status: server error (${resp.status} ${resp.statusText}). ` +
        "Try again in a moment.",
    );
    return;
  }
  if (!resp.ok) {
    fail(
      `alter pair status: could not fetch pair status (${resp.status} ${resp.statusText}).`,
    );
    return;
  }

  const data = (await resp
    .json()
    .catch(() => null)) as ConnectionsStatusResponse | null;
  if (!data) {
    fail("alter pair status: malformed response from backend.");
    return;
  }

  if (json) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    return;
  }

  console.log(formatStatus(data));
}
