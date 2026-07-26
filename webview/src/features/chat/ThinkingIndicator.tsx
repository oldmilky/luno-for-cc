// ─────────────────────────────────────────────────────────────
// Processing loader. Shown for the whole turn — from submit, through
// the pre-output gap, while text streams, and during tool work —
// until it ends. Mirrors Claude Code's own loader: a bare accent
// sparkle + a cycling status verb + an animated ellipsis. No avatar
// box, so it reads as a lightweight status line rather than a
// message.
// ─────────────────────────────────────────────────────────────

import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { AMBIENT, ENTER, SPIN } from "../../design/motion";
import { Icon } from "../../design/icons";
import bits from "./ChatBits.module.scss";

// The sparkle runs for as long as the turn does, so it takes the ambient
// presets rather than a role — roles time one-shot transitions and cap at
// 220ms, a length that means nothing to an animation that never ends.
// Rotation runs at double the ambient beat so it reads as a slow drift
// instead of a second pulse competing with the opacity breathe.
const SPARKLE_LOOP = {
  rotate: { ...SPIN, duration: AMBIENT.duration * 2 },
  opacity: AMBIENT
} as const;

// Whimsical status verbs, cycled while the model works.
const VERBS = [
  "Pondering",
  "Thinking",
  "Reasoning",
  "Cooking",
  "Noodling",
  "Crafting",
  "Working",
  "Brewing",
  "Mulling",
  "Tinkering"
];

export function ThinkingIndicator() {
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    const id = window.setInterval(
      () => setIdx((i) => (i + 1) % VERBS.length),
      2600
    );
    return () => window.clearInterval(id);
  }, []);

  const word = VERBS[idx];

  return (
    // ENTER carries no exit; this one fades out when the turn ends, and does
    // it on ENTER's own transition.
    <motion.div
      {...ENTER}
      exit={{ opacity: 0 }}
      className={bits.thinking}
      aria-live="polite"
      aria-label={`${word}…`}
    >
      <motion.span
        className={bits.thinkingIcon}
        animate={{ rotate: 360, opacity: [0.55, 1, 0.55] }}
        transition={SPARKLE_LOOP}
        aria-hidden
      >
        <Icon name="sparkle" size={15} />
      </motion.span>
      <span className={bits.shimmer}>{word}</span>
      <span className={bits.dots} aria-hidden>
        <span />
        <span />
        <span />
      </span>
    </motion.div>
  );
}
