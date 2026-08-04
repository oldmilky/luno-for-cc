// ─────────────────────────────────────────────────────────────
// The roster of background agents a conversation has dispatched.
//
// Three collections that are only ever touched together, plus the rules for
// folding an update into them. It decides what an update *means* and returns
// that; emitting the row, posting to the webview and saving the session stay
// with the caller, which is what keeps this side free of the session, the
// provider and VS Code.
//
// The rules here were all paid for by a card showing the wrong thing, and each
// one carries the measurement that found it.
// ─────────────────────────────────────────────────────────────

import { isWorkflowTask, type SubagentUpdate } from "../../core/types.js";
import { stripUndefined } from "../conversation-format.js";

/**
 * What an update turned out to be, once the roster had the rest of the task.
 *
 * `ended` is raised by `notification` rather than by the terminal status that
 * `updated` reports first: it is the only phase carrying the summary, and the
 * pair arrives back to back.
 */
export type RosterOutcome =
  | { kind: "ignored" }
  | { kind: "started"; task: SubagentUpdate }
  | { kind: "progress"; task: SubagentUpdate }
  | { kind: "ended"; task: SubagentUpdate };

export class SubagentRoster {
  /**
   * Subagents dispatched this turn that have not reported a terminal status,
   * keyed by CLI task id.
   *
   * Kept because `task_updated` identifies its task by id alone — it carries no
   * `tool_use_id` — so the card it belongs to is only findable through what
   * `task_started` said.
   */
  private readonly live = new Map<string, SubagentUpdate>();

  /**
   * Identity of every task seen this conversation: the fields that arrive once
   * on `task_started` and never again. Kept past the end of the card so a late
   * event cannot degrade a workflow's row to a bare "Agent".
   */
  private readonly identity = new Map<string, SubagentUpdate>();

  /**
   * Tasks the CLI has itself reported a terminal status for.
   *
   * A `task_progress` can land *after* the `task_notification` that ended a
   * task — measured, 1.4s after, in the run behind the ten-minute-cutoff audit.
   * Any phase but `notification` puts its task back among the live ones, so
   * that one late event resurrected a finished workflow and the sweep then
   * filed it `interrupted`. That fabricated status is what the card showed,
   * over the `stopped` the CLI had actually reported a second earlier.
   *
   * Only a status the CLI reported gets an entry here. A card closed by the
   * sweep does not, so a late notification can still heal one — measured, an
   * agent closed yellow at 38.6s and reopened green at 107.6s.
   */
  private readonly reported = new Set<string>();

  /** How many agents are still open. Drives the conversation's status. */
  get openCount(): number {
    return this.live.size;
  }

  /** Every open agent, for a surface that has to rebuild their cards. */
  open(): SubagentUpdate[] {
    return [...this.live.values()];
  }

  /**
   * Fold an update into the roster and say what it was.
   *
   * The merge order is load-bearing: identity first because it is the oldest
   * and least specific, then whatever the task last looked like, then the
   * incoming event stripped of its undefined fields — so a phase that omits a
   * field leaves the known value standing rather than erasing it.
   */
  accept(update: SubagentUpdate): RosterOutcome {
    // The CLI has already said how this one ended. Nothing arriving afterwards
    // can add to that, and letting it through is what resurrects a finished
    // task — see `reported`.
    if (this.reported.has(update.taskId)) return { kind: "ignored" };

    const merged: SubagentUpdate = {
      ...this.identity.get(update.taskId),
      ...this.live.get(update.taskId),
      ...stripUndefined(update),
      // Restated because `stripUndefined` widens both to optional; they are the
      // two fields the incoming event is always authoritative for.
      taskId: update.taskId,
      phase: update.phase
    };

    // `task_type` rides on `task_started` and on no other phase, so this is the
    // first point that knows a progress event belongs to a workflow — the
    // dispatch has been merged in by now. A workflow puts the *agent's label*
    // in `last_tool_name` ("Reply with exactly the word OK"), not the name of a
    // tool, and the same string is already the activity.
    if (isWorkflowTask(merged.taskType)) delete merged.lastToolName;

    if (update.phase === "notification") {
      this.live.delete(update.taskId);
      this.reported.add(update.taskId);
      return { kind: "ended", task: merged };
    }

    this.live.set(update.taskId, merged);

    if (update.phase === "started") {
      this.identity.set(update.taskId, merged);
      return { kind: "started", task: merged };
    }
    return { kind: "progress", task: merged };
  }

  /**
   * Take every still-open agent off the roster, because nothing more is coming
   * for them. The caller closes their cards.
   *
   * **Never sweep because a turn ended.** In session mode the process survives
   * the turn, so a `run_in_background` agent really is still running and will
   * report later; sweeping would put "interrupted" on a card that is about to
   * answer, and that status is persisted. Every call site is gated on the
   * process being gone, and the one that was not is what D1 in the parity audit
   * was.
   */
  sweep(): SubagentUpdate[] {
    if (this.live.size === 0) return [];
    const open = [...this.live.values()];
    this.live.clear();
    return open;
  }
}
