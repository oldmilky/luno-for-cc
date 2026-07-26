// ─────────────────────────────────────────────────────────────
// Inline expanded plan view. Replaces the previous PlanModal —
// renders directly inside the chat stream where the compact
// PlanCard was, instead of as a fixed overlay covering the
// webview viewport.
//
// Single-column stack (chat sidebars get narrow):
//   ┌─ header (title · time · path · actions · close) ─┐
//   │  progress bar                                     │
//   │  rendered markdown body (selection-+ comments)    │
//   │  comments list                                    │
//   │  tasks                                            │
//   │  questions                                        │
//   │  footer actions                                   │
//   └───────────────────────────────────────────────────┘
//
// Highlight-click and selection-+ flows still mount their own
// floating popovers anchored to the click/selection position;
// those remain `position: fixed` because they need to track
// scroll independently of the chat stream.
// ─────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../design/icons";
import { Chip, IconButton, Tooltip } from "../../design/primitives";
import { renderMarkdown } from "../chat/markdown";
import { send } from "../../lib/rpc";
import { AnimatePresence, motion } from "framer-motion";
import { ENTER, ENTER_CARD, EXPAND, SWAP, enterAt } from "../../design/motion";
import { PlanRevisionDiff } from "./PlanRevisionDiff";
import { PlanStepCard } from "./PlanStepCard";
import { QuestionCard } from "./QuestionCard";
import { SelectionCommentLayer } from "./SelectionCommentLayer";
import { PlanReviewDropdown } from "./PlanReviewDropdown";
import { SidebarCommentsList } from "./SidebarCommentsList";
import { InlineCommentThreads } from "./InlineCommentThreads";
import { unresolvedComments } from "./foldPlanState";
import { extractPlanSummary, formatRelativeTime } from "./summary";
import { useQuoteHighlights, QuoteEntry } from "./useQuoteHighlights";
import { compactPath } from "./utils";
import type { PlanCommentMeta, PlanRevisionView } from "./types";
import s from "./PlanFullView.module.scss";
import pbtn from "./PlanButton.module.scss";

/**
 * How long the jumped-to line stays flashed. Must equal `--motion-flash` in
 * themes/_base.scss, which times the keyframe this class runs: strip the class
 * early and the flash is cut off mid-animation, never reaching its final frame.
 */
const FLASH_MS = 1400;

interface Props {
  view: PlanRevisionView;
  previous?: PlanRevisionView;
  isLatest: boolean;
  ordinal: number;
  onCollapse: () => void;
}

