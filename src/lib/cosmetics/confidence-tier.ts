/**
 * Shared confidence-to-tier label mapper.
 *
 * Tier-labels-only doctrine: members MUST NOT see numeric confidence
 * floats. This helper maps the assignment confidence returned
 * by /api/v1/members/me/style (and the overall_confidence from
 * /api/v1/me/connections/status) to a human-readable tier label.
 *
 * Tier thresholds align with the Exceptional / Established / Strong
 * vocabulary already used across the alter MCP protocol.
 *
 * Tier-label binding: this function MUST NOT return a percentage or numeric
 * value - only tier labels.
 */

/** Map a confidence float (0-1) to a tier label. */
export function confidenceTier(conf: number | null | undefined): string {
  if (conf === null || conf === undefined || Number.isNaN(conf)) {
    return "indeterminate";
  }
  if (conf >= 0.9) return "Exceptional";
  if (conf >= 0.7) return "Established";
  if (conf >= 0.5) return "Strong";
  return "building";
}
