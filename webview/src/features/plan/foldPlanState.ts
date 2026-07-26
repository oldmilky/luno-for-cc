// ─────────────────────────────────────────────────────────────
// Pure fold from a flat TimelineEvent[] to an ordered list of
// PlanRevisionView objects with comments, questions, and answers
// attached. Used by ChatScreen.groupEvents to produce one
// PlanCard per revision in render order.
//
// The fold is deterministic and side-effect free, so calling it
// from a freshly loaded session (history replay) yields identical
// state to live streaming.
// ─────────────────────────────────────────────────────────────

import type {
  PlanAnswerMeta,
  PlanCommentMeta,
  PlanCommentView,
  PlanQuestionMeta,
  PlanRevisionMeta,
  PlanRevisionView,
  TimelineEvent
} from "./types";

/** Tool names whose tool_call events we sniff for plan-file writes.
 *  Permissive — also accepts any name containing write/edit/create/save. */
const WRITE_TOOL_NAMES = new Set([
  "Write",
  "Create",
  "Edit",
  "MultiEdit",
  "fs_write",
  "str_replace_editor"
]);
const WRITE_TOOL_NAME_RE_PREFIX = /^(write|edit|create|save|update|put|insert)(?:$|[_-]|[A-Z])/i;
const WRITE_TOOL_NAME_RE_BOUNDARY = /[_-](write|edit|create|save|update|put|insert)(?:$|[_-]|[A-Z])/i;
function isWriteToolName(name: string): boolean {
  return (
    WRITE_TOOL_NAMES.has(name) ||
    WRITE_TOOL_NAME_RE_PREFIX.test(name) ||
    WRITE_TOOL_NAME_RE_BOUNDARY.test(name)
  );
}

/** True if `path` looks like a plan-mode markdown file. Permissive on
 *  directory layout — any `*.md` under a `plans/` segment counts. Catches
 *  legacy `~/.claude/plans/` plus newer `~/.claude/projects/<X>/plans/`
 *  and workspace-local `<root>/plans/` shapes. */
export function looksLikePlanFile(p: string): boolean {
  if (!p) return false;
  if (!/\.(md|markdown)$/i.test(p)) return false;
  return /(?:^|\/)plans\//i.test(p);
}

/**
 * Synthesize a virtual plan_revision event from a tool_call event whose
 * input writes a plan-file. Used to back-fill PlanCards in sessions saved
 * before the orchestrator-side interceptor was wired.
 */
function synthesizeFromWrite(e: TimelineEvent, parent?: PlanRevisionMeta): PlanRevisionView | null {
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(e.body ?? "{}") as Record<string, unknown>;
  } catch {
    return null;
  }
  const path = String(
    input.path ??
      input.file_path ??
      input.filePath ??
      input.target_file ??
      input.target ??
      input.destination ??
      input.uri ??
      ""
  );
  if (!looksLikePlanFile(path)) return null;
  const content =
    (typeof input.content === "string" && input.content) ||
    (typeof input.file_text === "string" && input.file_text) ||
    (typeof input.text === "string" && input.text) ||
    (typeof input.new_str === "string" && input.new_str) ||
    (typeof input.body === "string" && input.body) ||
    (typeof input.markdown === "string" && input.markdown) ||
    (typeof input.data === "string" && input.data) ||
    (typeof input.value === "string" && input.value) ||
    "";
  if (!content) return null;
  const revisionId = `synth-${e.id}`;
  const meta: PlanRevisionMeta = {
    revisionId,
    parentRevisionId: parent?.revisionId,
    toolUseId: (e.meta as { id?: string } | undefined)?.id,
    body: content,
    tasks: parent?.tasks ?? [],
    bodyChanged: content !== (parent?.body ?? ""),
    planFilePath: path
  };
  return {
    meta,
    eventId: e.id,
    ts: e.ts,
    comments: [],
    rootComments: [],
    questions: [],
    answers: [],
    answeredQuestionIds: new Set<string>()
  };
}

