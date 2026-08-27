/**
 * Humanise an ISO-8601 timestamp to "YYYY-MM-DD HH:MM" for member-facing
 * output. Returns "-" for null/empty and falls back to the raw string when
 * the value will not parse.
 *
 * Single source for the CLI's short-date rendering: pair-status, passkey
 * and discover all share this so member output never leaks raw
 * microseconds-and-offset ISO strings (e.g. 2026-04-25T12:00:54.830596+00:00).
 */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "-";
  try {
    return new Date(iso).toISOString().slice(0, 16).replace("T", " ");
  } catch {
    return iso;
  }
}
