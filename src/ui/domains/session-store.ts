// ─────────────────────────────────────────────────────────────
// The current session and everything that hangs off it: the timeline
// listeners, debounced persistence, checkpoints, and the CLI resume id.
//
// These four pieces of state were separate fields on the panel, poked from
// ninety-odd call sites, and the operation that swaps one session for another
// was written out twice — once for "restore the last session on startup", once
// for "load this one from history" — including a `defineProperty` hack that
// only makes sense with a comment next to it.
//
// One `adopt()` now owns that, and the panel owns none of it.
//
// What this deliberately does NOT own: the orchestrator, the active turn, and
// the abort path. Those are the *turn* lifecycle. A session outlives many
// turns, and conflating them is what made the panel hard to read.
// ─────────────────────────────────────────────────────────────

import { Session } from "../../core/session.js";
import type { PermissionMode } from "../../core/types.js";
import type { EffortLevel } from "../../providers/claude-cli.js";
import type { CheckpointService } from "../../services/checkpoint.js";
import {
  deriveTitle,
  type HistoryService,
  type StoredSession
} from "../../services/history.js";
import type { PlanDecorationService } from "../../services/plan-decorations.js";
import { CheckpointService as Checkpoints } from "../../services/checkpoint.js";
import { fileTouchedByTool } from "./checkpoint-triggers.js";
import type { Post } from "../messages.js";

/** Coalesce a burst of timeline events into one write. */
const SAVE_DEBOUNCE_MS = 400;

/**
 * The posture one conversation runs in.
 *
 * Per conversation rather than per workspace: with several chats open at once,
 * one can be planning while another edits under Bypass, and a single global
 * setting would retarget every running turn at once. The `luno.*` settings of
 * the same names are what a *new* conversation is born with.
 */
export interface ConversationSettings {
  model: string;
  permissionMode: PermissionMode;
  effort: EffortLevel;
  thinking: boolean;
}

export class SessionStore {
  private session: Session;
  private checkpointService?: CheckpointService;
  private saveTimer?: NodeJS.Timeout;

  /** Claude CLI session id for `--resume`. Owned here because it is saved and
   *  restored with the session, and cleared when the session is. */
  resumeId?: string;

  /** The name the user gave this conversation, if any. Here for the same
   *  reason as `resumeId`: saved with the session, restored with it, and gone
   *  when the session is. */
  name?: string;

  constructor(
    private readonly post: Post,
    private readonly history: HistoryService,
    private readonly decorations: PlanDecorationService,
    /** Read at save time rather than held, because the user can change the
     *  posture between the event that scheduled the write and the write. */
    private readonly settingsFor: () => ConversationSettings
  ) {
    this.session = new Session();
    this.attachListeners();
  }

  get current(): Session {
    return this.session;
  }

  get checkpoints(): CheckpointService | undefined {
    return this.checkpointService;
  }

  /** Start over: fresh session, no resume id, checkpoints dropped. */
  reset(): void {
    this.session = new Session();
    this.attachListeners();
    this.resumeId = undefined;
    this.name = undefined;
    this.checkpointService?.clear();
    this.checkpointService = undefined;
  }

  /**
   * Adopt a stored session as the current one.
   *
   * A fresh `Session` is constructed and then spliced rather than mutated in
   * place, because callers need the id and `createdAt` to match the stored
   * record — otherwise the next save writes a *new* history entry and the user
   * watches one conversation split into two.
   *
   * `id` and `createdAt` are `readonly`, hence `defineProperty`. Reworking
   * `Session`'s constructor for this one caller would be the tidier fix and a
   * wider change; this is the seam where the hack is contained.
   *
   * Checkpoints are dropped here rather than by the caller. They snapshot files
   * for *this* conversation's rewind, so carrying them across a session swap
   * would let a rewind restore a file to a state that belongs to a different
   * chat. A caller that forgets is a data-loss bug, so it is not the caller's
   * job to remember.
   */
  adopt(stored: StoredSession): void {
    this.checkpointService?.clear();
    this.checkpointService = undefined;

    this.session = new Session(stored.title);
    Object.defineProperty(this.session, "id", { value: stored.id });
    Object.defineProperty(this.session, "createdAt", {
      value: stored.createdAt
    });
    this.session.messages = stored.messages;
    this.session.timeline = stored.timeline;
    this.session.title = stored.title;
    this.resumeId = stored.resumeId;
    this.name = stored.name;

    // The previous listener closure now points at a dead Session, so it has to
    // be re-attached rather than left alone.
    this.attachListeners();
  }

  /** Checkpoints need a workspace root, which does not exist until there is
   *  one. Created on first use and kept for the session's lifetime. */
  ensureCheckpoints(workspaceRoot: string): void {
    this.checkpointService ??= new Checkpoints(workspaceRoot);
  }

  /** Re-post the whole timeline — used when a webview (re)mounts. */
  replay(): void {
    for (const e of this.session.timeline) {
      this.post({ type: "timeline", event: e });
    }
    this.decorations.syncFromTimeline(this.session.timeline);
  }

  scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void this.history.save({
        id: this.session.id,
        title: deriveTitle(this.session.timeline),
        name: this.name,
        createdAt: this.session.createdAt,
        updatedAt: Date.now(),
        messages: this.session.messages,
        timeline: this.session.timeline,
        resumeId: this.resumeId,
        ...this.settingsFor()
      });
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Drop a queued write.
   *
   * Needed when a rewind empties the timeline: `history.save` never persists an
   * empty session, so a queued save would no-op and leave the stale file on
   * disk for the next startup to adopt — resurrecting the chat the user just
   * cleared. The caller cancels, then deletes the file outright.
   */
  cancelPendingSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
  }

  dispose(): void {
    this.cancelPendingSave();
  }

  /**
   * Wire the timeline hooks onto whichever `Session` is current.
   *
   * Called again after every swap, because these closures capture the instance
   * and a stale one would keep feeding a session nobody can see.
   */
  private attachListeners(): void {
    this.session.onEvent((e) => {
      this.post({ type: "timeline", event: e });

      // **The event arrives after the CLI already ran the tool**, not before.
      // That matters: reading the file from disk at this point yields the
      // *post-edit* content, so a snapshot taken that way would restore the
      // damage instead of undoing it. `addFileToLatest` therefore pulls
      // pre-edit state from git HEAD, and `test/unit/checkpoint.test.ts` guards
      // it with a named regression test. "Simplifying" that back to a disk read
      // breaks rewind for every tracked file.
      const touched = fileTouchedByTool(e);
      if (touched) void this.checkpointService?.addFileToLatest(touched);

      // Every plan revision is its own restore point, so a rewind can land on
      // any revision and bring file state and comment threads with it.
      if (e.kind === "plan_revision" && this.checkpointService) {
        void this.checkpointService.captureBeforePlanRevision(e.id);
      }

      // Mirror plan changes into editor decorations so comments and the active
      // step show up inline next to the source.
      if (e.kind === "plan_revision" || e.kind === "plan_comment") {
        this.decorations.syncFromTimeline(this.session.timeline);
      }

      this.scheduleSave();
    });

    this.session.onUserTurn(async (eventId) => {
      await this.checkpointService?.captureBefore(eventId);
    });
  }
}
