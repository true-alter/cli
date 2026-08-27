/**
 * alter wallet - Identity Income payout setup.
 *
 * Today the CLI ships ONE live rail (non-custodial rules):
 *
 *   Crypto wallet (EVM address)
 *     When on-chain settlement is live, the AlterRouter contract routes
 *     x402 payments directly to your external EOA / smart account /
 *     multi-sig at payment time. Funds are never held by Alter.
 *
 *   Bank account (Stripe) - GATED, not available today.
 *     The as-built Stripe path parks member royalties on a platform
 *     balance, which is custody Alter is not allowed to take
 *     (non-custodial rules). It returns later as a re-architected
 *     non-custodial off-ramp where a licensed intermediary holds the
 *     balance, never Alter. Until then every fiat entry point below is
 *     hard-gated behind ALTER_PHASE2_FIAT_RAIL ("1" to re-open in dev).
 *
 * If both rails are ever configured the on-chain rail wins.
 *
 * Subcommands:
 *   alter wallet                       Show current rail + status
 *   alter wallet register              Set EVM payout address
 *   alter wallet register --bank       GATED (fiat off-ramp, not yet live)
 *   alter wallet register --crypto <0x...>   Set EVM payout address
 *   alter wallet withdraw [amount]     PHASE-GATED (fiat-only path)
 *   alter wallet clear                 Clear the registered EVM address
 *   alter wallet clear --crypto        Same as `clear` (explicit)
 *   alter wallet revoke <address>      Unbind an attested identity wallet
 *   alter wallet revoke <address> --chain <chain>   Same, chain disambiguated
 *
 * `revoke` is distinct from `clear`: `clear` drops the payout destination
 * (PUT/DELETE /me/wallet); `revoke` unbinds an identity-attested wallet
 * (DELETE /api/v1/wallet/attest/{address}) recorded via SIWE / Solana
 * off-chain signature at browser onboarding. The two are independent:
 * revoking an attestation does not touch the payout rail and clearing
 * the payout rail does not revoke an attestation.
 *
 * Alter is debtor-not-custodian. The member is a data licensor receiving
 * licensing royalties - language is "earned", not "balance".
 */

import { text, isCancel, cancel } from "@clack/prompts";
import { pickOne, textInput, confirmYesNo, BACK_OPTION, isBack } from "../ui/picker.js";
import { apiCall, failNotLoggedIn, getSession } from "../auth.js";
import { withLoadingCancel } from "../ui/biosMenu.js";
import { openBrowser } from "../browser.js";

// The gate for every fiat (Stripe) entry point. Today is closed-rail and
// crypto-native: income accrues per query and settles on-chain; first-earn
// never waits on a payout rail. Deliberately an env flag and not a removal so
// the later re-entry (and dev/e2e testing of the Stripe flow) stays cheap.
export const FIAT_RAIL_LIVE = process.env.ALTER_PHASE2_FIAT_RAIL === "1";

/** One canonical line for every gated fiat entry point. */
function fiatRailGateMessage(): string {
  return (
    "bank payout isn't available yet. Income accrues to your ledger per\n" +
    "query and settles on-chain once settlement is live - add a wallet with\n" +
    "'alter wallet register'. A non-custodial bank off-ramp arrives in a\n" +
    "later phase."
  );
}

interface WalletInfo {
  status?: string;
  message?: string;
  // The backend payout-wallet endpoints (GET/PUT/DELETE /members/me/wallet)
  // serialise the on-chain address under `wallet_address`, never `address`,
  // and the registration timestamp under `created_at`/`updated_at`. The CLI
  // historically read `address`/`registered_at`, so a registered wallet was
  // never recognised (the saved-wallet probe saw `undefined` and every
  // member was told "No payout wallet is set"). normaliseWalletInfo() maps
  // the backend shape onto these CLI-facing aliases at every fetch boundary.
  address?: string;
  wallet_address?: string;
  network?: string;
  registered_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  warnings?: string[];
  [key: string]: unknown;
}

// Reconcile the backend payout-wallet response shape with the CLI-facing
// WalletInfo. The backend returns `wallet_address` (+ `created_at`); the CLI
// reads `address` (+ `registered_at`). Populate the CLI aliases from the
// backend fields when the backend fields are present and the aliases aren't,
// so a registered wallet is correctly recognised everywhere downstream.
function normaliseWalletInfo<T extends WalletInfo | null>(info: T): T {
  if (!info) return info;
  if (info.address === undefined && typeof info.wallet_address === "string") {
    info.address = info.wallet_address;
  }
  if (
    (info.registered_at === undefined || info.registered_at === null) &&
    typeof info.created_at === "string"
  ) {
    info.registered_at = info.created_at;
  }
  return info;
}

interface PayoutAccount {
  has_account: boolean;
  account_id?: string | null;
  onboarding_url?: string | null;
  payouts_enabled?: boolean;
  details_submitted?: boolean;
}

interface BalanceResponse {
  balance_cents: number;
  balance_display: string;
}

interface WithdrawResponse {
  transfer_id?: string | null;
  amount_cents: number;
  status: string;
  balance_after_cents: number;
}

const CLI_RETURN_URL = "https://truealter.com/payouts/return";
const CLI_REFRESH_URL = "https://truealter.com/payouts/refresh";

function isEvmAddress(v: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(v.trim());
}

