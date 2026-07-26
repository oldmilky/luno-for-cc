// ─────────────────────────────────────────────────────────────
// One inline-thread bubble — the actual UI rendered by
// InlineCommentThreads via React portal into a DOM slot
// adjacent to the commented line.
//
// Modes:
//   - default : header + quote + body + action toolbar
//   - editing : body replaced with a textarea + save/cancel
//   - replying: same body, reply textarea below the thread
//
// All mutations dispatch via the rpc layer. The host writes the
// resulting timeline event back, the webview reducer updates,
// and React re-renders this card with the new comment data.
// State here is purely UI-local (which textarea is open,
// what's being typed); nothing about the comment itself lives
// here.
// ─────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { EXPAND, enterAt } from "../../design/motion";
import { Icon } from "../../design/icons";
import { Tooltip } from "../../design/primitives";
import { send } from "../../lib/rpc";
import { formatRelativeTime } from "./summary";
import { truncate } from "./utils";
import type { PlanCommentView } from "./types";
import s from "./InlineThreadCard.module.scss";
import btn from "./PlanButton.module.scss";

interface Props {
  comment: PlanCommentView;
  pinNumber: number;
  /** When the parent revision is superseded, all controls disable. */
  locked: boolean;
}

export function InlineThreadCard({ comment, pinNumber, locked }: Props) {
  const [editing, setEditing] = useState(false);
  const [draftEdit, setDraftEdit] = useState(comment.body);
  const [replying, setReplying] = useState(false);
  const [draftReply, setDraftReply] = useState("");

  const resolvedAuto = !!comment.resolvedInRevisionId;
  const resolvedManual = !!comment.resolvedAt;
  const resolved = resolvedAuto || resolvedManual;
  const editable = !locked && !resolvedAuto;

  // Re-sync the draft when the comment body changes externally — e.g.
  // the user edited the same comment via the sidebar list. Without this
  // an open inline editor would silently overwrite the sibling change.
  useEffect(() => {
    if (!editing) setDraftEdit(comment.body);
  }, [comment.body, editing]);

  const startEdit = () => {
    if (!editable) return;
    setDraftEdit(comment.body);
    setEditing(true);
    setReplying(false);
  };

  const saveEdit = () => {
    const body = draftEdit.trim();
    if (!body || body === comment.body.trim()) return;
    send({ type: "planEditComment", commentId: comment.commentId, body });
    setEditing(false);
  };

  const submitReply = () => {
    const body = draftReply.trim();
    if (!body || locked) return;
    send({
      type: "planReplyComment",
      revisionId: comment.revisionId,
      parentCommentId: comment.commentId,
      body
    });
    setDraftReply("");
    setReplying(false);
  };

  const toggleResolve = () => {
    if (locked) return;
    send({
      type: resolvedManual ? "planReopenComment" : "planResolveComment",
      commentId: comment.commentId
    });
  };

  const remove = () => {
    if (!editable) return;
    send({ type: "planDeleteComment", commentId: comment.commentId });
  };

  const className = [
    s.thread,
    editing && s.editing,
    replying && s.replying,
    resolved && s.resolved
  ]
    .filter(Boolean)
    .join(" ");

  // The card root stays a plain <div> on purpose. `.slot .thread` in the
  // stylesheet owns this element's opacity and transform for the hover /
  // pin reveal, and framer writes those inline — an inline opacity would
  // outrank the hover rule and pin every thread permanently open. Only the
  // card's interior animates here.
  return (
    <div className={className}>
      <header className={s.head}>
        <span className={`${s.pin}${resolved ? ` ${s.resolved}` : ""}`}>
          {pinNumber}
        </span>
        <span className={s.time}>
          {comment.editedAt
            ? `edited ${formatRelativeTime(comment.editedAt)}`
            : formatRelativeTime(comment.ts)}
        </span>
        {resolvedAuto && <span className={s.status}>addressed</span>}
        {resolvedManual && !resolvedAuto && (
          <span className={s.status}>resolved</span>
        )}
      </header>

      {comment.quote && (
        <Tooltip label={comment.quote} wrap>
          <blockquote className={s.quote}>
            {truncate(comment.quote, 200)}
          </blockquote>
        </Tooltip>
      )}

      {/* Body ⇄ editor swap. Both arms run at once rather than under
          `mode="wait"`: EXPAND is symmetric, so two of them crossing sum to a
          straight lerp between the two heights — monotonic, no bulge — and
          the card settles in one 220ms beat instead of two. Waiting would
          also hold the textarea's focus back until the second beat. */}
      <AnimatePresence initial={false}>
        {!editing ? (
          <motion.div
            key="body"
            {...EXPAND}
            className={`${s.body}${resolvedManual ? ` ${s.strike}` : ""}`}
            onClick={() => editable && startEdit()}
            role={editable ? "button" : undefined}
            tabIndex={editable ? 0 : undefined}
          >
            {comment.body}
          </motion.div>
        ) : (
          <ThreadEditor
            key="editor"
            autoFocus
            rows={3}
            value={draftEdit}
            onChange={setDraftEdit}
            onSubmit={saveEdit}
            onCancel={() => {
              setEditing(false);
              setDraftEdit(comment.body);
            }}
            submitLabel="Save"
            submitDisabled={
              !draftEdit.trim() || draftEdit.trim() === comment.body.trim()
            }
          />
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {comment.replies.length > 0 && (
          <motion.ul key="replies" {...EXPAND} className={s.replies}>
            {comment.replies.map((r, i) => (
              // A reply is a row arriving in a list — it lands after the RPC
              // round-trip, so it always mounts into an already-open card.
              <motion.li
                key={r.eventId}
                {...enterAt(i)}
                className={s.reply}
              >
                <span className={s.replyRail} aria-hidden>
                  {i === comment.replies.length - 1 ? "└" : "├"}
                </span>
                <div className={s.replyContent}>
                  <div className={s.replyMeta}>
                    {formatRelativeTime(r.ts)}
                    {r.editedAt ? <span> · edited</span> : null}
                  </div>
                  <div className={s.replyBody}>{r.body}</div>
                </div>
              </motion.li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {replying && (
          <ThreadEditor
            key="reply"
            autoFocus
            rows={2}
            placeholder="Reply…"
            value={draftReply}
            onChange={setDraftReply}
            onSubmit={submitReply}
            onCancel={() => {
              setReplying(false);
              setDraftReply("");
            }}
            submitLabel="Reply"
            submitDisabled={!draftReply.trim() || locked}
          />
        )}
      </AnimatePresence>

      {/* The toolbar is the third arm of the same accordion — it collapses as
          an editor takes its place, so both halves move on one curve. */}
      <AnimatePresence initial={false}>
        {!editing && !replying && (
          <motion.footer key="foot" {...EXPAND} className={s.foot}>
            {!locked && (
              <FootBtn
                icon="dots"
                label="Reply"
                onClick={() => setReplying(true)}
              />
            )}
            {!locked && !resolvedAuto && (
              <FootBtn
                icon={resolvedManual ? "refresh" : "check"}
                label={resolvedManual ? "Reopen" : "Resolve"}
                onClick={toggleResolve}
                active={resolvedManual}
              />
            )}
            {editable && (
              <FootBtn icon="edit" label="Edit" onClick={startEdit} />
            )}
            <span className={s.footSpacer} />
            {editable && (
              <FootBtn
                icon="x"
                label=""
                onClick={remove}
                tone="danger"
                title="Delete"
              />
            )}
          </motion.footer>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Local helper components ──────────────────────────────────

interface ThreadEditorProps {
  autoFocus?: boolean;
  rows: number;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submitLabel: string;
  submitDisabled: boolean;
}

function ThreadEditor({
  autoFocus,
  rows,
  value,
  placeholder,
  onChange,
  onSubmit,
  onCancel,
  submitLabel,
  submitDisabled
}: ThreadEditorProps) {
  // The preset lives on the editor's own root rather than at each call site:
  // both uses (edit-in-place and reply) are the same gesture, and this way
  // AnimatePresence can drive it directly as its keyed child.
  return (
    <motion.div {...EXPAND} className={s.editor}>
      <textarea
        autoFocus={autoFocus}
        className={s.textarea}
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            onSubmit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <div className={s.actions}>
        <button
          type="button"
          className={`${btn.btn} ${s.compact}`}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className={`${btn.btn} ${btn.primary} ${s.compact}`}
          onClick={onSubmit}
          disabled={submitDisabled}
        >
          {submitLabel}
        </button>
      </div>
    </motion.div>
  );
}

interface FootBtnProps {
  icon: import("../../design/icons").IconName;
  label: string;
  onClick: () => void;
  active?: boolean;
  tone?: "default" | "danger";
  title?: string;
}

function FootBtn({ icon, label, onClick, active, tone, title }: FootBtnProps) {
  const className = [
    s.footBtn,
    active && s.active,
    tone === "danger" && s.danger
  ]
    .filter(Boolean)
    .join(" ");
  const button = (
    <button type="button" className={className} onClick={onClick}>
      <Icon name={icon} size={9} />
      {label && <span>{label}</span>}
    </button>
  );

  // A tooltip only where it says something the button does not. `title ?? label`
  // meant three of these — Reply, Resolve, Edit — echoed back the text already
  // rendered beside their icon. Now only an explicit `title` produces one, which
  // in practice is the icon-only Delete.
  return title ? <Tooltip label={title}>{button}</Tooltip> : button;
}
