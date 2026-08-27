/**
 * doctor/checks/pairing.ts -- connector and trait pipeline diagnostic checks.
 *
 * All checks are LIVE (network call to /api/v1/me/connections/status).
 * All checks are DIAGNOSE-ONLY -- doctor never mutates pairing state.
 *
 * Unauthenticated (no session / null apiCall return) -> WARN with
 * `alter login` remedy. The identity category owns FAIL on missing session.
 *
 * Response fields are sourced from the connections-status response shape.
 *
 * Australian English in comments; US English in identifiers.
 */

import { apiCall } from "../../auth.js";

import type {
  Check,
  CheckResult,
  DoctorCtx,
} from "../../lib/check-report.js";

// ---------------------------------------------------------------------------
// Response shape (mirrors the connections-status response verbatim)
// ---------------------------------------------------------------------------

interface ConnectionItem {
  platform: string;
  platform_username: string | null;
  connected_at: string | null;
  disconnected_at: string | null;
  profile_data_present: boolean;
  extracted_traits_count: number;
  extracted_trait_names: string[];
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

// ---------------------------------------------------------------------------
// Cached fetch helper (fetches once; each Check calls fetchStatus())
// ---------------------------------------------------------------------------

type StatusCacheEntry =
  | { ok: true; data: ConnectionsStatusResponse }
  | { ok: false; reason: "unauthenticated" | "error"; detail: string };

let _cache: StatusCacheEntry | null = null;
let _cacheTimeoutMs = 0;

/**
 * Fetch /api/v1/me/connections/status and cache the result for the
 * lifetime of the doctor run (identified by ctx.now + ctx.timeoutMs).
 * Cache is keyed on (ctx.now, ctx.timeoutMs) so a new DoctorCtx always
 * gets a fresh fetch.
 */
async function fetchStatus(
  ctx: DoctorCtx,
): Promise<StatusCacheEntry> {
  // Re-use if the ctx hasn't changed (same run).
  if (_cache !== null && _cacheTimeoutMs === ctx.timeoutMs) {
    return _cache;
  }

  let resp: Response | null;
  try {
    resp = await apiCall("/api/v1/me/connections/status", {
      timeoutMs: ctx.timeoutMs,
    });
  } catch (err) {
    const detail =
      err instanceof Error ? err.message : "network error";
    _cache = { ok: false, reason: "error", detail };
    _cacheTimeoutMs = ctx.timeoutMs;
    return _cache;
  }

  if (resp === null) {
    _cache = {
      ok: false,
      reason: "unauthenticated",
      detail: "no session on disk",
    };
    _cacheTimeoutMs = ctx.timeoutMs;
    return _cache;
  }

  if (resp.status === 401 || resp.status === 403) {
    _cache = {
      ok: false,
      reason: "unauthenticated",
      detail: `server returned ${resp.status}`,
    };
    _cacheTimeoutMs = ctx.timeoutMs;
    return _cache;
  }

  if (!resp.ok) {
    _cache = {
      ok: false,
      reason: "error",
      detail: `server returned ${resp.status} ${resp.statusText}`,
    };
    _cacheTimeoutMs = ctx.timeoutMs;
    return _cache;
  }

  let data: ConnectionsStatusResponse | null = null;
  try {
    data = (await resp.json()) as ConnectionsStatusResponse;
  } catch {
    _cache = {
      ok: false,
      reason: "error",
      detail: "malformed JSON response from backend",
    };
    _cacheTimeoutMs = ctx.timeoutMs;
    return _cache;
  }

  _cache = { ok: true, data };
  _cacheTimeoutMs = ctx.timeoutMs;
  return _cache;
}

// ---------------------------------------------------------------------------
// pairing.any-connector
// ---------------------------------------------------------------------------

const anyConnector: Check = {
  id: "pairing.any-connector",
  category: "pairing",
  label: "at least one connector paired",
  healClass: "DIAGNOSE-ONLY",
  live: true,
  async run(ctx: DoctorCtx): Promise<CheckResult> {
    const result = await fetchStatus(ctx);
    if (!result.ok) {
      if (result.reason === "unauthenticated") {
        return {
          status: "WARN",
          detail: `could not check connectors: ${result.detail}`,
          remedy: "run `alter login`",
        };
      }
      return {
        status: "WARN",
        detail: `could not reach connections endpoint: ${result.detail}`,
        remedy: "check network and try again",
      };
    }

    const { connections, summary } = result.data;
    if (!Array.isArray(connections) || summary.paired_count === 0) {
      return {
        status: "FAIL",
        detail: "no connectors paired",
        remedy: "run `alter pair <connector>` to add an identity source",
      };
    }
    return {
      status: "OK",
      detail: `${summary.paired_count} paired, ${summary.active_count} active`,
    };
  },
};

// ---------------------------------------------------------------------------
// pairing.profile-extracted
// ---------------------------------------------------------------------------

const profileExtracted: Check = {
  id: "pairing.profile-extracted",
  category: "pairing",
  label: "profile data extracted from at least one connector",
  healClass: "DIAGNOSE-ONLY",
  live: true,
  async run(ctx: DoctorCtx): Promise<CheckResult> {
    const result = await fetchStatus(ctx);
    if (!result.ok) {
      if (result.reason === "unauthenticated") {
        return {
          status: "WARN",
          detail: `could not check profile extraction: ${result.detail}`,
          remedy: "run `alter login`",
        };
      }
      return {
        status: "WARN",
        detail: `could not reach connections endpoint: ${result.detail}`,
        remedy: "check network and try again",
      };
    }

    const { connections } = result.data;
    if (!Array.isArray(connections) || connections.length === 0) {
      return {
        status: "WARN",
        detail: "no connectors paired; cannot check profile extraction",
        remedy: "run `alter pair <connector>` to add an identity source",
      };
    }

    const withProfile = connections.filter(
      (c) => c.profile_data_present === true,
    );
    if (withProfile.length === 0) {
      const platforms = connections.map((c) => c.platform).join(", ");
      return {
        status: "FAIL",
        detail: `profile data not yet extracted for any connector (${platforms})`,
        remedy:
          "wait for the extraction pipeline or re-run `alter pair <connector>` if the OAuth callback may have errored",
      };
    }
    return {
      status: "OK",
      detail: `${withProfile.length}/${connections.length} connector(s) have profile data`,
    };
  },
};

// ---------------------------------------------------------------------------
// pairing.traits-counted
// ---------------------------------------------------------------------------

const traitsCounted: Check = {
  id: "pairing.traits-counted",
  category: "pairing",
  label: "trait vector populated (count > 0)",
  healClass: "DIAGNOSE-ONLY",
  live: true,
  async run(ctx: DoctorCtx): Promise<CheckResult> {
    const result = await fetchStatus(ctx);
    if (!result.ok) {
      if (result.reason === "unauthenticated") {
        return {
          status: "WARN",
          detail: `could not check trait count: ${result.detail}`,
          remedy: "run `alter login`",
        };
      }
      return {
        status: "WARN",
        detail: `could not reach connections endpoint: ${result.detail}`,
        remedy: "check network and try again",
      };
    }

    const { connections, trait_vector: tv } = result.data;
    const hasPaired =
      Array.isArray(connections) && connections.length > 0;

    // The MERGED identity vector is the truth the member experiences -
    // status/portfolio/queries all read it. Judging only the per-connector
    // counts false-FAILed members whose vector was populated while an
    // individual connector showed 0 (e.g. github=0 with a 25-trait merged
    // vector).
    const mergedCount =
      tv && typeof tv.non_null_trait_count === "number"
        ? tv.non_null_trait_count
        : 0;
    const vectorExists = Boolean(tv && tv.exists);

    // Per-connector accounting, kept as secondary diagnostic detail.
    const totalExtracted = Array.isArray(connections)
      ? connections.reduce(
          (sum, c) =>
            sum +
            (typeof c.extracted_traits_count === "number"
              ? c.extracted_traits_count
              : 0),
          0,
        )
      : 0;

    if (vectorExists && mergedCount > 0) {
      return {
        status: "OK",
        detail:
          `identity vector populated (${mergedCount} trait(s))` +
          (totalExtracted > 0
            ? `; ${totalExtracted} via connectors`
            : "; connector counts still settling"),
      };
    }

    if (totalExtracted === 0) {
      if (!hasPaired) {
        return {
          status: "WARN",
          detail: "no connectors paired; trait extraction has not run",
          remedy: "run `alter pair <connector>` to add an identity source",
        };
      }
      return {
        status: "FAIL",
        detail:
          "connectors paired but no traits extracted yet (extraction pipeline may still be running)",
        // No `alter traits retrigger` command exists in the CLI (verified by grep).
        remedy:
          "wait for the extraction pipeline to complete, then re-run `alter doctor`",
      };
    }

    return {
      status: "OK",
      detail: `${totalExtracted} trait(s) extracted across all connectors`,
    };
  },
};

// ---------------------------------------------------------------------------
// pairing.vector-exists
// ---------------------------------------------------------------------------

const vectorExists: Check = {
  id: "pairing.vector-exists",
  category: "pairing",
  label: "identity vector exists",
  healClass: "DIAGNOSE-ONLY",
  live: true,
  async run(ctx: DoctorCtx): Promise<CheckResult> {
    const result = await fetchStatus(ctx);
    if (!result.ok) {
      if (result.reason === "unauthenticated") {
        return {
          status: "WARN",
          detail: `could not check identity vector: ${result.detail}`,
          remedy: "run `alter login`",
        };
      }
      return {
        status: "WARN",
        detail: `could not reach connections endpoint: ${result.detail}`,
        remedy: "check network and try again",
      };
    }

    const tv = result.data.trait_vector;
    if (!tv?.exists) {
      return {
        status: "FAIL",
        detail:
          "identity vector not yet computed (pair at least one connector to bootstrap)",
        remedy:
          "run `alter pair <connector>` to add an identity source; the vector is computed after extraction completes",
      };
    }
    const versionLabel =
      typeof tv.version === "number" ? ` (version ${tv.version})` : "";
    return {
      status: "OK",
      detail: `identity vector present${versionLabel}`,
    };
  },
};

// ---------------------------------------------------------------------------
// pairing.alignment-ready
// ---------------------------------------------------------------------------

const alignmentReady: Check = {
  id: "pairing.alignment-ready",
  category: "pairing",
  label: "identity vector has at least 3 non-null driver traits (alignment threshold)",
  healClass: "DIAGNOSE-ONLY",
  live: true,
  async run(ctx: DoctorCtx): Promise<CheckResult> {
    const result = await fetchStatus(ctx);
    if (!result.ok) {
      if (result.reason === "unauthenticated") {
        return {
          status: "WARN",
          detail: `could not check alignment readiness: ${result.detail}`,
          remedy: "run `alter login`",
        };
      }
      return {
        status: "WARN",
        detail: `could not reach connections endpoint: ${result.detail}`,
        remedy: "check network and try again",
      };
    }

    const { trait_vector: tv, summary } = result.data;

    if (!tv?.exists) {
      return {
        status: "WARN",
        detail: "identity vector not present; cannot evaluate alignment readiness",
        remedy:
          "run `alter pair <connector>` to add an identity source; the vector is computed after extraction completes",
      };
    }

    const nonNull =
      typeof tv.non_null_trait_count === "number"
        ? tv.non_null_trait_count
        : 0;

    if (nonNull < 3) {
      return {
        status: "FAIL",
        detail: `only ${nonNull} non-null trait(s) present; peer matching requires at least 3`,
        remedy:
          "pair more identity sources to build a richer trait profile (`alter pair <connector>`)",
      };
    }

    // Cross-check against the server-computed summary flag.
    const serverFlag = summary?.queryable_via_alter_alignment;
    if (serverFlag === false) {
      return {
        status: "WARN",
        detail:
          `${nonNull} non-null trait(s) found but server reports not yet queryable via alter_alignment`,
        remedy:
          "check `alter pair status` for pipeline detail; the vector may still be computing",
      };
    }

    return {
      status: "OK",
      detail: `${nonNull} non-null trait(s) -- alignment threshold met`,
    };
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const checks: Check[] = [
  anyConnector,
  profileExtracted,
  traitsCounted,
  vectorExists,
  alignmentReady,
];
