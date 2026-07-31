// ─────────────────────────────────────────────────────────────
// Plan review — the fourteen actions the user can take on a plan.
//
// These could not move until the session store existed. They read and mutate
// the timeline, persist it, and several of them start an agent turn: accepting
// a step re-posts an event and prompts, Proceed additionally flips permission
// mode and takes a checkpoint. That is not plan logic reaching too far, it is
// what the actions are — see the note at the bottom of `plan-state.ts`.
//
// With the store owning the session, the surface they need is five things, and
// the accessors below are the honest list. Everything above them is
// infrastructure; everything below is the code as it was on the provider,
// moved without edits so the diff shows a move rather than a rewrite.
//
// Pure reads and edits over a timeline live in `plan-state.ts`. This file is
// the side effects.
// ─────────────────────────────────────────────────────────────

import * as vscode from "vscode";
import type { Session } from "../../core/session.js";
import type {
  PermissionMode,
  PlanQuestionMeta,
  PlanRevisionMeta
} from "../../core/types.js";
import type { PlanArtifactManager } from "../plan-artifact-panel.js";
import { makeNonce } from "../webview-html.js";
import {
  findCommentEvent,
  findQuestionEvent,
  findRevisionEvent,
  incompletePlanSections,
  isCommentRevisionProceeded,
  isRevisionProceeded,
  setTaskStatus,
  type TaskStatus
} from "./plan-state.js";
import type { SessionStore } from "./session-store.js";
import type { Post } from "../messages.js";

export interface PlanDeps {
  post: Post;
  sessions: SessionStore;
  artifacts: PlanArtifactManager;
  /** Start an agent turn with this text — several plan actions continue the
   *  conversation rather than just editing state. */
  startPrompt: (text: string) => Promise<void>;
  /** Re-publish auth and settings. Proceed changes permission mode, and the
   *  composer renders from that. */
  refreshAuth: () => Promise<void>;
}

export class PlanHandlers {
  constructor(private readonly deps: PlanDeps) {}

  // The five dependencies, under the names the moved code already used. This is
  // what let the bodies below come across untouched.
  private get post(): Post {
    return this.deps.post;
  }
  private get session(): Session {
    return this.deps.sessions.current;
  }
  private get artifacts(): PlanArtifactManager {
    return this.deps.artifacts;
  }
  private get resumeId(): string | undefined {
    return this.deps.sessions.resumeId;
  }
  private set resumeId(value: string | undefined) {
    this.deps.sessions.resumeId = value;
  }
  private scheduleSave(): void {
    this.deps.sessions.scheduleSave();
  }
  private handlePrompt(text: string): Promise<void> {
    return this.deps.startPrompt(text);
  }
  private broadcastAuthState(): Promise<void> {
    return this.deps.refreshAuth();
  }

  // ───────────────────────────────────────────────────────────
  /** Append a plan_comment event tied to a (revisionId, taskId). No round-trip yet. */
  handlePlanComment(
    revisionId: string,
    taskId: string,
    body: string,
    quote?: string
  ) {
    const trimmed = body.trim();
    if (!trimmed) return;
    if (isRevisionProceeded(this.session.timeline, revisionId)) {
      this.postLockedError();
      return;
    }
    this.session.emitPlanComment({
      commentId: makeNonce().slice(0, 8),
      revisionId,
      taskId,
      body: trimmed,
      quote: quote && quote.trim() ? quote.trim() : undefined
    });
  }

  /**
   * Edit an existing comment in place. We mutate the timeline event's meta
   * rather than emitting a superseding event so the rewind/truncate logic
   * stays simple — the comment remains anchored at its original position
   * for restore purposes.
   */
  handlePlanEditComment(commentId: string, body: string) {
    const trimmed = body.trim();
    if (!trimmed) return;
    if (isCommentRevisionProceeded(this.session.timeline, commentId)) {
      this.postLockedError();
      return;
    }
    const ev = findCommentEvent(this.session.timeline, commentId);
    if (!ev) return;
    const meta = ev.meta as Record<string, unknown>;
    meta.body = trimmed;
    meta.editedAt = Date.now();
    ev.body = trimmed;
    this.post({ type: "timeline", event: ev });
    this.scheduleSave();
  }

  /**
   * Soft-delete: flag the comment as deleted but leave the event in the
   * timeline so any rewind to a checkpoint older than this delete restores
   * the comment intact. The webview filters deleted comments out at fold
   * time.
   */
  handlePlanDeleteComment(commentId: string) {
    if (isCommentRevisionProceeded(this.session.timeline, commentId)) {
      this.postLockedError();
      return;
    }
    const ev = findCommentEvent(this.session.timeline, commentId);
    if (!ev) return;
    const meta = ev.meta as Record<string, unknown>;
    meta.deleted = true;
    this.post({ type: "timeline", event: ev });
    this.scheduleSave();
  }

