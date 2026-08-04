// ─────────────────────────────────────────────────────────────
// ThoughtBlock — collapsible "Thought for Xs" wrapper around the
// model's pre-tool reasoning text. Open by default the first time;
// the user can click to collapse.
// ─────────────────────────────────────────────────────────────

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { EXPAND } from "../../../design/motion";
import { Icon } from "../../../design/icons";
import { formatDuration } from "../../../lib/format";
import { MarkdownBody } from "./markdown";
import s from "../Turn.module.scss";

interface ThoughtBlockProps {
  text: string;
  durationMs?: number;
}

export function ThoughtBlock({ text, durationMs }: ThoughtBlockProps) {
  const [open, setOpen] = useState(true);
  if (!text.trim()) return null;
  const label =
    durationMs === undefined
      ? "Thinking…"
      : `Thought for ${formatDuration(durationMs)}`;
  return (
    <div className={s.thought}>
      <button
        type="button"
        className={s.thoughtHead}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{label}</span>
        <span className={s.chev}>
          <Icon name={open ? "chevronD" : "chevronR"} size={10} />
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div {...EXPAND} className={s.thoughtBody}>
            <MarkdownBody text={text} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
