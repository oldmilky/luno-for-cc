// ─────────────────────────────────────────────────────────────
// Motion language — the single source for every framer-motion
// timing in the app.
//
// The rule: components never write numbers. They spread a preset.
// Before this file there were eight durations for one class of
// job (0.14 / 0.16 / 0.18 / 0.2 / 0.22 / 0.3 / 0.32 / 0.4), three
// easing curves and thirteen springs across four stiffness values
// — which is why neighbouring rows in the chat log each felt
// slightly different.
//
// Kept in sync with the `--motion-*` / `--ease-*` tokens in
// themes/_base.scss: CSS transitions read the tokens, framer reads
// these. Same numbers, two consumers.
// ─────────────────────────────────────────────────────────────

/**
 * House curve — hard start, long soft landing. Reads fast, feels gentle.
 *
 * For arrivals only. It is an expo-out: roughly 90% of the change is done in
 * the first third of the duration. That is exactly right for something coming
 * in — it appears at once and eases into place — and exactly wrong for
 * something leaving, see EASE_SOFT.
 */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;

/**
 * Symmetric — slow out of the gate, slow into the stop.
 *
 * Every exit in the app uses this, and that is the fix for the longest-running
 * complaint about this UI: modals that "close with no animation". They had one;
 * it ran on EASE_OUT, so a dismissed panel was at 47% opacity one quarter into
 * its exit and invisible by the halfway mark, leaving the rest of the duration
 * to animate something nobody could see. Lengthening the exit did nothing,
 * because the problem was never the length. On this curve the panel is still
 * at 88% a quarter of the way out, so the eye actually catches it leaving.
 *
 * Also used for anything that plays in reverse (expand/collapse), which is the
 * same argument: open and close should be the same gesture.
 */
export const EASE_SOFT = [0.65, 0, 0.35, 1] as const;

/** Seconds, mirroring the CSS duration tokens. */
export const DURATION = {
  tap: 0.09,
  hover: 0.12,
  enter: 0.18,
  expand: 0.22,
  overlay: 0.2
} as const;

/** Pixels, mirroring the `--travel-*` tokens. */
export const TRAVEL = {
  sm: 4,
  md: 8,
  lg: 12,
  xl: 28
} as const;

// ── Enter ────────────────────────────────────────────────────
// One character for everything that arrives in the chat log — user message,
// assistant reply, tool card, error, edited-files card. Only the delay may
// differ between them, never the feel.

export const ENTER = {
  initial: { opacity: 0, y: TRAVEL.sm },
  animate: { opacity: 1, y: 0 },
  transition: { duration: DURATION.enter, ease: EASE_OUT }
} as const;

/** Same character, longer travel — for card-sized surfaces. */
export const ENTER_CARD = {
  initial: { opacity: 0, y: TRAVEL.md },
  animate: { opacity: 1, y: 0 },
  transition: { duration: DURATION.enter, ease: EASE_OUT }
} as const;

// ── Overlays ─────────────────────────────────────────────────

/**
 * Modal scrim.
 *
 * The exit is deliberately NOT faster than the panel's. It used to be (90ms
 * against the panel's 120), and that is what made dismissal read as "no
 * animation at all": the background snapped back first, so by the time the
 * panel was still travelling there was nothing left to travel against. The
 * two now leave together.
 */
export const BACKDROP = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: DURATION.hover, ease: EASE_OUT } },
  exit: { opacity: 0, transition: { duration: DURATION.enter, ease: EASE_SOFT } }
} as const;

/**
 * Overlay panel — the one place the language allows a spring.
 *
 * Arriving is the moment worth animating: the surface overshoots a little and
 * settles, which reads as physical rather than as a fade. Under-damped on
 * purpose — 26 against a critical ~43 for this stiffness and mass — but stiff
 * enough to be over in roughly the wall-clock time of a tween.
 *
 * Two things set how loud this reads, and they are easy to confuse. Damping
 * controls whether it bounces; the starting scale controls whether you can
 * see that it bounced. A surface that begins 2% away has nowhere to travel no
 * matter how loose the damping, and one that begins 12% away is theatrical
 * even when tightly damped. Amplitude is the dial to reach for first.
 *
 * Leaving is a tween, and a short one. A spring on exit has to decay to rest
 * before the element unmounts, so it always feels like the panel is reluctant
 * to go; dismissal should be immediate. It drops rather than rises, so open
 * and close are not mirror images — the panel does not look like it is being
 * sucked back into the button.
 */
