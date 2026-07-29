// ─────────────────────────────────────────────────────────────
// What a conversation's state is called, and which state wins.
// Shared by the history list and the header so both surfaces
// name the same thing the same way.
// ─────────────────────────────────────────────────────────────

import type { ChatStatus } from "../../lib/rpc";

/**
 * One table so the seven stay consistent as a set — seven labels invented at
 * seven call sites is how a vocabulary stops meaning anything.
 */
export const STATUS_LABEL: Record<ChatStatus, string> = {
  "needs-you": "needs you",
  working: "working",
  agents: "agents",
  failed: "failed",
  interrupted: "interrupted",
  "no-reply": "no reply",
  done: "done"
};

/**
 * `working` seen from the header is not the same claim as `working` in the
 * list: there it means "this chat is mid-turn while you look at another one",
 * here it means text is arriving in front of you.
 *
 * `agents` means the same thing on both, so it is spelt the same on both: the
 * model has finished and its background agents have not.
 */
export const HEADER_LABEL: Record<ChatStatus, string> = {
  ...STATUS_LABEL,
  working: "streaming"
};

interface LiveState {
  busy: boolean;
  awaitingApproval: boolean;
  errored: boolean;
  /** Background agents still running with no turn in flight. The process
   *  outlives the turn, so this outlives `busy`. */
  agentsRunning: boolean;
  /** What the host derived from the stored timeline, `null` before it says. */
  stored: ChatStatus | null;
}

/**
 * The state the header should show.
 *
 * Live state outranks the stored one because the webview learns it first: the
 * host's view arrives over `sessionMeta` a message later, and a header that
 * lagged the spinner beside it would be worse than no header at all.
 *
 * An approval outranks a running turn — the turn is running precisely because
 * nobody has answered yet, and the answer is the only thing that moves it.
 *
 * `agents` sits below the failure: how the turn ended is what the user has to
 * act on, and agents outliving it do not change that. It sits above `stored`
 * because the stored reading is of a timeline whose work has not finished.
 */
export function headerStatus({
  busy,
  awaitingApproval,
  errored,
  agentsRunning,
  stored
}: LiveState): ChatStatus | null {
  if (awaitingApproval) return "needs-you";
  if (busy) return "working";
  if (errored) return "failed";
  if (agentsRunning) return "agents";
  return stored;
}
