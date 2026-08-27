/**
 * Closes the loop on the next-best-action projection `alter status` (and
 * the post-login flow) already render: when a previously-shown suggestion
 * is still pending, report what the member did next and clear it.
 *
 * Local state rides the existing per-handle-bound status-snapshot file
 * (`auth.ts` - `readStatusSnapshot` / `writeStatusSnapshot` /
 * `StatusSnapshot.pending_suggestion_id`); no new file, format, or config
 * key is introduced.
 *
 * Silent and best-effort throughout - this is a side channel and must
 * never change what a member sees, never block a render, and never retry.
 * Any failure (network, auth, missing local state, non-2xx) simply means
 * no report this time.
 */

import {
  apiCall,
  readStatusSnapshot,
  writeStatusSnapshot,
  type StatusSnapshot,
} from "../auth.js";
import type { NextBestAction } from "./next-best-action.js";

const REPORT_TIMEOUT_MS = 1500;

/**
 * The snapshot fields that record "a suggestion was just shown". Merge the
 * result into whatever `StatusSnapshot` object a caller is about to pass to
 * `writeStatusSnapshot`.
 */
export interface PendingSuggestionFields {
  pending_suggestion_id?: string;
  pending_suggestion_at?: string;
}

/**
 * Compute the pending-suggestion fields for the snapshot a caller is about
 * to write. `nba` is whatever was just rendered - callers pass the exact
 * value they gated their own render on (`if (nba) renderWhatNext(nba)`), so
 * this never fires on a suggestion the member didn't actually see. Returns
 * an empty object (no fields to merge) when there is nothing pending: no
 * projection, or one with no usable id.
 */
export function pendingSuggestionFields(
  nba: NextBestAction | null,
): PendingSuggestionFields {
  const id = nba?.primary_action.id;
  if (!id || id.length === 0) return {};
  return {
    pending_suggestion_id: id,
    pending_suggestion_at: new Date().toISOString(),
  };
}

/**
 * What the member did next, expressed in the backend's own action-id
 * vocabulary. The only signal available at a later checkpoint is a fresh
 * next-best-action projection: when the primary suggestion shown now still
 * matches what was pending, nothing has moved (null, "they did nothing").
 * When it differs, the new primary action id is reported as the observed
 * next step.
 */
export function resolveNextActionId(
  pendingId: string,
  freshNba: NextBestAction | null,
): string | null {
  const currentId = freshNba?.primary_action.id;
  if (!currentId || currentId === pendingId) return null;
  return currentId;
}

/**
 * Clear the pending marker, but only if it still names the id just
 * reported. A caller (`alter status`) may have already written a NEWER
 * pending suggestion (its own render) to the same snapshot between this
 * function's read and this write; in that case the newer marker is left
 * alone rather than clobbered. Best-effort: any failure here is silent,
 * same as everything else in this module.
 */
function clearIfStillPending(reportedId: string): void {
  try {
    const onDisk = readStatusSnapshot();
    if (!onDisk || onDisk.pending_suggestion_id !== reportedId) return;
    const { pending_suggestion_id, pending_suggestion_at, ...rest } = onDisk;
    writeStatusSnapshot(rest as StatusSnapshot);
  } catch {
    /* best-effort */
  }
}

/**
 * Best-effort: if `pendingId` names a still-pending suggestion (a caller
 * reads it from `readStatusSnapshot().pending_suggestion_id` BEFORE writing
 * any newer snapshot, and passes it straight through here - never re-read
 * internally, so this can never mistake a snapshot a caller just wrote for
 * itself), report it and clear the marker so a later checkpoint doesn't
 * report the same suggestion twice. Never throws, never retries. Returns
 * whether the report was actually sent and accepted - callers may ignore
 * the result; it exists for tests.
 */
export async function reportPendingSuggestion(
  pendingId: string | null | undefined,
  freshNba: NextBestAction | null,
): Promise<boolean> {
  if (!pendingId) return false;
  try {
    const resp = await apiCall("/api/v1/next-action/observation", {
      method: "POST",
      body: {
        suggestion_id: pendingId,
        next_action_id: resolveNextActionId(pendingId, freshNba),
        occurred_at: new Date().toISOString(),
      },
      timeoutMs: REPORT_TIMEOUT_MS,
    });
    const ok = !!resp && resp.ok;
    if (ok) clearIfStillPending(pendingId);
    return ok;
  } catch {
    return false;
  }
}
