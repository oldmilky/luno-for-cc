// ─────────────────────────────────────────────────────────────
// The one overlay. Portal, backdrop, Escape, focus, scroll lock and the exit
// animation, owned once instead of by each of the fourteen modals that used to
// hand-write them.
//
// **It portals because `position: fixed` is not reliable inside the tree.** A
// fixed element is positioned against the viewport only while no ancestor
// creates a containing block for it — `transform`, `filter`, `backdrop-filter`,
// `will-change` and `contain` all do, and framer writes `transform` inline on
// every `motion.*` element. The note in `ChatScreen.module.scss` is the round of
// debugging this already cost: a picker's popover lost to the log because the
// composer became a stacking context, and the log then swallowed its clicks.
// Rendering into `document.body` makes the class of bug unreachable rather than
// defended against by a z-index convention every new overlay has to remember.
//
// **`open` is a prop, not a condition at the call site.** `{cond && <Modal/>}`
// unmounts the subtree, and an unmounted node has nothing left to animate —
// AnimatePresence has to outlive the thing it is animating out. That is also
// why AnimatePresence sits *inside* the portal: a portal element is not a motion
// child, so wrapping the portal instead silently drops the exit.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, type MotionProps } from "framer-motion";
import { BACKDROP, OVERLAY_PANEL } from "../motion";
import s from "./Overlay.module.scss";

/** Open overlays, so nesting one inside another does not unlock the page when
 *  the inner one closes. */
let scrollLocks = 0;

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])'
].join(",");

/**
 * A dialog has to be named, and there are two ways to do it.
 *
 * `labelledBy` points at a heading the dialog already draws, which is the
 * better one when it has a visible title — it keeps the name and the heading
 * from drifting apart, and it stops a dialog and the button that opens it from
 * announcing as the same string. `label` is for a dialog with no heading of its
 * own. Exactly one, enforced here rather than left to a review.
 */
type OverlayName =
  { label: string; labelledBy?: never } | { labelledBy: string; label?: never };

interface OverlayBaseProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Extra class on the panel — its chrome, width and layout. */
  className?: string;
  /** Extra class on the backdrop. This is where a modal brings its own scrim;
   *  the primitive deliberately has none, so migrating one cannot move it. */
  backdropClassName?: string;
  /** Whether a click on the backdrop dismisses. Off for a modal whose choice
   *  has to be made rather than escaped. */
  dismissOnBackdrop?: boolean;
  /** Whether Escape dismisses. Same reasoning as the backdrop. */
  dismissOnEscape?: boolean;
  /** Overrides spread over `OVERLAY_PANEL`, for a dialog whose motion genuinely
   *  differs — not a licence to hand-write one. Build the override out of the
   *  preset's own values so timing and curve stay shared. */
  panelMotion?: Pick<MotionProps, "initial" | "animate" | "exit">;
  /** The same, for the backdrop over `BACKDROP`. `BACKDROP` carries opacity
   *  only, so a scrim that also blurs has to re-state each state with the blur
   *  folded in — declaring the blur in CSS instead would fight the tween. */
  backdropMotion?: Pick<MotionProps, "initial" | "animate" | "exit">;
}

export type OverlayProps = OverlayBaseProps & OverlayName;

export function Overlay({
  open,
  onClose,
  label,
  labelledBy,
  children,
  className,
  backdropClassName,
  dismissOnBackdrop = true,
  dismissOnEscape = true,
  panelMotion,
  backdropMotion
}: OverlayProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);
  // A drag that starts on the panel and ends on the backdrop fires `click` on
  // their common ancestor, which is the backdrop — selecting text in a dialog
  // would otherwise dismiss it. Only a press that began on the backdrop counts.
  const pressedBackdrop = useRef(false);

  useEffect(() => {
    if (!open) return;
    restoreTo.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    return () => {
      // The element may be gone by now — a modal opened from a row that the
      // same action deleted. `isConnected` is the cheap way to not throw.
      const target = restoreTo.current;
      if (target?.isConnected) target.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    scrollLocks += 1;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      scrollLocks -= 1;
      if (scrollLocks === 0) document.body.style.overflow = previous;
    };
  }, [open]);

  // Focus lands inside on open, so the first Tab goes where the eye already is
  // and a screen reader starts reading the dialog rather than the page under it.
  //
  // It lands on the PANEL unless a control asks for it with `data-autofocus`.
  // Focusing the first button by default would change what Enter does: a
  // focused button activates on Enter, so a dialog that also binds Enter to a
  // decision would run both, and the one it ran first would not be the one the
  // key means. Nominating is explicit; falling into it is not.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    (panel.querySelector<HTMLElement>("[data-autofocus]") ?? panel).focus();
  }, [open]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Deliberately not stopped: the modals being migrated listened on
      // `window`, so anything else watching Escape saw it too. Swallowing it
      // here would be a behaviour change smuggled into a structural move.
      if (e.key === "Escape" && dismissOnEscape) {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const stops = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (stops.length === 0) return;
      const edge = e.shiftKey ? stops[0] : stops[stops.length - 1];
      // Wrapping by hand rather than trusting the browser: the panel is in
      // `document.body`, so tabbing off its end walks into the page behind it,
      // which is exactly what `aria-modal` promises does not happen.
      if (document.activeElement === edge) {
        e.preventDefault();
        (e.shiftKey ? stops[stops.length - 1] : stops[0]).focus();
      }
    },
    [dismissOnEscape, onClose]
  );

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className={
            backdropClassName
              ? `${s.backdrop} ${backdropClassName}`
              : s.backdrop
          }
          role="dialog"
          aria-modal="true"
          aria-label={label}
          aria-labelledby={labelledBy}
          onKeyDown={onKeyDown}
          onMouseDown={(e) => {
            pressedBackdrop.current = e.target === e.currentTarget;
          }}
          onClick={(e) => {
            if (!dismissOnBackdrop) return;
            if (e.target === e.currentTarget && pressedBackdrop.current) {
              onClose();
            }
          }}
          {...BACKDROP}
          {...backdropMotion}
        >
          <motion.div
            ref={panelRef}
            className={className ? `${s.panel} ${className}` : s.panel}
            tabIndex={-1}
            {...OVERLAY_PANEL}
            {...panelMotion}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
