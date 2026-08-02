// ─────────────────────────────────────────────────────────────
// What dictation looks like while it is happening.
//
// A strip above the composer rather than text written straight into the
// editor, for one reason worth stating: the editor is a contenteditable, and
// the endpoint sends the whole utterance again several times a second. Writing
// each of those into the editor would move the caret out from under whatever
// the user had already typed. The transcript lands in the editor once, when
// the dictation ends.
// ─────────────────────────────────────────────────────────────

import { motion } from "framer-motion";
import { Icon } from "../../design/icons";
import { DURATION, EASE_OUT, ENTER } from "../../design/motion";
import s from "./DictationStrip.module.scss";

const BARS = 5;

export interface DictationStripProps {
  listening: boolean;
  committed: string;
  interim: string;
  error?: string;
  /** 0…1, twenty times a second while a device is open. */
  level: number;
}

export function DictationStrip({
  listening,
  committed,
  interim,
  error,
  level
}: DictationStripProps) {
  const said = committed.trim();
  const saying = interim.trim();

  return (
    <motion.div
      className={`${s.strip}${error ? ` ${s.stripError}` : ""}`}
      {...ENTER}
      exit={{ opacity: 0, y: -4 }}
      role="status"
      aria-live="polite"
    >
      {error ? (
        <>
          <span className={s.errorIcon}>
            <Icon name="danger" size={13} />
          </span>
          <span className={s.error}>{error}</span>
        </>
      ) : (
        <>
          <Meter level={listening ? level : 0} />
          {said || saying ? (
            <span className={s.text}>
              {said}
              {said && saying ? " " : ""}
              {saying && <span className={s.interim}>{saying}</span>}
            </span>
          ) : (
            <span className={s.waiting}>Listening…</span>
          )}
        </>
      )}
    </motion.div>
  );
}

/**
 * Five bars, tallest in the middle.
 *
 * Scale rather than height so the browser animates a transform instead of
 * re-laying out the row twenty times a second, and a floor of 0.15 so silence
 * still reads as "open and waiting" rather than as a dead control.
 */
function Meter({ level }: { level: number }) {
  const shape = [0.45, 0.75, 1, 0.75, 0.45];
  return (
    <div className={s.meter} aria-hidden="true">
      {Array.from({ length: BARS }, (_, i) => (
        <motion.span
          key={i}
          className={s.bar}
          style={{ height: 16 }}
          animate={{
            scaleY: Math.max(0.15, Math.min(1, level * shape[i] * 2))
          }}
          transition={{ duration: DURATION.hover, ease: EASE_OUT }}
        />
      ))}
    </div>
  );
}
