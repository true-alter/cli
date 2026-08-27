/**
 * client-headers - canonical X-Alter-* identity headers attached to every
 * backend HTTP call.
 *
 * Builds the client version-floor identity headers.
 *
 * Returns the four headers the server-side gate consults:
 *   - X-Alter-Client-Id      - always "alter-cli" for this binary.
 *   - X-Alter-Client-Version - package.json version, read once at module load.
 *   - X-Alter-Client-Channel - install-channel detection result.
 *   - X-Alter-Output-Format  - "json" when headless OR --output-format=json,
 *                              else omitted (default text).
 *
 * The channel value (closed enum: brew | aur | npm | binary | pipx |
 * scoop | winget | nix | unknown) flows directly into this header - the
 * backend already accepts the full set.
 *
 * Idempotent: callers can spread the returned object into any `headers`
 * literal; existing headers (Authorization, Content-Type) are NEVER touched.
 * The helper deliberately returns plain string fields rather than a
 * `Headers` instance because most callsites build header literals.
 *
 * NOT YET WIRED into every call site. Wiring this helper into the ~20
 * distributed HTTP callsites is a follow-on mechanical edit that ships
 * separately once we can integration-test against the real reject envelope.
 */

import { detectInstallChannel, type InstallChannel } from "./install-channel.js";
import { isHeadless } from "./output-format.js";
import { getCliVersion } from "./version.js";

export interface ClientHeaders {
  "X-Alter-Client-Id": string;
  "X-Alter-Client-Version": string;
  "X-Alter-Client-Channel": InstallChannel;
  "X-Alter-Output-Format"?: "json";
}

export interface ClientHeadersOpts {
  /** Override the channel detection (tests / CI). */
  channel?: InstallChannel;
  /** Force the output-format header on or off (tests / explicit caller). */
  outputFormat?: "json" | "text";
}

/**
 * Build the canonical X-Alter-* header bundle. Pure modulo
 * `detectInstallChannel()` and `isHeadless()` - both read `process.env`,
 * `process.platform`, and `process.execPath`.
 */
export function clientHeaders(opts?: ClientHeadersOpts): ClientHeaders {
  const channel = opts?.channel ?? detectInstallChannel();
  const headers: ClientHeaders = {
    "X-Alter-Client-Id": "alter-cli",
    "X-Alter-Client-Version": getCliVersion(),
    "X-Alter-Client-Channel": channel,
  };
  // Output-format header - explicit > heuristic.
  if (opts?.outputFormat === "json") {
    headers["X-Alter-Output-Format"] = "json";
  } else if (opts?.outputFormat === "text") {
    // explicit text → omit the header (default is text).
  } else if (isHeadless()) {
    headers["X-Alter-Output-Format"] = "json";
  }
  return headers;
}
