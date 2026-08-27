/**
 * `alter cash-out` - convert earned USDC to local-currency cash.
 *
 * Alter settles Identity Income on-chain to a wallet the member controls, and
 * stops there. Converting that USDC to fiat is the member's own act, done with
 * a licensed third-party provider of their choice. This command is pure
 * information plus a browser hand-off: it shows the member their own settlement
 * address and a neutral, alphabetical list of licensed off-ramp providers, then
 * opens the provider the member picks. Alter never holds the funds, never
 * converts on the member's behalf, never prefills a partner-keyed widget, and
 * takes no fee, commission, or spread on the conversion.
 *
 * The reason the list is neutral and the hand-off is a plain link (the member
 * enters their own address on the provider's own site) is legal, not
 * cosmetic: taking a per-conversion role, fee, or partner-key integration is
 * what would make Alter an intermediary in the exchange. It stays a referrer.
 */

import { getSession, failNotLoggedIn, apiCall } from "../auth.js";
import { pickOne, BACK_OPTION, isBack } from "../ui/picker.js";
import { openBrowser } from "../browser.js";
import {
  JurisdictionCode,
  JURISDICTION_LABELS,
  OfframpProvider,
  RegulatorRegister,
  REGULATOR_REGISTERS,
  ShownProvider,
  flatProvidersFor,
  providersFor,
  regulatorRegistersFor,
  resolveJurisdiction,
  shownProvidersFor,
} from "../lib/offramp.js";

interface WalletResp {
  status?: string;
  wallet_address?: string;
  address?: string;
}

interface MemberMeResp {
  profile?: { location_country?: string | null };
}

/**
 * The API reader both side-reads use. Injectable so the tests can drive the
 * three ways this surface used to lose the provider list - a null session, a
 * non-ok response, and a rejected fetch (DNS, reset, TLS, timeout) - without
 * a network or a live backend.
 */
type ApiCall = typeof apiCall;

/**
 * One diagnostic line on stderr for a read this command deliberately
 * swallowed. Off unless ALTER_DEBUG=1, and never stdout: the invariant on
 * this surface is that the member always gets the provider list, so a failed
 * side-read must not colour the output or contaminate `--json`.
 */
function debugSwallowed(what: string, err: unknown): void {
  if (process.env.ALTER_DEBUG !== "1") return;
  const detail = err instanceof Error ? err.message : String(err);
  console.error(`alter cash-out: ${what} failed, continuing without it: ${detail}`);
}

/**
 * The member's own on-chain settlement address, or null when no crypto wallet
 * is registered, when the read fails, or when it cannot be reached at all.
 *
 * Every failure resolves to null rather than throwing. A thrown error here
 * used to abort the whole command (index.ts's top-level catch sets exit 1),
 * which meant a transient wallet-read fault cost the member the entire
 * provider list. The backend twin catches the same fault, logs
 * `wallet_lookup_failed`, and still serves the list; this matches it. The
 * member is told no address is on file, which is what a null address means
 * to them either way, and the list is what they came for.
 */
async function fetchWalletAddress(
  call: ApiCall = apiCall,
): Promise<string | null> {
  try {
    const resp = await call("/api/v1/members/me/wallet");
    if (!resp || !resp.ok) {
      debugSwallowed(
        "payout wallet read",
        resp ? `${resp.status} ${resp.statusText}` : "no session",
      );
      return null;
    }
    const info = (await resp.json()) as WalletResp;
    if (!info.status || info.status === "not_registered") return null;
    return info.wallet_address ?? info.address ?? null;
  } catch (err) {
    debugSwallowed("payout wallet read", err);
    return null;
  }
}

/**
 * The member's own resolved jurisdiction, or null when their stored country
 * is unset or not one of the four jurisdictions this registry covers. A
 * failed, unreachable, or unauthenticated read resolves to null (show every
 * jurisdiction), never to a default of Australia.
 *
 * The try/catch is the whole point, not defensive padding: `apiCall` hands
 * back the raw `fetch` promise carrying an `AbortSignal.timeout`, and `fetch`
 * REJECTS on DNS failure, connection reset, TLS failure and timeout rather
 * than returning a non-ok Response. Without this, connectivity dropping
 * mid-command surfaced as a bare "The operation was aborted due to timeout"
 * and no provider list at all.
 */
async function fetchJurisdiction(
  call: ApiCall = apiCall,
): Promise<JurisdictionCode | null> {
  try {
    const resp = await call("/api/v1/members/me");
    if (!resp || !resp.ok) {
      debugSwallowed(
        "jurisdiction read",
        resp ? `${resp.status} ${resp.statusText}` : "no session",
      );
      return null;
    }
    const info = (await resp.json().catch(() => null)) as MemberMeResp | null;
    return resolveJurisdiction(info?.profile?.location_country ?? null);
  } catch (err) {
    debugSwallowed("jurisdiction read", err);
    return null;
  }
}

/**
 * The member-facing statement of what ~alter does and does not do with the
 * conversion. Mirrors the backend's own cash-out note builder sentence for
 * sentence, and is the
 * ONE source for this text on this surface: the plain-text render and the
 * `--json` payload both print exactly this. Three drifting copies of one
 * legal fact is the defect being closed here.
 */
