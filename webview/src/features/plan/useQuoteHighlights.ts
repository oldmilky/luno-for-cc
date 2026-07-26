// ─────────────────────────────────────────────────────────────
// Block-level quote hydration. After the markdown renders, we
// walk each block element (paragraph, list-item, heading,
// blockquote, table cell, pre) and check whether its textContent
// contains the comment's quote string. The first block that does
// becomes the comment's anchor: it gets a `plan-line-commented`
// class, the comment's id/pin metadata as data-attributes, and a
// numbered pin badge appended at the end of the line.
//
// Why block-level (not text-span <mark>) wrapping:
//
//   Real-world markdown selections cross formatting boundaries —
//   `<strong>Phase 0</strong> — Coverage…` is two text nodes,
//   and Range.surroundContents() can't span those. The previous
//   implementation tried each text node in isolation and silently
//   aborted on multi-node quotes, which is why the user saw a
//   correct count "(3 comments)" but no rendered threads.
//
//   Block-level matching always succeeds when the quote came from
//   a single paragraph/list-item, which is the overwhelmingly
//   common case. The visual is a left accent rule + line-end
//   pin badge, instead of a per-word underline.
// ─────────────────────────────────────────────────────────────

import { RefObject, useLayoutEffect } from "react";

export interface QuoteEntry {
  commentId: string;
  quote: string;
  resolved: boolean;
  /** Sequential 1-based number — surfaced as a small pin badge on the
   * commented line so users can match it visually with the matching
   * margin / inline thread. */
  pinNumber: number;
  /** Short preview surfaced via the [data-plan-preview]:hover::before
   * tooltip on the line. */
  preview?: string;
}

const BLOCK_SELECTOR =
  "p, li, blockquote, h1, h2, h3, h4, h5, h6, pre, td, dd";

export function useQuoteHighlights(
  containerRef: RefObject<HTMLElement | null>,
  /** Re-key whenever the body changes so we re-walk after a re-render. */
  bodyKey: string,
  quotes: QuoteEntry[],
  /** Optional callback when a commented line is clicked. Receives the
   * line's bounding rect so the caller can anchor a popover. */
  onClick?: (commentId: string, rect: DOMRect) => void
): void {
  // useLayoutEffect (not useEffect) is critical here. <InlineCommentThreads>
  // — a child of the same parent — walks the doc looking for our marker
  // attributes. Child useEffects fire before parent useEffects, so a
  // regular useEffect would let the children walk a doc with no markers.
  // useLayoutEffect bypasses that ordering: all layout effects fire
  // (parent and child) before any regular effect runs.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Strip prior markers so we work from a clean slate. We track our
    // own marker classes/attrs rather than mutating node structure, so
    // cleanup is a simple class/attr removal — no DOM unwrapping needed.
    const stale = container.querySelectorAll<HTMLElement>(
      "[data-plan-comment-id]"
    );
    stale.forEach((el) => {
      el.classList.remove("plan-line-commented", "plan-line-resolved");
      el.removeAttribute("data-plan-comment-id");
      el.removeAttribute("data-plan-pin-number");
      el.removeAttribute("data-plan-preview");
      el.querySelectorAll(".plan-line-pin").forEach((p) => p.remove());
    });

    if (quotes.length === 0) return;

    // Sort by length desc so a longer quote that contains a shorter one
    // claims the more specific block first.
    const ordered = [...quotes].sort((a, b) => b.quote.length - a.quote.length);
    const blocks = Array.from(container.querySelectorAll(BLOCK_SELECTOR));
    const claimed = new Set<Element>();

    for (const q of ordered) {
      const needle = collapseWhitespace(q.quote);
      if (!needle) continue;
      for (const block of blocks) {
        if (claimed.has(block)) continue;
        // Skip blocks nested inside another claimed block (e.g. a <p>
        // inside an <li> we already marked).
        if (block.closest("[data-plan-comment-id]")) continue;
        const text = collapseWhitespace(block.textContent || "");
        if (!text.includes(needle)) continue;

        block.classList.add("plan-line-commented");
        if (q.resolved) block.classList.add("plan-line-resolved");
        block.setAttribute("data-plan-comment-id", q.commentId);
        block.setAttribute("data-plan-pin-number", String(q.pinNumber));
        if (q.preview) {
          block.setAttribute(
            "data-plan-preview",
            collapseWhitespace(q.preview).slice(0, 240)
          );
        }

        // Pin badge appended at the end of the line. Inline-block so it
        // hugs the last word and tracks line wrapping.
        const pin = document.createElement("span");
        pin.className = `plan-line-pin${q.resolved ? " resolved" : ""}`;
        pin.contentEditable = "false";
        pin.textContent = String(q.pinNumber);
        pin.dataset.commentId = q.commentId;
        block.appendChild(pin);

        claimed.add(block);
        break;
      }
    }

    if (!onClick) return;
    const handler = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const block = target.closest<HTMLElement>("[data-plan-comment-id]");
      if (!block) return;
      // Don't intercept clicks on the inline thread itself — that lives
      // *outside* the commented block (as a sibling slot) but the user
      // might still click within the thread's bounds. The closest()
      // above only matches the commented block; inline-thread clicks
      // pass through naturally.
      const id = block.getAttribute("data-plan-comment-id");
      if (id) onClick(id, block.getBoundingClientRect());
    };
    container.addEventListener("click", handler);
    return () => container.removeEventListener("click", handler);
  }, [containerRef, bodyKey, quotes, onClick]);
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
