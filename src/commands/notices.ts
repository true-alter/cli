/**
 * alter notices - read and dismiss in-Service legal/account notices.
 *
 * Menu-only entry under the Account zone (mirrors email.ts's convention:
 * not registered as a top-level CLI verb, the verb surface stays frozen).
 * This IS the served Terms section 14 "notice within the Service" channel
 * - a member reaches this row directly (Account > Notices), and it is
 * also where the session-start stderr ping (src/lib/session-notices.ts)
 * points a member who was told "N notices need your attention" from a
 * plain-verb command.
 *
 * Each notice is shown in full and the member picks Dismiss or Skip.
 * Dismiss POSTs to the server - that round trip is the notification
 * receipt, so a network failure here means the notice stays live and is
 * reported as such, never silently dropped.
 */

import { confirmYesNo } from "../ui/picker.js";
import { failNotLoggedIn, getSession } from "../auth.js";
import { withLoadingCancel } from "../ui/biosMenu.js";
import { shortDate } from "../lib/format-date.js";
import {
  dismissNotice,
  fetchActiveNotices,
  type SessionNotice,
} from "../lib/session-notices.js";

export async function notices(): Promise<void> {
  const session = getSession();
  if (!session) {
    failNotLoggedIn();
    return;
  }

  const fetchWait = await withLoadingCancel(
    () => fetchActiveNotices({ force: true }),
    "checking for notices",
  );
  if (fetchWait.cancelled) {
    console.log("Cancelled.");
    return;
  }
  const list: SessionNotice[] = fetchWait.result ?? [];

  console.log("");
  if (list.length === 0) {
    console.log("  No notices right now.");
    console.log("");
    return;
  }

  console.log(
    `  ${list.length} notice${list.length === 1 ? "" : "s"} about your ~Alter account.`,
  );
  console.log("");

  for (const notice of list) {
    console.log(`  ${notice.title}`);
    console.log(`  (${notice.kind} · v${notice.document_version} · ${shortDate(notice.published_at)})`);
    console.log("");
    for (const line of notice.body.split("\n")) {
      console.log(`  ${line}`);
    }
    console.log("");

    const dismiss = await confirmYesNo({
      message: "Dismiss this notice?",
      initialValue: true,
    });
    if (dismiss === null) {
      // Member quit the confirm-exit modal - stop working through the
      // list rather than force the remaining notices past them.
      return;
    }
    if (!dismiss) {
      console.log("  Left undismissed - it will show again next time.");
      console.log("");
      continue;
    }

    const dismissWait = await withLoadingCancel(
      () => dismissNotice(notice.id),
      "dismissing",
    );
    if (dismissWait.cancelled) {
      console.log("  Cancelled - not dismissed.");
      console.log("");
      continue;
    }
    if (dismissWait.result) {
      console.log("  Dismissed.");
    } else {
      console.log(
        "  Couldn't reach the server to dismiss this - it will show again next time.",
      );
    }
    console.log("");
  }
}
