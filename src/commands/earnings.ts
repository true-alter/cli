/**
 * alter earnings - Identity Income visibility surface.
 *
 * The CLI complement to `alter wallet`. Where `wallet` manages where
 * earnings are sent, `earnings` shows what has accumulated, when, and
 * from what. Closes the "is anything actually happening" loop without
 * needing a web dashboard.
 *
 * Subcommands:
 *   alter earnings                  Balance + last 10 ledger entries + totals
 *   alter earnings --json           Machine-readable JSON for scripts
 *   alter earnings ledger [--limit] Paginated ledger view (default 20)
 *   alter earnings summary [year]   Annual financial-year summary (AU)
 *
 * Backend endpoints:
 *   GET /api/v1/members/me/earnings           total / pending / count
 *   GET /api/v1/members/me/earnings/balance   { balance_cents, balance_display }
 *   GET /api/v1/members/me/earnings/ledger    paginated entries
 *   GET /api/v1/members/me/earnings/annual-summary  AU FY summary
 */

import { apiCall, failNotLoggedIn, getSession } from "../auth.js";
import { emitSessionHeartbeat } from "../lib/active-sessions-emit.js";
import { withLoadingCancel } from "../ui/biosMenu.js";

// ---------------------------------------------------------------------------
// ConsequencePreview - on-chain settlement schedule from the backend.
// USDC-raw uses 6-decimal precision (1 USDC = 1_000_000 raw).
// ---------------------------------------------------------------------------

interface ConsequencePreview {
  per_query_price_usdc_raw: Record<string, number>;
  per_query_subject_share_usdc_raw: Record<string, number>;
  subject_share_bps: number;
  protocol_cut_bps: number;
  facilitator_bps: number;
  cooperative_bps: number;
  anti_extraction_ratio: string;
  settlement_primitive: string;
  settlement_note: string;
}

interface EarningsSummary {
  total_earned: number;
  pending_amount: number;
  transaction_count: number;
  unique_orgs: number;
  transactions: Transaction[];
  // Extended fields from the IncomeSummary schema
  total_cents?: number;
  last_7d_cents?: number;
  last_30d_cents?: number;
  by_source?: Record<string, number>;
  consequence_preview?: ConsequencePreview;
}

interface Transaction {
  id?: string;
  amount_cents?: number;
  amount_usd?: number;
  description?: string;
  org_id?: string;
  created_at?: string;
  status?: string;
}

interface BalanceResponse {
  balance_cents: number;
  balance_display: string;
}

interface LedgerEntry {
  id: string;
  entry_type: string;
  amount_gross_cents: number;
  amount_net_cents: number;
  tax_withheld_cents: number;
  balance_after_cents: number;
  description: string | null;
  created_at: string | null;
}

interface LedgerResponse {
  entries: LedgerEntry[];
  pagination: {
    next_cursor: string | null;
    has_more: boolean;
    total_count: number;
  };
}

async function fetchEarnings(signal?: AbortSignal): Promise<EarningsSummary> {
  const resp = await apiCall("/api/v1/members/me/earnings", { signal });
  if (!resp) throw new Error("not logged in. Run 'alter login' first.");
  if (resp.status === 403)
    throw new Error("earnings access requires a member account. Run `alter login` to check your session.");
  if (!resp.ok)
    throw new Error(`fetch earnings failed: ${resp.status} ${resp.statusText}`);
  return (await resp.json()) as EarningsSummary;
}

async function fetchBalance(signal?: AbortSignal): Promise<BalanceResponse | null> {
  const resp = await apiCall("/api/v1/members/me/earnings/balance", { signal });
  if (!resp || !resp.ok) return null;
  return (await resp.json()) as BalanceResponse;
}

async function fetchLedger(limit: number, signal?: AbortSignal): Promise<LedgerResponse | null> {
  const resp = await apiCall(`/api/v1/members/me/earnings/ledger?limit=${limit}`, { signal });
  if (!resp || !resp.ok) return null;
  return (await resp.json()) as LedgerResponse;
}

async function fetchAnnualSummary(year?: number, signal?: AbortSignal): Promise<unknown | null> {
  const path = year
    ? `/api/v1/members/me/earnings/annual-summary?financial_year=${year}`
    : "/api/v1/members/me/earnings/annual-summary";
  const resp = await apiCall(path, { signal });
  if (!resp || !resp.ok) return null;
  return await resp.json();
}

