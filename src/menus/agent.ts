/**
 * "Agent" menu - interactive entry point for the inter-agent
 * communication substrate.
 *
 * By design: customisation goes
 * into the interactive menu with arrow-key picks; new top-level CLI
 * verbs are frozen. The `alter agent` namespace is the dispatcher for
 * agent-frame emission; this menu surfaces handover for guided
 * interactive use, and routes power-user flows to the CLI verb.
 *
 * Ships ONE pick:
 *   • Hand work over to a future session - emit an `agent_handover`
 *     frame onto the per-`~handle` DO SSE channel, retiring the
 *     `/tmp/handover-*.md` + `/go` fallback.
 *
 * Subsequent follow-up commits land advisory / broadcast /
 * lock kinds; this menu accretes picks as
 * the kinds land. Lock is advisory at the substrate, never enforced
 * server-side; a local filesystem lock is the enforcer.
 *
 * No `~handle` in any header/footer (locked CLI-chrome rule) - the action
 * header is set by the parent menu's `drawActionHeader`.
 */

import { text, isCancel } from "@clack/prompts";

import { agent } from "../commands/agent.js";
import { pickOne, BACK_OPTION, isBack } from "../ui/picker.js";
import { brand } from "../ui/biosMenu.js";

/**
 * Interactive entry point. Wired into the root menu when it
 * lands - until then, `alter agent handover` covers the power-user
 * scripted path and this surface stays available for guided use.
 *
 * Returns silently on cancel (Esc / Ctrl-C); errors raised by the
 * underlying verb propagate so the caller's flash banner can render
 * them per the existing menu error-surface pattern.
 */
export async function agentMenu(): Promise<void> {
  const choice = await pickOne({
    message: "Session handover: pass your work to another session",
    options: [
      {
        value: "handover",
        label: "Hand work over to a future session",
        hint: "Save your current work so another session can pick it up where you left off",
      },
      BACK_OPTION,
    ],
  });
  if (isBack(choice)) return;

  if (choice === "handover") {
    await handoverFlow();
    return;
  }
}

/**
 * Guided `agent handover` flow. Prompts for the three required
 * inputs (recipient handle, previous session id, handover body) plus
 * the optional next session id, then dispatches to the CLI verb so
 * the wire path is identical whether the user came via menu or via
 * `alter agent handover` directly.
 *
 * Self-fan-out: leaving the
 * recipient blank defaults to the sender's own handle so the user
 * can leave a handover for a future session of themselves. The
 * underlying verb resolves the default from `session.json`; this
 * menu just leaves --to off the argv when the prompt is empty.
 */
async function handoverFlow(): Promise<void> {
  process.stdout.write(
    "\n  " +
      brand.titleDim("Hand work over to a future session") +
      "\n" +
      "  " +
      brand.faint(
        "saved to your ~Alter account, not to this machine, so any future session can pick it up",
      ) +
      "\n\n",
  );

  const toRaw = await text({
    message: "Recipient handle (leave blank for self-fan-out)",
    placeholder: "~handle (or blank for yourself)",
  });
  if (isCancel(toRaw)) return;

  const previousSessionId = await text({
    message: "Previous session id (the session you're handing off from)",
    placeholder: "session-id or hash",
    validate: (v) =>
      v && v.trim().length > 0 ? undefined : "previous session id is required",
  });
  if (isCancel(previousSessionId)) return;

  const nextSessionIdRaw = await text({
    message: "Next session id (optional, leave blank when unknown)",
    placeholder: "session-id or blank",
  });
  if (isCancel(nextSessionIdRaw)) return;

  const handoverBody = await text({
    message: "Handover body (one paragraph: what the next session needs)",
    placeholder: "current state, next move, blockers",
    validate: (v) =>
      v && v.trim().length > 0 ? undefined : "handover body is required",
  });
  if (isCancel(handoverBody)) return;

  // Build the argv the CLI verb expects, then dispatch. Keeping the
  // wire path single-sourced means the menu can't drift from the
  // power-user verb's envelope shape.
  const argv: string[] = ["handover"];

  const toStr = String(toRaw).trim();
  if (toStr.length > 0) {
    argv.push("--to", toStr);
  }

  argv.push("--previous-session-id", String(previousSessionId).trim());

  const nextStr = String(nextSessionIdRaw).trim();
  if (nextStr.length > 0) {
    argv.push("--next-session-id", nextStr);
  }

  argv.push("--body", String(handoverBody));

  await agent(argv);
}
