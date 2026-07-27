// ─────────────────────────────────────────────────────────────
// What a conversation's state is called, and which state wins.
// Shared by the history list and the header so both surfaces
// name the same thing the same way.
// ─────────────────────────────────────────────────────────────

import type { ChatStatus } from "../../lib/rpc";

/**
 * One table so the six stay consistent as a set — six labels invented at six
 * call sites is how a vocabulary stops meaning anything.
 */
export const STATUS_LABEL: Record<ChatStatus, string> = {
  "needs-you": "needs you",
  working: "working",
  failed: "failed",
  interrupted: "interrupted",
  "no-reply": "no reply",
  done: "done"
};

/**
 * `working` seen from the header is not the same claim as `working` in the
 * list: there it means "this chat is mid-turn while you look at another one",
 * here it means text is arriving in front of you.
 */
export const HEADER_LABEL: Record<ChatStatus, string> = {
  ...STATUS_LABEL,
  working: "streaming"
};

interface LiveState {
  busy: boolean;
  awaitingApproval: boolean;
  errored: boolean;
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
 */
export function headerStatus({
  busy,
  awaitingApproval,
  errored,
  stored
}: LiveState): ChatStatus | null {
  if (awaitingApproval) return "needs-you";
  if (busy) return "working";
  if (errored) return "failed";
  return stored;
}