function formatDollars(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toFixed(2)}`;
}

// Surface backend-returned warnings verbatim. Each warning string is
// already self-describing - do not prepend a generic "Warning:" label.
function printWalletWarnings(info: WalletInfo): void {
  if (!info.warnings || info.warnings.length === 0) return;
  for (const w of info.warnings) {
    console.log(`  ! ${w}`);
  }
  console.log("");
}

// ─── API wrappers ──────────────────────────────────────────────────────

async function fetchWallet(signal?: AbortSignal): Promise<WalletInfo | null> {
  const resp = await apiCall("/api/v1/members/me/wallet", { signal });
  if (!resp) throw new Error("not logged in. Run 'alter login' first.");
  if (resp.status === 403) {
    const body = (await resp.json().catch(() => ({}))) as { detail?: string };
    throw new Error(
      body.detail ?? "wallet access requires a member account. Run `alter login` to check your session.",
    );
  }
  if (!resp.ok) {
    throw new Error(
      `could not fetch wallet (${resp.status} ${resp.statusText}).`,
    );
  }
  return normaliseWalletInfo((await resp.json()) as WalletInfo);
}

async function registerCryptoWallet(
  address: string,
  signal?: AbortSignal,
): Promise<WalletInfo> {
  const resp = await apiCall(
    `/api/v1/members/me/wallet?wallet_address=${encodeURIComponent(address)}`,
    { method: "PUT", signal },
  );
  if (!resp) throw new Error("not logged in. Run 'alter login' first.");
  if (resp.status === 403) {
    const body = (await resp.json().catch(() => ({}))) as { detail?: string };
    throw new Error(
      body.detail ?? "wallet registration requires engagement level 3 or higher.",
    );
  }
  if (resp.status === 422) {
    const body = (await resp.json().catch(() => ({}))) as { detail?: string };
    throw new Error(body.detail ?? "invalid wallet address.");
  }
  if (!resp.ok) {
    throw new Error(`register failed (${resp.status} ${resp.statusText}).`);
  }
  return normaliseWalletInfo((await resp.json()) as WalletInfo);
}

// ─── Attest API wrappers ───────────────────────────────────────────────

interface AttestChallenge {
  message?: string;
  domain?: string;
  nonce?: string;
  issued_at?: string;
  typed_data?: unknown;
  [key: string]: unknown;
}

interface AttestVerifyResult {
  verified?: boolean;
  [key: string]: unknown;
}

async function requestAttestChallenge(
  address: string,
  signal?: AbortSignal,
): Promise<AttestChallenge> {
  const resp = await apiCall("/api/v1/wallet/attest/challenge", {
    method: "POST",
    body: { handle: requireBoundHandle(), chain: REGISTER_ATTEST_CHAIN, address },
    signal,
  });
  if (!resp) throw new Error("not logged in. Run 'alter login' first.");
  if (!resp.ok) {
    const body = (await resp.json().catch(() => ({}))) as { detail?: string };
    throw new Error(
      body.detail ?? `could not request signing challenge (${resp.status} ${resp.statusText}).`,
    );
  }
  return (await resp.json()) as AttestChallenge;
}

async function verifyAttestation(
  address: string,
  signature: string,
  nonce: string,
  message: string,
  signal?: AbortSignal,
): Promise<AttestVerifyResult> {
  const resp = await apiCall("/api/v1/wallet/attest/verify", {
    method: "POST",
    body: {
      handle: requireBoundHandle(),
      chain: REGISTER_ATTEST_CHAIN,
      address,
      signature,
      message,
      nonce,
      consent_added: [REGISTER_ATTEST_CHAIN],
    },
    signal,
  });
  if (!resp) throw new Error("not logged in. Run 'alter login' first.");
  if (!resp.ok) {
    const body = (await resp.json().catch(() => ({}))) as { detail?: string };
    throw new Error(
      body.detail ?? `attestation verify failed (${resp.status} ${resp.statusText}).`,
    );
  }
  return (await resp.json()) as AttestVerifyResult;
}

// Full chain identifier set the backend accepts (app.schemas.wallet_attest.
// Chain). Kept local rather than imported from bridge/verbs/wallet-attest.ts:
// that file's CHAINS set is {"base","eth","solana"} only, which pre-dates
// eth-l1/polygon/arbitrum/optimism/avalanche support and does not reflect
// what a member may actually have attested. Revoke must be able to name
// any chain a live row can carry, so it uses the current, complete set.
const ATTEST_CHAIN_VALUES = new Set([
  "base",
  "eth-l1",
  "solana",
  "polygon",
  "arbitrum",
  "optimism",
  "avalanche",
]);

// The chain `alter wallet register` attests on. It must be a member of the
// set above, which mirrors the backend Chain enum, because the request models
// are `extra="forbid"` and reject an unknown value outright rather than
// coercing it. The literal here was "eth" until 2026-08-07; that string is in
// no enum on either side, so every challenge 422'd before a signature was
// ever asked for and the CLI could not create an attestation at all.
const REGISTER_ATTEST_CHAIN = "eth-l1";

/**
 * The bound ~handle, or a thrown "not logged in" error.
 *
 * The attest challenge and verify bodies both require `handle`, and the
 * backend validates it against the tilde-prefixed pattern. Reading it from the
 * session rather than accepting it as an argument keeps a caller from
 * attesting a wallet against someone else's handle.
 */
function requireBoundHandle(): string {
  const session = getSession();
  if (!session?.handle) {
    throw new Error("not logged in. Run 'alter login' first.");
  }
  return session.handle;
}

interface WalletAttestationSummary {
  id: string;
  address: string;
  chain: string;
  paired_at: string;
  per_chain_consent?: string[];
}

interface WalletAttestationListResponse {
  wallets: WalletAttestationSummary[];
}

/** GET /api/v1/wallet/attest: the caller's own active identity-attested wallets. */
async function fetchWalletAttestations(
  signal?: AbortSignal,
): Promise<WalletAttestationSummary[]> {
  const resp = await apiCall("/api/v1/wallet/attest", { signal });
  if (!resp) throw new Error("not logged in. Run 'alter login' first.");
  if (!resp.ok) {
    throw new Error(
      `could not read attested wallets (${resp.status} ${resp.statusText}).`,
    );
  }
  const body = (await resp.json()) as WalletAttestationListResponse;
  return body.wallets ?? [];
}

/** DELETE /api/v1/wallet/attest/{address}?chain=...: soft-revoke one row. */
async function revokeWalletAttestation(
  address: string,
  chain: string,
  signal?: AbortSignal,
): Promise<void> {
  const resp = await apiCall(
    `/api/v1/wallet/attest/${encodeURIComponent(address)}?chain=${encodeURIComponent(chain)}`,
    { method: "DELETE", signal },
  );
  if (!resp) throw new Error("not logged in. Run 'alter login' first.");
  if (!resp.ok) {
    throw new Error(
      `could not revoke wallet attestation (${resp.status} ${resp.statusText}).`,
    );
  }
  // 204 No Content on success, nothing to parse. The endpoint returns 204
  // even when no row matched (privacy: it never discloses which addresses
  // are bound to which handles), so a 2xx here does not by itself prove a
  // row existed. revokeAttestationFlow() below confirms existence itself
  // via the list read before calling this, so the caller already knows.
}

/**
 * `alter wallet revoke <address> [--chain <chain>]`.
 *
 * Unbinds an identity-attested wallet. Chain is resolved from the caller's
 * own attestation list rather than required up front: the member reasons
 * about "this address", not about which of seven chain identifiers it was
 * attested under, and the list read is self-scoped (GET /wallet/attest
 * returns only the caller's own rows) so resolving this way discloses
 * nothing beyond what the member can already see about themselves.
 */
async function revokeAttestationFlow(
  addressArg: string | undefined,
  chainArg: string | undefined,
): Promise<void> {
  if (!addressArg || addressArg.startsWith("-")) {
    throw new Error(
      "usage: alter wallet revoke <address> [--chain <chain>]",
    );
  }
  if (chainArg !== undefined && !ATTEST_CHAIN_VALUES.has(chainArg)) {
    throw new Error(
      `unknown chain '${chainArg}'. One of: ${Array.from(ATTEST_CHAIN_VALUES).join(", ")}.`,
    );
  }
  const address = addressArg.trim();

  const listWait = await withLoadingCancel(
    (signal) => fetchWalletAttestations(signal),
    "reading your attested wallets",
  );
  if (listWait.cancelled) {
    cancel("Nothing revoked.");
    return;
  }
  const wallets = listWait.result!;

  const lowerAddress = address.toLowerCase();
  let matches = wallets.filter((w) => w.address.toLowerCase() === lowerAddress);
  if (chainArg !== undefined) {
    matches = matches.filter((w) => w.chain === chainArg);
  }

  if (matches.length === 0) {
    console.log("");
    console.log("  No active attestation found for that address" +
      (chainArg ? ` on chain '${chainArg}'.` : "."));
    console.log("");
    return;
  }

  // Same address attested under more than one chain and no --chain given:
  // ask which, one at a time, rather than guessing or revoking every chain
  // silently. A member who genuinely wants all of them re-runs per chain,
  // or answers each prompt; silent multi-revoke on a bare address is the
  // wrong default for a destructive action with no undo.
  let targets = matches;
  if (targets.length > 1) {
    console.log("");
    console.log(`  '${address}' is attested on ${targets.length} chains:`);
    for (const w of targets) console.log(`    - ${w.chain}`);
    console.log("");
    const chosen = await pickOne({
      message: "Revoke which one?",
      options: [
        ...targets.map((w) => ({ value: w.chain, label: w.chain })),
        { value: "__all__", label: "All of the above" },
        BACK_OPTION,
      ],
    });
    if (isBack(chosen)) {
      cancel("Nothing revoked.");
      return;
    }
    if (chosen !== "__all__") {
      targets = targets.filter((w) => w.chain === chosen);
    }
  }

  const confirmed = await confirmYesNo({
    message:
      targets.length === 1
        ? `Revoke the '${targets[0].chain}' attestation for ${address}? This cannot be undone from this session.`
        : `Revoke ${targets.length} attestations for ${address}? This cannot be undone from this session.`,
  });
  if (!confirmed) {
    cancel("Nothing revoked.");
    return;
  }

  for (const w of targets) {
    const revokeWait = await withLoadingCancel(
      (signal) => revokeWalletAttestation(address, w.chain, signal),
      `revoking (${w.chain})`,
    );
    if (revokeWait.cancelled) {
      console.log("");
      console.log(
        `  Cancelled partway through. Run 'alter wallet revoke ${address}' again to check what's left.`,
      );
      console.log("");
      return;
    }
  }

  console.log("");
  console.log(
    targets.length === 1
      ? "  Attestation revoked."
      : `  ${targets.length} attestations revoked.`,
  );
  console.log("");
}