export function PlanFullView({ view, previous, isLatest, ordinal, onCollapse }: Props) {
  const [showDiff, setShowDiff] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewAnchor, setReviewAnchor] = useState<{ right: number; top: number } | null>(null);
  const [, forceTick] = useState(0);
  const docRef = useRef<HTMLDivElement>(null);
  const reviewBtnRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const summary = useMemo(() => extractPlanSummary(view.meta.body), [view.meta.body]);
  const proceeded = !!view.meta.proceeded;
  // Treat a proceeded plan as locked for all editing surfaces — comments,
  // step controls, the Review dropdown, etc. The user can unlock it by
  // rewinding to this revision's checkpoint.
  const locked = !isLatest || proceeded;
  const pending = unresolvedComments(view).length;
  const tasks = view.meta.tasks;
  const completed = tasks.filter((t) => t.status === "completed").length;
  const progressPct = tasks.length > 0 ? Math.round((completed / tasks.length) * 100) : 0;

  const liveComments = useMemo(
    () => view.comments.filter((c) => !c.deleted),
    [view.comments]
  );

  const quotedComments = useMemo<Array<PlanCommentMeta & { ts: number }>>(
    () => liveComments.filter((c) => !!c.quote),
    [liveComments]
  );

  const quoteEntries = useMemo<QuoteEntry[]>(
    () =>
      quotedComments.map((c, i) => ({
        commentId: c.commentId,
        quote: c.quote!,
        resolved: !!c.resolvedInRevisionId || !!c.resolvedAt,
        pinNumber: i + 1,
        preview: c.body
      })),
    [quotedComments]
  );

  // Refresh relative timestamps every 30 s.
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  // Smoothly bring the expanded card into view when it first opens.
  useEffect(() => {
    rootRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // No onClick callback needed — InlineCommentThreads owns the
  // click-to-pin interaction itself by listening on the doc container.
  useQuoteHighlights(docRef, view.meta.body, showDiff ? [] : quoteEntries);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(view.meta.body);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = view.meta.body;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  const download = () => {
    const blob = new Blob([view.meta.body], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const fileName = view.meta.planFilePath
      ? view.meta.planFilePath.split("/").pop() || "plan.md"
      : `plan-revision-${ordinal}.md`;
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  const openReview = () => {
    const btn = reviewBtnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    setReviewAnchor({
      right: Math.max(8, window.innerWidth - r.right),
      top: r.bottom + 6
    });
    setReviewOpen(true);
  };

  const proceed = () => {
    send({ type: "planProceedRequest", revisionId: view.meta.revisionId });
    onCollapse();
  };

  /**
   * Scroll the commented line matching `commentId` into view + flash it +
   * pin its inline thread open. Called when the user clicks a row in the
   * sidebar comments list (whole-plan comments still use the sidebar).
   */
  const jumpToHighlight = (commentId: string) => {
    const container = docRef.current;
    if (!container) return;
    const block = container.querySelector<HTMLElement>(
      `[data-plan-comment-id="${CSS.escape(commentId)}"]`
    );
    if (!block) return;
    block.scrollIntoView({ behavior: "smooth", block: "center" });
    block.classList.remove("plan-line-flash");
    void block.offsetWidth;
    block.classList.add("plan-line-flash");
    setTimeout(() => block.classList.remove("plan-line-flash"), FLASH_MS);
    // Pin the matching slot open so the user can read/edit immediately
    // without having to hover.
    setTimeout(() => {
      container
        .querySelectorAll(".plan-inline-thread-slot.is-pinned")
        .forEach((el) => el.classList.remove("is-pinned"));
      const slot = container.querySelector(
        `.plan-inline-thread-slot[data-comment-id="${CSS.escape(commentId)}"]`
      );
      slot?.classList.add("is-pinned");
      block.classList.add("is-pinned");
    }, 320);
  };

  return (
    <motion.div ref={rootRef} {...ENTER_CARD} className={s.plan}>
      <header className={s.head}>
        <div className={s.headLeft}>
          <span className={s.icon} aria-hidden>
            <Icon name="book" size={13} />
          </span>
          <div className={s.titles}>
            <div className={s.title}>{summary.title}</div>
            <div className={s.subtitle}>
              <span>{formatRelativeTime(view.ts)}</span>
              {view.meta.planFilePath && (
                <>
                  <span className={s.dot}>·</span>
                  <Tooltip label={view.meta.planFilePath} wrap>
                    <span className={s.path}>{compactPath(view.meta.planFilePath)}</span>
                  </Tooltip>
                </>
              )}
              <span className={s.dot}>·</span>
              <span>rev {ordinal}</span>
              {!isLatest && (
                <>
                  <span className={s.dot}>·</span>
                  <span className={s.superseded}>superseded</span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className={s.headRight}>
          <IconButton
            icon="copy"
            title={copied ? "Copied!" : "Copy markdown"}
            size={26}
            onClick={copy}
          />
          <IconButton icon="arrow" title="Download .md" size={26} onClick={download} />
          {previous && view.meta.bodyChanged && (
            // There is nothing to diff against until a second revision lands,
            // which happens while this header is already on screen.
            <motion.span className={s.headSlot} {...ENTER}>
              <IconButton
                icon="branch"
                title={showDiff ? "Show body" : "Show diff vs previous"}
                size={26}
                active={showDiff}
                onClick={() => setShowDiff((d) => !d)}
              />
            </motion.span>
          )}
          <button
            ref={reviewBtnRef}
            type="button"
            className={`${s.toggle}${reviewOpen ? ` ${s.toggleActive}` : ""}`}
            onClick={() => (reviewOpen ? setReviewOpen(false) : openReview())}
            disabled={locked}
          >
            Review
            <Icon name={reviewOpen ? "chevronU" : "chevronD"} size={9} />
          </button>
          <IconButton
            icon="chevronU"
            title="Collapse"
            size={26}
            onClick={onCollapse}
          />
        </div>
      </header>

      {/* The card outlives the approval, so the banner has to be able to
          leave as well as arrive — `initial={false}` keeps it from replaying
          on a plan that was already proceeded when the view opened. */}
      <AnimatePresence initial={false}>
        {proceeded && (
          <motion.div key="banner" className={s.banner} role="status" {...EXPAND}>
            <Icon name="check" size={11} />
            <span>Plan in progress — rewind to this revision to edit.</span>
          </motion.div>
        )}
      </AnimatePresence>

      {tasks.length > 0 && (
        // Fades rather than expands: EXPAND animates to `height: auto`, and
        // the bar inside is sized in percent — an auto-height rail would
        // resolve that to nothing and the progress bar would vanish.
        <Tooltip label={`${completed}/${tasks.length} tasks complete`}>
          <motion.div {...ENTER} className={s.progress}>
            <div
              className={s.progressBar}
              style={{ width: `${progressPct}%` }}
              role="progressbar"
              aria-valuenow={progressPct}
              aria-valuemin={0}
              aria-valuemax={100}
            />
          </motion.div>
        </Tooltip>
      )}

      <div className={s.doc}>
        {/* Keyed so the two panes are distinct children and the incoming one
            actually remounts and plays its arrival. Deliberately not wrapped
            in AnimatePresence: keeping the outgoing pane alive would delay the
            mount of the body by a frame or more, and useQuoteHighlights only
            re-runs on the commit that attaches docRef — the highlights would
            come back missing. */}
        {showDiff && previous ? (
          <motion.div key="diff" {...ENTER}>
            <PlanRevisionDiff previous={previous.meta.body} current={view.meta.body} />
          </motion.div>
        ) : (
          <motion.div key="body" className={s.docStack} {...ENTER}>
            <div ref={docRef} className={`md ${s.docMd}`}>
              {renderMarkdown(view.meta.body, { preserveHeadings: true })}
            </div>
            {/* Hydrate the rendered markdown with comment threads inline
                at each highlight's containing block. Uses React portals
                so the threads sit *between* paragraphs, not in a separate
                section pushed to the bottom of the doc. */}
            <InlineCommentThreads
              docRef={docRef}
              comments={view.rootComments}
              locked={locked}
              redrawKey={view.meta.body + ":" + view.comments.length}
            />
            <SelectionCommentLayer
              containerRef={docRef}
              revisionId={view.meta.revisionId}
              locked={locked}
            />
          </motion.div>
        )}
      </div>

      <div className={s.sections}>
        <SidebarCommentsList
          comments={view.rootComments}
          locked={locked}
          onJumpToHighlight={jumpToHighlight}
        />

        {/* Both sections land after the plan body — steps on the first
            TodoWrite, questions on an AskUserQuestion — and both can go away
            again on a rewind, so they open and close rather than snapping. */}
        <AnimatePresence initial={false}>
          {tasks.length > 0 && (
            <motion.section key="steps" className={s.section} {...EXPAND}>
              <div className={s.sectionHead}>
                <Icon name="check" size={11} />
                <span>Plan steps</span>
                <Chip tone="default">
                  {completed}/{tasks.length}
                </Chip>
              </div>
              <PlanStepList
                tasks={tasks}
                revisionId={view.meta.revisionId}
                comments={view.comments}
                locked={locked}
              />
            </motion.section>
          )}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {view.questions.length > 0 && (
            <motion.section key="questions" className={s.section} {...EXPAND}>
              <div className={s.sectionHead}>
                <Icon name="bolt" size={11} />
                <span>Questions</span>
              </div>
              {view.questions.map((q, i) => {
                const ans = view.answers.find((a) => a.questionId === q.questionId);
                return (
                  // The stagger lives here rather than in QuestionCard: the
                  // parent is the only one that knows the row's position.
                  <motion.div key={q.eventId} {...enterAt(i)}>
                    <QuestionCard question={q} answer={ans} locked={locked} />
                  </motion.div>
                );
              })}
            </motion.section>
          )}
        </AnimatePresence>

        <section className={s.footer}>
          {/* One slot, two mutually exclusive buttons: the primary action
              changes under the user as the last comment is resolved. `wait`
              so the outgoing one is gone before the incoming one starts —
              sharing the slot for a frame makes the footer jump. */}
          <AnimatePresence mode="wait" initial={false}>
            {isLatest && !proceeded && pending > 0 && (
              <motion.button
                key="resubmit"
                {...SWAP}
                type="button"
                className={`${pbtn.btn} ${pbtn.primary} ${pbtn.block}`}
                onClick={() => {
                  send({ type: "planResubmit", revisionId: view.meta.revisionId });
                  onCollapse();
                }}
              >
                Update plan with feedback ({pending})
              </motion.button>
            )}
            {isLatest && !proceeded && pending === 0 && (
              <motion.button
                key="proceed"
                {...SWAP}
                type="button"
                className={`${pbtn.btn} ${pbtn.success} ${pbtn.block}`}
                onClick={proceed}
              >
                <Icon name="check" size={11} />
                Proceed
              </motion.button>
            )}
          </AnimatePresence>
          <button
            type="button"
            className={`${pbtn.btn} ${pbtn.block}`}
            onClick={() => {
              send({ type: "planRewindTo", revisionId: view.eventId });
              onCollapse();
            }}
          >
            <Icon name="history" size={11} />
            Rewind to this revision
          </button>
        </section>
      </div>

      <AnimatePresence>
        {reviewOpen && reviewAnchor && (
          <PlanReviewDropdown
            revisionId={view.meta.revisionId}
            locked={locked}
            anchor={reviewAnchor}
            onClose={() => setReviewOpen(false)}
          />
        )}
      </AnimatePresence>

    </motion.div>
  );
}

const STEP_ITEM_CLASS = {
  active: s.stepActive,
  completed: s.stepCompleted,
  upcoming: s.stepUpcoming
} as const;

/**
 * Renders the plan tasks in three groups: completed/accepted/skipped above,
 * one active step in the middle (with full Accept/Modify/Skip controls),
 * and upcoming steps faded below. This is the Antigravity-style gating —
 * the user reviews and approves one step at a time instead of seeing the
 * whole plan as a flat to-do list.
 */
function PlanStepList({
  tasks,
  revisionId,
  comments,
  locked
}: {
  tasks: import("./types").PlanTask[];
  revisionId: string;
  comments: import("./types").PlanCommentMeta[];
  locked: boolean;
}) {
  // Active step = first in_progress, else first pending. Skipped/accepted/
  // completed never claim the active slot.
  const activeIdx = (() => {
    const inProg = tasks.findIndex((t) => t.status === "in_progress");
    if (inProg !== -1) return inProg;
    return tasks.findIndex((t) => t.status === "pending");
  })();

  return (
    <ol className={s.stepList}>
      {tasks.map((task, i) => {
        const mode: "active" | "completed" | "upcoming" =
          i === activeIdx ? "active" : i < activeIdx || activeIdx === -1 ? "completed" : "upcoming";
        // When activeIdx === -1 (everything is done/skipped), treat all as
        // completed so they all collapse into the read-only summary form.
        return (
          // The whole list arrives in one commit when the agent posts its
          // todos, so the rows are staggered — enterAt caps itself, so a
          // twenty-step plan does not turn into a two-second reveal.
          <motion.li key={task.id} className={STEP_ITEM_CLASS[mode]} {...enterAt(i)}>
            <PlanStepCard
              task={task}
              index={i}
              total={tasks.length}
              revisionId={revisionId}
              mode={mode}
              comments={comments}
              locked={locked}
            />
          </motion.li>
        );
      })}
    </ol>
  );
}
