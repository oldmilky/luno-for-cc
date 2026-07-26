// ─────────────────────────────────────────────────────────────
// Compact comments list for the PlanModal sidebar. Shows every
// non-deleted comment on the current revision (whole-plan and
// inline-quoted alike) so the user always has a visible record
// of feedback they've added — the Review dropdown alone left
// whole-plan comments invisible after submission.
//
// Each row supports in-place edit: tap to expand into a
// textarea + Save / Cancel / Delete row. Inline-quoted comments
// also expose a "jump to passage" action that scrolls and
// flashes the matching highlight in the rendered markdown.
// ─────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { EXPAND, enterAt } from "../../design/motion";
import { Icon } from "../../design/icons";
import { Chip, Tooltip } from "../../design/primitives";
import { send } from "../../lib/rpc";
import { formatRelativeTime } from "./summary";
import { truncate } from "./utils";
import type { PlanCommentMeta, PlanCommentView } from "./types";
import s from "./SidebarCommentsList.module.scss";
import btn from "./PlanButton.module.scss";

interface SidebarComment extends PlanCommentMeta {
  eventId: string;
  ts: number;
  replies?: PlanCommentView[];
}

interface Props {
  comments: SidebarComment[];
  locked: boolean;
  /** Scroll the highlight matching `commentId` into view + flash it. */
  onJumpToHighlight: (commentId: string) => void;
}