async function clearCryptoWallet(signal?: AbortSignal): Promise<WalletInfo> {
  const resp = await apiCall("/api/v1/members/me/wallet", {
    method: "DELETE",
    signal,
  });
  if (!resp) throw new Error("not logged in. Run 'alter login' first.");
  if (resp.status === 403) {
    const body = (await resp.json().catch(() => ({}))) as { detail?: string };
    throw new Error(
      body.detail ?? "wallet clear requires engagement level 3 or higher.",
    );
  }
  if (!resp.ok) {
    const body = (await resp.json().catch(() => ({}))) as { detail?: string };
    throw new Error(
      body.detail ?? `clear failed (${resp.status} ${resp.statusText}).`,
    );
  }
  return normaliseWalletInfo((await resp.json()) as WalletInfo);
}

async function fetchPayoutAccount(
  signal?: AbortSignal,
): Promise<PayoutAccount | null> {
  const resp = await apiCall("/api/v1/members/me/payout-account", { signal });
  if (!resp) return null;
  if (resp.status === 403 || resp.status === 404) {
    return { has_account: false };
  }
  if (!resp.ok) return null;
  return (await resp.json()) as PayoutAccount;
}

async function setupPayoutAccount(
  country: string,
  signal?: AbortSignal,
): Promise<PayoutAccount> {
  const resp = await apiCall("/api/v1/members/me/payout-account", {
    method: "POST",
    body: {
      country,
      return_url: CLI_RETURN_URL,
      refresh_url: CLI_REFRESH_URL,
    },
    signal,
  });
  if (!resp) throw new Error("not logged in. Run 'alter login' first.");
  if (resp.status === 403) {
    const body = (await resp.json().catch(() => ({}))) as { detail?: string };
    throw new Error(
      body.detail ??
        "Stripe payout setup requires engagement level 3 or higher.",
    );
  }
  if (!resp.ok) {
    const body = (await resp.json().catch(() => ({}))) as { detail?: string };
    throw new Error(
      body.detail ?? `payout setup failed: ${resp.status} ${resp.statusText}`,
    );
  }
  return (await resp.json()) as PayoutAccount;
}

