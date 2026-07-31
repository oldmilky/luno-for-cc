import { useEffect, type ReactNode } from "react";
import { motion } from "framer-motion";
import { Icon } from "../../design/icons";
import { BACKDROP, OVERLAY_PANEL } from "../../design/motion";
import { formatDuration } from "./tool-buckets";
import type { LiveAgents } from "./subagent-state";
import s from "./RewindModal.module.scss";

interface RewindModalProps {
  messagesAfter: number;
  /** What rewinding will also destroy. Rewinding interrupts the turn *and*
   *  releases the CLI process, so a background agent does not merely stop —
   *  the run it belonged to is gone. */
  agents: LiveAgents;
  onCancel: () => void;
  onConfirm: () => void;
}

export function RewindModal({
  messagesAfter,
  agents,
  onCancel,
  onConfirm
}: RewindModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      else if (e.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, onConfirm]);

  const plural = messagesAfter !== 1 ? "s" : "";

  return (
    <motion.div
      className={s.backdrop}
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label="Rewind conversation"
      {...BACKDROP}
    >
      <motion.div
        className={s.panel}
        onClick={(e) => e.stopPropagation()}
        {...OVERLAY_PANEL}
      >
        {/* Top accent hairline */}
        <div className={s.hairline} />

        <div className={s.head}>
          <div className={s.headRow}>
            {/* Icon tile with breathing halo */}
            <div className={s.iconWrap}>
              <span className={s.halo} aria-hidden />
              <div className={s.iconTile}>
                <Icon name="history" size={22} />
              </div>
            </div>

            <div className={s.headText}>
              <h2 className={s.title}>Rewind to this point?</h2>
              <p className={s.sub}>
                Jump the conversation back here. This can&rsquo;t be undone.
              </p>
            </div>
          </div>

          {/* What will happen */}
          <div className={s.details}>
            {messagesAfter > 0 && (
              <DetailRow
                icon="layers"
                tone="warn"
                text={
                  <>
                    <strong className={s.strong}>
                      {messagesAfter} message{plural}
                    </strong>{" "}
                    after this point will be removed
                  </>
                }
              />
            )}
            <DetailRow
              icon="refresh"
              tone="accent"
              text={
                <>
                  Files changed since then will be{" "}
                  <strong className={s.strong}>restored</strong>
                </>
              }
            />
            {agents.count > 0 && (
              <DetailRow
                icon="layers"
                tone="warn"
                text={
                  <>
                    <strong className={s.strong}>
                      {agents.count} agent{agents.count !== 1 ? "s" : ""}
                    </strong>{" "}
                    still working will be stopped
                    {agents.longestMs > 0 && (
                      <> — the longest at {formatDuration(agents.longestMs)}</>
                    )}
                  </>
                }
              />
            )}
          </div>
        </div>

        {/* Footer */}
        <div className={s.foot}>
          <div className={s.escHint}>
            <kbd className={s.kbd}>Esc</kbd>
            <span>to cancel</span>
          </div>
          <div className={s.actions}>
            <button type="button" className={s.cancel} onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className={s.confirm}
              onClick={onConfirm}
              autoFocus
            >
              <Icon name="history" size={12} />
              Rewind
              <kbd className={s.confirmKbd}>↵</kbd>
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

function DetailRow({
  icon,
  tone,
  text
}: {
  icon: "layers" | "refresh";
  tone: "warn" | "accent";
  text: ReactNode;
}) {
  const toneCls = tone === "warn" ? s.toneWarn : s.toneAccent;
  return (
    <div className={s.detail}>
      <span className={`${s.detailIcon} ${toneCls}`}>
        <Icon name={icon} size={12} />
      </span>
      <span className={s.detailText}>{text}</span>
    </div>
  );
}
