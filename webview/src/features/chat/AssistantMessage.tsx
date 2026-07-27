import { motion } from "framer-motion";
import { useState } from "react";
import { EASE_SOFT, ENTER, SPRING_PRESS } from "../../design/motion";
import { Icon } from "../../design/icons";
import { Tooltip } from "../../design/primitives";
import { MarkdownBody } from "./markdown";
import s from "./AssistantMessage.module.scss";

// The one timing the motion language does not cover. Every role in motion.ts
// caps at 220ms because it describes a transition — something that starts and
// finishes; this is an ambient loop that runs for as long as the model is
// talking. Declared once here and mirrored by `$ambient-pulse` in the
// stylesheet, so the avatar, the halo and the caret breathe on a single beat
// instead of three that drift against each other. EASE_SOFT because it plays
// in both directions.
const STREAM_PULSE = {
  duration: 1.8,
  repeat: Infinity,
  ease: EASE_SOFT
} as const;

interface AssistantMessageProps {
  text: string;
  streaming?: boolean;
  showAvatar?: boolean;
  /** When set, hovering the message shows a "Continue from here" hint that
   *  fires `onContinue(text)` — used to seed the composer with a follow-up
   *  prompt anchored to this assistant turn. */
  onContinue?: (excerpt: string) => void;
}

export function AssistantMessage({
  text,
  streaming,
  showAvatar = true,
  onContinue
}: AssistantMessageProps) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <motion.div className={s.row} {...ENTER}>
      {showAvatar && (
        <div className={s.avatarWrap}>
          <span
            className={`${s.halo}${streaming ? ` ${s.haloLive}` : ""}`}
            aria-hidden
          />
          {/* SPRING_PRESS, not the PRESS preset: the affordance here is hover,
              and PRESS would move the trigger to tap. Only the spring is shared. */}
          <motion.div
            className={s.avatar}
            whileHover={{ scale: 1.08, rotate: -6 }}
            animate={streaming ? { opacity: [0.78, 1, 0.78] } : { opacity: 1 }}
            transition={streaming ? STREAM_PULSE : SPRING_PRESS}
          >
            <Icon name="sparkle" size={13} />
          </motion.div>
        </div>
      )}
      <div className={s.column}>
        <div className={`md ${s.body}`}>
          <MarkdownBody text={text} />
          {streaming && <span className={s.caret} aria-hidden />}
        </div>
        {!streaming && text.length > 0 && (
          <div className={s.actions}>
            {/* No tooltip: the old `title` was the same expression as the
                button's own text, character for character. */}
            <button type="button" onClick={copy} className={s.copy}>
              <Icon name={copied ? "check" : "copy"} size={9} />
              {copied ? "Copied" : "Copy"}
            </button>
            {onContinue && (
              <Tooltip label="Continue from here — seed the composer with a follow-up anchored to this message">
                <button
                  type="button"
                  onClick={() => onContinue(excerpt(text))}
                  className={s.continue}
                >
                  <Icon name="arrow" size={9} />
                  Continue
                </button>
              </Tooltip>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function excerpt(text: string): string {
  // Pull the last ~140 chars of plain text, trimmed at a clause boundary, so
  // the seed prompt has tight context without dragging in formatting.
  const flat = text
    .replace(/`{3}[\s\S]*?`{3}/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const tail = flat.slice(-140);
  const cut = tail.lastIndexOf(". ");
  return cut > 40 ? tail.slice(cut + 2) : tail;
}