async function withdrawFiat(
  amountCents: number,
  signal?: AbortSignal,
): Promise<WithdrawResponse> {
  const resp = await apiCall(
    "/api/v1/members/me/payout-account/withdraw",
    {
      method: "POST",
      body: { amount_cents: amountCents },
      signal,
    },
  );
  if (!resp) throw new Error("not logged in. Run 'alter login' first.");
  if (resp.status === 409) {
    // On-chain-first rail precedence - payments routed direct to EVM wallet.
    const body = (await resp.json().catch(() => ({}))) as { detail?: string };
    throw new Error(
      body.detail ??
        "Withdrawal rejected: an active crypto wallet is registered, so " +
          "earnings already routed on-chain at payment time. Run 'alter wallet " +
          "clear --crypto' if you want to switch to fiat payouts.",
    );
  }
  if (resp.status === 403) {
    const body = (await resp.json().catch(() => ({}))) as { detail?: string };
    throw new Error(
      body.detail ?? "withdrawal requires engagement level 3 or higher.",
    );
  }
  if (resp.status === 422) {
    const body = (await resp.json().catch(() => ({}))) as { detail?: string };
    throw new Error(body.detail ?? "invalid withdrawal request.");
  }
  if (!resp.ok) {
    const body = (await resp.json().catch(() => ({}))) as { detail?: string };
    throw new Error(
      body.detail ?? `withdrawal failed: ${resp.status} ${resp.statusText}`,
    );
  }
  return (await resp.json()) as WithdrawResponse;
}

async function fetchBalance(
  signal?: AbortSignal,
): Promise<BalanceResponse | null> {
  const resp = await apiCall("/api/v1/members/me/earnings/balance", { signal });
  if (!resp) throw new Error("not logged in. Run 'alter login' first.");
  if (resp.status === 401 || resp.status === 403) {
    throw new Error(
      "Identity Income requires engagement level 3 (L3) or higher. " +
        "Run 'alter login' to check your session.",
    );
  }
  if (!resp.ok) {
    throw new Error(
      `could not fetch balance (${resp.status} ${resp.statusText}).`,
    );
  }
  return (await resp.json()) as BalanceResponse;
}

// ─── Renderers ─────────────────────────────────────────────────────────

function renderRailStatus(
  crypto: WalletInfo | null,
  fiat: PayoutAccount | null,
): void {
  console.log("");
  console.log("  Identity Income payouts");
  console.log("  =======================");

  const cryptoActive =
    crypto && crypto.status && crypto.status !== "not_registered";
  const fiatActive = fiat && fiat.has_account && fiat.payouts_enabled;
  const fiatPending =
    fiat && fiat.has_account && !fiat.payouts_enabled;

  if (!cryptoActive && !fiatActive && !fiatPending) {
    console.log("  Status:         No payout method registered yet");
    console.log("");
    console.log("  Earnings accumulate until you set up a payout method.");
    console.log("  Run 'alter wallet register' to begin.");
    console.log("");
    return;
  }

  if (cryptoActive) {
    console.log("  Crypto rail:    Registered (on-chain settlement pending)");
    if (crypto?.address) console.log(`  Address:        ${crypto.address}`);
    if (crypto?.registered_at)
      console.log(`  Registered:     ${crypto.registered_at}`);
    console.log("");
    // Honest posture: the address is on file, but on-chain settlement isn't
    // live yet (AlterRouter is mock by default). Earnings accrue to the
    // ledger and settle to this address once it goes live.
    console.log("  On-chain settlement isn't live yet. Earnings accrue to your");
    console.log("  ledger and will settle to this address once it goes live.");
    console.log("");
    console.log("  To turn settled USDC into cash via a licensed provider:");
    console.log("    alter cash-out");
    console.log("");
  }

  if (fiatActive) {
    console.log(
      `  ${cryptoActive ? "Backup rail:    " : "Active rail:    "}Bank account (Stripe Connect)`,
    );
    console.log(`  Stripe account: ${fiat?.account_id ?? ""}`);
    console.log(`  Payouts ready:  yes`);
    if (cryptoActive) {
      console.log("  (Crypto rail takes precedence)");
    } else {
      console.log("");
      console.log("  Earnings accumulate. Run 'alter wallet withdraw' to");
      console.log("  transfer to your bank/card.");
    }
    console.log("");
  } else if (fiatPending) {
    console.log("  Bank rail:      Setup incomplete");
    console.log(`  Stripe account: ${fiat?.account_id ?? ""}`);
    if (FIAT_RAIL_LIVE) {
      console.log("  Run 'alter wallet register --bank' to finish setup.");
    } else {
      // Truthful about the existing account, but never point at a gated verb.
      console.log("  Bank payout is phase-gated; this account resumes when the");
      console.log("  non-custodial off-ramp opens in a later phase.");
    }
    console.log("");
  }
}

// ─── Interactive flows ─────────────────────────────────────────────────

async function registerInteractive(): Promise<void> {
  // One live rail today. No picker - go straight to the wallet entry,
  // with one line saying where the bank option went.
  if (!FIAT_RAIL_LIVE) {
    console.log("");
    console.log("  Payout settles on-chain to a wallet you control. A bank");
    console.log("  off-ramp arrives in a later phase.");
    console.log("");
    await registerCryptoInteractive();
    return;
  }

  const choice = await pickOne({
    message: "How do you want to receive Identity Income?",
    options: [
      {
        value: "crypto",
        label: "Crypto wallet  (EVM address - on-chain settlement pending)",
        hint: "Bring your own EOA or smart account. Settles on-chain once live.",
      },
      {
        value: "bank",
        label: "Bank account / debit card  (via Stripe)",
        hint: "No crypto required.",
      },
      BACK_OPTION,
    ],
  });
  if (isBack(choice)) {
    cancel("Nothing registered.");
    return;
  }

  if (choice === "bank") {
    await registerBankInteractive();
  } else {
    await registerCryptoInteractive();
  }
}

