// ─────────────────────────────────────────────────────────────
// Every permission in force, and the only way to take one back.
//
// Two lists, and the difference between them is the whole point. The first is
// LUNO's own standing grants: stored globally — a grant made in your own
// repository is in force inside a clone of someone else's — and revocable
// here, because a permission you cannot see is one you cannot withdraw.
//
// The second is what the CLI is *already* applying from its own settings
// files, which until now was invisible from inside LUNO: a project that ships
// a `.claude/settings.json` could allow or deny tools with nothing on screen
// to say so. LUNO shows these and does not enforce them — the CLI does that,
// and a second, divergent policy engine here would be worse than none.
// ─────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  onMessage,
  send,
  type PermissionRuleView,
  type ToolGrantView,
  type UnreadableSourceView
} from "../../lib/rpc";
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
  const [rules, setRules] = useState<PermissionRuleView[]>([]);
  const [unreadable, setUnreadable] = useState<UnreadableSourceView[]>([]);
  const [cannotRead, setCannotRead] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    send({ type: "requestToolGrants" });
    // Read fresh every time: these live in files the user can edit in the
    // editor behind this modal, so a cached list would go stale silently.
    send({ type: "requestPermissionRules" });
  }, [open]);

  // Outside the `open` guard: a grant made from a card while this is closed
  // should be there when it opens, and the host broadcasts to every
  // conversation rather than answering only the one that asked.
  useEffect(
    () =>
      onMessage((m) => {
        if (m.type === "toolGrants") setGrants(m.grants);
        if (m.type === "permissionRules") {
          setRules(m.rules);
          setUnreadable(m.unreadable);
          setCannotRead(m.cannotRead);
        }
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
            aria-label="Permissions"
            // The scrim closes on click; the panel is inside it, so without
            // this every click on the list dismisses the thing being read.
            onClick={(e) => e.stopPropagation()}
            {...OVERLAY_PANEL}
          >
            <div className={s.head}>
              <Icon name="shield" size={13} />
              <span className={s.title}>Permissions</span>
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

            <div className={s.body}>
              <div className={s.sectionHead}>
                <span className={s.sectionTitle}>Granted here</span>
                {grants.length > 0 && (
                  <button
                    type="button"
                    className={s.revokeAll}
                    onClick={() => send({ type: "revokeToolGrant", key: "*" })}
                  >
                    Revoke all
                  </button>
                )}
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
                      {g.prefix && (
                        <code className={s.prefix}>{g.prefix} …</code>
                      )}
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

              <div className={s.sectionHead}>
                <span className={s.sectionTitle}>Already in force</span>
              </div>
              <p className={s.note}>
                Rules the Claude CLI applies from its own settings files. LUNO
                shows them; it does not decide between them, and it cannot
                revoke one it did not make — open the file to change it.
              </p>

              {rules.length === 0 ? (
                <div className={s.empty}>
                  No rules in any settings file. Nothing outside LUNO is
                  allowing or denying a tool.
                </div>
              ) : (
                <ul className={s.list}>
                  {rules.map((r, i) => (
                    <motion.li
                      key={`${r.source}:${r.kind}:${r.rule}:${r.file}`}
                      {...enterAt(i)}
                      className={s.row}
                    >
                      <span className={`${s.kind} ${s[r.kind]}`}>{r.kind}</span>
                      <code className={s.rule}>{r.rule}</code>
                      <span className={s.source}>{r.source}</span>
                      <Tooltip label={`Open ${r.file}`}>
                        <button
                          type="button"
                          className={s.open}
                          onClick={() =>
                            send({
                              type: "openFile",
                              path: r.file,
                              startLine: r.line
                            })
                          }
                          aria-label={`Open the file that sets ${r.rule}`}
                        >
                          <Icon name="file" size={12} />
                        </button>
                      </Tooltip>
                    </motion.li>
                  ))}
                </ul>
              )}

              {unreadable.map((u) => (
                <p key={u.file} className={s.warn}>
                  <Icon name="danger" size={12} />
                  <span>
                    The {u.source} settings at <code>{u.file}</code> could not
                    be read — {u.reason}. Rules in it are not listed above, but
                    the CLI may still be applying them.
                  </span>
                </p>
              ))}

              {cannotRead.length > 0 && (
                <p className={s.warn}>
                  <Icon name="info" size={12} />
                  <span>
                    LUNO cannot read {cannotRead.join(", ")}. If your
                    organisation sets policy there, it is in force and not shown
                    here.
                  </span>
                </p>
              )}
            </div>
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
