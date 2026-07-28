// ─────────────────────────────────────────────────────────────
// The standing permissions the user has granted, and the only way to take
// one back.
//
// This screen is not a convenience. Grants are stored globally — a grant made
// in your own repository is in force inside a clone of someone else's — and a
// permission you cannot see is one you cannot withdraw. That is the whole
// reason the list exists, and why it says where the grants apply rather than
// leaving it to be discovered.
// ─────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { onMessage, send, type ToolGrantView } from "../../lib/rpc";
import { Icon } from "../../design/icons";
import { Tooltip } from "../../design/primitives";
import { BACKDROP, OVERLAY_PANEL, enterAt } from "../../design/motion";
import s from "./PermissionsModal.module.scss";

interface PermissionsModalProps {
  open: boolean;
  onClose: () => void;
}

export function PermissionsModal({ open, onClose }: PermissionsModalProps) {
  const [grants, setGrants] = useState<ToolGrantView[]>([]);

  useEffect(() => {
    if (!open) return;
    send({ type: "requestToolGrants" });
  }, [open]);

  // Outside the `open` guard: a grant made from a card while this is closed
  // should be there when it opens, and the host broadcasts to every
  // conversation rather than answering only the one that asked.
  useEffect(
    () =>
      onMessage((m) => {
        if (m.type === "toolGrants") setGrants(m.grants);
      }),
    []
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div className={s.scrim} {...BACKDROP} onClick={onClose}>
          <motion.div
            className={s.panel}
            role="dialog"
            aria-label="Standing permissions"
            // The scrim closes on click; the panel is inside it, so without
            // this every click on the list dismisses the thing being read.
            onClick={(e) => e.stopPropagation()}
            {...OVERLAY_PANEL}
          >
            <div className={s.head}>
              <Icon name="shield" size={13} />
              <span className={s.title}>Standing permissions</span>
              <Tooltip label="Close">
                <button
                  type="button"
                  className={s.close}
                  onClick={onClose}
                  aria-label="Close"
                >
                  <Icon name="x" size={13} />
                </button>
              </Tooltip>
            </div>

            <p className={s.note}>
              Granted from an approval card. They apply in every project you
              open, and they never cover a destructive or network call — those
              always ask.
            </p>

            {grants.length === 0 ? (
              <div className={s.empty}>
                Nothing granted. Every tool call still asks.
              </div>
            ) : (
              <ul className={s.list}>
                {grants.map((g, i) => (
                  <motion.li key={keyOf(g)} {...enterAt(i)} className={s.row}>
                    <Icon name="shield" size={12} />
                    <span className={s.tool}>{g.tool}</span>
                    {g.prefix && <code className={s.prefix}>{g.prefix} …</code>}
                    <Tooltip label="Revoke — this call will ask again">
                      <button
                        type="button"
                        className={s.revoke}
                        onClick={() =>
                          send({ type: "revokeToolGrant", key: keyOf(g) })
                        }
                      >
                        Revoke
                      </button>
                    </Tooltip>
                  </motion.li>
                ))}
              </ul>
            )}

            {grants.length > 0 && (
              <div className={s.foot}>
                <button
                  type="button"
                  className={s.revokeAll}
                  onClick={() => send({ type: "revokeToolGrant", key: "*" })}
                >
                  Revoke all
                </button>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Mirrors `grantKey` in src/core/tool-grants.ts — the host revokes by this
 *  string, so the two spellings have to agree. */
function keyOf(grant: ToolGrantView): string {
  return grant.prefix ? `${grant.tool} ${grant.prefix}` : grant.tool;
}