async function registerBankInteractive(): Promise<void> {
  const country = await text({
    message: "Country for the bank account (ISO 3166-1 alpha-2)",
    placeholder: "AU",
    initialValue: "AU",
    validate: (v) => {
      if (!v || v.trim().length === 0) return "Required.";
      if (!/^[A-Za-z]{2}$/.test(v.trim()))
        return "Must be a 2-letter country code (e.g. AU, US, GB).";
      return;
    },
  });
  if (isCancel(country)) {
    cancel("Nothing registered.");
    return;
  }

  // Give the in-flight Stripe call a visible, cancellable state so the rail
  // selection never blanks while the request is outstanding. esc aborts the
  // in-flight call itself; a thrown error carries the human message from
  // setupPayoutAccount and is rendered by the menu's outer catch.
  const setupWait = await withLoadingCancel(
    (signal) => setupPayoutAccount(String(country).toUpperCase(), signal),
    "setting up bank payout",
  );
  if (setupWait.cancelled) {
    cancel("Cancelled. Run 'alter wallet' to check whether the account was created.");
    return;
  }
  const account: PayoutAccount = setupWait.result!;

  if (account.payouts_enabled && account.details_submitted) {
    console.log("");
    console.log("  Bank payout setup already complete - nothing more to do.");
    console.log(`  Stripe account: ${account.account_id ?? ""}`);
    console.log("");
    return;
  }

  if (!account.onboarding_url) {
    throw new Error(
      "Stripe did not return a setup URL. Try again, or contact support.",
    );
  }

  console.log("");
  console.log("  Opening Stripe Connect setup in your browser...");
  console.log("");
  console.log("  If the browser doesn't open, visit:");
  console.log(`  ${account.onboarding_url}`);
  console.log("");
  try {
    openBrowser(account.onboarding_url);
  } catch {
    // openBrowser already prints the URL via the catch block above.
  }
  console.log("  Complete the Stripe form, then return here and run");
  console.log("  'alter wallet' to confirm payouts are ready.");
  console.log("");
  // Re-entry path: closing the browser tab before finishing is a
  // common failure mode (audit blocker #3). Surface the resume command
  // up front so the user doesn't have to guess that the same verb is
  // idempotent - the backend's POST /payout-account returns a fresh
  // onboarding link for the existing in-flight Stripe account.
  console.log("  If the browser closes before you finish, run");
  console.log("  'alter wallet register --bank' again to resume. Stripe");
  console.log("  picks up the same account where you left off.");
  console.log("");
}