  private postLockedError(): void {
    this.post({
      type: "error",
      message: "Plan is locked. Rewind to this revision's checkpoint to edit."
    });
  }

  /** Append a reply: a new plan_comment whose `parentCommentId` points at `parent`. */
  handlePlanReplyComment(
    revisionId: string,
    parentCommentId: string,
    body: string
  ) {
    const trimmed = body.trim();
    if (!trimmed) return;
    if (isRevisionProceeded(this.session.timeline, revisionId)) {
      this.postLockedError();
      return;
    }
    const parent = findCommentEvent(this.session.timeline, parentCommentId);
    const parentMeta = parent?.meta as
      { taskId?: string; quote?: string } | undefined;
    this.session.emitPlanComment({
      commentId: makeNonce().slice(0, 8),
      revisionId,
      taskId: parentMeta?.taskId ?? "__general__",
      body: trimmed,
      // Inherit the parent's quote so the reply still renders in the
      // sidebar with a "jump to passage" affordance.
      quote: parentMeta?.quote,
      parentCommentId
    });
  }

  /** Toggle a comment's manual resolved state. */
  handlePlanResolveComment(commentId: string, resolve: boolean) {
    if (isCommentRevisionProceeded(this.session.timeline, commentId)) {
      this.postLockedError();
      return;
    }
    const ev = findCommentEvent(this.session.timeline, commentId);
    if (!ev) return;
    const meta = ev.meta as Record<string, unknown>;
    if (resolve) meta.resolvedAt = Date.now();
    else delete meta.resolvedAt;
    this.post({ type: "timeline", event: ev });
    this.scheduleSave();
  }

  /**
   * Mutate a single task's status on its plan_revision and re-post the event.
   * Returns the updated revision event (or null if it doesn't exist) so callers
   * can chain a follow-up agent prompt.
   */
  private mutateTaskStatus(
    revisionId: string,
    taskId: string,
    nextStatus: TaskStatus
  ) {
    const result = setTaskStatus(
      this.session.timeline,
      revisionId,
      taskId,
      nextStatus
    );
    if (!result) return null;
    this.post({ type: "timeline", event: result.ev });
    this.scheduleSave();
    return result;
  }

  /**
   * Plan "Proceed" pressed. Show a permission popup, switch out of plan mode
   * if needed, then send the continuation prompt — all in one step so the
   * agent can start writing without the user having to manually flip mode.
   */
  async handlePlanProceed(revisionId: string): Promise<void> {
    if (isRevisionProceeded(this.session.timeline, revisionId)) {
      this.postLockedError();
      return;
    }

    const cfg = vscode.workspace.getConfiguration("luno");
    const currentMode = cfg.get<PermissionMode>("permissionMode", "default");

    // Fetched up front so we can warn on an incomplete plan before the user
    // authorizes edits. Reused below for locking the revision.
    const ev = findRevisionEvent(this.session.timeline, revisionId);
    const planMeta = ev?.meta as unknown as PlanRevisionMeta | undefined;

    const baseDetail =
      currentMode === "plan"
        ? "Plan mode blocks edits. Approving switches into Agent mode so the agent can carry out the plan autonomously."
        : "The agent will continue with file edits and any necessary commands.";
    const missing = incompletePlanSections(planMeta);
    const detail =
      missing.length > 0
        ? `⚠ This plan is missing or has empty sections: ${missing.join(", ")}. ` +
          "Skipping these is the most common cause of broken work. Consider " +
          "cancelling and asking Luno to complete the plan first.\n\n" +
          baseDetail
        : baseDetail;

    const choice = await vscode.window.showInformationMessage(
      "Luno has a plan ready. Allow it to start implementing?",
      { modal: true, detail },
      "Allow & continue"
    );

    if (!choice) return; // user cancelled / closed modal

    // Out of plan, go straight into Agent mode (auto). Anywhere else, leave
    // the user's chosen mode alone.
    const targetMode: PermissionMode =
      currentMode === "plan" ? "auto" : currentMode;

    if (targetMode !== currentMode) {
      await cfg.update(
        "permissionMode",
        targetMode,
        vscode.ConfigurationTarget.Global
      );
      // Mirror the change back to the webview so the mode pill updates
      // before the next turn begins.
      await this.broadcastAuthState();
      // Drop the prior CLI resume id. Without this, the next claude-cli
      // invocation passes --resume <plan-mode-session> and the resumed
      // session's stored permission posture (plan = no edits) sticks even
      // though we passed a new --permission-mode flag, so writes keep
      // getting denied with "It seems write permissions need to be
      // granted." A fresh session honors the new mode cleanly. We hand
      // the plan file path back to the agent in the continuation prompt
      // below so the lost conversation context is recovered.
      this.resumeId = undefined;
    }

    // Lock the revision: no more comments / step mutations / re-Proceed
    // until the user rewinds to this revision's checkpoint. Capture the
    // pre-Proceed mode so rewind can restore it. (`ev` was fetched above.)
    const planFilePath =
      ev &&
      ((ev.meta as { planFilePath?: string } | undefined)?.planFilePath ??
        undefined);
    if (ev) {
      const meta = ev.meta as Record<string, unknown>;
      meta.proceeded = true;
      meta.prePermissionMode = currentMode;
      this.post({ type: "timeline", event: ev });
      this.scheduleSave();
    }

    // Continue the conversation. If we cleared resumeId above, the agent
    // is in a fresh session with no planning context — so we hand it the
    // plan file path to re-read. The "permission mode has changed" line
    // is load-bearing: without it the model occasionally remembers being
    // told (in the prior plan-mode prompt) to refuse edits and gets stuck
    // even though the gate is open.
    const continuation = [
      "Plan approved. The permission mode has been switched out of plan mode — you now have permission to make file edits and run the commands the plan requires.",
      planFilePath
        ? `Re-read the plan at \`${planFilePath}\` and carry out each step in order.`
        : "Carry out each step of the plan in order.",
      "The plan was written in a separate read-only session, so before you rely on any file:line reference in it, re-open that location and confirm it still matches — fix the step rather than trusting a stale or mistaken citation.",
      "Stop only if you hit a blocker that requires user input."
    ].join("\n\n");
    void this.handlePrompt(continuation);
  }

