import {
  ContentBlock,
  Message,
  PlanAnswerMeta,
  PlanCommentMeta,
  PlanQuestionMeta,
  PlanRevisionMeta,
  TimelineEvent
} from "./types.js";
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

  async addUser(text: string): Promise<TimelineEvent> {
    this.messages.push({ role: "user", content: text });
    const ev = this.emit({ kind: "user", title: "User", body: text });
    // Awaited so checkpoint capture (and any other onUserTurn hooks)
    // settles before the orchestrator starts firing tool calls.
    await this.userTurnHook?.(ev.id);
    return ev;
  }

  addAssistantBlocks(blocks: ContentBlock[]) {
    this.messages.push({ role: "assistant", content: blocks });
    for (const b of blocks) {
      if (b.type === "text") this.emit({ kind: "assistant", title: "Assistant", body: b.text });
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

  addToolResult(toolUseId: string, content: string, isError = false) {
    const block: ContentBlock = { type: "tool_result", tool_use_id: toolUseId, content, is_error: isError };
    this.messages.push({ role: "user", content: [block] });
    this.emit({
      kind: "tool_result",
      title: isError ? "Tool Error" : "Tool Result",
      body: content,
      meta: { id: toolUseId }
    });
  }

  emitPlanRevision(meta: PlanRevisionMeta): TimelineEvent {
    return this.emit({
      kind: "plan_revision",
      title: meta.bodyChanged ? `Plan ${meta.revisionId}` : `Plan ${meta.revisionId} · tasks updated`,
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
          newMessages.push({ role: "assistant", content: [{ type: "text", text: e.body }] });
        }
      }
    }
    this.messages = newMessages;
    return this.timeline.slice();
  }
}
