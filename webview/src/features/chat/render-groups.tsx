// ─────────────────────────────────────────────────────────────
// The timeline renderers: one group, and one block inside a turn.
//
// Moved out of `ChatScreen.tsx` as functions, deliberately NOT converted into
// components. Each already takes everything explicitly and closes over
// nothing, so relocating them changes no behaviour — whereas making them
// `<GroupView />` and `<TurnBlockView />` would give each its own fiber and
// its own re-render boundary. That is a change worth making on purpose and
// measuring, not one to smuggle into a move.
// ─────────────────────────────────────────────────────────────

import { Icon } from "../../design/icons";
import type { SubagentTaskView } from "../../lib/rpc";
import { UserMessage } from "./UserMessage";
import { AssistantMessage } from "./AssistantMessage";
import { ToolGroupCard, ToolGroupItem } from "./ToolGroupCard";
import { SubagentCard } from "./SubagentCard";
import { AnsweredQuestion } from "./AnsweredQuestion";
import { TurnHeader } from "./TurnHeader";
import { ThoughtBlock } from "./ThoughtBlock";
import { EditedFilesCard } from "./EditedFilesCard";
import { InlineEditPreview } from "./InlineEditPreview";
import { extractFileEdits } from "./extract-file-edits";
import { MarkdownBody } from "./markdown";
import { PlanCard } from "../plan";
import type { Group, RenderCtx, TurnBlock } from "./group-events";
import s from "./ChatScreen.module.scss";

export function renderGroup(
  g: Group,
  idx: number,
  all: Group[],
  ctx: RenderCtx,
  onRewindRequest: (turnId: string, messagesAfter: number) => void,
  onEditRequest: (turnId: string) => void,
  isTurnCollapsed: (
    turnId: string,
    hasWork: boolean,
    isLatest: boolean
  ) => boolean,
  toggleTurn: (turnId: string, currentlyCollapsed: boolean) => void,
  isLatestTurn: boolean,
  onContinue: (text: string) => void,
  onAddDiffNote: (note: import("./FileDiffModal").DiffLineNote) => void
) {
  if (g.kind === "user") {
    const messagesAfter = all.length - idx - 1;
    return (
      <UserMessage
        key={g.id}
        id={g.id}
        text={g.text}
        canRewind
        messagesAfter={messagesAfter}
        onRewindRequest={onRewindRequest}
        onEditRequest={onEditRequest}
      />
    );
  }
  // Turn — "Worked for Xs" header collapses ONLY the work (thought + tool
  // groups + interleaved narrative). The actual assistant response (final
  // text + plan cards) renders OUTSIDE the collapsible so it's never hidden.
  const hasWork = !!g.thought || g.blocks.length > 0;
  const collapsed = isTurnCollapsed(g.turnId, hasWork, isLatestTurn);
  // Pull file-edit summary across the whole turn (work + response). The card
  // is rendered after responseBlocks so it sits at the end of the turn, just
  // before the next user message.
  const allToolItems: ToolGroupItem[] = [];
  for (const b of g.blocks)
    if (b.kind === "toolGroup") allToolItems.push(...b.items);
  for (const b of g.responseBlocks)
    if (b.kind === "toolGroup") allToolItems.push(...b.items);
  const fileEdits = extractFileEdits(allToolItems);
  return (
    <div key={g.turnId} className={s.rail}>
      {hasWork && (
        <>
          <TurnHeader
            workedMs={g.workedMs}
            collapsed={collapsed}
            onToggle={() => toggleTurn(g.turnId, collapsed)}
          />
          {!collapsed && (
            <div className={s.stack}>
              {g.thought && (
                <ThoughtBlock text={g.thought} durationMs={g.thoughtMs} />
              )}
              {g.blocks.map((b, i) => renderTurnBlock(b, i, ctx))}
            </div>
          )}
        </>
      )}
      {g.responseBlocks.length > 0 && (
        <div className={s.stackWide}>
          {g.responseBlocks.map((b, i) => {
            const isLastNarrative =
              b.kind === "narrative" &&
              !g.responseBlocks
                .slice(i + 1)
                .some((x) => x.kind === "narrative");
            return renderTurnBlock(
              b,
              i,
              ctx,
              isLastNarrative ? onContinue : undefined
            );
          })}
        </div>
      )}
      {fileEdits.length > 0 && (
        <EditedFilesCard edits={fileEdits} onAddDiffNote={onAddDiffNote} />
      )}
    </div>
  );
}

