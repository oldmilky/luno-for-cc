// ─────────────────────────────────────────────────────────────
// Tooltip.
//
// Replaces the native `title` attribute, which the app used in 91
// places and which cannot be styled, cannot carry an icon, appears
// after a delay the OS picks, and renders outside the webview's
// palette entirely — a grey Windows box on a copper panel.
//
// Wraps its child rather than rendering a wrapper element around it:
// most triggers here sit in flex rows where an extra span would
// change the layout. The child is cloned with the hover/focus
// handlers and an `aria-describedby` pointing at the label.
// ─────────────────────────────────────────────────────────────

import {
  ReactElement,
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  TOOLTIP,
  TOOLTIP_ABOVE,
  TOOLTIP_DELAY_MS,
  TOOLTIP_GRACE_MS
} from "../motion";
import { Icon, IconName } from "../icons";
import s from "./Tooltip.module.scss";

/** Gap between the trigger and the label, and the minimum viewport margin. */
const OFFSET = 8;
const MARGIN = 8;

/**
 * When the last tooltip closed. Module-level on purpose: the grace period is a
 * property of the pointer's journey across the UI, not of any one tooltip, and
 * the component that is about to open has no other way to know that its
 * neighbour was just showing.
 */
let lastHiddenAt = 0;

/**
 * The tooltip that most recently began opening, so it can be called off when
 * another one starts.
 *
 * Triggers nest — a message bubble that explains itself contains a Copy button
 * that explains itself, a connector card contains four. `mouseenter` does not
 * bubble, but it *is* dispatched to every element the pointer entered, so both
 * the card and the button open and the user gets two bubbles at once. The
 * native `title` never had this problem: the browser resolves it to the nearest
 * ancestor and shows exactly one.
 *
 * React dispatches those enter events outermost-first, so the innermost trigger
 * is the last to call `show()` — cancelling whoever registered before it leaves
 * precisely the most specific label on screen, which is the one the pointer is
 * actually over. Calling `hide` rather than just forgetting matters: it clears a
 * pending timer as well as an open bubble, so an ancestor whose delay has not
 * elapsed yet never gets to fire.
 */
let pending: (() => void) | null = null;

type Placement = "top" | "bottom";

interface Position {
  left: number;
  top: number;
  placement: Placement;
}

export interface TooltipProps {
  /** The label itself. Keep it to a phrase — this is not a help panel. */
  label: string;
  /** Optional glyph before the label. */
  icon?: IconName;
  /**
   * Second line, for a shortcut or a consequence. Rendered dimmer than the
   * label; if you need a third line the thing you are describing is too
   * complicated for a tooltip.
   */
  hint?: string;
  /**
   * Let the label wrap.
   *
   * For the tooltips that reveal a *value* rather than explain an action — a
   * file path, a skill's source URL, the passage a comment is attached to.
   * Those are the ones the ellipsis in the UI cut off, so they are long by
   * definition, and on one nowrap line they would be cut off a second time.
   * Anything phrased as an instruction should stay on its line.
   */
  wrap?: boolean;
  /** Suppress without unmounting — for a trigger whose label is conditional. */
  disabled?: boolean;
  children: ReactElement;
}

