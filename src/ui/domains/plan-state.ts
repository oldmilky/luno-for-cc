// ─────────────────────────────────────────────────────────────
// Plan state — pure reads and edits over a session timeline.
//
// This is the half of the plan domain that has no dependencies: no vscode, no
// posting, no provider. The *handlers* stayed on the provider, and that is a
// finding rather than an oversight — see the note at the bottom.
//
// Everything here is a plain function over `TimelineEvent[]`, which is what
// makes it the first plan logic in the project that can be tested at all.
// ─────────────────────────────────────────────────────────────

import {
  REQUIRED_PLAN_SECTIONS,
  type PlanRevisionMeta,
  type PlanSections
} from "../../core/types.js";

/** The shape this module needs from a timeline entry. */
export interface PlanEvent {
  kind: string;
  meta?: unknown;
}

export type TaskStatus = "accepted" | "skipped" | "in_progress";

export function findCommentEvent<T extends PlanEvent>(
  timeline: readonly T[],
  commentId: string
): T | undefined {
  return timeline.find(
    (e) =>
      e.kind === "plan_comment" &&
      (e.meta as { commentId?: string } | undefined)?.commentId === commentId
  );
}

export function findRevisionEvent<T extends PlanEvent>(
  timeline: readonly T[],
  revisionId: string
): T | undefined {
  return timeline.find(
    (e) =>
      e.kind === "plan_revision" &&
      (e.meta as { revisionId?: string } | undefined)?.revisionId === revisionId
  );
}

/**
 * Required sections that are missing outright or present but empty, as display
 * labels ("Risks", "Verification").
 *
 * This is what gives the Proceed gate teeth: the completeness badge is
 * cosmetic on its own, so the gaps are surfaced in the approval modal before
 * the user lets the agent start editing from a thin plan.
 *
 * Returns `[]` when sections were never parsed — plans predating section
 * parsing must not be reported as incomplete, since that would be a warning
 * about nothing.
 */
export function incompletePlanSections(
  meta: PlanRevisionMeta | undefined
): string[] {
  const sections: PlanSections | undefined = meta?.sections;
  if (!sections) return [];

  const out: string[] = [];
  for (const key of REQUIRED_PLAN_SECTIONS) {
    const value = sections[key];
    if (value === undefined || value.trim() === "") {
      out.push(key.charAt(0).toUpperCase() + key.slice(1));
    }
  }
  return out;
}

/**
 * True once the user has pressed Proceed on this revision.
 *
 * A proceeded revision is locked: no further comments, no step mutations, no
 * second Proceed. Rewinding to its checkpoint is what clears the flag — the
 * plan and the work done from it have to move together, or the agent ends up
 * editing against a plan the user has since changed underneath it.
 */
export function isRevisionProceeded(
  timeline: readonly PlanEvent[],
  revisionId: string
): boolean {
  const ev = findRevisionEvent(timeline, revisionId);
  if (!ev) return false;
  return (ev.meta as { proceeded?: boolean } | undefined)?.proceeded === true;
}

/** The same lock, reached through a comment rather than its revision. */
export function isCommentRevisionProceeded(
  timeline: readonly PlanEvent[],
  commentId: string
): boolean {
  const ev = findCommentEvent(timeline, commentId);
  if (!ev) return false;
  const revisionId = (ev.meta as { revisionId?: string } | undefined)
    ?.revisionId;
  return revisionId ? isRevisionProceeded(timeline, revisionId) : false;
}

/**
 * Set one task's status on its revision, in place.
 *
 * Returns the touched event and task so the caller can re-post and persist —
 * those are side effects and stay with whoever owns the session. Returns
 * `null` when either the revision or the task is missing, which callers treat
 * as "nothing to do" rather than an error.
 */
export function setTaskStatus<T extends PlanEvent>(
  timeline: readonly T[],
  revisionId: string,
  taskId: string,
  nextStatus: TaskStatus
): { ev: T; task: { id: string; status: string } } | null {
  const ev = findRevisionEvent(timeline, revisionId);
  if (!ev) return null;

  const meta = ev.meta as {
    tasks?: Array<{ id: string; status: string }>;
  } & Record<string, unknown>;

  const tasks = meta.tasks ?? [];
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) return null;

  tasks[idx] = { ...tasks[idx], status: nextStatus };
  meta.tasks = tasks;
  return { ev, task: tasks[idx] };
}

// ─────────────────────────────────────────────────────────────
// Why the handlers did not come with these functions
//
// The fourteen `handlePlan*` methods are not a leaf domain the way skills or
// connectors were. Counted across the block they touch `session` 16 times,
// `scheduleSave` 7, `handlePrompt` 6, plus `checkpoints`, `resumeId`,
// `abortTurn`, `artifacts`, `activeTurn` and `orchestrator`.
//
// That is not plan logic reaching too far — it is what those handlers are.
// Accepting a step re-posts a timeline event, persists the session and starts
// an agent turn; Proceed additionally flips permission mode and takes a
// checkpoint. They are session-lifecycle operations wearing plan labels, the
// same way `loadHistorySession` turned out to be.
//
// Handing this module an eight-member interface back to the provider would
// have looked like a seam and been a rename. The honest next step is to
// extract session lifecycle — the thing that actually owns `session`,
// `scheduleSave`, `checkpoints` and `resumeId` — after which the plan
// handlers become thin enough to follow their pure logic here.
// ─────────────────────────────────────────────────────────────
