// ─────────────────────────────────────────────────────────────
// Timeline grouping — a flat event list folded into the turns the chat draws.
//
// Pure, and no JSX: it takes `TimelineEvent[]` and returns the shape the
// renderers walk. That is why it is here rather than in `ChatScreen.tsx`,
// where it was 380 lines of the file with nothing React about it — and why it
// can be tested in the node project beside `fold-plan-state` and
// `subagent-state`, the folds it builds on.
// ─────────────────────────────────────────────────────────────

import type { TimelineEvent, SubagentTaskView } from "../../lib/rpc";
import { ToolGroupItem } from "./ToolGroupCard";
import { foldQuestions, type AskedQuestionView } from "./question-log";
import { classifyTool, ToolBucket } from "./tool-buckets";
import { foldPlanState, looksLikePlanFile } from "../plan";
import type { PlanRevisionView } from "../plan";
import {
  TASK_TOOL_NAMES,
  foldSubagents,
  type FoldedSubagents
} from "./subagent-state";

// ── Timeline grouping ────────────────────────────────────────
//
// Events are bucketed into TURNS (one per user message). Inside each turn:
//
//  - "Thought" — assistant text emitted before any tool fires (preamble).
//  - Body blocks — interleaved tool groups, plan cards, and narrative text
//    (assistant text after at least one tool has fired). Consecutive
//    tool calls of the same semantic bucket merge into a single
//    ToolGroupCard, rendered Antigravity-style ("Read 3 files").
//
// Turn timing (workedMs / thoughtMs) uses the timestamps already on every
// TimelineEvent — no orchestrator changes needed.

export type Group =
  | { kind: "user"; id: string; text: string }
  | {
      kind: "turn";
      turnId: string;
      startedAt: number;
      endedAt?: number;
      thought: string;
      thoughtMs?: number;
      workedMs?: number;
      /** "Work" — tool groups (and any narrative interleaved between them).
       *  Hidden behind the "Worked for X" collapsible. */
      blocks: TurnBlock[];
      /** "Response" — everything after the last tool call (final answer text
       *  and trailing plan cards). Always rendered OUTSIDE the collapsible
       *  so the actual answer is never hidden. */
      responseBlocks: TurnBlock[];
    };

export type TurnBlock =
  | { kind: "narrative"; text: string }
  | { kind: "toolGroup"; bucket: ToolBucket; items: ToolGroupItem[] }
  | { kind: "plan"; revisionId: string }
  | { kind: "compact"; text: string }
  | { kind: "remoteApproval"; tool: string }
  | { kind: "error"; text: string }
  | { kind: "subagent"; taskId: string }
  | { kind: "question"; questionId: string };

/**
 * Tool names whose tool_use blocks are rendered via PlanCard rather than
 * ToolCard. Filter applies even on historic sessions saved before plan
 * interception was wired (defensive — orchestrator already suppresses live).
 */
const PLAN_TOOL_NAMES = new Set([
  "ExitPlanMode",
  "TodoWrite",
  "AskUserQuestion"
]);
const WRITE_TOOL_NAMES = new Set([
  "Write",
  "Create",
  "Edit",
  "MultiEdit",
  "fs_write",
  "str_replace_editor"
]);
const WRITE_TOOL_NAME_RE_PREFIX =
  /^(write|edit|create|save|update|put|insert)(?:$|[_-]|[A-Z])/i;
const WRITE_TOOL_NAME_RE_BOUNDARY =
  /[_-](write|edit|create|save|update|put|insert)(?:$|[_-]|[A-Z])/i;

function isPlanFileWriteEvent(name: string, body: string | undefined): boolean {
  if (
    !WRITE_TOOL_NAMES.has(name) &&
    !WRITE_TOOL_NAME_RE_PREFIX.test(name) &&
    !WRITE_TOOL_NAME_RE_BOUNDARY.test(name)
  ) {
    return false;
  }
  try {
    const input = JSON.parse(body ?? "{}") as Record<string, unknown>;
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
    return looksLikePlanFile(path);
  } catch {
    return false;
  }
}

export interface GroupingResult {
  groups: Group[];
  views: Map<string, PlanRevisionView>;
  ordered: PlanRevisionView[];
  subagents: FoldedSubagents;
  questions: Map<string, AskedQuestionView>;
}

/** Everything the block renderers need that is not the block itself. */
export interface RenderCtx {
  views: Map<string, PlanRevisionView>;
  ordered: PlanRevisionView[];
  subagents: FoldedSubagents;
  taskProgress: Record<string, SubagentTaskView>;
  questions: Map<string, AskedQuestionView>;
}

