/**
 * alter status - full identity + org + session status.
 *
 * `--since-last` renders a delta line for the things that move between
 * runs (attunement, balance, query count, trait count). After every
 * render the snapshot is rewritten so the next call diffs against this
 * one. The recurring "yes ALTER is doing something" signal - without
 * a web dashboard.
 */

import {
  apiCall,
  failNotLoggedIn,
  getSessionInfo,
  readIdentity,
  isExpired,
  readStatusSnapshot,
  writeStatusSnapshot,
  extractAlterClaims,
  type StatusSnapshot,
  ALTER_CONFIG_DIR,
} from "../auth.js";
import { resolveEffectiveOrgs } from "../lib/memberships.js";
import { confidenceTier } from "../lib/cosmetics/confidence-tier.js";
import { fetchPaired } from "./discover.js";
import { emitSessionHeartbeat } from "../lib/active-sessions-emit.js";
import { withLoadingCancel } from "../ui/biosMenu.js";
import {
  parseNextBestAction,
  renderWhatNext,
  type NextBestAction,
} from "../onboarding/next-best-action.js";
import {
  pendingSuggestionFields,
  reportPendingSuggestion,
} from "../onboarding/next-action-report.js";
import {
  parseWalkthrough,
  renderWalkthroughBlock,
  walkthroughSnapshotFields,
  type Walkthrough,
} from "../onboarding/walkthrough.js";

interface EarningsSummary {
  total_earned: number;
  pending_amount: number;
  transaction_count: number;
}

interface BalanceResponse {
  balance_cents: number;
  balance_display: string;
}

interface ConnectionsStatusResponse {
  trait_vector?: {
    non_null_trait_count?: number;
  };
  next_best_action?: unknown;
  walkthrough?: unknown;
}

async function fetchEarningsSafe(signal?: AbortSignal): Promise<EarningsSummary | null> {
  try {
    const resp = await apiCall("/api/v1/members/me/earnings", { signal });
    if (!resp || !resp.ok) return null;
    return (await resp.json()) as EarningsSummary;
  } catch {
    return null;
  }
}

async function fetchBalanceSafe(signal?: AbortSignal): Promise<BalanceResponse | null> {
  try {
    const resp = await apiCall("/api/v1/members/me/earnings/balance", { signal });
    if (!resp || !resp.ok) return null;
    return (await resp.json()) as BalanceResponse;
  } catch {
    return null;
  }
}

/**
 * Canonical "traits on file" count. Sourced from the same authoritative
 * field pair-status uses: trait_vector.non_null_trait_count on
 * /me/connections/status, so the two surfaces always report the same
 * number. This is the backend's count of trait-vector slots that actually
 * carry a value, not the /me/traits continuous+categorical sum (which
 * double-counted derived categoricals and disagreed with pair-status by 1).
 */
async function fetchConnectionsStatusSafe(
  signal?: AbortSignal,
): Promise<{
  traitCount: number;
  nextBestAction: NextBestAction | null;
  walkthrough: Walkthrough | null;
}> {
  try {
    // include_walkthrough=true: the field is opt-in on the wire and costs
    // nothing when omitted, so ask for it explicitly rather than relying on
    // a default. The guided walk rides the same response as next_best_action
    // (no extra round-trip) and degrades to null on any backend failure.
    const resp = await apiCall(
      "/api/v1/me/connections/status?include_walkthrough=true",
      { signal },
    );
    if (!resp || !resp.ok) {
      return { traitCount: 0, nextBestAction: null, walkthrough: null };
    }
    const body = (await resp.json()) as ConnectionsStatusResponse;
    return {
      traitCount: body.trait_vector?.non_null_trait_count ?? 0,
      // The canonical next-best-action rides the same response, so the "what
      // next" block costs no extra round-trip. Parsed defensively: an older
      // backend omits it and yields null.
      nextBestAction: parseNextBestAction(body.next_best_action),
      // Parsed defensively too: an older backend, a resolver failure, or a
      // withheld consent gate all degrade to null and the caller falls back
      // to rendering nothing for this block.
      walkthrough: parseWalkthrough(body.walkthrough),
    };
  } catch {
    return { traitCount: 0, nextBestAction: null, walkthrough: null };
  }
}

/**
 * Humanise an ISO timestamp to "YYYY-MM-DD HH:MM" local time, matching
 * the convention pair-status already uses. Falls back to the
 * raw string on parse failure so existing output is never lost.
 */
function humaniseTimestamp(iso: string | null | undefined): string {
  if (!iso) return "-";
  try {
    return new Date(iso).toISOString().slice(0, 16).replace("T", " ");
  } catch {
    return String(iso);
  }
}

