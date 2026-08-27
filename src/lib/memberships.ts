/**
 * Org-membership fetch for the login-time session build.
 *
 * Memberships are authoritative server-side couplings, never inferred from the
 * login email's domain. The email domain is login identity and must NEVER seed
 * an org membership (a privacy-alias address would otherwise fabricate a bogus
 * org and overwrite the real coupling on every re-login). The backend's
 * `GET /api/v1/orgs/memberships` endpoint is the single source of truth:
 * it returns the member's confirmed couplings, and an empty list is a
 * legitimate, expected result (empty session.orgs[] is correct, never an
 * error).
 *
 * The helper is best-effort: a fetch failure NEVER blocks login. The login
 * path falls back to a same-account re-login's prior memberships (so a
 * transient outage does not blank a known coupling) or to [] for a fresh /
 * switched account.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { fetchWithRetry } from "./fetch-with-retry.js";
import type { OrgMembership } from "../auth.js";

/**
 * Wire shape of one membership row returned by
 * `GET /api/v1/orgs/memberships`. The org is addressed by its ~handle
 * (`org_handle`, e.g. "~example-org") with the bare domain alongside for
 * reference.
 */
export interface MembershipRecord {
  org_handle: string;
  org_domain: string;
  role: string;
  joined_at: string;
  status: string;
}

interface MembershipsResponse {
  memberships: MembershipRecord[];
}

/** Map the wire status/role to the session trust tier the badge renders. */
function tierForRole(role: string): OrgMembership["tier"] {
  // The badge's access-level label is derived from the role on the coupling.
  // founder / owner / admin run with the highest trust; everything else is an
  // observer until a richer server-side tier lands. This mirrors the legacy
  // login mapping so the rendered badge keeps its shape.
  switch (role) {
    case "founder":
    case "owner":
    case "admin":
    case "platform_admin":
      return "trusted";
    case "employer":
    case "operator":
    case "engineering":
      return "supervised";
    default:
      return "observer";
  }
}

/**
 * Map a wire membership record onto the session `OrgMembership` shape the
 * badge renders. The `domain` field is what whoami / status print as the org
 * identity, so the ~handle goes there (`org_handle`, e.g. "~example-org") to
 * make the badge read "~example-org", with the wire role preserved.
 */
export function toSessionOrg(record: MembershipRecord): OrgMembership {
  // Prefer the ~handle for the rendered identity; fall back to the bare
  // domain only when the server omits a handle.
  const identity = record.org_handle?.trim() || record.org_domain;
  return {
    domain: identity,
    role: record.role,
    tier: tierForRole(record.role),
  };
}

export interface FetchMembershipsOptions {
  api: string;
  /**
   * Session JWT (the access token minted at login), used as the Bearer
   * credential. The `GET /api/v1/orgs/memberships` endpoint authenticates via
   * the session JWT (`get_current_user`), NOT the member API key, so the JWT
   * is the only credential this call accepts. Passing the member key here gets
   * a 401, which silently blanks the badge.
   */
  jwt: string;
  /** Seam for tests: inject a fetch mock. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Fetch the member's confirmed org couplings from the backend and map them to
 * the session org shape. Returns [] on an empty membership list (a legitimate
 * 200) and THROWS on any transport / non-OK response so the caller can apply
 * its own graceful-degradation fallback (prior memberships or []). The login
 * path must never block on this call.
 */
export async function fetchMemberships(
  options: FetchMembershipsOptions,
): Promise<OrgMembership[]> {
  const { api, jwt } = options;
  const resp = await fetchWithRetry(
    `${api}/api/v1/orgs/memberships`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    },
    options.fetchImpl ? { fetchImpl: options.fetchImpl } : undefined,
  );

  if (!resp.ok) {
    throw new Error(
      `orgs/memberships responded ${resp.status} ${resp.statusText}`,
    );
  }

  const data = (await resp.json()) as MembershipsResponse;
  const rows = Array.isArray(data?.memberships) ? data.memberships : [];
  // Only active couplings render a badge; a revoked / pending row is not a
  // live membership.
  return rows
    .filter((r) => (r.status ?? "active") === "active")
    .map(toSessionOrg);
}

/** Wire shape of the daemon-written org cache (~/.cache/alter/orgs.json). */
interface OrgsCacheFile {
  refreshed_at?: string;
  memberships?: MembershipRecord[];
}

/**
 * Path to the org cache the alter-runtime daemon refreshes on a cadence.
 * Mirrors the daemon's `cache_dir()` (XDG_CACHE_HOME, default ~/.cache) so
 * both ends agree on the file location.
 */
function orgsCachePath(): string {
  const base = process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
  return join(base, "alter", "orgs.json");
}

/**
 * Resolve the org list to render, merging the daemon-refreshed cache over the
 * login-time seed so the badge updates WITHOUT a re-login.
 *
 * The alter-runtime daemon polls `GET /api/v1/orgs/memberships` on a cadence
 * and writes the result to `~/.cache/alter/orgs.json`. When that cache is
 * present and parseable it is AUTHORITATIVE: it reflects the member's current
 * couplings, including the empty case (a member who left every org gets an
 * empty list, which correctly clears the badge). When the cache is absent or
 * unreadable (daemon not running, or a fresh login before the first refresh
 * tick) we fall back to `seed`, the orgs captured in the session at login.
 *
 * LOCAL read only: a single synchronous file read, never a network call, so
 * it is safe on the statusline hot path (`whoami --json`). Any error degrades
 * to the seed and never throws.
 */
export function resolveEffectiveOrgs(seed: OrgMembership[]): OrgMembership[] {
  let raw: string;
  try {
    raw = readFileSync(orgsCachePath(), "utf8");
  } catch {
    return seed; // no cache file -> login-time seed
  }
  let cache: OrgsCacheFile;
  try {
    cache = JSON.parse(raw) as OrgsCacheFile;
  } catch {
    return seed; // corrupt cache -> seed, never throw on the hot path
  }
  if (!cache || !Array.isArray(cache.memberships)) {
    return seed;
  }
  // The cache (even empty) is authoritative when present.
  return cache.memberships
    .filter((r) => (r.status ?? "active") === "active")
    .map(toSessionOrg);
}