const SPRING_OVERLAY = {
  type: "spring",
  stiffness: 520,
  damping: 26,
  mass: 0.9
} as const;

export const OVERLAY_PANEL = {
  // A modal fills much more of the screen than a popover, so the same scale
  // delta covers far more distance and reads as louder. It starts closer to
  // its final size for that reason — the motion should feel like the same
  // family as a dropdown, one notch quieter.
  initial: { opacity: 0, y: TRAVEL.md, scale: 0.94 },
  animate: { opacity: 1, y: 0, scale: 1, transition: SPRING_OVERLAY },
  // The longest exit in the app. A modal is the largest thing that ever
  // leaves the screen, and a short fade on something that size looks like a
  // dropped frame rather than a dismissal. It also has real travel and scale
  // to move through, otherwise there is nothing to see it do.
  exit: {
    opacity: 0,
    y: TRAVEL.md,
    scale: 0.96,
    transition: { duration: DURATION.overlay, ease: EASE_SOFT }
  }
} as const;

/**
 * Popover / dropdown menu — same spring as a modal panel, shorter travel
 * because it is anchored to a trigger a few pixels away rather than centred
 * in the viewport.
 *
 * These used to animate with a CSS `animation`, which cannot do this at all:
 * a keyframe plays on mount, and on unmount the node is simply gone — there is
 * nothing left to animate. Every dropdown in the app opened smoothly and
 * vanished on a frame. Motion has to come from framer for anything that needs
 * to animate on the way out.
 *
 * `above` mirrors the travel for menus that open upward, so they always grow
 * out of the edge nearest their trigger.
 */
export const POPOVER = {
  initial: { opacity: 0, y: -TRAVEL.sm, scale: 0.95 },
  animate: { opacity: 1, y: 0, scale: 1, transition: SPRING_OVERLAY },
  exit: {
    opacity: 0,
    y: -TRAVEL.sm,
    scale: 0.97,
    transition: { duration: DURATION.hover, ease: EASE_SOFT }
  }
} as const;

export const POPOVER_ABOVE = {
  initial: { opacity: 0, y: TRAVEL.sm, scale: 0.95 },
  animate: { opacity: 1, y: 0, scale: 1, transition: SPRING_OVERLAY },
  exit: {
    opacity: 0,
    y: TRAVEL.sm,
    scale: 0.97,
    transition: { duration: DURATION.hover, ease: EASE_SOFT }
  }
} as const;

/**
 * Tooltip — the quietest floating surface in the app, and deliberately not a
 * popover.
 *
 * A popover is the result of a decision: the user clicked, and something
 * arrived. A tooltip is the result of a cursor being somewhere, which happens
 * hundreds of times an hour and mostly by accident. It gets no spring — an
 * overshoot on something that appears this often reads as the UI being twitchy
 * — and the shortest travel in the language.
 *
 * `above` mirrors the travel for tooltips that flip over their trigger, so the
 * label always grows out of the edge nearest the thing it describes.
 */
export const TOOLTIP = {
  initial: { opacity: 0, y: -TRAVEL.sm, scale: 0.96 },
  animate: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: DURATION.hover, ease: EASE_OUT }
  },
  exit: {
    opacity: 0,
    scale: 0.98,
    transition: { duration: DURATION.tap, ease: EASE_SOFT }
  }
} as const;

export const TOOLTIP_ABOVE = {
  ...TOOLTIP,
  initial: { opacity: 0, y: TRAVEL.sm, scale: 0.96 }
} as const;

/**
 * How long the cursor has to rest before a tooltip appears, in milliseconds —
 * setTimeout's unit, not framer's, which is why this is not in DURATION.
 *
 * Without a delay every tooltip on the way to somewhere else flashes open, and
 * the toolbar strobes as the cursor crosses it. 450ms is long enough to mean
 * "the user stopped here" and short enough not to feel broken.
 */
export const TOOLTIP_DELAY_MS = 450;

/**
 * Once one tooltip has been shown, the next one skips the delay if it opens
 * within this window.
 *
 * This is what makes a row of buttons feel like one labelled toolbar rather
 * than a set of unrelated controls that each make you wait. Reading along a
 * toolbar is a single continuous gesture; charging the full delay again for
 * every neighbour punishes exactly the user who is trying to learn the UI.
 */
