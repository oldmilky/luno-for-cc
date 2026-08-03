// ─────────────────────────────────────────────────────────────
// Strings a conversation shows or stores: a worktree's name, a compaction
// notice, a subagent's title, a token count in a notification.
//
// Pure, and lifted out of `conversation-host.ts` for that reason — none of it
// reads the class's state, so none of it needed to sit inside a 3200-line
// file to be found.
// ─────────────────────────────────────────────────────────────

import type { CompactionInfo, SubagentUpdate } from "../core/types.js";
import { isWorkflowTask } from "../core/types.js";

export function worktreeName(sessionId: string): string {
  return `luno-${sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8)}`;
}

/**
 * One line explaining what the fold cost.
 *
 * Says which way it was triggered because the two mean different things to the
 * user: one they asked for, the other happened to them and explains why the
 * agent no longer remembers the start of the conversation.
 */
export function compactionSummary(info: CompactionInfo | undefined): string {
  const how =
    info?.trigger === "auto"
      ? "The context filled up, so earlier messages were folded into a summary."
      : "Earlier messages were folded into a summary.";

  const { preTokens, postTokens } = info ?? {};
  if (typeof preTokens === "number" && typeof postTokens === "number") {
    return `${how} ${fmtTokens(preTokens)} → ${fmtTokens(postTokens)} tokens.`;
  }
  return how;
}

/**
 * What the card is called. The agent type is the useful half — "Explore",
 * "code-reviewer" — and it is what the user recognises from `.claude/agents/`.
 *
 * A workflow has no agent type to name, so it is called by its script's
 * `meta.name` instead. Without the branch every workflow rendered as the bare
 * word "Agent", which is both wrong and indistinguishable from the next one.
 */
export function subagentTitle(task: SubagentUpdate): string {
  if (isWorkflowTask(task.taskType)) {
    return task.workflowName ? `Workflow: ${task.workflowName}` : "Workflow";
  }
  return task.subagentType ? `Agent: ${task.subagentType}` : "Agent";
}

/**
 * Drop keys whose value is `undefined` so a later phase cannot erase what an
 * earlier one established.
 *
 * Spreading the raw update would: `task_updated` carries neither `toolUseId`
 * nor `description`, and object spread copies an explicit `undefined` over a
 * real value. The card would lose the agent it belongs to halfway through.
 */
export function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined)
  ) as Partial<T>;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/**
 * What a rewind's safety copy is called in the history list.
 *
 * Named rather than left to the derived title: the fork and the chat it came
 * from open with the same first prompt, so without this the list shows two rows
 * that read identically and the user has to open both to tell which is which.
 */
export function forkName(
  current: string | undefined,
  timeline: ReadonlyArray<{ kind: string }>
): string {
  const base = current ?? "Chat";
  const turns = timeline.filter((e) => e.kind === "user").length;
  return `${base} — before rewind (${turns} messages)`;
}

/** Strip stray slash prefixes and trailing whitespace from a captured selection. */
export function cleanSelection(raw: string): string {
  // Drop a leading line that is purely a slash command (e.g. "/explain").
  const lines = raw.split(/\r?\n/);
  if (lines.length && /^\s*\/\S/.test(lines[0]) && !lines[0].includes("//")) {
    lines.shift();
  }
  // Trim trailing blank lines but keep interior whitespace.
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.join("\n");
}