  async handlePlanAcceptStep(revisionId: string, taskId: string) {
    if (isRevisionProceeded(this.session.timeline, revisionId)) {
      this.postLockedError();
      return;
    }
    const result = this.mutateTaskStatus(revisionId, taskId, "accepted");
    if (!result) return;
    const taskMeta = result.task as { content?: string };
    const content = taskMeta.content ?? "this step";
    await this.handlePrompt(
      `Step approved — proceed with: "${content}".\n\n` +
        "Execute only this step, then stop and wait for the next instruction. " +
        "When done, emit a TodoWrite that marks this step's status as " +
        '"completed" and leaves later steps untouched.'
    );
  }

  async handlePlanModifyStep(
    revisionId: string,
    taskId: string,
    instruction: string
  ) {
    const trimmed = instruction.trim();
    if (!trimmed) return;
    if (isRevisionProceeded(this.session.timeline, revisionId)) {
      this.postLockedError();
      return;
    }
    const ev = findRevisionEvent(this.session.timeline, revisionId);
    if (!ev) return;
    const meta = ev.meta as {
      tasks?: Array<{ id: string; content?: string; status: string }>;
    };
    const task = meta.tasks?.find((t) => t.id === taskId);
    const content = task?.content ?? "the step";
    await this.handlePrompt(
      `Modify the plan step: "${content}".\n\n` +
        `Change requested: ${trimmed}\n\n` +
        "Preserve every step that is already marked accepted or completed. " +
        "Regenerate downstream steps as needed and emit a fresh ExitPlanMode " +
        "(plus TodoWrite) reflecting the updated plan."
    );
  }

  handlePlanSkipStep(revisionId: string, taskId: string) {
    if (isRevisionProceeded(this.session.timeline, revisionId)) {
      this.postLockedError();
      return;
    }
    this.mutateTaskStatus(revisionId, taskId, "skipped");
  }

  /**
   * Reveal the plan as a real editor tab. The artifact webview shares the
   * same compiled bundle as the chat panel; it loads `ArtifactApp` instead
   * of the chat shell because the host injects window globals that the
   * webview entry reads at boot.
   */
  handlePlanOpenInEditor(revisionId: string) {
    const ev = findRevisionEvent(this.session.timeline, revisionId);
    if (!ev) {
      this.post({
        type: "error",
        message: "That plan revision is no longer available."
      });
      return;
    }
    const meta = ev.meta as unknown as PlanRevisionMeta;
    this.artifacts.open(meta);
  }

