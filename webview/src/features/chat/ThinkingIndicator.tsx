// ─────────────────────────────────────────────────────────────
// Processing loader. Shown for the whole turn — from submit, through
// the pre-output gap, while text streams, and during tool work —
// until it ends. A turning globe of dots + a cycling status verb +
// an animated ellipsis. No avatar box, so it reads as a lightweight
// status line rather than a message.
// ─────────────────────────────────────────────────────────────

import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { ENTER } from "../../design/motion";
import { DotGlobe } from "../../design/primitives";
import bits from "./ChatBits.module.scss";

/** Larger than the 15px sparkle it replaced. The globe is the part that says
 *  "still working", and at 15px its parallels land under a dot each and stop
 *  resolving as a sphere. */
const GLOBE_SIZE = 19;

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
      <span className={bits.thinkingIcon} aria-hidden>
        <DotGlobe size={GLOBE_SIZE} />
      </span>
      <span className={bits.shimmer}>{word}</span>
      <span className={bits.dots} aria-hidden>
        <span />
        <span />
        <span />
      </span>
    </motion.div>
  );
}
