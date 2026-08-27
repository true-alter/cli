/**
 * messenger - public entry surface for the interactive Alter-to-Alter
 * messaging TUI.
 *
 * Three callers, one entry function:
 *
 *   `alter msg` / `alter room` / menu → openMessenger()
 *   `alter msg ~peer`                 → openMessenger({initialPeer: peer})
 *   menu → Room → Open                → openMessenger({initialPane: "presence"})
 *
 * The line-oriented verbs (`alter msg send|read|grant|revoke|thread|inbox`)
 * stay where they are in `src/commands/msg.ts` - this module is the
 * interactive surface only.
 */

export { openMessenger, type OpenMessengerOptions } from "./app.js";
export { stripUntrustedBody } from "./transport.js";
export {
  applyIncoming,
  applyOutbound,
  emptySnapshot,
  fuzzyMatch,
  formatAge,
  markConversationRead,
  toggleMessageRead,
  type MessengerSnapshot,
  type Conversation,
  type ThreadMessage,
  type Pane,
} from "./state.js";
