/**
 * Neutral, jurisdiction-scoped registry of licensed third-party off-ramp
 * providers.
 *
 * Alter settles Identity Income on-chain to a wallet the member controls and
 * does not convert to fiat. When a member wants cash, they use a licensed
 * provider of their own choosing; Alter only points the way. This module holds
 * that pointer: a neutral, alphabetical list of providers per jurisdiction
 * plus each jurisdiction's own regulator register a member can use to check
 * a provider's standing themselves.
 *
 * Design invariants (each is a legal boundary, not a style choice):
 * - No fee, commission, spread, or referral cut in either direction.
 * - No partner API key, signed URL, or embedded widget. These are plain public
 *   links; the member completes KYC, quote, and sale entirely on the provider's
 *   own site, and Alter passes no address, amount, or identity data.
 * - Alphabetical order within each jurisdiction, no ranking, no default, no
 *   "recommended". Alter names providers as a convenience and endorses none.
 * Taking any of these on would make Alter a party to the exchange rather than a
 * referrer. Do not add a key, a fee, or a prefill without fresh legal review.
 *
 * Mirrors the backend's own cash-out provider registry; keep the two in sync.
 */

export interface OfframpProviderExclusion {
  /** The sub-jurisdiction (state, territory, region) the provider does not serve. */
  region: string;
  /** Why, in the provider's own words where possible. */
  reason: string;
}

export interface OfframpProvider {
  /** Display name. */
  name: string;
  /** Public landing URL on the provider's own domain. No partner key. */
  url: string;
  /** One-line factual note (assets, currency, payout), never a recommendation. */
  note?: string;
  /**
   * Sub-jurisdictions this provider does NOT serve within the jurisdiction it
   * otherwise covers (e.g. Kraken excludes Maine and New York within the
   * US). General field, not a US-only concern: any provider in any
   * jurisdiction may carry one.
   */
  excludedRegions?: OfframpProviderExclusion[];
}

export interface RegulatorRegister {
  /** The register's own name. */
  name: string;
  /** Public URL. */
  url: string;
  /** What kind of register this is (live search, weekly CSV, etc.), plainly. */
  note: string;
}

/** Jurisdictions this registry covers, alphabetical by code. */
export const JURISDICTIONS = ["AU", "EU", "UK", "US"] as const;
export type JurisdictionCode = (typeof JURISDICTIONS)[number];

export const JURISDICTION_LABELS: Record<JurisdictionCode, string> = {
  AU: "Australia",
  EU: "the EU/EEA",
  UK: "the United Kingdom",
  US: "the United States",
};

/**
 * Providers verified (against each provider's own pages, 2026-08) to sell
 * USDC on Base for the jurisdiction's local currency, paid to a bank account
 * in that jurisdiction (except where a provider's note says otherwise, e.g.
 * Transak's AU card-only payout). Alphabetical within each jurisdiction, no
 * ranking, no default.
 */
export const OFFRAMP_REGISTRY: Record<JurisdictionCode, OfframpProvider[]> = {
  AU: [
    {
      name: "Coinbase",
      url: "https://www.coinbase.com/en-au",
      note: "sell USDC on Base for AUD, withdraw to an Australian bank",
    },
    {
      name: "Independent Reserve",
      url: "https://www.independentreserve.com/sell/usdc",
      note: "sell USDC on Base for AUD by bank transfer or PayID",
    },
    {
      name: "Kraken",
      url: "https://www.kraken.com/en-au",
      note: "sell USDC on Base for AUD, withdraw to an Australian bank via Osko",
    },
    {
      name: "Transak",
      url: "https://transak.com/sell/usdc",
      note: "sell USDC on Base for AUD, payout to a Visa card only, no bank transfer",
    },
  ],
  EU: [
    {
      name: "Coinbase",
      url: "https://www.coinbase.com",
      note: "sell USDC on Base for EUR, withdraw to a SEPA account",
    },
    {
      name: "Kraken",
      url: "https://www.kraken.com",
      note: "sell USDC on Base for EUR, withdraw to a SEPA account",
    },
  ],
  UK: [
    {
      name: "Coinbase",
      url: "https://www.coinbase.com/en-gb",
      note: "sell USDC on Base for GBP, withdraw to a UK bank by Faster Payments",
    },
    {
      name: "Kraken",
      url: "https://www.kraken.com/en-gb",
      note: "sell USDC on Base for GBP, withdraw to a UK bank by Faster Payments",
    },
  ],
  US: [
    {
      name: "Coinbase",
      url: "https://www.coinbase.com",
      note: "sell USDC on Base for USD, withdraw to a US bank by ACH",
    },
    {
      name: "Gemini",
      url: "https://www.gemini.com",
      note: "sell USDC on Base for USD, withdraw to a US bank by ACH",
      excludedRegions: [
        {
          region: "Hawaii",
          reason:
            "sandbox-participant licence only, not a standing money-transmitter licence",
        },
        {
          region: "Tennessee",
          reason: "licence excludes virtual-currency transmission",
        },
      ],
    },
    {
      name: "Kraken",
      url: "https://www.kraken.com",
      note: "sell USDC on Base for USD, withdraw to a US bank by ACH",
      excludedRegions: [
        { region: "Maine", reason: "Kraken does not serve Maine residents" },
        { region: "New York", reason: "Kraken does not serve New York residents" },
      ],
    },
  ],
};

/**
 * Per-jurisdiction regulator register a member can use to check a
 * provider's standing themselves. These differ in kind across
 * jurisdictions (a live search vs. a self-reported federal layer vs. a
 * weekly CSV dump), so each carries its own note rather than being
 * presented as equivalent.
 */
