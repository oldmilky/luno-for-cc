// ─────────────────────────────────────────────────────────────
// QueuedPrompt — the follow-up typed while a turn was still
// running. The host holds the text and sends it the moment the
// turn ends; this row is what says "waiting", not "lost".
// ─────────────────────────────────────────────────────────────

import { motion } from "framer-motion";
import { EXPAND } from "../../design/motion";
import { Icon } from "../../design/icons";
import { Tooltip } from "../../design/primitives";
import bits from "./ChatBits.module.scss";

interface QueuedPromptProps {
  text: string;
  /** Take it back into the composer to keep editing. The host forgets its
   *  copy, so the text exists in exactly one place at a time. */
  onEdit: (text: string) => void;
  onDrop: () => void;
}

export function QueuedPrompt({ text, onEdit, onDrop }: QueuedPromptProps) {
  if (!text) return null;
  return (
    <motion.div {...EXPAND} className={bits.queued}>
      <div className={bits.queuedRow}>
        <span className={bits.queuedLabel}>
          <Icon name="clock" size={10} />
          Queued
        </span>
        <Tooltip label="Edit before it goes — takes it back into the composer">
          <button
            type="button"
            className={bits.queuedText}
            onClick={() => onEdit(text)}
          >
            {text}
          </button>
        </Tooltip>
        <Tooltip label="Discard">
          <button
            type="button"
            className={bits.queuedDrop}
            onClick={onDrop}
            aria-label="Discard the queued message"
          >
            <Icon name="x" size={9} />
          </button>
        </Tooltip>
      </div>
    </motion.div>
  );
}
