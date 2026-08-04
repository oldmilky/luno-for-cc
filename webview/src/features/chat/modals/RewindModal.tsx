import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "../../../design/icons";
import { Overlay } from "../../../design/primitives";
import { formatDuration } from "../../../lib/format";
import type { LiveAgents } from "../subagent-state";
import s from "./RewindModal.module.scss";

interface RewindModalProps {
  /** What the rewind would remove, or null when closed. Null *is* the closed
   *  state — the component stays mounted so it can animate out. */
  pending: { messagesAfter: number } | null;
  /** What rewinding will also destroy. Rewinding interrupts the turn *and*
   *  releases the CLI process, so a background agent does not merely stop —
   *  the run it belonged to is gone. */
  agents: LiveAgents;
  onCancel: () => void;
  onConfirm: () => void;
}

export function RewindModal({
  pending,
  agents,
  onCancel,
  onConfirm
}: RewindModalProps) {
  const open = pending !== null;
  // Held across the dismissal so the exit animation does not play over a panel
  // whose numbers the parent has already cleared.
  const [shown, setShown] = useState(pending);
  if (pending && pending !== shown) setShown(pending);

  // Escape is `Overlay`'s; Enter stays here and on `window`, so confirming does
  // not depend on where the focus landed.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onConfirm]);

  if (!shown) return null;
  const messagesAfter = shown.messagesAfter;
  const plural = messagesAfter !== 1 ? "s" : "";

  return (
    <Overlay
      open={open}
      onClose={onCancel}
      label="Rewind conversation"
      className={s.panel}
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
            data-autofocus
          >
            <Icon name="history" size={12} />
            Rewind
            <kbd className={s.confirmKbd}>↵</kbd>
          </button>
        </div>
      </div>
    </Overlay>
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
