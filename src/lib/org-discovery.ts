/**
 * Org Alter DNS discovery: shared by `alter org join` (org.ts) and the
 * login-time membership bootstrap (login.ts storeSession).
 *
 * Two record generations declare "this domain hosts an Org Alter", and both
 * are conformant per the ALTER MCP DNS-discovery record format:
 *
 *   1. `_org-alter.<domain>` TXT: the Identity Bootstrap record
 *      (`v=oa…`). The record format incorporates these definitions by
 *      reference and keeps every existing `_org-alter` record conformant.
 *   2. `_alter.<domain>` TXT in the ORGANISATIONAL form (`v=alter1` carrying
 *      an `org=` field): the original ALTER Identity DNS Protocol record
 *      ("the identity equivalent of an MX record"); truealter.com publishes
 *      this form today. The record format reuses the `_alter.` label for the
 *      per-handle Envelope Publication record (REQUIRED `h=` field), so an
 *      envelope record at the same label is NOT an organisational
 *      declaration and is rejected here (presence of `h=` / absence of
 *      `org=`).
 *
 * Field-level parsing + signature verification remain the worker's job on
 * first handshake; discovery only confirms the domain publishes a
 * recognisable organisational record.
 */

import { promises as dnsPromises } from "node:dns";

export interface OrgDiscovery {
  /** DNS label the organisational record was found under. */
  label: "_org-alter" | "_alter";
  /** The matched TXT record value (multi-strings joined). */
  record: string;
}

/** Resolver seam: tests inject a stub; production uses a bounded resolver. */
export type ResolveTxt = (hostname: string) => Promise<string[][]>;

// Bounded resolver so callers on the login path can never hang on a dead
// nameserver: c-ares timeout per try, single try. `alter org join` shares
// the bound: a 3s ceiling is plenty for a TXT lookup and keeps the verb
// responsive on broken networks.
const boundedResolver = new dnsPromises.Resolver({ timeout: 3000, tries: 1 });
const defaultResolveTxt: ResolveTxt = (hostname) =>
  boundedResolver.resolveTxt(hostname);

/**
 * Query one TXT name, returning joined record values. Absence codes
 * (ENOTFOUND / ENODATA) mean "no record" and return []; every other error
 * (timeout, SERVFAIL, network down) is a lookup FAILURE, not proof of
 * absence, and is rethrown for the caller to surface or swallow.
 */
async function queryTxt(
  resolveTxt: ResolveTxt,
  name: string,
): Promise<string[]> {
  try {
    const records = await resolveTxt(name);
    // Each TXT record arrives as an array of strings (multi-string
    // concatenation per RFC 1035): join before matching.
    return (records ?? []).map((rr) => rr.join(""));
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === "ENOTFOUND" || code === "ENODATA") return [];
    throw err;
  }
}

/** Key is present as a standalone `k=` pair (start-of-record or after `;`). */
function hasField(record: string, key: string): boolean {
  return new RegExp(`(^|;)\\s*${key}=`, "i").test(record);
}

/**
 * Discover whether `domain` hosts an Org Alter. Returns the matched label +
 * record, or null when neither generation is published. Throws on DNS
 * failure (as distinct from absence): see queryTxt.
 */
export async function discoverOrgAlter(
  domain: string,
  resolveTxt: ResolveTxt = defaultResolveTxt,
): Promise<OrgDiscovery | null> {
  // The two record generations are independent declarations: a lookup
  // failure on one label must not prevent checking the other. A domain that
  // publishes only the organisational `_alter` record (truealter.com does)
  // will see its non-existent `_org-alter` subdomain return ETIMEOUT under
  // the bounded resolver, and that timeout must not abort discovery before
  // the `_alter` label is queried. We try both, remember any failure, and
  // surface it only when NEITHER label yields a record, preserving queryTxt's
  // contract that a DNS failure is not proof of absence.
  let deferredErr: unknown;

  // 1. Spec-canonical identity-bootstrap label (the record format, `v=oa…`).
  try {
    const bootstrap = await queryTxt(resolveTxt, `_org-alter.${domain}`);
    const oa = bootstrap.find((r) => /(^|;)\s*v=oa/i.test(r));
    if (oa) return { label: "_org-alter", record: oa };
  } catch (err) {
    deferredErr = err;
  }

  // 2. Organisational `_alter.` record (v=alter1 + org=), never the
  //    per-handle envelope form (h=).
  try {
    const alter = await queryTxt(resolveTxt, `_alter.${domain}`);
    const orgRecord = alter.find(
      (r) =>
        /(^|;)\s*v=alter1\b/i.test(r) && hasField(r, "org") && !hasField(r, "h"),
    );
    if (orgRecord) return { label: "_alter", record: orgRecord };
  } catch (err) {
    deferredErr = err;
  }

  // Neither label yielded a record. Distinguish a broken-DNS failure from a
  // domain that simply is not a discoverable Org Alter: rethrow a real lookup
  // failure, otherwise report clean absence.
  if (deferredErr) throw deferredErr;
  return null;
}