async function registerCryptoInteractive(): Promise<void> {
  // ── (1) Saved-state entry screen ──────────────────────────────────────
  // Read-only probe: cancellable, and a failure is non-fatal - proceed as
  // if no wallet is saved.
  const savedWait = await withLoadingCancel(
    (signal) => fetchWallet(signal).catch(() => null),
    "checking saved wallet",
  );
  if (savedWait.cancelled) {
    cancel("Nothing registered.");
    return;
  }
  const saved: WalletInfo | null = savedWait.result;

  const hasSaved =
    saved && saved.status && saved.status !== "not_registered" && saved.address;

  if (hasSaved) {
    console.log("");
    console.log("  Current payout wallet");
    console.log(`  Address: ${saved!.address}`);
    if (saved!.status) console.log(`  Status:  ${saved!.status}`);
    console.log("");

    const keepOrReplace = await pickOne({
      message: "A wallet is already registered. What do you want to do?",
      options: [
        {
          value: "keep",
          label: "Keep this wallet",
          hint: "No changes.",
        },
        {
          value: "replace",
          label: "Replace with a new wallet",
          hint: "Ownership signing required.",
        },
        BACK_OPTION,
      ],
    });
    if (isBack(keepOrReplace) || keepOrReplace === "keep") {
      cancel("No changes made.");
      return;
    }
    // replace: fall through to the address-entry flow below.
  } else {
    console.log("");
    console.log("  No payout wallet is set. Add an EVM address below.");
    console.log("");
  }

  // ── (2) Address entry ─────────────────────────────────────────────────
  const address = await textInput({
    message: "EVM wallet address for direct on-chain Identity Income",
    placeholder: "0x0000000000000000000000000000000000000000",
    validate: (v) => {
      if (!v || v.trim().length === 0) return "Required.";
      if (!isEvmAddress(v.trim())) return "Must be a 0x-prefixed 40-char hex address.";
      return undefined;
    },
  });
  if (address === null) {
    cancel("Nothing registered.");
    return;
  }
  const trimmedAddress = address.trim();

  // ── (3) Request challenge ─────────────────────────────────────────────
  const challengeWait = await withLoadingCancel(
    (signal) => requestAttestChallenge(trimmedAddress, signal),
    "requesting signing challenge",
  );
  if (challengeWait.cancelled) {
    cancel("Nothing registered.");
    return;
  }
  const challenge: AttestChallenge = challengeWait.result!;

  const nonce = (challenge.nonce ?? "") as string;
  // The verify body must echo the canonical message text the challenge
  // returned; the backend re-derives the signer from it and looks the nonce up
  // inside it. Without it the request fails validation before any signature is
  // checked, so an empty message here is a dead end worth naming now rather
  // than after the member has pasted a signature.
  const challengeMessage = typeof challenge.message === "string" ? challenge.message : "";
  if (!challengeMessage) {
    console.log("");
    console.log("  The signing challenge came back without a message to sign.");
    console.log("  Nothing was registered. Run 'alter wallet register' again.");
    console.log("");
    process.exitCode = 1;
    return;
  }

  // ── (4) Signing instructions ──────────────────────────────────────────
  console.log("");
  console.log("  Sign to prove you control this wallet.");
  console.log("");
  if (challenge.message) {
    console.log("  Message to sign:");
    console.log("");
    for (const line of String(challenge.message).split("\n")) {
      console.log(`    ${line}`);
    }
    console.log("");
  }
  console.log("  EOA (MetaMask, hardware wallet, cast):");
  console.log("    cast wallet sign --data \\");
  console.log(
    `      '${challenge.message ? JSON.stringify(challenge.message) : "<message-from-above>"}' \\`,
  );
  console.log("      --interactive");
  console.log("");
  console.log("  Safe / smart-contract wallet (EIP-1271):");
  console.log("    Sign with your Safe owners using your signer setup. The");
  console.log("    contract must support isValidSignature per EIP-1271.");
  console.log("");
  console.log("  Press esc to go back.");
  console.log("");

  // Non-interactive "press to continue" - we need an explicit continue
  // acknowledgement here so the user has time to run the sign command.
  // textInput with a custom message serves: esc goes back.
  const continueOrBack = await textInput({
    message: "Paste your 0x signature, or press esc to go back.",
    placeholder: "0x...",
    validate: (v) => {
      if (!v || v.trim().length === 0) return "Paste the 0x signature string.";
      if (!/^0x[a-fA-F0-9]+$/.test(v.trim())) return "Must be a 0x hex string.";
      return undefined;
    },
  });

  // ── (5) Signature entry - handled above in continueOrBack ─────────────
  if (continueOrBack === null) {
    cancel("Nothing registered.");
    return;
  }
  const signature = continueOrBack.trim();

  // ── (6) Verify ────────────────────────────────────────────────────────
  let verifyOk = false;
  let retryCount = 0;
  while (!verifyOk) {
    try {
      const verifyWait = await withLoadingCancel(
        (signal) =>
          verifyAttestation(trimmedAddress, signature, nonce, challengeMessage, signal),
        "verifying signature",
      );
      if (verifyWait.cancelled) {
        cancel("Nothing registered.");
        return;
      }
      // B1 fix: check the `verified` flag from the response body.
      // A 200 OK with verified:false means the backend accepted the request
      // but could not confirm ownership. Do NOT record this as verified.
      const attestResult = verifyWait.result;
      if (!attestResult || attestResult.verified !== true) {
        console.log("");
        console.log("  The address was submitted but the backend could not verify ownership.");
        console.log("  Your wallet has NOT been set as a payout address.");
        console.log("  Run 'alter wallet register' to try again with a fresh signature.");
        console.log("");
        process.exitCode = 1;
        return;
      }
      verifyOk = true;
    } catch (err) {
      console.log("");
      console.log(
        `  ${err instanceof Error ? err.message : String(err)}`,
      );
      console.log("");
      if (retryCount >= 2) {
        cancel("Verification failed. Run 'alter wallet register' to try again.");
        return;
      }
      retryCount++;
      const retry = await pickOne({
        message: "Signature did not verify. What do you want to do?",
        options: [
          { value: "retry", label: "Try a different signature" },
          { value: "restart", label: "Restart signing flow from address entry" },
          { value: "abort", label: "Cancel" },
          BACK_OPTION,
        ],
      });
      if (isBack(retry) || retry === "abort") {
        cancel("Nothing registered.");
        return;
      }
      if (retry === "restart") {
        // Re-enter from the top of this function: loop back to signing
        // instructions by re-running the whole function recursively once.
        await registerCryptoInteractive();
        return;
      }
      // retry: prompt for a new signature.
      const newSig = await textInput({
        message: "Paste your 0x signature.",
        placeholder: "0x...",
        validate: (v) => {
          if (!v || v.trim().length === 0) return "Paste the 0x signature string.";
          if (!/^0x[a-fA-F0-9]+$/.test(v.trim())) return "Must be a 0x hex string.";
          return undefined;
        },
      });
      if (newSig === null) {
        cancel("Nothing registered.");
        return;
      }
      // Loop again with the new signature - assign to outer binding via
      // the loop variable approach below.
      const retrySig = newSig.trim();
      try {
        const retryWait = await withLoadingCancel(
          (signal) =>
            verifyAttestation(trimmedAddress, retrySig, nonce, challengeMessage, signal),
          "verifying signature",
        );
        if (retryWait.cancelled) {
          cancel("Nothing registered.");
          return;
        }
        // B1 fix: same check as the primary path.
        const retryResult = retryWait.result;
        if (!retryResult || retryResult.verified !== true) {
          console.log("");
          console.log("  The address was submitted but the backend could not verify ownership.");
          console.log("  Your wallet has NOT been set as a payout address.");
          console.log("  Run 'alter wallet register' to try again with a fresh signature.");
          console.log("");
          process.exitCode = 1;
          return;
        }
        verifyOk = true;
      } catch (retryErr) {
        cancel(
          `Verification failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}. Run 'alter wallet register' to try again.`,
        );
        return;
      }
    }
  }

  // ── (7) Register ──────────────────────────────────────────────────────
  let info: WalletInfo;
  try {
    const registerWait = await withLoadingCancel(
      (signal) => registerCryptoWallet(trimmedAddress, signal),
      "registering payout wallet",
    );
    if (registerWait.cancelled) {
      cancel(
        "Cancelled. Run 'alter wallet' to check whether the address was registered.",
      );
      return;
    }
    info = registerWait.result!;
  } catch (err) {
    // 403 from the new attestation gate: explain and offer to re-attest.
    if (err instanceof Error && err.message.includes("403")) {
      console.log("");
      console.log("  Attestation missing or expired. The backend requires a fresh");
      console.log("  signed proof of ownership before registering a new address.");
      console.log("");
      const reAttest = await confirmYesNo({
        message: "Restart the signing flow?",
      });
      if (reAttest) {
        await registerCryptoInteractive();
        return;
      }
      cancel("Nothing registered.");
      return;
    }
    throw err;
  }

  console.log("");
  console.log("  Payout wallet registered.");
  if (info.address) console.log(`  Address: ${info.address}`);
  console.log("");
  printWalletWarnings(info);
  console.log("  Your address is on file. On-chain settlement isn't live yet,");
  console.log("  so earnings accrue to your ledger for now and will settle to");
  console.log("  this address once it goes live. Run 'alter earnings' to watch.");
  console.log("");
}

