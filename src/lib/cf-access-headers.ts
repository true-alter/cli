/**
 * cf-access-headers - resolve extra outbound headers for MCP calls.
 *
 * Member path (api.truealter.com, bearer-first): only `X-Agent-Version-Hash`
 * is required. The optional service-token header pair is NOT required and is
 * never sent when its env vars are absent. Members never hold or paste a
 * service token; the member bearer JWT is the complete credential.
 *
 * Legacy path only (when ALTER_PUBLIC_MCP_ENDPOINT overrides to a gated
 * custom endpoint): an optional service-token header pair
 * (`CF-Access-Client-Id/Secret`) is admitted by that endpoint; members never
 * need it. Resolution order:
 *   1. `process.env.CF_ACCESS_CLIENT_ID` + `_SECRET` if both are set.
 *   2. `~/.config/alter/cf-access.env` parsed for the same pair.
 * Either source alone is ignored; both are required or no header pair is added.
 *
 * `X-Agent-Version-Hash` declares the non-stationary-agent identity gate.
 * Tools at trust-tier L4/L5 (`alter_message_grant`, `alter_message_send`,
 * `alter_alignment_grant`) reject the call without it. The value is derived
 * deterministically from the CLI release identifier so it is stable across
 * machines on the same `@truealter/cli` version.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type CfAccessHeaders = {
  "CF-Access-Client-Id": string;
  "CF-Access-Client-Secret": string;
};

export type McpExtraHeaders = Record<string, string>;

function activeCfAccessEnvFile(): string {
  const xdg =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdg, "alter", "cf-access.env");
}

function parseEnvFile(file: string): Map<string, string> {
  const map = new Map<string, string>();
  let content: string;
  try {
    content = fs.readFileSync(file, "utf-8");
  } catch {
    return map;
  }
  // Parse once into raw values, then resolve `${VAR}` / `$VAR`
  // references against the same file's earlier-declared entries. This
  // matches the shell-style cf-access.env layout, where the canonical bare
  // pair may be defined by expanding a namespaced alias, so the CLI reads
  // the same service-token value the bridges do.
  const raw = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) raw.set(key, value);
  }
  const expand = (input: string, seen: Set<string>): string => {
    return input.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, bare) => {
      const name = braced ?? bare;
      if (seen.has(name)) return "";
      const next = new Set(seen);
      next.add(name);
      const fromFile = raw.get(name);
      if (fromFile !== undefined) return expand(fromFile, next);
      const fromEnv = process.env[name];
      return fromEnv ?? "";
    });
  };
  for (const [key, value] of raw) {
    const resolved = expand(value, new Set([key]));
    if (resolved) map.set(key, resolved);
  }
  return map;
}

/**
 * Derive a stable `sha256:<32-hex>` agent-version-hash from the CLI
 * release identifier. The backend validates the format
 * (`algo:digest`, algo in sha256/384/512, digest >= 16 chars) and
 * stores it on the call's audit row + the agent-tracking Redis key.
 * The value MUST change when the binary changes - using the
 * `@truealter/cli` semantic version satisfies that for the npm
 * release channel; local-dev builds will share the version string of
 * the working tree, which is the right granularity for the
 * non-stationary-agent gate (it cares about deployed-code identity, not
 * filesystem mtime).
 */
export function getAgentVersionHash(cliVersion: string): string {
  const digest = crypto
    .createHash("sha256")
    .update(`@truealter/cli@${cliVersion}`)
    .digest("hex")
    .slice(0, 32);
  return `sha256:${digest}`;
}

/**
 * Resolve the full set of outbound headers for MCP calls: the
 * agent-version-hash (always present) plus the optional service-token pair
 * only when both env vars are set (a legacy opt-in for gated custom
 * endpoints; absent for standard member bearer-first paths).
 */
export function getMcpExtraHeaders(cliVersion: string): McpExtraHeaders {
  const headers: McpExtraHeaders = {
    "X-Agent-Version-Hash": getAgentVersionHash(cliVersion),
  };
  const cf = getCfAccessHeaders();
  if (cf) Object.assign(headers, cf);
  return headers;
}

/**
 * Find a namespaced service-token alias by shape. The canonical config
 * writes the bare pair; some hand-rolled configs only carry a namespaced
 * alias (`CF_ACCESS_<scope>_CLIENT_ID` / `_SECRET`). Matching by regex
 * rather than literal keeps any internal scope naming out of the published
 * artefact while preserving the fallback.
 */
function namespacedCfAlias(
  map: Map<string, string>,
  kind: "ID" | "SECRET",
): string | undefined {
  const re = new RegExp(`^CF_ACCESS_.+_CLIENT_${kind}$`);
  for (const [key, value] of map) {
    if (re.test(key) && value) return value;
  }
  return undefined;
}

export function getCfAccessHeaders(): CfAccessHeaders | undefined {
  const envId = process.env.CF_ACCESS_CLIENT_ID;
  const envSecret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (envId && envSecret) {
    return {
      "CF-Access-Client-Id": envId,
      "CF-Access-Client-Secret": envSecret,
    };
  }

  const fileMap = parseEnvFile(activeCfAccessEnvFile());
  // Prefer the canonical bare pair; fall back to any namespaced
  // `CF_ACCESS_<scope>_CLIENT_ID` / `_SECRET` alias the file may carry.
  // Matched by shape, not by literal name, so the published CLI ships no
  // internal service-token naming convention.
  const fileId =
    fileMap.get("CF_ACCESS_CLIENT_ID") ?? namespacedCfAlias(fileMap, "ID");
  const fileSecret =
    fileMap.get("CF_ACCESS_CLIENT_SECRET") ??
    namespacedCfAlias(fileMap, "SECRET");
  if (fileId && fileSecret) {
    return {
      "CF-Access-Client-Id": fileId,
      "CF-Access-Client-Secret": fileSecret,
    };
  }

  return undefined;
}