export function renderTurnBlock(
  b: TurnBlock,
  i: number,
  ctx: RenderCtx,
  onContinue?: (text: string) => void
) {
  if (b.kind === "narrative") {
    if (onContinue) {
      return (
        <AssistantMessage
          key={`n-${i}`}
          text={b.text}
          showAvatar={false}
          onContinue={onContinue}
        />
      );
    }
    return (
      <div key={`n-${i}`} className={`md ${s.narrative}`}>
        <MarkdownBody text={b.text} />
      </div>
    );
  }
  if (b.kind === "compact") {
    return (
      <div key={`c-${i}`} className={s.compactBoundary}>
        <Icon name="layers" size={11} />
        <span>{b.text}</span>
      </div>
    );
  }
  if (b.kind === "remoteApproval") {
    return (
      <div key={`ra-${i}`} className={s.remoteApproval}>
        <Icon name="shield" size={11} />
        <span>
          {b.tool
            ? `${b.tool} · answered on another device`
            : "Answered on another device"}
        </span>
      </div>
    );
  }
  if (b.kind === "error") {
    return (
      <div key={`e-${i}`} className={s.errorBlock}>
        <span className={s.errorIcon} aria-hidden>
          <Icon name="x" size={11} />
        </span>
        <span>{b.text}</span>
      </div>
    );
  }
  if (b.kind === "question") {
    const view = ctx.questions.get(b.questionId);
    if (!view) return null;
    return <AnsweredQuestion key={`q-${b.questionId}`} view={view} />;
  }
  if (b.kind === "subagent") {
    const stored = ctx.subagents.byTaskId.get(b.taskId);
    const live = ctx.taskProgress[b.taskId];
    if (!stored && !live) return null;
    // Live progress last: while the agent runs it is the fresher half, and it
    // stops arriving the moment the host writes the closing event.
    const task: SubagentTaskView = { ...stored, ...live, taskId: b.taskId };
    return (
      <SubagentCard
        key={`sa-${b.taskId}`}
        task={task}
        fallbackMs={ctx.subagents.elapsed.get(b.taskId)}
      />
    );
  }
  if (b.kind === "toolGroup") {
    // Write/Edit tool groups render as Cursor-style inline diff previews —
    // one mini-diff card per file, in conversation order, instead of the
    // generic collapsible "Edited 3 files" bucket.
    if (b.bucket === "edit") {
      const inlineEdits = extractFileEdits(b.items);
      if (inlineEdits.length > 0) {
        return (
          <div key={`ie-${i}-${b.items[0].id}`} className={s.stackWide}>
            {inlineEdits.map((entry) => (
              <InlineEditPreview
                key={entry.id}
                entry={entry}
                onOpenFull={() => undefined}
              />
            ))}
          </div>
        );
      }
    }
    return (
      <ToolGroupCard
        key={`tg-${i}-${b.items[0].id}`}
        bucket={b.bucket}
        items={b.items}
      />
    );
  }
  // plan — only render the LATEST revision inline. Older revisions are
  // reachable via the card's built-in rev picker, so showing a stack of
  // "superseded" cards is just visual noise. This keeps the transcript
  // clean: at most one plan card surfaces at the end of the run.
  const view = ctx.views.get(b.revisionId);
  if (!view) return null;
  const ordinal = ctx.ordered.indexOf(view) + 1;
  const previous = ordinal > 1 ? ctx.ordered[ordinal - 2] : undefined;
  const isLatest = ordinal === ctx.ordered.length;
  if (!isLatest) return null;
  return (
    <PlanCard
      key={`p-${b.revisionId}`}
      view={view}
      previous={previous}
      isLatest={isLatest}
      ordinal={ordinal}
    />
  );
}
