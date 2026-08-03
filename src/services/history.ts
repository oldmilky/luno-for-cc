import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { Message, PermissionMode, TimelineEvent } from "../core/types.js";
import type { EffortLevel } from "../core/effort.js";

/**
 * Persists chat sessions under VS Code's per-extension globalStorage.
 * Each session is a single JSON file: {dir}/sessions/{sessionId}.json.
 * Saves are intentionally idempotent overwrites — we always rewrite the
 * whole session on each save call. Callers should debounce.
 */
export interface StoredSession {
  id: string;
  title: string;
  /**
   * A name the user gave this conversation, which wins over the derived title.
   *
   * `title` is re-derived from the first prompt on every read, so it cannot
   * hold one: the derivation would overwrite it. Running several chats at once
   * is what makes this worth having — "Bugs" and "Refactoring" are how the user
   * thinks about them, and the opening sentence of each is not.
   */
  name?: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  timeline: TimelineEvent[];
  /** Claude CLI session id used with `claude --resume`. Subscription-mode only. */
  resumeId?: string;
  /**
   * Absolute path of the workspace folder this conversation belongs to.
   *
   * Sessions live in globalStorage, which is shared across every project, so
   * without this the history list mixes chats from unrelated repositories.
   * Absent on sessions written before this field existed; those are treated as
   * belonging to no project rather than to all of them, which is what keeps the
   * list scoped instead of merely reordered.
   */
  workspaceRoot?: string;
  /**
   * The posture the conversation was running in — model, permission mode,
   * effort, extended thinking.
   *
   * Absent on sessions written before conversations carried their own settings.
   * A reader must fall back to the `luno.*` defaults rather than assume, which
   * is why every one of these is optional.
   */
  model?: string;
  permissionMode?: PermissionMode;
  effort?: EffortLevel;
  thinking?: boolean;
  /** The CLI's `ultracode` flag — xhigh plus standing workflow orchestration.
   *  Stored beside `effort` because the picker offers it as one more choice on
   *  the same control, even though the CLI keeps them apart. */
  ultracode?: boolean;
}

/** What a stored conversation was left in the middle of. Read off its
 *  timeline, so it holds for a chat nobody has open. */
export type StoredStatus =
  "done" | "interrupted" | "no-reply" | "failed" | "needs-you";

/**
 * What a conversation with a live process is doing. Only the registry knows
 * this, and it outranks the stored state — a turn actually running now says
 * more than however the last one ended.
 *
 * `needs-you` is in both sets on purpose: an unanswered plan question is
 * readable off the timeline, while an unanswered tool approval exists only
 * while the process that asked is still alive.
 *
 * `agents` is the state that only exists once the process outlives its turn:
 * the model has finished, background agents have not, and neither `working`
 * (nothing is streaming) nor the stored `done` is true of it.
 */
export type LiveStatus = "working" | "needs-you" | "agents";

/**
 * One status per chat, whether or not anything has it open.
 *
 * Deliberately one field rather than two: the row shows one word, and deciding
 * which word wins is domain logic that belongs where it can be tested, not in
 * the webview. Whether a chat is *open* is a separate fact — see
 * `HistoryEntry.open` — because "you are looking at it" and "it needs you" are
 * different questions and sharing a slot made both unreadable.
 */
export type ChatStatus = StoredStatus | LiveStatus;

export interface HistoryEntry {
  id: string;
  title: string;
  /** Whether the user named this chat, so the UI can offer to reset it back to
   *  the derived title rather than guessing whether it ever had one. */
  named: boolean;
  /** A longer, cleaned preview of the first user message — shown dimmer
   *  beneath the title so a chat is recognizable at a glance. Empty when it
   *  would just repeat the title. */
  snippet: string;
  createdAt: number;
  updatedAt: number;
  eventCount: number;
  /** What state this chat is in. Derived from the timeline here; the registry
   *  overwrites it with a live state when a conversation is mid-turn or parked
   *  on an approval, because those outrank however the last turn ended. */
  status: ChatStatus;
  /** Whether a conversation currently holds this session. Orthogonal to
   *  `status`: a chat can be open and done, or closed and interrupted. Set by
   *  the caller — only the registry knows, and history is a file store. */
  open: boolean;
}

export class HistoryService {
  private dir: string;

