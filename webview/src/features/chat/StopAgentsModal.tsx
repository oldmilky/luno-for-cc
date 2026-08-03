// ─────────────────────────────────────────────────────────────
// Stop, asked properly when there is background work to lose.
//
// Stop reaches the CLI as an `interrupt` over the control channel, and that
// stops every background agent with it — measured against 2.1.219, the
// terminal `stopped` status lands 10ms after the request. The process itself
// survives, so the conversation and any Remote Control bridge are fine; what
// does not survive is an unfinished workflow.
//
// Shown ONLY while agents are running. Stopping a turn that is merely
// streaming stays one click, because that is the common case and taxing it to
// protect the rare one is how a confirmation becomes something people learn to
// dismiss without reading.
// ─────────────────────────────────────────────────────────────

import { useEffect } from "react";
import { motion } from "framer-motion";
import { Icon } from "../../design/icons";
import { BACKDROP, OVERLAY_PANEL } from "../../design/motion";
import { formatDuration } from "../../lib/format";
import type { LiveAgents } from "./subagent-state";
import s from "./StopAgentsModal.module.scss";

interface StopAgentsModalProps {
  agents: LiveAgents;
  onCancel: () => void;
  onConfirm: () => void;
}

export function StopAgentsModal({
  agents,
  onCancel,
  onConfirm
}: StopAgentsModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      else if (e.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, onConfirm]);

  const plural = agents.count !== 1 ? "s" : "";

  return (
    <motion.div
      className={s.backdrop}
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label="Stop background agents"
      {...BACKDROP}
    >
      <motion.div
        className={s.panel}
        onClick={(e) => e.stopPropagation()}
        {...OVERLAY_PANEL}
      >
        <div className={s.hairline} />

        <div className={s.head}>
          <div className={s.headRow}>
            <div className={s.iconTile}>
              <Icon name="danger" size={22} />
            </div>
            <div className={s.headText}>
              <h2 className={s.title}>Stop the running agents?</h2>
              <p className={s.sub}>
                Stopping this turn stops them too, and their work is not
                recoverable.
              </p>
            </div>
          </div>

          <div className={s.details}>
            <Detail
              icon="layers"
              text={
                <>
                  <strong className={s.strong}>
                    {agents.count} agent{plural}
                  </strong>{" "}
                  still working will be stopped
                </>
              }
            />
            {agents.longestMs > 0 && (
              <Detail
                icon="clock"
                text={
                  <>
                    The longest has been running for{" "}
                    <strong className={s.strong}>
                      {formatDuration(agents.longestMs)}
                    </strong>
                  </>
                }
              />
            )}
          </div>
        </div>

        <div className={s.foot}>
          <div className={s.escHint}>
            <kbd className={s.kbd}>Esc</kbd>
            <span>to let them finish</span>
          </div>
          <div className={s.actions}>
            <button
              type="button"
              className={s.cancel}
              onClick={onCancel}
              autoFocus
            >
              Keep running
            </button>
            <button type="button" className={s.confirm} onClick={onConfirm}>
              <Icon name="stop" size={11} />
              Stop anyway
              <kbd className={s.confirmKbd}>↵</kbd>
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

function Detail({
  icon,
  text
}: {
  icon: "layers" | "clock";
  text: React.ReactNode;
}) {
  return (
    <div className={s.detail}>
      <span className={s.detailIcon}>
        <Icon name={icon} size={12} />
      </span>
      <span className={s.detailText}>{text}</span>
    </div>
  );
}
