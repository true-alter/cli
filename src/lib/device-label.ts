/**
 * device-label - derive a stable per-device label for member-key minting.
 *
 * Background. `POST /api/v1/auth/member-key` accepts an optional
 * `device_label` (max 64 chars). When supplied, the backend scopes the
 * implicit revoke to keys carrying the same label, so a desktop and a
 * phone can each hold an active member key concurrently instead of
 * clobbering one another every time the other logs in. Without a label
 * the singleton-per-user behaviour persists for legacy compatibility.
 *
 * The CLI ships its own scheme - `desktop-<short-hostname>` - so the
 * substrate stays self-describing: any operator inspecting member-key
 * rows can read provenance off the label without joining session.json.
 * Mobile and browser surfaces will use their own prefixes (`mobile-…`,
 * `web-…`) under the same convention.
 *
 * Sanitisation matters because the backend treats device_label as an
 * opaque string. We strip the FQDN to its first component (the hostname
 * itself never contains anything past `.`), restrict to ASCII
 * alphanumerics + `_-`, and cap the body so the final
 * `desktop-<short>` value comfortably fits the 64-char limit (8-char
 * prefix + 56-char body = 64).
 */

import * as os from "node:os";

export function deriveDeviceLabel(): string {
  const host = os.hostname() || "unknown";
  const shortHost = host
    .split(".")[0]
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 56);
  return `desktop-${shortHost || "unknown"}`;
}
