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

import { useEffect, useState } from "react";
import { Icon } from "../../../design/icons";
import { Overlay } from "../../../design/primitives";
import { formatDuration } from "../../../lib/format";
import type { LiveAgents } from "../timeline/subagent-state";
import s from "./StopAgentsModal.module.scss";

interface StopAgentsModalProps {
  /** The agents at risk, or null when the dialog is closed. Null *is* the
   *  closed state — the component stays mounted so it can animate out. */
  agents: LiveAgents | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function StopAgentsModal({
  agents,
  onCancel,
  onConfirm
}: StopAgentsModalProps) {
  const open = agents !== null;
  // The dialog is still on screen for the length of its own dismissal, and by
  // then the parent has already cleared `agents`. Keeping the last set is what
  // stops the exit animation playing over an empty panel. Derived during
  // render rather than in an effect, which is the shape React documents for
  // state that follows a prop.
  const [shown, setShown] = useState(agents);
  if (agents && agents !== shown) setShown(agents);
  // Escape belongs to `Overlay` now; Enter does not, and it stays on `window`
  // for the reason it was there — confirming should not require the focus to
  // have landed anywhere in particular.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onConfirm]);

  if (!shown) return null;
  const plural = shown.count !== 1 ? "s" : "";

  return (
    <Overlay
      open={open}
      onClose={onCancel}
      label="Stop background agents"
      className={s.panel}
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
                  {shown.count} agent{plural}
                </strong>{" "}
                still working will be stopped
              </>
            }
          />
          {shown.longestMs > 0 && (
            <Detail
              icon="clock"
              text={
                <>
                  The longest has been running for{" "}
                  <strong className={s.strong}>
                    {formatDuration(shown.longestMs)}
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
            data-autofocus
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
    </Overlay>
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