function formatDollars(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toFixed(2)}`;
}

function formatRelativeAge(iso: string): string {
  try {
    const taken = new Date(iso).getTime();
    const ms = Date.now() - taken;
    if (ms < 60_000) return "just now";
    const mins = Math.floor(ms / 60_000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 48) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  } catch {
    return iso;
  }
}

function renderDiffLines(prior: StatusSnapshot, current: StatusSnapshot): void {
  console.log("");
  console.log(`  Since last check  (${formatRelativeAge(prior.taken_at)})`);
  console.log("  ----------------");

  const lines: string[] = [];

  if (prior.attunement !== null && current.attunement !== null) {
    const deltaPp = (current.attunement - prior.attunement) * 100;
    if (Math.abs(deltaPp) >= 0.5) {
      const arrow = deltaPp > 0 ? "+" : "";
      lines.push(
        `  Attunement     ${(prior.attunement * 100).toFixed(0)}% → ${(current.attunement * 100).toFixed(0)}%   (${arrow}${deltaPp.toFixed(0)}pp)`,
      );
    }
  }

  const balanceDelta = current.balance_cents - prior.balance_cents;
  if (balanceDelta !== 0) {
    const arrow = balanceDelta > 0 ? "+" : "";
    lines.push(
      `  Balance        ${formatDollars(prior.balance_cents)} → ${formatDollars(current.balance_cents)}   (${arrow}${formatDollars(balanceDelta)})`,
    );
  }

  const earnedDelta = current.total_earned - prior.total_earned;
  if (Math.abs(earnedDelta) >= 0.005) {
    const arrow = earnedDelta > 0 ? "+" : "";
    lines.push(
      `  Total earned   $${prior.total_earned.toFixed(2)} → $${current.total_earned.toFixed(2)}   (${arrow}$${earnedDelta.toFixed(2)})`,
    );
  }

  const queriesDelta = current.transaction_count - prior.transaction_count;
  if (queriesDelta !== 0) {
    const arrow = queriesDelta > 0 ? "+" : "";
    lines.push(
      `  Queries        ${prior.transaction_count} → ${current.transaction_count}   (${arrow}${queriesDelta})`,
    );
  }

  const traitsDelta = current.trait_count - prior.trait_count;
  if (traitsDelta !== 0) {
    const arrow = traitsDelta > 0 ? "+" : "";
    lines.push(
      `  Traits         ${prior.trait_count} → ${current.trait_count}   (${arrow}${traitsDelta})`,
    );
  }

  if (lines.length === 0) {
    console.log("  No change since last check.");
  } else {
    for (const l of lines) console.log(l);
  }
  console.log("");
}

/**
 * Returns true when the stored handle is the fallback we synthesise at login
 * when the backend ID token carried no bound alter_handle claim.  Useful for
 * flagging "binding pending" in the UI.
 *
 * Two synthetic forms are recognised:
 *   - New:    `~u<7 hex>` - letter-leading, generated from 2026-05-11 onward.
 *   - Legacy: `~<8 hex>` - digit-leading placeholder from earlier sessions.
 *
 * For the legacy form we additionally verify that the UUID-derived fragment
 * matches the start of `userId` to avoid misclassifying real short handles.
 * The new form is unambiguous (no real handle starts with `~u` followed by
 * exactly 7 hex digits).
 */
export function looksLikeSyntheticHandle(
  handle: string,
  userId: string,
): boolean {
  if (!handle.startsWith("~")) return false;
  const tail = handle.slice(1);
  // New letter-leading form: ~u<7 hex chars>
  if (/^u[0-9a-f]{7}$/i.test(tail)) return true;
  // Legacy digit-leading form: ~<8 hex chars> whose value is the UUID prefix.
  if (/^[0-9a-f]{8}$/i.test(tail)) {
    return userId.toLowerCase().startsWith(tail.toLowerCase());
  }
  return false;
}

function displayEmail(email: string | undefined | null): string {
  // When the session token carries the member's email, show it. Real
  // registered accounts populate this; a member whose record has no bound
  // email gets an actionable CTA rather than a bare "not set" that reads as
  // a bug. The email string is not exposed via a member GET endpoint by
  // design (privacy: email is stored encrypted), so the session claim is the
  // only client-side source.
  if (!email || email.trim().length === 0) {
    return "not set - add one in Account > Login email";
  }
  return email;
}

/**
 * The OAuth token is minted without an email claim by design, so the session
 * often carries no email and Status would show "not set" even for a member
 * who has one. Fall back to the backend profile (GET /me returns the
 * decrypted account email). Best-effort: any failure leaves the session value
 * untouched so the display degrades gracefully to "not set".
 */
async function resolveAccountEmail(
  sessionEmail: string | undefined | null,
  signal?: AbortSignal,
): Promise<string | undefined | null> {
  if (sessionEmail && sessionEmail.trim().length > 0) return sessionEmail;
  const resp = await apiCall("/api/v1/members/me", { signal });
  if (resp && resp.ok) {
    const body = (await resp.json().catch(() => null)) as { email?: string } | null;
    if (body?.email) return body.email;
  }
  return sessionEmail;
}

function printHelp(): void {
  console.log(
    "Usage: alter status [--since-last]\n" +
      "\n" +
      "Render a multi-line identity + attunement + org status card.\n" +
      "Exits 1 if not logged in or the session has expired.\n" +
      "\n" +
      "Flags:\n" +
      "  --since-last   show what changed since the last 'alter status'\n",
  );
}

export async function status(args: string[] = []): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  try {
    emitSessionHeartbeat({
      sessionId: String(process.pid),
      workingOn: "alter status",
    });
  } catch { /* silent - must not block command */ }
  const showDiff = args.includes("--since-last");
  const session = getSessionInfo();

  if (!session) {
    failNotLoggedIn();
    return;
  }

  const expired = isExpired();
  const identity = readIdentity();
  // Prefer the daemon-refreshed org cache over the login-time seed (no-relogin
  // badge refresh); falls back to the seed when the cache is absent.
  const org = resolveEffectiveOrgs(session.orgs)[0];
  const handleIsPending = looksLikeSyntheticHandle(
    session.handle,
    session.user_id,
  );

  const verbose = args.includes("--verbose");

  console.log("");
  console.log(`  Alter Identity Status`);
  console.log(`  =====================`);
  console.log(
    `  Handle:        ${session.handle}${handleIsPending ? "  (binding pending - handle not yet chosen)" : ""}`,
  );
  let accountEmail: string | undefined | null = session.email;
  if (!session.email || session.email.trim().length === 0) {
    // Only paint the cancellable loader when a network lookup will actually
    // happen; the cached-email common path stays instant and flicker-free.
    const emailWait = await withLoadingCancel(
      (signal) => resolveAccountEmail(session.email, signal),
      "account",
    );
    if (emailWait.cancelled) return;
    accountEmail = emailWait.result ?? session.email;
  }
  console.log(`  Email:         ${displayEmail(accountEmail)}`);
  if (verbose) {
    console.log(`  User ID:       ${session.user_id}`);
  }
  console.log(`  Privacy level: ${session.consent_tier}`);
  console.log(
    `  Session:       ${expired ? "EXPIRED" : "Active"} (expires ${humaniseTimestamp(session.jwt_expires_at)})`
  );
  if (verbose) {
    console.log(`  API:           ${session.api}`);
    console.log(`  Config:        ${ALTER_CONFIG_DIR}/`);
  }
  console.log("");

  if (session.granted_scopes && verbose) {
    const scopes = session.granted_scopes.split(" ").filter(Boolean);
    console.log(`  Token scopes`);
    console.log(`  ------------`);
    for (const s of scopes) {
      console.log(`  ${s}`);
    }
    console.log("");
  }

  if (org) {
    console.log(`  Organisation`);
    console.log(`  -------------`);
    console.log(`  Domain:        ${org.domain}`);
    console.log(`  Role:          ${org.role}`);
    console.log(`  Access level:  ${org.tier}`);
    console.log("");
  }

  if (identity) {
    console.log(`  Your identity`);
    console.log(`  -------------`);
    // Member-facing output shows tier label, not a raw percentage.
    // The raw number is preserved in --json output only (current snapshot
    // written at the end carries the raw float for scripting consumers).
    console.log(`  Attunement:    ${confidenceTier(identity.attunement)}`);
    console.log(`  Engagement:    ${identity.engagement_label} (L${identity.engagement_level})`);
    console.log(`  Profile linked: ${identity.has_alter ? "yes" : "no"}`);
    console.log(`  Discovery:     ${identity.ceremony_complete ? "complete" : "not complete"}`);
    console.log(`  Last refresh:  ${formatRelativeAge(identity.last_refreshed)}`);
    console.log("");
  }

  if (!expired) {
    try {
      const pairedWait = await withLoadingCancel(
        (signal) => fetchPaired(signal),
        "loading connections",
      );
      const paired = pairedWait.cancelled ? [] : (pairedWait.result ?? []);
      if (paired.length > 0) {
        console.log(`  Connections`);
        console.log(`  -----------`);
        for (const c of paired) {
          const name = c.display_name ?? c.platform_username ?? c.profile_url ?? "";
          const boost =
            c.confidence_contribution && c.confidence_contribution > 0
              ? `  +${Math.round(c.confidence_contribution * 100)}% depth`
              : "";
          console.log(`  ${c.platform}${name ? `  (${name})` : ""}${boost}`);
        }
        console.log("");
      }
    } catch {
      // Connections are best-effort - never block the status card on a
      // network blip or a backend that hasn't shipped /me/connections yet.
    }
  }

  if (expired) {
    console.log("  Session expired. Run 'alter login' to re-authenticate.");
    console.log("");
    return;
  }

  // Snapshot + diff. Always fetch live signals so the snapshot is real,
  // not a stale cache. The diff render is opt-in (--since-last) but the
  // snapshot itself is written on every call so the next --since-last
  // has something to compare against.
  const liveWait = await withLoadingCancel(
    (signal) =>
      Promise.all([
        fetchEarningsSafe(signal),
        fetchBalanceSafe(signal),
        fetchConnectionsStatusSafe(signal),
      ]),
    "status",
  );
  if (liveWait.cancelled) return;
  const [earnings, balance, connections] = liveWait.result!;
  const traitCount = connections.traitCount;

  // Persist the engagement level alongside the live counts so the menu's
  // depth resolver (resolveEngagementLevel, src/lib/member-depth.ts) has a
  // local fallback when later access tokens drop the namespaced claim and
  // identity.json was never written. Sourced from the JWT claim ONLY -
  // when the claim is absent the field is absent (never a default level;
  // a written default would masquerade as a real observation).
  const claimedLevel = extractAlterClaims(session.jwt).engagement_level;

  // Read once, ahead of overwriting the snapshot below: the diff render
  // (--since-last) and the pending next-best-action report both need the
  // PRIOR snapshot, before this run's numbers replace it.
  const prior = readStatusSnapshot();

  const current: StatusSnapshot = {
    taken_at: new Date().toISOString(),
    attunement: identity?.attunement ?? null,
    balance_cents: balance?.balance_cents ?? 0,
    total_earned: earnings?.total_earned ?? 0,
    transaction_count: earnings?.transaction_count ?? 0,
    trait_count: traitCount,
    ...(typeof claimedLevel === "number"
      ? { engagement_level: claimedLevel }
      : {}),
    // Record whatever suggestion this run is about to render (below) as the
    // pending one for the next check to report on. Empty when there is
    // nothing to render, which also clears any pending marker that just
    // got reported.
    ...pendingSuggestionFields(connections.nextBestAction),
    // Carry a compact reading of the guided walk's progress so the menu
    // header can show a step teaser without its own network round-trip.
    // Empty when there is nothing to carry, which also clears a stale
    // teaser once the walk completes or stops being offered.
    ...walkthroughSnapshotFields(connections.walkthrough),
  };

  // Recent activity block - surface live counts in the regular render so
  // a member looking at `alter status` sees the live "is anything happening
  // to my vector" signal without needing --since-last or a separate verb.
  // Cross-links into the read-parity surfaces (queries / portfolio / earnings)
  // so the menu's static list isn't the only path.
  console.log("  Recent activity");
  console.log("  ---------------");
  console.log(
    `  Queries:       ${current.transaction_count}${current.transaction_count > 0 ? "          alter queries" : "          (none yet)"}`
  );
  console.log(
    `  Traits on file:  ${current.trait_count}${current.trait_count > 0 ? "        alter portfolio · alter traits" : "        (none yet - accrue as you act)"}`
  );
  if (current.trait_count > 0) {
    console.log(
      "                   (total traits measured to date - 'alter traits' shows which moved recently)"
    );
  }
  console.log(
    `  Total earned:  $${current.total_earned.toFixed(2)}      alter earnings`
  );
  console.log("");

  // What next - the canonical next-best-action, beneath the identity tier
  // labels and paired sources above. It rides the connections-status response
  // already fetched, so it costs no extra round-trip. Absent (older backend)
  // renders nothing rather than an empty block, so the card degrades cleanly.
  if (connections.nextBestAction) {
    renderWhatNext(connections.nextBestAction);
  }

  // Guided walk - the fuller teaching arc beneath the single-step "What
  // next" CTA above. Same additive contract: rides the connections-status
  // response already fetched, absent (older backend, consent not granted,
  // resolver failure) renders nothing rather than an empty block.
  if (connections.walkthrough) {
    renderWalkthroughBlock(connections.walkthrough);
  }

  if (showDiff) {
    if (!prior) {
      console.log("");
      console.log("  Since last check");
      console.log("  ----------------");
      console.log("  No prior snapshot yet - this is your baseline.");
      console.log("  Run 'alter status --since-last' again later to see");
      console.log("  what has changed in your identity record.");
      console.log("");
    } else {
      renderDiffLines(prior, current);
    }
  }

  writeStatusSnapshot(current);

  // If a suggestion rendered on a prior run is still pending, report what
  // happened next now that a fresh projection is in hand. Runs last, after
  // every render above and after the snapshot write, so it can never delay
  // or alter what the member already saw; any failure is silent.
  if (prior?.pending_suggestion_id) {
    await reportPendingSuggestion(
      prior.pending_suggestion_id,
      connections.nextBestAction,
    );
  }
}
