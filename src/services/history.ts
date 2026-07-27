import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { Message, TimelineEvent } from "../core/types.js";

/**
 * Persists chat sessions under VS Code's per-extension globalStorage.
 * Each session is a single JSON file: {dir}/sessions/{sessionId}.json.
 * Saves are intentionally idempotent overwrites — we always rewrite the
 * whole session on each save call. Callers should debounce.
 */
export interface StoredSession {
  id: string;
  title: string;
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
}

export interface HistoryEntry {
  id: string;
  title: string;
  /** A longer, cleaned preview of the first user message — shown dimmer
   *  beneath the title so a chat is recognizable at a glance. Empty when it
   *  would just repeat the title. */
  snippet: string;
  createdAt: number;
  updatedAt: number;
  eventCount: number;
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
        // below apply retroactively to sessions saved with older logic.
        const title = deriveTitle(s.timeline) || s.title || "New chat";
        const snippet = deriveSnippet(s.timeline, title);
        entries.push({
          id: s.id,
          title,
          snippet,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          eventCount: s.timeline?.length ?? 0
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
