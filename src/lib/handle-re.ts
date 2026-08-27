/**
 * Canonical ~handle regex - shared module aligned to the backend pattern.
 *
 * Backend canonical: /^~[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/
 *
 * Accepts:
 *   - Single-character handles: ~a, ~1
 *   - Multi-character handles up to 32 chars total (1 tilde + 32 body chars)
 *   - Body chars: a-z, 0-9, hyphens (not leading or trailing)
 *
 * Rejects:
 *   - Handles with dots (backend does not accept dots in the ~handle namespace)
 *   - Leading/trailing hyphens in the body
 *   - Empty body or body longer than 32 chars
 *
 * This replaces the old /^~[a-z0-9][a-z0-9-]{1,31}$/ which rejected valid
 * single-character handles and was diverged from the backend.
 */

export const HANDLE_RE = /^~[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