export function foldPlanState(events: TimelineEvent[]): PlanRevisionView[] {
  const revisions: PlanRevisionView[] = [];
  const byRevisionId = new Map<string, PlanRevisionView>();
  // Tool-use ids that already produced a plan_revision (via the live
  // interceptor). Used to skip back-fill synthesis for new-format sessions.
  const liveCoveredToolUseIds = new Set<string>();
  for (const e of events) {
    if (e.kind === "plan_revision") {
      const tu = (e.meta as { toolUseId?: string } | undefined)?.toolUseId;
      if (tu) liveCoveredToolUseIds.add(tu);
    }
  }

  for (const e of events) {
    if (e.kind === "plan_revision") {
      const meta = e.meta as unknown as PlanRevisionMeta | undefined;
      if (!meta) continue;
      const view: PlanRevisionView = {
        meta,
        eventId: e.id,
        ts: e.ts,
        comments: [],
        rootComments: [],
        questions: [],
        answers: [],
        answeredQuestionIds: new Set<string>()
      };
      revisions.push(view);
      byRevisionId.set(meta.revisionId, view);
    } else if (e.kind === "tool_call") {
      // Back-fill: old sessions never emitted plan_revision for plan-file
      // writes. If we see one and it isn't already covered by a live
      // revision, synthesize a virtual view in its position.
      const name = e.title.replace(/^Tool:\s*/, "");
      if (!isWriteToolName(name)) continue;
      const toolUseId = (e.meta as { id?: string } | undefined)?.id;
      if (toolUseId && liveCoveredToolUseIds.has(toolUseId)) continue;
      const view = synthesizeFromWrite(e, lastView(revisions)?.meta);
      if (view) {
        revisions.push(view);
        byRevisionId.set(view.meta.revisionId, view);
      }
    } else if (e.kind === "plan_question") {
      const meta = e.meta as unknown as PlanQuestionMeta | undefined;
      if (!meta) continue;
      // Ternary, not `&&`: an empty revisionId made this expression evaluate
      // to "" , which `??` passes straight through because it is not nullish.
      // `target` was then a string and the push below threw.
      const target =
        (meta.revisionId ? byRevisionId.get(meta.revisionId) : undefined) ??
        lastView(revisions);
      target?.questions.push({ ...meta, eventId: e.id, ts: e.ts });
    } else if (e.kind === "plan_comment") {
      const meta = e.meta as unknown as PlanCommentMeta | undefined;
      if (!meta) continue;
      // Soft-deleted comments are kept on the timeline (rewind safety) but
      // hidden from the rendered view.
      if (meta.deleted) continue;
      const target = byRevisionId.get(meta.revisionId);
      const view: PlanCommentView = { ...meta, eventId: e.id, ts: e.ts, replies: [] };
      target?.comments.push(view);
    } else if (e.kind === "plan_answer") {
      const meta = e.meta as unknown as PlanAnswerMeta | undefined;
      if (!meta) continue;
      // Attach answers to whichever revision view holds the question.
      for (const r of revisions) {
        if (r.questions.some((q) => q.questionId === meta.questionId)) {
          r.answers.push({ ...meta, eventId: e.id, ts: e.ts });
          r.answeredQuestionIds.add(meta.questionId);
          break;
        }
      }
    }
  }

  // Second pass: build comment trees per revision. Any comment whose
  // parentCommentId points at another comment in the same revision becomes
  // a reply. Orphan replies (whose parent was deleted/moved) get promoted
  // to root so they don't disappear.
  for (const rev of revisions) {
    const byId = new Map<string, PlanCommentView>();
    for (const c of rev.comments) byId.set(c.commentId, c);
    rev.rootComments = [];
    for (const c of rev.comments) {
      const parent = c.parentCommentId ? byId.get(c.parentCommentId) : undefined;
      if (parent) parent.replies.push(c);
      else rev.rootComments.push(c);
    }
  }

  return revisions;
}

function lastView(revisions: PlanRevisionView[]): PlanRevisionView | undefined {
  return revisions.length ? revisions[revisions.length - 1] : undefined;
}

/**
 * Comments not yet addressed by a follow-up revision and not manually
 * resolved. Includes replies (so the count matches the visual badge).
 */
export function unresolvedComments(view: PlanRevisionView): PlanRevisionView["comments"] {
  return view.comments.filter((c) => !c.resolvedInRevisionId && !c.resolvedAt);
}
