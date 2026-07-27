// ─────────────────────────────────────────────────────────────
// Session history — listing past sessions for the drawer.
//
// Only the *listing* lives here. `loadHistorySession` stayed on the provider
// on purpose: loading a session is not a history operation, it is a session
// lifecycle one. It aborts the running turn, drops the orchestrator, clears
// checkpoints, rebuilds `session` and re-attaches its listeners — six pieces
// of provider state, none of them history's. Moving it here would have meant
// handing this module the whole provider back, which is the coupling the split
// exists to remove. It belongs with session lifecycle when that is extracted.
// ─────────────────────────────────────────────────────────────

import type { HistoryService, LiveStatus } from "../../services/history.js";
import type { Post } from "../messages.js";

/** What the registry can say about a session, when a conversation holds one. */
export interface LiveState {
  /** A turn in flight, or an approval nobody has answered. Undefined when the
   *  conversation is merely sitting there — then the stored status stands. */
  status?: LiveStatus;
}

/**
 * @param liveFor answers what a conversation on that session is doing, or
 *   nothing when none is open. Passed in because history is a file store and
 *   has no idea which chats are running — only the registry does.
 */
export async function broadcastHistory(
  post: Post,
  history: HistoryService,
  liveFor?: (id: string) => LiveState | undefined
): Promise<void> {
  const stored = await history.list();
  const sessions = liveFor
    ? stored.map((s) => {
        const live = liveFor(s.id);
        if (!live) return s;
        // A running turn outranks however the last one ended; an idle open
        // conversation does not, because "you have this open" is not a state
        // the conversation is in — that is what `open` carries.
        return { ...s, open: true, status: live.status ?? s.status };
      })
    : stored;
  post({ type: "historyList", sessions });
}