async function fetchWalletStatus(signal?: AbortSignal): Promise<{ status?: string } | null> {
  const resp = await apiCall("/api/v1/members/me/wallet", { signal });
  if (!resp || !resp.ok) return null;
  return (await resp.json()) as { status?: string };
}

async function fetchPayoutAccount(signal?: AbortSignal): Promise<{
  has_account?: boolean;
  payouts_enabled?: boolean;
} | null> {
  const resp = await apiCall("/api/v1/members/me/payout-account", { signal });
  if (!resp || !resp.ok) return null;
  return (await resp.json()) as {
    has_account?: boolean;
    payouts_enabled?: boolean;
  };
}

function formatDollars(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toFixed(2)}`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toISOString().slice(0, 10);
  } catch {
    return iso.slice(0, 10);
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function printHelp(): void {
  console.log(
    "Usage: alter earnings [subcommand] [flags]\n" +
      "\n" +
      "Show your Identity Income - balance, recent activity, totals.\n" +
      "\n" +
      "  (no subcommand)        Balance + last 10 ledger entries + totals\n" +
      "  ledger [--limit N]     Full paginated ledger (default 20)\n" +
      "  summary [year]         Annual financial-year summary (AU FY)\n" +
      "\n" +
      "Flags:\n" +
      "  --json                 Machine-readable JSON output\n" +
      "  --limit <N>            Limit the number of ledger entries (max 100)\n" +
      "\n" +
      "Earnings accrue per paid query. Set up a payout method via 'alter wallet'.\n",
  );
}

/** Convert USDC-raw (6 decimals) to a human-readable dollar string. */
function usdcRawToDisplay(raw: number): string {
  const dollars = raw / 1_000_000;
  if (dollars === 0) return "$0.00";
  if (dollars < 0.001) return `$${dollars.toFixed(6)}`;
  if (dollars < 0.01) return `$${dollars.toFixed(4)}`;
  return `$${dollars.toFixed(4)}`;
}

/**
 * Render the per-tier rate card from the consequence_preview block.
 * Copy contract: active voice, AlterRouter as on-chain payer, no
 * "Alter distributes/manages/holds".
 */
function renderConsequencePreview(preview: ConsequencePreview): void {
  const subjectPct = Math.round(preview.subject_share_bps / 100);
  console.log("  Rate card - what your identity earns per agent query, by level");
  console.log("  ----------------------------------------------------");
  const tiers = ["L0", "L1", "L2", "L3", "L4", "L5"];
  for (const tier of tiers) {
    const price = preview.per_query_price_usdc_raw[tier] ?? 0;
    const share = preview.per_query_subject_share_usdc_raw[tier] ?? 0;
    if (price === 0) {
      console.log(`  ${tier.padEnd(4)}  free tier  (no payment)`.padEnd(60));
      continue;
    }
    const priceStr = usdcRawToDisplay(price).padStart(10);
    const shareStr = usdcRawToDisplay(share).padStart(10);
    console.log(`  ${tier.padEnd(4)}  query price ${priceStr}   your share ${shareStr}  (${subjectPct}%)`);
  }
  console.log("");
  console.log(`  75% goes to you. The rest keeps the protocol honest.`);
}

/**
 * Day-1 cold-start renderer: total_cents == 0, no ledger entries yet.
 * Shows rate-card framing so the member understands how earning works
 * before their first query arrives.
 */
function renderDay1(preview: ConsequencePreview | null): void {
  console.log("");
  console.log("  Identity Income");
  console.log("  ===============");
  console.log("  Balance:        $0.00");
  console.log("  Total earned:   $0.00");
  console.log("  Queries:        0");
  console.log("");
  console.log("  Your identity earns each time an external agent queries your");
  console.log("  profile, or when an organisation pays for a verified attestation.");
  console.log("");
  if (preview) {
    renderConsequencePreview(preview);
    console.log("");
  }
  console.log("  Grow your earning surface:");
  console.log("    alter pair          pair more identity sources");
  console.log("    alter portfolio     see what your vector currently looks like");
  console.log("    alter queries       audit log of who's queried you (none yet)");
  console.log("    alter wallet        register a payout account");
  console.log("");
}

/**
 * Day-7 renderer: some earnings, last_7d_cents > 0.
 * Shows trajectory - what the last 7 days converted to, plus rate card
 * so the member can see what growth looks like going forward.
 */
function renderDay7(
  balance: BalanceResponse | null,
  earnings: EarningsSummary,
  last7dCents: number,
  preview: ConsequencePreview | null,
): void {
  const balanceDisplay =
    balance?.balance_display ??
    `$${(((balance?.balance_cents ?? 0) as number) / 100).toFixed(2)}`;
  const totalDisplay = `$${earnings.total_earned.toFixed(2)}`;
  const pendingDisplay = `$${earnings.pending_amount.toFixed(2)}`;
  const last7dDisplay = `$${(last7dCents / 100).toFixed(4)}`;

  console.log("");
  console.log("  Identity Income");
  console.log("  ===============");
  console.log(`  Balance:        ${balanceDisplay}    (accrued)`);
  console.log(`  Pending:        ${pendingDisplay}    (settling)`);
  console.log(`  Total earned:   ${totalDisplay}`);
  console.log(`  Last 7 days:    ${last7dDisplay}    your identity earned from recent queries`);
  console.log(`  Queries:        ${earnings.transaction_count}`);
  if (earnings.unique_orgs > 0) {
    console.log(`  From queriers:  ${earnings.unique_orgs}`);
  }
  console.log("");
  if (preview) {
    renderConsequencePreview(preview);
    console.log("");
  }
}

/**
 * Day-30 renderer: rolling-30 framing with by-source split.
 * Full picture: 30-day total, sources breakdown, rate card.
 */
function renderDay30(
  balance: BalanceResponse | null,
  earnings: EarningsSummary,
  last30dCents: number,
  preview: ConsequencePreview | null,
): void {
  const balanceDisplay =
    balance?.balance_display ??
    `$${(((balance?.balance_cents ?? 0) as number) / 100).toFixed(2)}`;
  const totalDisplay = `$${earnings.total_earned.toFixed(2)}`;
  const pendingDisplay = `$${earnings.pending_amount.toFixed(2)}`;
  const last30dDisplay = `$${(last30dCents / 100).toFixed(4)}`;

  console.log("");
  console.log("  Identity Income");
  console.log("  ===============");
  console.log(`  Balance:        ${balanceDisplay}    (accrued)`);
  console.log(`  Pending:        ${pendingDisplay}    (settling)`);
  console.log(`  Total earned:   ${totalDisplay}`);
  console.log(`  Last 30 days:   ${last30dDisplay}    rolling window`);
  console.log(`  Queries:        ${earnings.transaction_count}`);
  if (earnings.unique_orgs > 0) {
    console.log(`  From queriers:  ${earnings.unique_orgs}`);
  }

  // By-source breakdown. Prefer the authoritative by_source field from the
  // backend; only recompute from transaction descriptions when it's absent
  // (older backend that doesn't return the aggregate).
  let bySourceEntries: [string, number][];
  if (earnings.by_source && Object.keys(earnings.by_source).length > 0) {
    bySourceEntries = Object.entries(earnings.by_source);
  } else {
    const bySource: Record<string, number> = {};
    for (const t of earnings.transactions ?? []) {
      const key = t.description ?? "other";
      bySource[key] = (bySource[key] ?? 0) + (t.amount_cents ?? 0);
    }
    bySourceEntries = Object.entries(bySource);
  }
  if (bySourceEntries.length > 0) {
    console.log("");
    console.log("  By source:");
    for (const [src, cents] of bySourceEntries) {
      console.log(`    ${src.padEnd(32)} $${(cents / 100).toFixed(4)}`);
    }
  }

  console.log("");
  if (preview) {
    renderConsequencePreview(preview);
    console.log("");
  }
}

// ---------------------------------------------------------------------------
// Legacy fallback renderer - used when consequence_preview is absent
// (older backend). Keeps backward compat with renderDefault's call site.
// ---------------------------------------------------------------------------

function renderEmpty(): void {
  renderDay1(null);
}

function renderBalanceLine(
  balance: BalanceResponse | null,
  earnings: EarningsSummary,
): void {
  const balanceDisplay =
    balance?.balance_display ??
    `$${(((balance?.balance_cents ?? 0) as number) / 100).toFixed(2)}`;
  const totalDisplay = `$${earnings.total_earned.toFixed(2)}`;
  const pendingDisplay = `$${earnings.pending_amount.toFixed(2)}`;

  console.log("  Identity Income");
  console.log("  ===============");
  console.log(`  Balance:        ${balanceDisplay}    (accrued)`);
  console.log(`  Pending:        ${pendingDisplay}    (settling)`);
  console.log(`  Total earned:   ${totalDisplay}`);
  console.log(`  Queries:        ${earnings.transaction_count}`);
  if (earnings.unique_orgs > 0) {
    console.log(`  From queriers:  ${earnings.unique_orgs}`);
  }
}

function renderLedgerEntries(
  entries: LedgerEntry[],
  options: { showBalance?: boolean } = {},
): void {
  if (entries.length === 0) {
    console.log("  (no ledger entries yet)");
    return;
  }
  for (const e of entries) {
    const date = formatDate(e.created_at);
    const amount = formatDollars(e.amount_net_cents);
    const desc = truncate(e.description ?? e.entry_type, 48);
    const balance = options.showBalance
      ? `   ${formatDollars(e.balance_after_cents)}`
      : "";
    console.log(`  ${date}   ${amount.padStart(8)}   ${desc}${balance}`);
  }
}

async function renderPayoutHint(): Promise<void> {
  // Show payout-readiness one-liner: nothing nags, but a member sitting
  // on a non-zero balance with no payout account set up should see the
  // unblock right where the balance is.
  try {
    const wait = await withLoadingCancel(
      (signal) =>
        Promise.all([fetchWalletStatus(signal), fetchPayoutAccount(signal)]),
      "payout status",
    );
    if (wait.cancelled) return;
    const [wallet, payout] = wait.result!;
    const hasCrypto = wallet && wallet.status && wallet.status !== "not_registered";
    const hasFiat = payout && payout.has_account && payout.payouts_enabled;
    // A member with a registered crypto wallet is settled on-chain to an
    // address they control; the useful next step for them is turning that USDC
    // into cash, so point them at the licensed-provider hand-off.
    if (hasCrypto) {
      console.log("");
      console.log("  Turn settled USDC into cash via a licensed provider:");
      console.log("  run 'alter cash-out'.");
      return;
    }
    if (hasFiat) return;
    console.log("");
    console.log("  No payout wallet yet - earnings accrue to your ledger and");
    console.log("  settle once you set one. Run 'alter wallet register'.");
  } catch {
    // Best-effort hint; never block the main render on a network blip.
  }
}

async function renderDefault(jsonMode: boolean, limit: number): Promise<void> {
  const wait = await withLoadingCancel(
    (signal) =>
      Promise.all([
        fetchEarnings(signal),
        fetchBalance(signal),
        fetchLedger(limit, signal),
      ]),
    "earnings",
  );
  if (wait.cancelled) return;
  const [earnings, balance, ledger] = wait.result!;

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          balance_cents: balance?.balance_cents ?? 0,
          balance_display: balance?.balance_display ?? "$0.00",
          total_earned: earnings.total_earned,
          pending_amount: earnings.pending_amount,
          transaction_count: earnings.transaction_count,
          unique_orgs: earnings.unique_orgs,
          recent_entries: ledger?.entries ?? [],
        },
        null,
        2,
      ),
    );
    return;
  }

  const preview = earnings.consequence_preview ?? null;
  const totalCents = earnings.total_cents ?? Math.round(earnings.total_earned * 100);
  const last7dCents = earnings.last_7d_cents ?? 0;
  const last30dCents = earnings.last_30d_cents ?? 0;

  // Route to the appropriate variant based on earnings state:
  //   Day-1: cold start, no earnings yet
  //   Day-7: some earnings within the last 7 days - trajectory view
  //   Day-30: broader rolling window - full picture
  //   Legacy: backward-compat when consequence_preview is absent
  if (totalCents === 0 && earnings.transaction_count === 0) {
    renderDay1(preview);
    return;
  }

  if (last30dCents > 0) {
    renderDay30(balance, earnings, last30dCents, preview);
  } else if (last7dCents > 0) {
    renderDay7(balance, earnings, last7dCents, preview);
  } else {
    // Has historical earnings but nothing recent - use the balance line
    // + legacy rate card (consequence_preview when present).
    renderBalanceLine(balance, earnings);
    if (preview) {
      console.log("");
      renderConsequencePreview(preview);
    }
  }

  console.log("");
  console.log("  Recent activity");
  console.log("  ---------------");
  renderLedgerEntries(ledger?.entries ?? [], { showBalance: true });
  if (ledger && ledger.pagination.has_more) {
    console.log("");
    console.log(`  ... ${ledger.pagination.total_count - (ledger.entries.length)} more - 'alter earnings ledger' for the full view`);
  }
  if (earnings.transaction_count > 0) {
    console.log("");
    console.log("  See who's queried you:  alter queries");
  }
  await renderPayoutHint();
  console.log("");
}

async function renderLedgerSubcommand(
  limit: number,
  jsonMode: boolean,
): Promise<void> {
  const wait = await withLoadingCancel(
    (signal) => fetchLedger(Math.min(Math.max(limit, 1), 100), signal),
    "ledger",
  );
  if (wait.cancelled) return;
  const ledger = wait.result;
  if (!ledger) {
    throw new Error("could not fetch ledger.");
  }

  if (jsonMode) {
    console.log(JSON.stringify(ledger, null, 2));
    return;
  }

  console.log("");
  console.log(`  Earnings ledger  (${ledger.pagination.total_count} entries total)`);
  console.log("  =================");
  console.log("  date         amount    description                                   balance");
  console.log("  ----         ------    -----------                                   -------");
  renderLedgerEntries(ledger.entries, { showBalance: true });
  if (ledger.pagination.has_more) {
    console.log("");
    console.log(
      `  showing ${ledger.entries.length} of ${ledger.pagination.total_count} - pass --limit to expand`,
    );
  }
  console.log("");
}

async function renderSummarySubcommand(
  year: number | undefined,
  jsonMode: boolean,
): Promise<void> {
  const wait = await withLoadingCancel(
    (signal) => fetchAnnualSummary(year, signal),
    "annual summary",
  );
  if (wait.cancelled) return;
  const summary = wait.result;
  if (!summary) {
    throw new Error("could not fetch annual summary.");
  }
  if (jsonMode) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  // The backend response is shape-loose; print key/value pairs that look
  // financial. Map known snake_case keys to plain labels; humanise the rest.
  console.log("");
  console.log("  Annual earnings summary");
  console.log("  =======================");
  const KEY_LABELS: Record<string, string> = {
    total_gross_cents: "Total (gross)",
    total_net_cents: "Total (net)",
    total_cents: "Total",
    pending_cents: "Pending",
    last_7d_cents: "Last 7 days",
    last_30d_cents: "Last 30 days",
    fy_start: "Financial year start",
    fy_end: "Financial year end",
    tax_year: "Tax year",
    transaction_count: "Transactions",
    unique_orgs: "Queriers",
    withdrawal_total_cents: "Withdrawn",
    refund_total_cents: "Refunds",
  };
  const obj = summary as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "object") continue;
    const label = KEY_LABELS[k] ??
      k.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    let display = String(v);
    if (k.endsWith("_cents") && typeof v === "number") {
      display = formatDollars(v);
    }
    console.log(`  ${label.padEnd(28)} ${display}`);
  }
  console.log("");
}

export async function earnings(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    printHelp();
    return;
  }
  try {
    emitSessionHeartbeat({
      sessionId: String(process.pid),
      workingOn: "alter earnings",
    });
  } catch { /* silent - must not block command */ }

  if (!getSession()) {
    failNotLoggedIn();
    return;
  }

  const jsonMode = args.includes("--json");
  const limitFlag = args.indexOf("--limit");
  const limitArg =
    limitFlag >= 0 && args[limitFlag + 1]
      ? parseInt(args[limitFlag + 1], 10)
      : NaN;

  const sub = args.find(
    (a) => !a.startsWith("--") && a !== "help",
  );

  // Reject unknown subcommands instead of silently rendering the default
  // earnings screen. `alter earnings ledgr` (typo) used to look like it
  // worked while quietly ignoring the request. A bare `alter earnings`
  // (no positional) still shows the default view.
  const KNOWN_SUBCOMMANDS = new Set(["ledger", "summary"]);
  if (sub !== undefined && !KNOWN_SUBCOMMANDS.has(sub)) {
    console.error(
      `Unknown subcommand 'earnings ${sub}'. Run 'alter earnings --help' for usage.`,
    );
    process.exitCode = 1;
    return;
  }

  if (sub === "ledger") {
    const limit = Number.isFinite(limitArg) ? limitArg : 20;
    await renderLedgerSubcommand(limit, jsonMode);
    return;
  }

  if (sub === "summary") {
    const yearStr = args.find(
      (a) => !a.startsWith("--") && a !== "summary" && /^\d{4}$/.test(a),
    );
    const year = yearStr ? parseInt(yearStr, 10) : undefined;
    await renderSummarySubcommand(year, jsonMode);
    return;
  }

  const defaultLimit = Number.isFinite(limitArg)
    ? Math.min(Math.max(limitArg, 1), 100)
    : 10;
  await renderDefault(jsonMode, defaultLimit);
}
