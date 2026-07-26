// ─────────────────────────────────────────────────────────────
// Mirrors the plan-related shapes defined in src/core/types.ts.
// Re-exported here as a webview-local type module so plan
// components do not have to thread `meta` casts everywhere.
// ─────────────────────────────────────────────────────────────

import type {
  PlanAnswerMeta,
  PlanCommentMeta,
  PlanQuestionEntry,
  PlanQuestionMeta,
  PlanRevisionMeta,
  PlanTask,
  PlanTaskFileRef,
  TimelineEvent
} from "../../lib/rpc";

export type {
  PlanAnswerMeta,
  PlanCommentMeta,
  PlanQuestionEntry,
  PlanQuestionMeta,
  PlanRevisionMeta,
  PlanTask,
  PlanTaskFileRef,
  TimelineEvent
};

export type PlanCommentView = PlanCommentMeta & {
  eventId: string;
  ts: number;
  /** Replies to this comment in chronological order. Empty when none. */
  replies: PlanCommentView[];
};

/** A revision plus the comments / questions / answers attached to it. */
export interface PlanRevisionView {
  meta: PlanRevisionMeta;
  eventId: string;
  ts: number;
  /** All non-deleted comments in chronological order (replies sit on their
   * parent's `replies` array, but also appear here flat for legacy users). */
  comments: PlanCommentView[];
  /** Top-level comments only (comments with no `parentCommentId`). The
   * thread tree lives off these. */
  rootComments: PlanCommentView[];
  questions: Array<PlanQuestionMeta & { eventId: string; ts: number }>;
  answeredQuestionIds: Set<string>;
  answers: Array<PlanAnswerMeta & { eventId: string; ts: number }>;
}