  /**
   * Bundle all unresolved plan_comment events for `revisionId` into a single
   * structured user turn and feed it back through the regular handlePrompt
   * pipeline. The orchestrator's PlanInterceptor will turn the response into
   * a fresh plan_revision with parentRevisionId pointing at the old one.
   */
  async handlePlanResubmit(revisionId: string) {
    if (isRevisionProceeded(this.session.timeline, revisionId)) {
      this.postLockedError();
      return;
    }
    const comments = this.session.timeline.filter(
      (e) =>
        e.kind === "plan_comment" &&
        (e.meta as { revisionId?: string } | undefined)?.revisionId ===
          revisionId &&
        !(e.meta as { resolvedInRevisionId?: string } | undefined)
          ?.resolvedInRevisionId
    );
    if (comments.length === 0) return;

    const tasksById = new Map<string, string>();
    const revEvent = this.session.timeline.find(
      (e) =>
        e.kind === "plan_revision" &&
        (e.meta as { revisionId?: string })?.revisionId === revisionId
    );
    const tasks =
      (
        revEvent?.meta as
          { tasks?: Array<{ id: string; content: string }> } | undefined
      )?.tasks ?? [];
    for (const t of tasks) tasksById.set(t.id, t.content);

    interface CommentEntry {
      body: string;
      quote?: string;
    }
    const grouped = new Map<string, CommentEntry[]>();
    for (const c of comments) {
      const meta = c.meta as { taskId: string; body: string; quote?: string };
      const list = grouped.get(meta.taskId) ?? [];
      list.push({ body: meta.body, quote: meta.quote });
      grouped.set(meta.taskId, list);
    }

    const lines = ["The plan needs revision based on this feedback:", ""];
    for (const [taskId, entries] of grouped) {
      const label =
        taskId === "__general__"
          ? "Whole-plan feedback"
          : taskId === "__inline__"
            ? "Inline feedback"
            : (tasksById.get(taskId) ?? `(task ${taskId})`);
      lines.push(`**${label}**`);
      for (const e of entries) {
        if (e.quote) {
          // Truncate long quotes — the agent doesn't need the whole passage,
          // just enough to relocate what the user was reacting to.
          const snippet =
            e.quote.length > 240 ? `${e.quote.slice(0, 237)}…` : e.quote;
          lines.push(
            `- (re: "${snippet.replace(/\s+/g, " ").trim()}") ${e.body}`
          );
        } else {
          lines.push(`- ${e.body}`);
        }
      }
      lines.push("");
    }
    lines.push(
      "Produce an updated plan via ExitPlanMode that addresses each comment."
    );
    await this.handlePrompt(lines.join("\n"));
  }

  /**
   * Record the user's question-card answers on the timeline, so a reload or a
   * rewind still shows what was chosen.
   *
   * Recording only. The answers reach the model through the `updatedInput` of
   * the `AskUserQuestion` permission response — that tool returns the input it
   * is handed, and nothing else delivers them. This used to also send a
   * synthetic prompt, which opened a second turn against a tool call the CLI
   * had already resolved with "The user did not answer the questions."
   */
  handlePlanAnswer(
    questionId: string,
    _toolUseId: string,
    answers: Array<{ choice: string; note?: string }>
  ) {
    const ev = this.session.emitPlanAnswer({ questionId, answers });
    this.post({ type: "timeline", event: ev });
    this.scheduleSave();
  }

  /**
   * Record an answer that came back as the `updatedInput` of an
   * `AskUserQuestion` permission response — the only path there is since the
   * card stopped submitting on its own.
   *
   * Two shapes meet here. On the wire the answers are keyed by question text
   * (`{"Which library?": "date-fns"}`); on the timeline they are positional,
   * which is what every stored session already carries and what the plan panel
   * reads. The question event is the thing that knows both orders, so the
   * mapping happens against it and nowhere else.
   *
   * No-op when nothing matches: a question the interceptor never recorded is
   * not worth inventing an event for, and a turn that moved on is not an error.
   */
  recordAnswerFromTool(
    toolUseId: string,
    answers: Record<string, string>
  ): void {
    if (!toolUseId) return;
    const asked = findQuestionEvent(this.session.timeline, toolUseId);
    if (!asked) return;
    const meta = asked.meta as unknown as PlanQuestionMeta;
    const recorded = meta.questions.map((q) => ({
      choice: answers[q.question] ?? ""
    }));
    if (recorded.every((a) => a.choice === "")) return;
    this.handlePlanAnswer(meta.questionId, toolUseId, recorded);
  }
  // ───────────────────────────────────────────────────────────
}