async function clearWalletFlow(): Promise<void> {
  const ok = await confirmYesNo({
    message:
      "Clear the registered crypto wallet? Future earnings will pause until you set a new payout (crypto or bank).",
  });
  if (!ok) {
    cancel("Aborted.");
    return;
  }
  const clearWait = await withLoadingCancel(
    (signal) => clearCryptoWallet(signal),
    "clearing wallet",
  );
  if (clearWait.cancelled) {
    cancel("Cancelled. Run 'alter wallet' to check whether the wallet was cleared.");
    return;
  }
  const info = clearWait.result!;
  console.log("");
  if (info.status === "not_registered") {
    console.log("  No active crypto wallet to clear.");
  } else {
    console.log("  Crypto wallet cleared.");
  }
  console.log("");
}

// ─── Withdraw flow ─────────────────────────────────────────────────────

async function withdrawFlow(amountArg: string | undefined): Promise<void> {
  const balanceWait = await withLoadingCancel(
    async (signal) => {
      const balance = await fetchBalance(signal);
      const fiat = await fetchPayoutAccount(signal);
      return { balance, fiat };
    },
    "checking balance",
  );
  if (balanceWait.cancelled) {
    cancel("Withdrawal cancelled.");
    return;
  }
  const { balance, fiat } = balanceWait.result!;

  if (!balance || balance.balance_cents <= 0) {
    console.log("");
    console.log(
      `  No funds to withdraw (balance: ${balance?.balance_display ?? "$0.00"}).`,
    );
    console.log("  Run 'alter earnings' to see activity.");
    console.log("");
    return;
  }
  if (!fiat || !fiat.has_account) {
    throw new Error(
      "no Stripe payout account on file. Run 'alter wallet register --bank' first.",
    );
  }
  if (!fiat.payouts_enabled) {
    throw new Error(
      "Stripe payout account is not yet enabled - setup likely incomplete. " +
        "Run 'alter wallet register --bank' to resume.",
    );
  }

  let amountCents: number;
  if (amountArg && /^\d+(\.\d{1,2})?$/.test(amountArg)) {
    amountCents = Math.round(parseFloat(amountArg) * 100);
  } else if (amountArg && amountArg === "all") {
    amountCents = balance.balance_cents;
  } else if (amountArg) {
    throw new Error(
      `invalid amount '${amountArg}'. Use a dollar value (e.g. 5.00) or 'all'.`,
    );
  } else {
    const ans = await text({
      message: `Withdraw how much? (balance: ${balance.balance_display}, type 'all' for full)`,
      placeholder: "all",
      validate: (v) => {
        if (!v || v.trim().length === 0) return "Required.";
        const trimmed = v.trim();
        if (trimmed === "all") return;
        if (!/^\d+(\.\d{1,2})?$/.test(trimmed))
          return "Use a dollar value (e.g. 5.00) or 'all'.";
        const cents = Math.round(parseFloat(trimmed) * 100);
        if (cents <= 0) return "Must be greater than zero.";
        if (cents > balance.balance_cents)
          return `Exceeds available balance (${balance.balance_display}).`;
        return;
      },
    });
    if (isCancel(ans)) {
      cancel("Withdrawal cancelled.");
      return;
    }
    const trimmed = String(ans).trim();
    amountCents =
      trimmed === "all"
        ? balance.balance_cents
        : Math.round(parseFloat(trimmed) * 100);
  }

  if (amountCents > balance.balance_cents) {
    throw new Error(
      `Requested ${formatDollars(amountCents)} exceeds balance ${balance.balance_display}.`,
    );
  }

  const ok = await confirmYesNo({
    message: `Withdraw ${formatDollars(amountCents)} to your bank/card?`,
  });
  if (!ok) {
    cancel("Aborted.");
    return;
  }

  // The in-flight withdrawal is the one network call in this flow with no
  // user-facing feedback. Left unguarded it paints nothing while the request
  // is in flight (a stalled backend reads as a frozen/black screen). Wrap it
  // in withLoadingCancel so the call always renders a cancellable status
  // line, and a try/catch so every failure mode (network, 4xx/5xx,
  // on-chain-precedence 409, payouts-not-enabled, insufficient balance)
  // prints a human message instead of blanking. esc aborts the in-flight
  // request; because a mutation may already have reached the server, the
  // cancel copy points at 'alter earnings' to confirm the outcome.
  let result: WithdrawResponse;
  try {
    const withdrawWait = await withLoadingCancel(
      (signal) => withdrawFiat(amountCents, signal),
      "processing withdrawal",
    );
    if (withdrawWait.cancelled) {
      console.log("");
      console.log("  Cancelled. If the request had already reached the server it");
      console.log("  may still complete - run 'alter earnings' to check.");
      console.log("");
      return;
    }
    result = withdrawWait.result!;
  } catch (err) {
    console.log("");
    console.log(
      `  ${err instanceof Error ? err.message : String(err)}`,
    );
    console.log("");
    console.log("  Your balance was not changed. Run 'alter wallet' to check");
    console.log("  your payout method, or 'alter earnings' to review activity.");
    console.log("");
    return;
  }

  console.log("");
  console.log(`  Amount:         ${formatDollars(result.amount_cents)}`);
  console.log(`  Status:         ${result.status}`);
  if (result.transfer_id) console.log(`  Transfer ID:    ${result.transfer_id}`);
  console.log(`  Balance after:  ${formatDollars(result.balance_after_cents)}`);
  console.log("");
  console.log("  Settlement times depend on your bank. Most arrive in 1-3");
  console.log("  business days.");
  console.log("");
}

// ─── Entry point ───────────────────────────────────────────────────────

