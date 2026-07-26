// ─────────────────────────────────────────────────────────────
// Hydration-style inline comment threads.
//
// useQuoteHighlights tags the commented block (paragraph / list
// item / heading / blockquote / pre / table cell) with a
// `data-plan-comment-id` attribute and a left-rule class. This
// component then walks those tagged blocks, injects a sibling
// slot element directly after each one, and uses React portals
// to render the actual comment thread UI inside that slot.
//
// The thread bubble itself lives in InlineThreadCard.tsx — this
// file only handles slot lifecycle (injection / cleanup) and
// the document-level click-to-pin interaction.
// ─────────────────────────────────────────────────────────────

import { RefObject, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { InlineThreadCard } from "./InlineThreadCard";
import type { PlanCommentView } from "./types";
// The slot is styled together with the card it hosts — the reveal animates
// both at once, and a CSS module can only name classes it declares itself.
import s from "./InlineThreadCard.module.scss";

interface Props {
  /** The doc container that holds the rendered markdown. */
  docRef: RefObject<HTMLElement | null>;
  /** Threaded root comments — replies live on each comment's `replies`. */
  comments: PlanCommentView[];
  /** Disable mutations on superseded revisions. */
  locked: boolean;
  /** Bump to force a re-walk when the body or comment list changes. */
  redrawKey: string;
}

export function InlineCommentThreads({
  docRef,
  comments,
  locked,
  redrawKey
}: Props) {
  const [slots, setSlots] = useState<Map<string, HTMLElement>>(new Map());
  /** Sticky-open commentId: the user clicked a line and wants the thread
   *  to stay visible even after the mouse leaves. Cleared by clicking
   *  outside any commented line or thread. */
  const [pinnedId, setPinnedId] = useState<string | null>(null);

  const quoted = useMemo(() => comments.filter((c) => !!c.quote), [comments]);

  // ── Slot injection ────────────────────────────────────────
  useEffect(() => {
    const root = docRef.current;
    if (!root) return;

    root
      .querySelectorAll(".plan-inline-thread-slot")
      .forEach((el) => el.remove());

    const next = new Map<string, HTMLElement>();
    for (const c of quoted) {
      if (c.resolvedInRevisionId) continue;
      const block = root.querySelector<HTMLElement>(
        `[data-plan-comment-id="${CSS.escape(c.commentId)}"]`
      );
      if (!block) continue;
      const parent = block.parentElement;
      if (!parent) continue;
      // <li> when inside a UL/OL to keep the HTML valid; otherwise <div>.
      const tag: "div" | "li" =
        parent.tagName === "UL" || parent.tagName === "OL" ? "li" : "div";
      const slot = document.createElement(tag);
      // `plan-inline-thread-slot` is the query contract PlanFullView uses to
      // pin a thread open; the module class carries the styling.
      slot.className = `plan-inline-thread-slot ${s.slot}`;
      slot.dataset.commentId = c.commentId;
      block.insertAdjacentElement("afterend", slot);
      next.set(c.commentId, slot);
    }
    setSlots(next);

    return () => {
      root
        .querySelectorAll(".plan-inline-thread-slot")
        .forEach((el) => el.remove());
    };
  }, [docRef, quoted, redrawKey]);

  // ── Click-to-pin ─────────────────────────────────────────
  useEffect(() => {
    const root = docRef.current;
    if (!root) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      // Click inside an open thread → keep it open.
      if (target.closest(`.${s.thread}`)) return;
      // Click on a commented line → toggle.
      if (root.contains(target)) {
        const block = target.closest<HTMLElement>("[data-plan-comment-id]");
        if (block) {
          const id = block.getAttribute("data-plan-comment-id");
          setPinnedId((prev) => (prev === id ? null : id));
          return;
        }
      }
      // Anywhere else → unpin.
      setPinnedId(null);
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [docRef]);

  // ── Apply pinned class on slots + lines ──────────────────
  useEffect(() => {
    const root = docRef.current;
    if (!root) return;
    root
      .querySelectorAll(".is-pinned")
      .forEach((el) => el.classList.remove("is-pinned"));
    if (!pinnedId) return;
    const slot = root.querySelector(
      `.plan-inline-thread-slot[data-comment-id="${CSS.escape(pinnedId)}"]`
    );
    slot?.classList.add("is-pinned");
    const line = root.querySelector(
      `[data-plan-comment-id="${CSS.escape(pinnedId)}"]`
    );
    line?.classList.add("is-pinned");
  }, [pinnedId, docRef, slots]);

  // ── Portal-render thread cards into their slots ──────────
  return (
    <>
      {Array.from(slots.entries()).map(([id, slot]) => {
        const c = quoted.find((x) => x.commentId === id);
        if (!c) return null;
        const pinNumber = quoted.indexOf(c) + 1;
        return createPortal(
          <InlineThreadCard
            key={id}
            comment={c}
            pinNumber={pinNumber}
            locked={locked}
          />,
          slot
        );
      })}
    </>
  );
}
