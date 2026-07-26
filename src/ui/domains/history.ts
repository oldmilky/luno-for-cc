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

import type { HistoryService } from "../../services/history.js";
import type { Post } from "../messages.js";

export async function broadcastHistory(
  post: Post,
  history: HistoryService
): Promise<void> {
  const sessions = await history.list();
  post({ type: "historyList", sessions });
}