export function SidebarCommentsList({ comments, locked, onJumpToHighlight }: Props) {
  // Inline-anchored comments now render directly inside the document via
  // InlineCommentThreads — show only whole-plan comments here so the
  // sidebar isn't a redundant duplicate. Whole-plan comments don't have
  // a doc anchor, so they need a home.
  const visible = comments.filter((c) => !c.deleted && !c.quote);

  // The section hides entirely when there's nothing to show — the header
  // dropdown (Review ▾) is the entry point for adding whole-plan comments.
  // That used to be a bare `return null`, which meant deleting the last
  // comment took the whole panel out on a single frame. The presence has to
  // live here rather than in PlanFullView: the parent renders this component
  // unconditionally, so this is the only place that can watch it leave.
  // The extra wrapper is what EXPAND collapses — the section's own padding
  // and border would survive `height: 0` and leave a 20px ghost behind.
  return (
    <AnimatePresence initial={false}>
      {visible.length > 0 && (
        <motion.div key="comments" {...EXPAND} className={s.sectionWrap}>
          <section className={s.section}>
            <div className={s.sectionHead}>
              <Icon name="at" size={11} />
              <span>Comments</span>
              <Chip tone="warn">{visible.length}</Chip>
            </div>
            <ul className={s.list}>
              {/* `initial={false}` is the load-bearing part: without it every
                  row staggers in each time the plan view opens, which reads as
                  the list being slow to load rather than as choreography. Only
                  rows that arrive afterwards should animate. */}
              <AnimatePresence initial={false}>
                {visible.map((c, i) => (
                  <CommentRow
                    key={c.eventId}
                    index={i}
                    comment={c}
                    locked={locked}
                    onJumpToHighlight={onJumpToHighlight}
                  />
                ))}
              </AnimatePresence>
            </ul>
          </section>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

interface RowProps {
  comment: SidebarComment;
  /** Position in the list — feeds the stagger on arrival. */
  index: number;
  locked: boolean;
  onJumpToHighlight: (commentId: string) => void;
}

function CommentRow({ comment, index, locked, onJumpToHighlight }: RowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyDraft, setReplyDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isInline = !!comment.quote;
  const isResolvedAuto = !!comment.resolvedInRevisionId;
  const isResolvedManual = !!comment.resolvedAt;
  const isResolved = isResolvedAuto || isResolvedManual;
  const editable = !locked && !isResolvedAuto;
  const replies = comment.replies ?? [];

  useEffect(() => {
    if (editing) {
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.selectionStart = el.selectionEnd = el.value.length;
        }
      });
    }
  }, [editing]);

  // External edits (e.g. via the doc-highlight popover) refresh our draft
  // when the row isn't actively editing.
  useEffect(() => {
    if (!editing) setDraft(comment.body);
  }, [comment.body, editing]);

  const dirty = draft.trim() !== comment.body.trim();
  const valid = draft.trim().length > 0;

  const save = () => {
    if (!valid || !dirty || !editable) return;
    send({ type: "planEditComment", commentId: comment.commentId, body: draft.trim() });
    setEditing(false);
  };

  const remove = () => {
    if (!editable) return;
    send({ type: "planDeleteComment", commentId: comment.commentId });
  };

  const submitReply = () => {
    const body = replyDraft.trim();
    if (!body || locked) return;
    send({
      type: "planReplyComment",
      revisionId: comment.revisionId,
      parentCommentId: comment.commentId,
      body
    });
    setReplyDraft("");
    setReplyOpen(false);
  };

  const toggleResolve = () => {
    if (locked) return;
    if (isResolvedManual) {
      send({ type: "planReopenComment", commentId: comment.commentId });
    } else {
      send({ type: "planResolveComment", commentId: comment.commentId });
    }
  };

  // enterAt, not EXPAND: a row is a card arriving in a list, and the stagger
  // is what keeps a batch of them from landing as one block. It has no exit
  // counterpart in the language, so a deleted row still leaves on a frame —
  // ENTER / ENTER_CARD / enterAt() are arrival-only presets.
  return (
    <motion.li
      {...enterAt(index)}
      className={[
        s.row,
        isInline ? s.inline : s.general,
        isResolved && s.resolved,
        editing && s.editing
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className={s.head}>
        {isInline ? (
          <Chip tone="info">passage</Chip>
        ) : (
          <Chip tone="default">whole-plan</Chip>
        )}
        <span className={s.time}>
          {comment.editedAt
            ? `edited ${formatRelativeTime(comment.editedAt)}`
            : formatRelativeTime(comment.ts)}
        </span>
        {isResolvedAuto && <span className={s.tag}>addressed</span>}
        {isResolvedManual && !isResolvedAuto && (
          <span className={s.tag}>resolved</span>
        )}
      </div>

      {comment.quote && (
        <Tooltip label="Jump to passage in plan">
          <button
            type="button"
            className={s.quote}
            onClick={() => onJumpToHighlight(comment.commentId)}
          >
            “{truncate(comment.quote, 100)}”
          </button>
        </Tooltip>
      )}

      {/* Body ⇄ editor swap, both arms at once — see InlineThreadCard: two
          symmetric EXPANDs crossing lerp the row's height straight from one
          to the other, so there is nothing for `mode="wait"` to protect
          against and it would only double the beat. */}
      <AnimatePresence initial={false}>
        {!editing ? (
          <motion.div
            key="body"
            {...EXPAND}
            className={s.body}
            onClick={() => editable && setEditing(true)}
          >
            {comment.body}
          </motion.div>
        ) : (
          <motion.div key="edit" {...EXPAND} className={s.editWrap}>
            <textarea
              ref={textareaRef}
              className={s.edit}
              value={draft}
              rows={3}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  save();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setEditing(false);
                  setDraft(comment.body);
                }
              }}
            />
            <div className={s.actions}>
              <button
                type="button"
                className={s.delete}
                onClick={remove}
                disabled={!editable}
              >
                <Icon name="x" size={10} />
                Delete
              </button>
              <span className={s.spacer} />
              <button
                type="button"
                className={`${btn.btn} ${s.compact}`}
                onClick={() => {
                  setEditing(false);
                  setDraft(comment.body);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className={`${btn.btn} ${btn.primary} ${s.compact}`}
                onClick={save}
                disabled={!valid || !dirty || !editable}
              >
                Save
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {replies.length > 0 && (
          <motion.ul key="replies" {...EXPAND} className={s.replies}>
            {replies.map((r, i) => (
              <motion.li key={r.eventId} {...enterAt(i)} className={s.reply}>
                <div className={s.replyMeta}>
                  <Icon name="user" size={10} />
                  <span>{formatRelativeTime(r.ts)}</span>
                  {r.editedAt ? <span>· edited</span> : null}
                </div>
                <div className={s.replyBody}>{r.body}</div>
              </motion.li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {replyOpen && (
          <motion.div key="reply" {...EXPAND} className={s.replyCompose}>
            <textarea
              autoFocus
              className={s.edit}
              placeholder="Reply…"
              rows={2}
              value={replyDraft}
              onChange={(e) => setReplyDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  submitReply();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setReplyOpen(false);
                  setReplyDraft("");
                }
              }}
            />
            <div className={s.actions}>
              <span className={s.spacer} />
              <button
                type="button"
                className={`${btn.btn} ${s.compact}`}
                onClick={() => {
                  setReplyOpen(false);
                  setReplyDraft("");
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className={`${btn.btn} ${btn.primary} ${s.compact}`}
                onClick={submitReply}
                disabled={!replyDraft.trim() || locked}
              >
                Reply
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Deliberately not animated. The toolbar is hidden at rest and revealed
          by `.row:hover` in CSS, and EXPAND's `animate` writes an inline
          `opacity: 1` — which outranks the class rule and would leave every
          row's toolbar showing permanently. */}
      {!editing && (
        <div className={s.foot}>
          {editable && (
            <button
              type="button"
              className={s.footBtn}
              onClick={() => setEditing(true)}
            >
              <Icon name="edit" size={10} />
              Edit
            </button>
          )}
          {!locked && (
            <button
              type="button"
              className={s.footBtn}
              onClick={() => setReplyOpen((v) => !v)}
            >
              <Icon name="dots" size={10} />
              Reply
            </button>
          )}
          {!locked && !isResolvedAuto && (
            <button
              type="button"
              className={s.footBtn}
              onClick={toggleResolve}
            >
              <Icon name={isResolvedManual ? "refresh" : "check"} size={10} />
              {isResolvedManual ? "Reopen" : "Resolve"}
            </button>
          )}
          {editable && (
            <button
              type="button"
              className={s.footDelete}
              onClick={remove}
            >
              <Icon name="x" size={10} />
              Delete
            </button>
          )}
        </div>
      )}
    </motion.li>
  );
}