export function groupEvents(events: TimelineEvent[]): GroupingResult {
  const ordered = foldPlanState(events);
  const views = new Map<string, PlanRevisionView>();
  for (const v of ordered) views.set(v.meta.revisionId, v);
  const subagents = foldSubagents(events);
  const questions = foldQuestions(events);

  const groups: Group[] = [];
  const suppressedToolUseIds = new Set<string>();
  const toolItemsById = new Map<string, ToolGroupItem>();
  /** Cards already placed, so a dispatch is not rendered twice when both the
   *  `Agent` tool_call and the `subagent` event are present. */
  const placedTasks = new Set<string>();

  let currentTurn: Extract<Group, { kind: "turn" }> | null = null;
  let firstToolTsInTurn: number | undefined;
  let lastTsInTurn: number | undefined;

  const finalizeTurn = (): void => {
    if (!currentTurn) return;
    if (lastTsInTurn !== undefined) {
      currentTurn.endedAt = lastTsInTurn;
      currentTurn.workedMs = lastTsInTurn - currentTurn.startedAt;
    }
    if (firstToolTsInTurn !== undefined) {
      currentTurn.thoughtMs = firstToolTsInTurn - currentTurn.startedAt;
    } else if (lastTsInTurn !== undefined) {
      currentTurn.thoughtMs = lastTsInTurn - currentTurn.startedAt;
    }
    // No-tools turn: the "thought" buffer IS the assistant's answer (there
    // never was any pre-tool thinking — the agent just replied). Hoist it
    // to responseBlocks so it stays visible when the user collapses the
    // "Worked for" header. Without this, the final reply vanishes the
    // moment the turn is collapsed.
    if (firstToolTsInTurn === undefined && currentTurn.thought) {
      currentTurn.responseBlocks.push({
        kind: "narrative",
        text: currentTurn.thought
      });
      currentTurn.thought = "";
    }
    // Step 1: Move trailing non-toolGroup blocks (narrative + plan) into
    // responseBlocks. Anything after the last tool call is the assistant's
    // answer and shouldn't sit inside the "Worked for X" collapsible.
    while (currentTurn.blocks.length > 0) {
      const last = currentTurn.blocks[currentTurn.blocks.length - 1];
      if (last.kind === "toolGroup") break;
      currentTurn.responseBlocks.unshift(currentTurn.blocks.pop()!);
    }
    // Step 2: ALSO hoist any plan blocks that ended up in the middle of the
    // work area (e.g. when the model wrote the plan, then did more reads to
    // verify before calling ExitPlanMode). Plans are deliverables — they
    // should never be hidden behind the collapsible.
    const hoistedPlans: TurnBlock[] = [];
    const remainingBlocks: TurnBlock[] = [];
    for (const b of currentTurn.blocks) {
      if (b.kind === "plan") hoistedPlans.push(b);
      else remainingBlocks.push(b);
    }
    currentTurn.blocks = remainingBlocks;
    // Plans always render at the BOTTOM of the turn so the narrative reads
    // through to a clean call-to-action card at the end. Without this they
    // can land mid-stream and split the explanation across the card.
    const responsePlans: TurnBlock[] = [];
    const responseNonPlans: TurnBlock[] = [];
    for (const b of currentTurn.responseBlocks) {
      if (b.kind === "plan") responsePlans.push(b);
      else responseNonPlans.push(b);
    }
    currentTurn.responseBlocks = [
      ...responseNonPlans,
      ...hoistedPlans,
      ...responsePlans
    ];

    currentTurn = null;
    firstToolTsInTurn = undefined;
    lastTsInTurn = undefined;
  };

  const ensureTurn = (ts: number): Extract<Group, { kind: "turn" }> => {
    if (!currentTurn) {
      currentTurn = {
        kind: "turn",
        turnId: `t-${ts}`,
        startedAt: ts,
        thought: "",
        blocks: [],
        responseBlocks: []
      };
      groups.push(currentTurn);
    }
    lastTsInTurn = ts;
    return currentTurn;
  };

  for (const e of events) {
    if (e.kind === "user") {
      finalizeTurn();
      groups.push({ kind: "user", id: e.id, text: e.body ?? "" });
      continue;
    }

    const turn = ensureTurn(e.ts);

    if (e.kind === "assistant") {
      const text = e.body ?? "";
      if (firstToolTsInTurn === undefined) {
        // Pre-tool text becomes the turn's "Thought for Xs" preamble.
        turn.thought += (turn.thought ? "\n\n" : "") + text;
      } else {
        // Post-tool text interleaves between tool groups as narrative.
        const last = turn.blocks[turn.blocks.length - 1];
        if (last && last.kind === "narrative") {
          last.text += "\n\n" + text;
        } else {
          turn.blocks.push({ kind: "narrative", text });
        }
      }
      continue;
    }

    if (e.kind === "tool_call") {
      const name = e.title.replace(/^Tool:\s*/, "");
      if (PLAN_TOOL_NAMES.has(name)) continue;
      const synthId = `synth-${e.id}`;
      if (views.has(synthId)) {
        const tid = (e.meta as { id?: string } | undefined)?.id;
        if (tid) suppressedToolUseIds.add(tid);
        turn.blocks.push({ kind: "plan", revisionId: synthId });
        continue;
      }
      if (isPlanFileWriteEvent(name, e.body)) {
        const tid = (e.meta as { id?: string } | undefined)?.id;
        if (tid) suppressedToolUseIds.add(tid);
        continue;
      }

      // A dispatch renders as its own card, in the slot the tool call would
      // have taken. The generic chip is dropped rather than shown alongside:
      // it says "Ran 1 tool" and nothing about which agent or what came back.
      //
      // Matched on `meta.name` rather than the title `name` above: the title is
      // a rendered string that a caller has to have prefixed "Tool: " for the
      // parse to recover anything, and a card silently reverting to a chip is
      // the kind of miss nothing else would catch.
      const meta = e.meta as { id?: string; name?: string } | undefined;
      if (TASK_TOOL_NAMES.has(meta?.name ?? name)) {
        const tid = meta?.id;
        const taskId = tid ? subagents.taskIdByToolUse.get(tid) : undefined;
        if (taskId) {
          if (tid) suppressedToolUseIds.add(tid);
          if (firstToolTsInTurn === undefined) firstToolTsInTurn = e.ts;
          if (!placedTasks.has(taskId)) {
            placedTasks.add(taskId);
            turn.blocks.push({ kind: "subagent", taskId });
          }
          continue;
        }
        // No task events for it — an older CLI, or a dispatch that died before
        // reporting. Fall through and render the plain tool chip: an unhelpful
        // card beats a silently missing one.
      }

      if (firstToolTsInTurn === undefined) firstToolTsInTurn = e.ts;

      const bucket = classifyTool(name, e.body);
      const item: ToolGroupItem = {
        id: e.id,
        name,
        input: e.body ?? "{}"
      };
      const tid = (e.meta as { id?: string } | undefined)?.id;
      if (tid) toolItemsById.set(tid, item);

      const last = turn.blocks[turn.blocks.length - 1];
      if (last && last.kind === "toolGroup" && last.bucket === bucket) {
        last.items.push(item);
      } else {
        turn.blocks.push({ kind: "toolGroup", bucket, items: [item] });
      }
      continue;
    }

    if (e.kind === "tool_result") {
      const meta = e.meta as
        { id?: string; blockedReason?: string } | undefined;
      const tid = meta?.id;
      if (tid && suppressedToolUseIds.has(tid)) continue;
      const target = tid ? toolItemsById.get(tid) : undefined;
      if (target) {
        target.result = e.body ?? "";
        target.isError = e.title === "Tool Error";
        // Read off `meta`, not off the title: this one has to survive a
        // reworded heading, and it changes what the card means rather than
        // how it is captioned.
        target.blockedReason = meta?.blockedReason;
      }
      continue;
    }

    // Its own block rather than narrative text: this is the one event that
    // changes what the model remembers without the user asking, so it reads as
    // a boundary in the conversation, not as something the assistant said.
    if (e.kind === "compact") {
      turn.blocks.push({ kind: "compact", text: e.body ?? e.title });
      continue;
    }

    // A tool this panel never approved ran anyway, because the same prompt was
    // answered on a phone driving the session. It stays on the timeline for the
    // same reason compaction does: nothing else explains it later.
    if (e.kind === "approval") {
      turn.blocks.push({ kind: "remoteApproval", tool: e.body ?? "" });
      continue;
    }

    // The banner carrying this text is cleared on the next `turnStart`, so
    // without a block of its own the only account of a failed turn is gone the
    // moment the user retries — which is exactly when they go looking for it.
    if (e.kind === "error") {
      turn.blocks.push({ kind: "error", text: e.body ?? e.title });
      continue;
    }

    // Normally the card is already placed by the `Agent` tool call, which
    // lands first. This catches a timeline that has the task without the
    // dispatch — the tool call intercepted as a plan write, or a stored
    // session from before the two were tied together.
    if (e.kind === "subagent") {
      const taskId = (e.meta as { taskId?: string } | undefined)?.taskId;
      if (taskId && !placedTasks.has(taskId)) {
        placedTasks.add(taskId);
        if (firstToolTsInTurn === undefined) firstToolTsInTurn = e.ts;
        turn.blocks.push({ kind: "subagent", taskId });
      }
      continue;
    }

    if (e.kind === "plan_revision") {
      const meta = e.meta as { revisionId?: string } | undefined;
      if (meta?.revisionId) {
        turn.blocks.push({ kind: "plan", revisionId: meta.revisionId });
      }
    }

    // The question the model asked, and what was answered. The card that
    // collected the answer is a permission prompt and is gone the moment it
    // is answered, so without this the transcript has no account of a
    // decision the rest of the turn was built on. Placed for every question,
    // plan mode or not — the PlanRevisionView only ever held the ones that
    // happened to land under a revision.
    if (e.kind === "plan_question") {
      const meta = e.meta as { questionId?: string } | undefined;
      if (meta?.questionId) {
        // Ends the thinking preamble the way a tool call does. The question's
        // own tool_call is intercepted and never reaches here, so without this
        // a turn that only asked has no tool at all: every line the model
        // wrote — before the question and after — is hoisted into the response
        // as one block, and the question renders above text that preceded it.
        if (firstToolTsInTurn === undefined) firstToolTsInTurn = e.ts;
        turn.blocks.push({ kind: "question", questionId: meta.questionId });
      }
    }
    // plan_comment / plan_answer produce no block of their own: the answer is
    // rendered by the question block it belongs to.
  }
  finalizeTurn();

  return { groups, views, ordered, subagents, questions };
}
