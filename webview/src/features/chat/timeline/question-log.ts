// ─────────────────────────────────────────────────────────────
// The transcript's account of an AskUserQuestion.
//
// The card that collects an answer is a permission prompt: it is
// gone the moment it is answered, and nothing it did survives in
// the conversation. These two events are the record — the question
// as asked, and the answer as chosen — and folding them together
// is what lets the chat show a decision the rest of the turn was
// built on.
//
// The plan panel folds the same pair into a PlanRevisionView, but
// only when the question landed under a revision. Most do not:
// clarifying questions happen outside plan mode, which is exactly
// where the record used to disappear.
//
// Pure and React-free so it can be unit-tested directly.
// ─────────────────────────────────────────────────────────────

import type {
  PlanAnswerMeta,
  PlanQuestionEntry,
  PlanQuestionMeta,
  TimelineEvent
} from "../../../lib/rpc";

export interface AskedQuestionView {
  questionId: string;
  questions: PlanQuestionEntry[];
  /** Positional, aligned with `questions`. Empty while unanswered. */
  answers: Array<{ choice: string; note?: string }>;
  answered: boolean;
}

/** The sentinel the submitting question card stored for "Other" before the
 *  answer moved onto the permission response. Still on disk in old sessions;
 *  rendering it raw would show the user `__other`. */
const LEGACY_OTHER = "__other";

/** What was actually chosen for one question, with the legacy sentinel
 *  resolved to the text that was typed beside it. */
export function answerText(a: { choice: string; note?: string } | undefined) {
  if (!a) return "";
  if (a.choice === LEGACY_OTHER) return a.note?.trim() ?? "Other";
  return a.choice;
}

export function foldQuestions(
  events: TimelineEvent[]
): Map<string, AskedQuestionView> {
  const byId = new Map<string, AskedQuestionView>();
  for (const e of events) {
    if (e.kind === "plan_question") {
      const meta = e.meta as unknown as PlanQuestionMeta | undefined;
      if (!meta?.questionId) continue;
      byId.set(meta.questionId, {
        questionId: meta.questionId,
        questions: meta.questions ?? [],
        answers: [],
        answered: false
      });
    } else if (e.kind === "plan_answer") {
      const meta = e.meta as unknown as PlanAnswerMeta | undefined;
      if (!meta?.questionId) continue;
      const view = byId.get(meta.questionId);
      // An answer whose question is not on the timeline has nothing to render
      // against — it would be a list of choices to an unknown prompt.
      if (!view) continue;
      view.answers = meta.answers ?? [];
      view.answered = true;
    }
  }
  return byId;
}