  /** The project whose chats `list()` returns. Undefined when no folder is
   *  open, in which case nothing is filtered — there is no project to scope to
   *  and an empty list would just look broken. */
  private readonly workspaceRoot?: string;

  constructor(ctx: vscode.ExtensionContext) {
    this.dir = path.join(ctx.globalStorageUri.fsPath, "sessions");
    this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /** Stamp a session with the project it belongs to. Called on the way to disk
   *  so a conversation carries its own scope rather than the list guessing. */
  private scoped(session: StoredSession): StoredSession {
    if (!this.workspaceRoot || session.workspaceRoot) return session;
    return { ...session, workspaceRoot: this.workspaceRoot };
  }

  private belongsHere(session: StoredSession): boolean {
    if (!this.workspaceRoot) return true;
    return session.workspaceRoot === this.workspaceRoot;
  }

  async ensureReady(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  async save(session: StoredSession): Promise<void> {
    if (!hasUserContent(session)) {
      // Never persist an empty placeholder — and if a previously-saved
      // session has since lost all its user content (e.g. rewound to empty),
      // remove the stale file instead of silently skipping, otherwise a
      // reload would resurrect it via restoreLatestSession.
      await this.delete(session.id).catch(() => undefined);
      return;
    }
    await this.ensureReady();
    const file = path.join(this.dir, `${session.id}.json`);
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.scoped(session)));
    await fs.rename(tmp, file);
  }

  async list(): Promise<HistoryEntry[]> {
    await this.ensureReady();
    const files = await fs.readdir(this.dir).catch(() => []);
    const entries: HistoryEntry[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(this.dir, f), "utf8");
        const s = JSON.parse(raw) as StoredSession;
        if (!this.belongsHere(s)) continue;
        // Derive title/snippet fresh from the timeline so the cleaning rules
        // below apply retroactively to sessions saved with older logic. A name
        // the user typed is not derived and outranks all of it.
        const derived = deriveTitle(s.timeline) || s.title || "New chat";
        const named = typeof s.name === "string" && s.name.length > 0;
        // The snippet exists to avoid repeating the title. Under a name the
        // title no longer says anything about the conversation, so there is
        // nothing to repeat and the preview is the only thing left that says
        // what "Bugs" was about.
        const snippet = deriveSnippet(s.timeline, named ? "" : derived);
        entries.push({
          id: s.id,
          title: named ? (s.name as string) : derived,
          named,
          snippet,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          eventCount: s.timeline?.length ?? 0,
          status: deriveStatus(s.timeline ?? []),
          open: false
        });
      } catch {
        // ignore corrupt files
      }
    }
    entries.sort((a, b) => b.updatedAt - a.updatedAt);
    return entries;
  }

  async load(id: string): Promise<StoredSession | null> {
    try {
      const raw = await fs.readFile(path.join(this.dir, `${id}.json`), "utf8");
      return JSON.parse(raw) as StoredSession;
    } catch {
      return null;
    }
  }

  async delete(id: string): Promise<void> {
    await fs.unlink(path.join(this.dir, `${id}.json`)).catch(() => undefined);
  }
}

function hasUserContent(s: StoredSession): boolean {
  return s.timeline.some((e) => e.kind === "user");
}

/**
 * What state a conversation was left in, read off the end of its timeline.
 *
 * Pure, and deliberately not a method: it is the one part of a chat's status
 * that survives the extension host, so a chat nobody has open still says
 * whether it finished, stalled or failed. The live states — a turn actually in
 * flight, an approval actually pending — are laid over this by the registry,
 * which is the only thing that knows a conversation exists.
 *
 * `checkpoint` events are skipped: they are bookkeeping for rewind, not part of
 * the conversation, and a chat whose last write happened to be one would
 * otherwise report whatever `checkpoint` maps to.
 */
