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

/** Long enough to tell two chats apart, short enough to type after an `@`.
 *  The CLI's own cap is 200 characters — that is a limit, not a target. */
const NAME_MAX = 60;

/** Names that identify nothing. A chat is called one of these precisely when
 *  nobody has said what it is about yet. */
const PLACEHOLDERS = new Set(["untitled", "new chat"]);

/** This name reaches argv and another session's screen. A newline in it is a
 *  thing to strip here rather than to discover there. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]+/g;

/**
 * What this conversation is called *to the CLI* — `--name`, and the name every
 * other session addresses it by.
 *
 * Three jobs, and only the first was being served: `/resume` lists it in a
 * terminal, `/status` reports it, and since 2.1.224 it is the **address** a
 * peer session sends a message to. LUNO was passing `Session.title` raw, and
 * the session registry on this machine shows what that produced — `"/start
 * Привет"`, `"Hello"`, `"Untitled"`. A slash command is not what the chat is
 * about, and `Untitled` is not an identity.
 *
 * `undefined` means "say nothing", which is the useful answer rather than a
 * fallback: given no `--name` the CLI derives one from the working directory —
 * `luno-for-cc-3f` — and a derived name that says where the work is beats a
 * placeholder that says nothing. It also lets the CLI keep names distinct
 * itself, which it does by appending a variant when two sessions collide.
 *
 * @param userName what the user typed into the rename field, if anything. It
 *   wins outright: they have already answered the question this function is
 *   guessing at.
 */
export function cliSessionName(
  userName: string | undefined,
  derivedTitle: string | undefined
): string | undefined {
  const given = cleanName(userName);
  if (given) return given;
  return cleanName(stripLeadingCommand(derivedTitle ?? ""));
}

/**
 * Drop a slash command from the front of a derived title.
 *
 * `deriveTitle` reads the first prompt, and a prompt that opens with `/start`
 * or `/ship` names the command rather than the work. What follows it is the
 * part that says something; when nothing follows, the whole title goes and the
 * CLI derives a better one.
 */
function stripLeadingCommand(title: string): string {
  // The token must end at whitespace or at the end of the string, and carries
  // no slash of its own — otherwise `/etc/hosts is wrong` loses its first
  // segment and the chat is called `/hosts is wrong`.
  return title.replace(/^\/[a-zA-Z0-9:_-]+(?=\s|$)\s*/, "");
}

/** Collapsed, trimmed, capped on a word boundary — and empty for anything that
 *  identifies nothing. */
function cleanName(raw: string | undefined): string | undefined {
  // Control characters included: this reaches argv, and a name is not a place
  // to discover that something carried a newline.
  const flat = (raw ?? "")
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat || PLACEHOLDERS.has(flat.toLowerCase())) return undefined;
  if (flat.length <= NAME_MAX) return flat;
  const cut = flat.slice(0, NAME_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > NAME_MAX * 0.5 ? cut.slice(0, lastSpace) : cut).trim();
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