export function Tooltip({
  label,
  icon,
  hint,
  wrap,
  disabled,
  children
}: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Position | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    if (pending === hideRef.current) pending = null;
    setOpen((wasOpen) => {
      if (wasOpen) lastHiddenAt = Date.now();
      return false;
    });
    setPos(null);
  }, []);

  // `show` has to be able to call the *previous* tooltip's `hide`, and `hide`
  // has to know whether the slot still belongs to it. A ref breaks the cycle
  // without either of them depending on the other's identity.
  const hideRef = useRef(hide);
  hideRef.current = hide;

  const show = useCallback(() => {
    if (disabled) return;
    if (pending && pending !== hideRef.current) pending();
    pending = hideRef.current;
    window.clearTimeout(timer.current);
    const warm = Date.now() - lastHiddenAt < TOOLTIP_GRACE_MS;
    timer.current = window.setTimeout(() => setOpen(true), warm ? 0 : TOOLTIP_DELAY_MS);
  }, [disabled]);

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      if (pending === hideRef.current) pending = null;
    },
    []
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    // A tooltip must not survive the surface it describes moving out from
    // under it. `scroll` is captured because the chat log scrolls, not the
    // window, and a bubble pinned to viewport coordinates would be left
    // pointing at nothing.
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [open, hide]);

  // Positioned after render, because centring and flipping both need the
  // bubble's own measured size. framer holds it at opacity 0 for the first
  // frame, so the pre-measurement position is never painted.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const bubble = bubbleRef.current;
    if (!trigger || !bubble) return;

    const t = trigger.getBoundingClientRect();
    // offsetWidth/Height, not a bounding rect: this runs on the frame the
    // bubble mounts, when the enter animation still has it at scale 0.96, and
    // a bounding rect reports the scaled box. Measuring the shrunken copy put
    // the label 2px too close to its trigger and 4px off centre — small enough
    // to look like sloppy design rather than a bug.
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;

    // Above by default: most triggers here live in the composer and the
    // header, and below the composer there is no viewport left.
    const fitsAbove = t.top - bh - OFFSET >= MARGIN;
    const placement: Placement = fitsAbove ? "top" : "bottom";

    const left = clamp(
      t.left + t.width / 2 - bw / 2,
      MARGIN,
      Math.max(MARGIN, window.innerWidth - bw - MARGIN)
    );
    const top = placement === "top" ? t.top - bh - OFFSET : t.bottom + OFFSET;

    setPos({ left, top, placement });
  }, [open, label, hint, wrap]);

  const child = children as ReactElement<Record<string, unknown>>;
  const childProps = child.props;

  /**
   * A disabled control dispatches no mouse events, and the events do not reach
   * its ancestors either — hit-testing stops at the disabled element and
   * nothing is fired. So the one tooltip a user most needs, the one explaining
   * why a button cannot be pressed, is the one that would never appear.
   *
   * The fix is a wrapper that owns the handlers, plus `pointer-events: none` on
   * the disabled child so the hit test falls through to it. Keyed off whether
   * the child *declares* `disabled` at all rather than its current value: the
   * value flips at runtime, and changing the DOM shape underneath a live
   * element would remount it and drop its focus mid-interaction.
   */
  const needsWrapper = "disabled" in childProps;

  const handlers = {
    onMouseEnter: chain(childProps.onMouseEnter, show),
    onMouseLeave: chain(childProps.onMouseLeave, hide),
    // Dismiss on press: the click has already answered whatever the label was
    // about to explain, and a tooltip left hanging over a menu the click just
    // opened is in the way.
    onPointerDown: chain(childProps.onPointerDown, hide),
    onFocus: chain(childProps.onFocus, (e: React.FocusEvent<HTMLElement>) => {
      // Keyboard focus only. Plain `:focus` fires on click too, which would
      // re-open the tooltip the pointerdown above just dismissed.
      if (e.target.matches(":focus-visible")) show();
    }),
    onBlur: chain(childProps.onBlur, hide)
  };

  // `aria-describedby` and the ref stay on the control itself even when a
  // wrapper is present: the description belongs to the thing being described,
  // and the bubble is positioned against the box the user can actually see.
  const cloned = cloneElement(child, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node;
      applyRef(childProps.ref, node);
    },
    "aria-describedby": open ? id : undefined,
    ...(needsWrapper ? {} : handlers)
  } as Record<string, unknown>);

  const trigger = needsWrapper ? (
    // `presentation` so the span leaves the accessibility tree and its child is
    // re-parented to the real container. Without it a wrapped tab stops being a
    // child of its `role="tablist"`, and the relationship a screen reader needs
    // is broken by a node that exists only to catch a mouse.
    <span className={s.gate} role="presentation" {...handlers}>
      {cloned}
    </span>
  ) : (
    cloned
  );

  return (
    <>
      {trigger}
      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              ref={bubbleRef}
              id={id}
              role="tooltip"
              className={wrap ? `${s.bubble} ${s.wrap}` : s.bubble}
              // Viewport coordinates, computed from the trigger's rect — the
              // only values in this file that cannot come from a token.
              style={{ left: pos?.left ?? 0, top: pos?.top ?? 0 }}
              {...(pos?.placement === "bottom" ? TOOLTIP : TOOLTIP_ABOVE)}
            >
              {icon && (
                <span className={s.icon} aria-hidden>
                  <Icon name={icon} size={11} />
                </span>
              )}
              <span className={s.text}>
                <span className={s.label}>{label}</span>
                {hint && <span className={s.hint}>{hint}</span>}
              </span>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** Run the child's own handler before ours, and never swallow it. */
function chain<E>(theirs: unknown, ours: (e: E) => void) {
  return (e: E) => {
    if (typeof theirs === "function") (theirs as (e: E) => void)(e);
    ours(e);
  };
}

/** Forward the node to whatever ref shape the child already had. */
function applyRef(ref: unknown, node: HTMLElement | null) {
  if (typeof ref === "function") (ref as (n: HTMLElement | null) => void)(node);
  else if (ref && typeof ref === "object") {
    (ref as { current: HTMLElement | null }).current = node;
  }
}