export function deriveStatus(timeline: TimelineEvent[]): StoredStatus {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i];
    switch (e.kind) {
      case "checkpoint":
        continue;
      case "error":
        return "failed";
      // The user spoke last and nothing came back — the turn never started, or
      // died before it produced anything.
      case "user":
        return "no-reply";
      // A question the agent asked and nobody answered. Unlike a tool
      // permission, this one survives the process: reopening the chat shows the
      // card again, so it is genuinely still waiting.
      case "plan_question":
        return "needs-you";
      case "assistant":
        // A cancelled turn flushes its partial answer as an ordinary assistant
        // event, so without this marker Stop, rewind, edit and switching chats
        // would every one of them read as "done". `orchestrator.ts` stamps it.
        return e.meta?.interrupted === true ? "interrupted" : "done";
      // Mid-turn when the timeline stops: the process died with a tool in
      // flight, or right after one came back. Either way nobody answered.
      case "tool_call":
      case "tool_result":
      case "approval":
        return "interrupted";
      default:
        // plan_revision, plan_comment, plan_answer — the agent was working and
        // the turn did not get to say anything after.
        return "interrupted";
    }
  }
  // Only reachable for a timeline of nothing but checkpoints, which `save`
  // refuses to persist. Answering "done" would be a guess; "no-reply" is what
  // an empty conversation actually is.
  return "no-reply";
}

/** Cleaned, single-line text of the first user message — the basis for both
 *  the title and the preview snippet. Strips composer code badges, fenced
 *  code, images, links, markdown emphasis, and `@file` mentions so the
 *  surfaced text is the prose the user actually wrote rather than markup or
 *  a bare filename. */
function firstUserText(timeline: TimelineEvent[]): string {
  const firstUser = timeline.find((e) => e.kind === "user");
  if (!firstUser?.body) return "";
  return (
    firstUser.body
      // Composer code badge: **file:lines**\n```lang\n…code…\n```
      .replace(/\*\*[^*\n]+\*\*\s*\n`{3,}[^\n]*\n[\s\S]*?\n`{3,}/g, " ")
      // Any remaining fenced code block
      .replace(/`{3,}[^\n]*\n[\s\S]*?\n`{3,}/g, " ")
      // Image markdown ![alt](src) — drop entirely (alt is rarely useful here)
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      // Link [text](url) → text
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      // Inline code `x` → x ; bold/italic markers → inner text
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      // `@file` mention tokens — drop them so the title reads as the user's
      // instruction ("fix the bug") instead of a bare filename.
      .replace(/(^|\s)@[^\s@]+/g, "$1")
      // Leading heading / list / quote markers per line
      .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|>\s+)/gm, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** Basenames of every `@file` mention in the first user message, in order.
 *  Used as a last-resort title for prompts that are *only* mentions/code. */
function mentionedFiles(timeline: TimelineEvent[]): string[] {
  const firstUser = timeline.find((e) => e.kind === "user");
  if (!firstUser?.body) return [];
  const out: string[] = [];
  const re = /(?:^|\s)@([^\s@]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(firstUser.body)) !== null) {
    const name = m[1].split("/").pop() ?? m[1];
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Word-aware truncation: never cuts mid-word and trims trailing punctuation,
 * appending an ellipsis only when something was actually dropped.
 */
function truncateWords(s: string, max: number): string {
  if (s.length <= max) return s.replace(/[\s.,;:!?–-]+$/, "");
  const slice = s.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > max * 0.5 ? slice.slice(0, lastSpace) : slice;
  return cut.replace(/[\s.,;:!?–-]+$/, "") + "…";
}

/** Pull a short, clean title from the first user message in the timeline. */
export function deriveTitle(timeline: TimelineEvent[]): string {
  const text = firstUserText(timeline);
  if (text) {
    // Prefer the first sentence when it's short enough to read as a title;
    // otherwise fall back to a word-boundary cut of the opening prose.
    const sentence = text.match(/^.*?[.!?](?=\s|$)/)?.[0];
    const base = sentence && sentence.length <= 72 ? sentence : text;
    return truncateWords(base, 72);
  }
  // No prose at all — the prompt was only file mentions and/or inserted code.
  // Surface the file name(s) so the chat is still identifiable.
  const files = mentionedFiles(timeline);
  if (files.length === 1) return files[0];
  if (files.length > 1) return `${files[0]} +${files.length - 1} more`;
  return "New chat";
}

/** A longer preview line for the history row. Returns "" when it would just
 *  echo the title (short prompts), so the UI can skip the second line. */
export function deriveSnippet(
  timeline: TimelineEvent[],
  title: string
): string {
  const text = firstUserText(timeline);
  if (!text) return "";
  const titleStem = title.replace(/…$/, "");
  // If the whole message is already captured by the title, no snippet needed.
  if (text.length <= titleStem.length + 4) return "";
  return truncateWords(text, 160);
}