function printHelp(): void {
  console.log(
    "Usage: alter wallet [subcommand] [flags]\n" +
      "\n" +
      "Manage Identity Income payouts. Income settles on-chain to a wallet\n" +
      "you control - funds are never held by Alter. A non-custodial bank\n" +
      "off-ramp arrives in a later phase.\n" +
      "\n" +
      "Subcommands:\n" +
      "  (no subcommand)              Show current payout method + status\n" +
      "  register                     Set your payout wallet (EVM address)\n" +
      "  register --crypto <0x...>    Same, with the address inline\n" +
      "  clear                        Clear the registered EVM address\n" +
      "  revoke <address>             Unbind an identity-attested wallet\n" +
      "  revoke <address> --chain <chain>   Same, chain disambiguated\n" +
      "\n" +
      "'revoke' is distinct from 'clear': clear only drops the payout\n" +
      "destination; revoke unbinds an identity attestation recorded via\n" +
      "signature (SIWE / Solana off-chain), independent of the payout rail.\n" +
      "\n" +
      "Earnings are licensing royalties for queries against your identity,\n" +
      "and accrue per query from the first query - payout setup never\n" +
      "blocks earning.\n",
  );
}

export async function wallet(args: string[]): Promise<void> {
  const sub = args[0];

  if (sub === "--help" || sub === "-h" || sub === "help") {
    printHelp();
    return;
  }

  if (!getSession()) {
    failNotLoggedIn();
    return;
  }

  // Reject unknown subcommands instead of silently falling through to the
  // no-subcommand status screen. A typo like `alter wallet withraw` ran
  // nothing while looking like it succeeded - the riskiest place for a
  // silent no-op is the payout surface.
  const KNOWN_SUBCOMMANDS = new Set(["register", "withdraw", "clear", "revoke"]);
  if (sub !== undefined && !KNOWN_SUBCOMMANDS.has(sub)) {
    console.error(
      `Unknown subcommand 'wallet ${sub}'. Run 'alter wallet --help' for usage.`,
    );
    process.exitCode = 1;
    return;
  }

  if (sub === "register") {
    const hasBank = args.includes("--bank");
    const hasCrypto = args.includes("--crypto");

    // A rail must be unambiguous. Passing both --bank and --crypto used to
    // silently win for --bank (it was checked first) and drop the address.
    if (hasBank && hasCrypto) {
      throw new Error(
        "choose one rail: pass either --bank or --crypto <0x...>, not both.",
      );
    }

    if (hasBank) {
      // Hard-gated today: the as-built Stripe path is custodial
      // (platform balance) and the launch posture ships no fiat rail.
      if (!FIAT_RAIL_LIVE) {
        throw new Error(fiatRailGateMessage());
      }
      await registerBankInteractive();
      return;
    }

    if (hasCrypto) {
      const idx = args.indexOf("--crypto");
      const addr = args[idx + 1];
      // An explicit address that fails validation is a user error - report it
      // up front. The prior code dropped to the interactive picker on a bad
      // address, which crashes with `uv_tty_init returned EBADF` in a non-TTY
      // shell (CI, pipes, the new-user audit harness).
      if (addr !== undefined && !addr.startsWith("-")) {
        if (!isEvmAddress(addr)) {
          throw new Error(
            `invalid wallet address '${addr}'. Must be a 0x-prefixed 40-char hex address.`,
          );
        }
        const wait = await withLoadingCancel(
          (signal) => registerCryptoWallet(addr.trim(), signal),
          "registering payout wallet",
        );
        if (wait.cancelled) {
          cancel("Cancelled. Run 'alter wallet' to check whether the address was registered.");
          return;
        }
        const info = wait.result!;
        console.log("");
        console.log("  Crypto rail registered.");
        if (info.address) console.log(`  Address: ${info.address}`);
        console.log("");
        printWalletWarnings(info);
        console.log("  On-chain settlement isn't live yet; earnings accrue to");
        console.log("  your ledger and settle to this address once it goes live.");
        console.log("");
        return;
      }
      // No address supplied after --crypto → interactive entry (real TTY).
      await registerCryptoInteractive();
      return;
    }

    // Bare positional address (legacy: `alter wallet register 0x...`).
    if (args[1] !== undefined && !args[1].startsWith("-")) {
      if (!isEvmAddress(args[1])) {
        throw new Error(
          `invalid wallet address '${args[1]}'. Must be a 0x-prefixed 40-char hex address.`,
        );
      }
      const wait = await withLoadingCancel(
        (signal) => registerCryptoWallet(args[1].trim(), signal),
        "registering payout wallet",
      );
      if (wait.cancelled) {
        cancel("Cancelled. Run 'alter wallet' to check whether the address was registered.");
        return;
      }
      const info = wait.result!;
      console.log("");
      console.log("  Crypto rail registered.");
      if (info.address) console.log(`  Address: ${info.address}`);
      console.log("");
      printWalletWarnings(info);
      console.log("  On-chain settlement isn't live yet; earnings accrue to");
      console.log("  your ledger and settle to this address once it goes live.");
      console.log("");
      return;
    }

    await registerInteractive();
    return;
  }

  if (sub === "withdraw") {
    // The withdraw flow is fiat-only (Stripe Transfer), so it gates with the
    // rail. The crypto rail needs no withdraw verb - settlement is per-query.
    if (!FIAT_RAIL_LIVE) {
      throw new Error(fiatRailGateMessage());
    }
    await withdrawFlow(args[1]);
    return;
  }

  if (sub === "clear") {
    await clearWalletFlow();
    return;
  }

  if (sub === "revoke") {
    const chainIdx = args.indexOf("--chain");
    const chainArg = chainIdx >= 0 ? args[chainIdx + 1] : undefined;
    await revokeAttestationFlow(args[1], chainArg);
    return;
  }

  // No subcommand - show status of both rails. Cancellable: a slow backend
  // must never strand the status screen behind two un-abortable fetches.
  const statusWait = await withLoadingCancel(
    (signal) =>
      Promise.all([
        fetchWallet(signal).catch(() => null),
        fetchPayoutAccount(signal).catch(() => null),
      ]),
    "loading payout status",
  );
  if (statusWait.cancelled) return;
  const [crypto, fiat] = statusWait.result!;
  renderRailStatus(crypto, fiat);

  const cryptoActive =
    crypto && crypto.status && crypto.status !== "not_registered";
  const fiatActive = fiat && fiat.has_account;
  if (!cryptoActive && !fiatActive) {
    const go = await confirmYesNo({ message: "Register a payout method now?" });
    if (!go) return;
    await registerInteractive();
  }
}
