import { ContentBlock, Message, TimelineEvent } from "./types.js";
import {
  PlanAnswerMeta,
  PlanCommentMeta,
  PlanQuestionMeta,
  PlanRevisionMeta
} from "./plan-types.js";
import { randomUUID } from "node:crypto";

export type SessionListener = (e: TimelineEvent) => void;
export type UserTurnHook = (eventId: string) => void | Promise<void>;

export class Session {
  readonly id: string;
  readonly createdAt: number;
  messages: Message[] = [];
  timeline: TimelineEvent[] = [];
  private listener?: SessionListener;
  private userTurnHook?: UserTurnHook;

  constructor(public title = "Untitled") {
    this.id = randomUUID();
    this.createdAt = Date.now();
  }

  onEvent(fn: SessionListener) {
    this.listener = fn;
  }

  onUserTurn(fn: UserTurnHook) {
    this.userTurnHook = fn;
  }

  /**
   * @param attachments files the user picked, already in the API's block
   *   shape. They go into the message the model reads and **not** into the
   *   timeline body: a data URI on the timeline is megabytes of base64 in the
   *   stored session and a wall of characters in the chat. What the bubble
   *   needs is the names, which ride in `meta`.
   */
  async addUser(
    text: string,
    attachments: ContentBlock[] = []
  ): Promise<TimelineEvent> {
    // Attachments first, the typed words last — the order the reference sends
    // and the one that reads correctly: the instruction comes after what it is
    // about.
    this.messages.push({
      role: "user",
      content: attachments.length
        ? [...attachments, { type: "text" as const, text }]
        : text
    });
    const ev = this.emit({
      kind: "user",
      title: "User",
      body: text,
      ...(attachments.length && {
        meta: { attachments: attachments.map(attachmentLabel) }
      })
    });
    // Awaited so checkpoint capture (and any other onUserTurn hooks)
    // settles before the orchestrator starts firing tool calls.
    await this.userTurnHook?.(ev.id);
    return ev;
  }

  addAssistantBlocks(blocks: ContentBlock[]) {
    this.messages.push({ role: "assistant", content: blocks });
    for (const b of blocks) {
      if (b.type === "text")
        this.emit({ kind: "assistant", title: "Assistant", body: b.text });
      else if (b.type === "tool_use")
        this.emit({
          kind: "tool_call",
          title: `Tool: ${b.name}`,
          body: JSON.stringify(b.input),
          meta: { id: b.id, name: b.name }
        });
    }
  }

  emitToolCall(id: string, name: string, input: Record<string, unknown>) {
    this.emit({
      kind: "tool_call",
      title: `Tool: ${name}`,
      body: JSON.stringify(input),
      meta: { id, name }
    });
  }

  /**
   * `blockedReason` names the case where the failure is a decision: the CLI's
   * auto-mode classifier refused the call. What the model was told is still
   * what goes into `messages` — that is the conversation, and editing it would
   * make the transcript disagree with the model's memory. Only what the person
   * reads changes, and it reads the reason rather than the paragraph of advice
   * the CLI addressed to the model.
   */
  addToolResult(
    toolUseId: string,
    content: string,
    isError = false,
    blockedReason?: string
  ) {
    const block: ContentBlock = {
      type: "tool_result",
      tool_use_id: toolUseId,
      content,
      is_error: isError
    };
    this.messages.push({ role: "user", content: [block] });
    this.emit({
      kind: "tool_result",
      title: blockedReason ? "Blocked" : isError ? "Tool Error" : "Tool Result",
      body: blockedReason ?? content,
      meta: blockedReason ? { id: toolUseId, blockedReason } : { id: toolUseId }
    });
  }

  emitPlanRevision(meta: PlanRevisionMeta): TimelineEvent {
    return this.emit({
      kind: "plan_revision",
      title: meta.bodyChanged
        ? `Plan ${meta.revisionId}`
        : `Plan ${meta.revisionId} · tasks updated`,
      body: meta.body,
      meta: meta as unknown as Record<string, unknown>
    });
  }

  emitPlanQuestion(meta: PlanQuestionMeta): TimelineEvent {
    const head = meta.questions[0];
    return this.emit({
      kind: "plan_question",
      title: head?.header ?? "Question",
      body: head?.question ?? "",
      meta: meta as unknown as Record<string, unknown>
    });
  }

  emitPlanComment(meta: PlanCommentMeta): TimelineEvent {
    return this.emit({
      kind: "plan_comment",
      title: "Plan comment",
      body: meta.body,
      meta: meta as unknown as Record<string, unknown>
    });
  }

  emitPlanAnswer(meta: PlanAnswerMeta): TimelineEvent {
    const summary = meta.answers
      .map((a) => a.choice + (a.note ? ` — ${a.note}` : ""))
      .join(" · ");
    return this.emit({
      kind: "plan_answer",
      title: "Plan answer",
      body: summary,
      meta: meta as unknown as Record<string, unknown>
    });
  }

  emit(e: Omit<TimelineEvent, "id" | "ts">): TimelineEvent {
    const full: TimelineEvent = { id: randomUUID(), ts: Date.now(), ...e };
    this.timeline.push(full);
    this.listener?.(full);
    return full;
  }

  /** Truncate timeline + messages to state *just before* the given user event. Returns surviving timeline. */
  truncateAt(userEventId: string): TimelineEvent[] {
    const idx = this.timeline.findIndex((e) => e.id === userEventId);
    if (idx === -1) return this.timeline.slice();
    this.timeline = this.timeline.slice(0, idx);
    // Rebuild messages from surviving timeline events.
    const newMessages: Message[] = [];
    for (const e of this.timeline) {
      if (e.kind === "user" && typeof e.body === "string") {
        newMessages.push({ role: "user", content: e.body });
      } else if (e.kind === "assistant" && typeof e.body === "string") {
        const last = newMessages[newMessages.length - 1];
        if (last?.role === "assistant" && Array.isArray(last.content)) {
          (last.content as ContentBlock[]).push({ type: "text", text: e.body });
        } else {
          newMessages.push({
            role: "assistant",
            content: [{ type: "text", text: e.body }]
          });
        }
      }
    }
    this.messages = newMessages;
    return this.timeline.slice();
  }
}

/**
 * What an attachment is called on the timeline.
 *
 * The name the user picked when there is one, and the media type when there is
 * not — a pasted screenshot has no filename, and "image/png" is a better label
 * for it than nothing at all.
 */
function attachmentLabel(block: ContentBlock): string {
  if (block.type === "document" && block.title) return block.title;
  if (block.type === "image") return block.source.media_type;
  if (block.type === "document") return block.source.media_type;
  return block.type;
}