export const TOOLTIP_GRACE_MS = 320;

/**
 * Side drawer — travels on X, so it gets its own preset.
 *
 * Travel is the whole point here and it has to be much longer than an
 * overlay's. A drawer is a full-height panel anchored to the screen edge: at
 * 12px it moved a thirtieth of its own width, which the eye reads as a fade
 * rather than a slide. 28px is short enough to stay quick and long enough to
 * be a direction.
 *
 * No spring, unlike the overlay panel. A spring overshoots past its target,
 * and past zero for an edge-anchored panel means a two-pixel strip of scrim
 * flashing along the screen edge before it settles back. Panels centred in the
 * viewport can overshoot in place; this one cannot.
 */
export const DRAWER = {
  initial: { opacity: 0, x: TRAVEL.xl },
  animate: {
    opacity: 1,
    x: 0,
    transition: { duration: DURATION.overlay, ease: EASE_OUT }
  },
  exit: {
    opacity: 0,
    x: TRAVEL.xl,
    transition: { duration: DURATION.overlay, ease: EASE_SOFT }
  }
} as const;

/**
 * Two mutually exclusive elements sharing one slot — a primary action whose
 * label and meaning change with state, a readout that swaps between shapes.
 *
 * Opacity only, and short. What is changing is the *contents* of a box that
 * stays exactly where it is; give this travel or scale and it reads as one
 * button being replaced by a different button rather than as the same control
 * changing its mind.
 *
 * Pair it with `<AnimatePresence mode="wait">`. Without `wait` both elements
 * hold the slot for a frame and the layout jumps — which is worse than the
 * hard swap this replaces.
 */
export const SWAP = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: DURATION.hover, ease: EASE_OUT } },
  exit: { opacity: 0, transition: { duration: DURATION.tap, ease: EASE_SOFT } }
} as const;

// ── Expand / collapse ────────────────────────────────────────
// Symmetric curve: an asymmetric one makes the reverse look wrong.

export const EXPAND = {
  initial: { height: 0, opacity: 0 },
  animate: { height: "auto", opacity: 1 },
  exit: { height: 0, opacity: 0 },
  transition: { duration: DURATION.expand, ease: EASE_SOFT }
} as const;

// ── Springs ──────────────────────────────────────────────────
// Two, replacing thirteen hand-tuned ones.

/** Press feedback. Stiff and well damped — no wobble on a button. */
export const SPRING_PRESS = {
  type: "spring",
  stiffness: 400,
  damping: 30
} as const;

/** Appearing with a little character. Used sparingly — brand marks, badges. */
export const SPRING_POP = {
  type: "spring",
  stiffness: 360,
  damping: 22
} as const;

/** Standard press affordance for buttons. */
export const PRESS = {
  whileTap: { scale: 0.94 },
  transition: SPRING_PRESS
} as const;

// ── Ambient loops ────────────────────────────────────────────
// The one thing the roles cannot describe. A role times a transition —
// something that starts and finishes — and all of them cap at 220ms. These
// run for as long as a condition holds: the model is talking, a tool is
// working. One period for every breathing element so they stay in phase;
// they were drifting at 1.4s, 1.6s and 1.8s.

/** Breathing — opacity/scale pulses. Mirrors `--motion-ambient`. */
export const AMBIENT = {
  duration: 1.8,
  repeat: Infinity,
  ease: EASE_SOFT
} as const;

/**
 * Continuous rotation. Mirrors `--motion-spin`.
 * `linear` is mandatory: an eased curve makes a spinner stutter once per turn.
 */
export const SPIN = {
  duration: 0.8,
  repeat: Infinity,
  ease: "linear"
} as const;

// ── Lists ────────────────────────────────────────────────────

/**
 * Per-item delay for a list that reveals itself.
 *
 * Capped deliberately: past a handful of items a stagger stops reading as
 * choreography and starts reading as the list being slow to load. Anything
 * beyond the cap arrives with no delay at all.
 */
export function stagger(index: number, step = 0.02, max = 6): number {
  return Math.min(index, max) * step;
}

/** ENTER with a stagger delay folded in. */
export function enterAt(index: number) {
  return {
    ...ENTER,
    transition: { ...ENTER.transition, delay: stagger(index) }
  };
}