function noteFor(jurisdiction: JurisdictionCode | null): string {
  const base =
    "~alter settles your Identity Income on-chain to a wallet you control " +
    "and does not convert it to fiat. To turn that USDC into cash, use a " +
    "licensed provider of your choice below: you send USDC from your own " +
    "wallet and the provider pays you. ~alter holds no funds, takes no fee, " +
    "and passes the provider no address, amount, or identity data.";
  if (jurisdiction) {
    return (
      base +
      ` The providers below are licensed to serve ${JURISDICTION_LABELS[jurisdiction]}; ` +
      "members elsewhere should pick a provider licensed where they live."
    );
  }
  return (
    base +
    " Your jurisdiction isn't on file, or isn't one this list covers yet, so " +
    "every jurisdiction ~alter has verified is listed below, grouped by " +
    "jurisdiction; pick a provider licensed where you live."
  );
}

/**
 * What the member does next. Mirrors the backend's `next_step`, and is
 * present on every path (there is always a next action, whether or not a
 * payout wallet is on file).
 */
function nextStepFor(address: string | null): string {
  if (address === null) {
    return (
      "No payout wallet is registered yet, so there is no address to cash " +
      "out from. Register the wallet you control first (alter wallet " +
      "register --crypto <0x...>); income accrues to your ledger meanwhile."
    );
  }
  return (
    "Pick a provider below and sell your USDC on its own site. You send " +
    "the USDC from the wallet you control and the provider pays you; " +
    "~alter is not a party to that sale and never sees it."
  );
}

/**
 * The `--json` payload. Mirrors the backend twin's shape key for key so an
 * agent reading one surface can read the other unchanged.
 *
 * `providers` is the FLAT list of the rows actually shown, in render order,
 * and is the original published contract; `providers_by_jurisdiction` is the
 * same rows grouped. `austrac_register` is DEPRECATED in favour of
 * `regulator_registers` and is kept as the bare AU register URL it has
 * always been, present on every response, so a client written against the
 * pre-jurisdiction shape cannot miss it or trip on a changed type.
 * `wallet_address`, `note` and `next_step` are likewise present on every
 * path, `wallet_address` null when no payout wallet is on file.
 */
function buildCashOutPayload(
  address: string | null,
  jurisdiction: JurisdictionCode | null,
): Record<string, unknown> {
  return {
    wallet_registered: address !== null,
    wallet_address: address,
    jurisdiction,
    providers: flatProvidersFor(jurisdiction),
    providers_by_jurisdiction: providersFor(jurisdiction),
    regulator_registers: regulatorRegistersFor(jurisdiction),
    austrac_register: REGULATOR_REGISTERS.AU.url,
    note: noteFor(jurisdiction),
    next_step: nextStepFor(address),
  };
}

function renderProviderLine(p: OfframpProvider): void {
  const note = p.note ? ` - ${p.note}` : "";
  console.log(`    ${p.name}${note}`);
  console.log(`      ${p.url}`);
  for (const excl of p.excludedRegions ?? []) {
    console.log(`      not available in ${excl.region}: ${excl.reason}`);
  }
}

function renderRegister(reg: RegulatorRegister): void {
  console.log(`    ${reg.name} (${reg.note}):`);
  console.log(`      ${reg.url}`);
}

function printHelp(): void {
  console.log(
    "Usage: alter cash-out\n" +
      "\n" +
      "Convert the USDC you earn to cash through a licensed provider you\n" +
      "choose. Alter settles your income on-chain to your own wallet and\n" +
      "never touches it again - converting to cash is yours to do, and this\n" +
      "command shows you where. Alter takes no fee and holds no funds.\n" +
      "\n" +
      "  --json    Print your address and the provider list as JSON.\n",
  );
}

/** Greedy word wrap. Local so the plain-text render owes nothing to the onboarding renderer. */
function wrapAt(text: string, width: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    if (cur === "") {
      cur = word;
    } else if (cur.length + 1 + word.length <= width) {
      cur += ` ${word}`;
    } else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur !== "") lines.push(cur);
  return lines;
}

function renderParagraph(text: string): void {
  for (const line of wrapAt(text, 66)) console.log(`  ${line}`);
}

/**
 * The plain-text render.
 *
 * The provider list is printed on EVERY path, including the no-wallet one.
 * On the money-out surface a blank result is the worst outcome there is:
 * worse than a stale list, worse than an over-broad one. A member with no
 * payout wallet still wants to know which licensed providers exist, and the
 * backend twin has always shipped them the list. The address block is what
 * varies, never the list.
 */