export const REGULATOR_REGISTERS: Record<JurisdictionCode, RegulatorRegister> = {
  AU: {
    name: "AUSTRAC Digital Currency Exchange register",
    url: "https://www.austrac.gov.au/digital-currency-exchange-provider-registration-actions",
    note: "live, searchable register of AUSTRAC-registered digital currency exchange providers",
  },
  EU: {
    name: "ESMA CASP register",
    url: "https://www.esma.europa.eu/esmas-activities/digital-finance-and-innovation/markets-crypto-assets-regulation-mica",
    note:
      "not a live search: a set of downloadable CSV files, updated weekly, until it " +
      "is integrated into ESMA's own IT systems",
  },
  UK: {
    name: "FCA Financial Services Register",
    url: "https://register.fca.org.uk/s/search?predefined=CA",
    note: "live, searchable register of FCA-registered cryptoasset businesses",
  },
  US: {
    name: "FinCEN MSB Registrant Search",
    url: "https://msb.fincen.gov",
    note:
      "live, no-login federal register of money-services-business registrations; " +
      "self-reported by the registrant and federal-layer only (state money-transmitter " +
      "licensing is separate), and FinCEN's own page states inclusion is not a " +
      "recommendation, certification, or endorsement",
  },
};

// location_country carries inconsistent ISO2/ISO3 values across the
// codebase's own test fixtures ("AU" and "AUS" both appear), so resolution
// normalises both. EU covers the 27 EU member states plus Iceland,
// Liechtenstein and Norway (EEA), matching the EEA-wide reach both shipped
// EU providers publicly claim for themselves.
const AU_CODES = new Set(["AU", "AUS"]);
const US_CODES = new Set(["US", "USA"]);
const UK_CODES = new Set(["UK", "GB", "GBR"]);
const EU_EEA_ISO2 = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
  "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK",
  "SI", "ES", "SE", "IS", "LI", "NO",
]);
const EU_EEA_ISO3 = new Set([
  "AUT", "BEL", "BGR", "HRV", "CYP", "CZE", "DNK", "EST", "FIN", "FRA",
  "DEU", "GRC", "HUN", "IRL", "ITA", "LVA", "LTU", "LUX", "MLT", "NLD",
  "POL", "PRT", "ROU", "SVK", "SVN", "ESP", "SWE", "ISL", "LIE", "NOR",
]);

/**
 * Normalise a stored country value to a covered jurisdiction code. Returns
 * `null` when the country is unset or not one of the four jurisdictions this
 * registry covers; the caller then shows every jurisdiction rather than
 * guessing or defaulting to Australia.
 */
export function resolveJurisdiction(
  locationCountry: string | null | undefined,
): JurisdictionCode | null {
  if (!locationCountry) return null;
  const code = locationCountry.trim().toUpperCase();
  if (AU_CODES.has(code)) return "AU";
  if (US_CODES.has(code)) return "US";
  if (UK_CODES.has(code)) return "UK";
  if (EU_EEA_ISO2.has(code) || EU_EEA_ISO3.has(code)) return "EU";
  return null;
}

/**
 * The jurisdiction codes in play for a resolution, in the one order every
 * consumer must use: the member's own when it resolved, otherwise every
 * covered jurisdiction in ship order (AU, EU, UK, US).
 *
 * This is the single ordering source. The grouped view, the flat list, the
 * plain-text render and the picker all derive from it, so "the flat list
 * matches the grouped view" and "the picker matches what was printed" are
 * properties of construction rather than two lists kept in step by hand.
 */
export function jurisdictionCodesFor(
  jurisdiction: JurisdictionCode | null,
): JurisdictionCode[] {
  return jurisdiction ? [jurisdiction] : [...JURISDICTIONS];
}

/** Providers for a resolved jurisdiction, or every jurisdiction grouped when unresolved. */
export function providersFor(
  jurisdiction: JurisdictionCode | null,
): Partial<Record<JurisdictionCode, OfframpProvider[]>> {
  const out: Partial<Record<JurisdictionCode, OfframpProvider[]>> = {};
  for (const code of jurisdictionCodesFor(jurisdiction)) {
    out[code] = OFFRAMP_REGISTRY[code];
  }
  return out;
}

/** Regulator register(s) matching the same jurisdiction resolution as {@link providersFor}. */
export function regulatorRegistersFor(
  jurisdiction: JurisdictionCode | null,
): Partial<Record<JurisdictionCode, RegulatorRegister>> {
  const out: Partial<Record<JurisdictionCode, RegulatorRegister>> = {};
  for (const code of jurisdictionCodesFor(jurisdiction)) {
    out[code] = REGULATOR_REGISTERS[code];
  }
  return out;
}

/**
 * Every provider being shown, flattened, in the order they render. Rebuilt
 * from {@link jurisdictionCodesFor} rather than kept as a second source, so
 * it can never disagree with the grouped view.
 */
export function flatProvidersFor(
  jurisdiction: JurisdictionCode | null,
): OfframpProvider[] {
  return jurisdictionCodesFor(jurisdiction).flatMap(
    (code) => OFFRAMP_REGISTRY[code],
  );
}

/**
 * A provider paired with the jurisdiction it is being shown under. The
 * jurisdiction is not cosmetic here: Coinbase and Kraken each appear under
 * more than one jurisdiction with the SAME url, so the url alone is not a
 * unique key for a shown row and anything keyed on it collides.
 */
export interface ShownProvider {
  jurisdiction: JurisdictionCode;
  provider: OfframpProvider;
}

/** The shown providers with their jurisdiction attached, in render order. */
export function shownProvidersFor(
  jurisdiction: JurisdictionCode | null,
): ShownProvider[] {
  return jurisdictionCodesFor(jurisdiction).flatMap((code) =>
    OFFRAMP_REGISTRY[code].map((provider) => ({ jurisdiction: code, provider })),
  );
}