function renderList(
  address: string | null,
  jurisdiction: JurisdictionCode | null,
): void {
  const providers = providersFor(jurisdiction);
  const registers = regulatorRegistersFor(jurisdiction);

  console.log("");
  console.log("  Cash out your Identity Income");
  console.log("  ============================");
  console.log("");
  if (address) {
    console.log("  Your income settles on-chain to the wallet you control:");
    console.log(`    ${address}`);
  } else {
    renderParagraph(nextStepFor(null));
  }
  console.log("");
  renderParagraph(noteFor(jurisdiction));

  if (jurisdiction) {
    console.log("");
    console.log(
      `  Providers licensed for ${JURISDICTION_LABELS[jurisdiction]} (alphabetical, pick whichever suits you):`,
    );
    for (const p of providers[jurisdiction] ?? []) renderProviderLine(p);
  } else {
    for (const code of Object.keys(providers) as JurisdictionCode[]) {
      console.log("");
      console.log(`  ${JURISDICTION_LABELS[code]}:`);
      for (const p of providers[code] ?? []) renderProviderLine(p);
    }
  }
  console.log("");
  console.log("  Verify a provider's standing on its jurisdiction's own register:");
  for (const code of Object.keys(registers) as JurisdictionCode[]) {
    const reg = registers[code];
    if (reg) renderRegister(reg);
  }
  console.log("");
  if (address) {
    console.log(
      "  Tip: copy your address above and paste it into the provider as the",
    );
    console.log("  wallet you're selling from.");
    console.log("");
  }
}

/**
 * The picker rows, in the order {@link renderList} just printed them.
 *
 * Keyed on jurisdiction PLUS url, never url alone. Coinbase and Kraken each
 * appear under more than one jurisdiction on the same url, so a url-keyed
 * lookup resolves the first match rather than the row the member picked. The
 * label carries the jurisdiction in the grouped case for the same reason: a
 * bare "Coinbase" three times over is not a choice the member can make. The
 * hint carries the provider's own note, which differs by currency and payout
 * rail, rather than the url they all share.
 */
function pickerOptionsFor(
  jurisdiction: JurisdictionCode | null,
): { value: string; label: string; hint?: string }[] {
  const grouped = jurisdiction === null;
  return shownProvidersFor(jurisdiction).map(
    ({ jurisdiction: code, provider }) => ({
      value: providerKey(code, provider),
      label: grouped
        ? `${provider.name} - ${JURISDICTION_LABELS[code]}`
        : provider.name,
      hint: provider.note ?? provider.url,
    }),
  );
}

/** The unique key for a SHOWN provider row. A url alone is not unique across jurisdictions. */
function providerKey(
  code: JurisdictionCode,
  provider: OfframpProvider,
): string {
  return `${code}|${provider.url}`;
}

/** The shown row a picker value resolves to, or null when it matches nothing. */
function resolvePicked(
  jurisdiction: JurisdictionCode | null,
  value: string,
): ShownProvider | null {
  return (
    shownProvidersFor(jurisdiction).find(
      (row) => providerKey(row.jurisdiction, row.provider) === value,
    ) ?? null
  );
}

export async function cashOut(args: string[]): Promise<void> {
  if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    printHelp();
    return;
  }

  if (!getSession()) {
    failNotLoggedIn();
    return;
  }

  const jsonMode = args.includes("--json");

  // Concurrent and independently settled. These are two unrelated reads and
  // running them in series added a whole round-trip, up to 15 s of it on a
  // stalled connection, to a money-out command. `allSettled` is what makes
  // them independent: neither read's failure can take the other one out, and
  // both already resolve rather than reject, so a rejection here would mean
  // a fault below those handlers - which still must not cost the member the
  // list.
  const [walletResult, jurisdictionResult] = await Promise.allSettled([
    fetchWalletAddress(),
    fetchJurisdiction(),
  ]);
  const address =
    walletResult.status === "fulfilled" ? walletResult.value : null;
  const jurisdiction =
    jurisdictionResult.status === "fulfilled" ? jurisdictionResult.value : null;

  if (jsonMode) {
    console.log(JSON.stringify(buildCashOutPayload(address, jurisdiction), null, 2));
    return;
  }

  renderList(address, jurisdiction);

  // Offer to open a provider's own site. Purely a convenience launch of a
  // public URL; the member does everything (KYC, quote, sell) on the
  // provider's domain. No address or amount is passed by ~alter. The picker
  // rows come from the same ordering source renderList used, so the picker
  // always covers exactly what was just printed, in the same order.
  const options = pickerOptionsFor(jurisdiction);
  const choice = await pickOne({
    message: "Open a provider's site now?",
    options: [...options, BACK_OPTION],
  });
  if (isBack(choice)) return;
  const picked = resolvePicked(jurisdiction, choice as string);
  if (!picked) return;
  const provider = picked.provider;
  console.log("");
  console.log(`  Opening ${provider.name} in your browser...`);
  console.log(`  If it doesn't open, visit: ${provider.url}`);
  console.log("");
  openBrowser(provider.url);
}

// Test seam. Stripped from the published dist by scripts/strip-testing-exports.mjs
// (flat shorthand object, no nested braces - keep it that way).
export const __testing = {
  fetchWalletAddress,
  fetchJurisdiction,
  noteFor,
  nextStepFor,
  buildCashOutPayload,
  wrapAt,
  renderList,
  pickerOptionsFor,
  providerKey,
  resolvePicked,
};
