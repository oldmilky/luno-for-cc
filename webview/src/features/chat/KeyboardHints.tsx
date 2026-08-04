// ─────────────────────────────────────────────────────────────
// KeyboardHints — overlay listing the extension's shortcuts.
// Triggered by pressing "?" (when not focused in an input). Esc to
// dismiss.
//
// Every row here is a promise: it must correspond to a keybinding in
// package.json or a handler in the webview. Rows for Cmd+I and Cmd+/
// were removed because neither was ever bound to anything.
// ─────────────────────────────────────────────────────────────

import { useEffect } from "react";
import { motion } from "framer-motion";
import { Icon } from "../../design/icons";
import { Overlay, Tooltip } from "../../design/primitives";
import { BACKDROP, enterAt } from "../../design/motion";
import { useWebviewSettings } from "../../lib/settings";
import s from "./KeyboardHints.module.scss";

interface Group {
  label: string;
  rows: Array<{ keys: string[]; desc: string }>;
}

/** `luno.useCtrlEnterToSend` moves send onto a modifier and gives Enter back
 *  to the line break. A panel advertising the other pair would be teaching the
 *  shortcut that does nothing. */
function groups(useCtrlEnterToSend: boolean): Group[] {
  const sendRows = useCtrlEnterToSend
    ? [
        { keys: ["⌘/Ctrl", "↵"], desc: "Send message" },
        { keys: ["↵"], desc: "New line" }
      ]
    : [
        { keys: ["↵"], desc: "Send message" },
        { keys: ["⇧", "↵"], desc: "New line" }
      ];
  return [
    {
      label: "In editor",
      rows: [
        { keys: ["⌘", "U"], desc: "Send selection to chat" },
        { keys: ["⌘", "⇧", "I"], desc: "Toggle chat panel" }
      ]
    },
    {
      label: "In chat",
      rows: [
        { keys: ["⌘", "K"], desc: "Command palette" },
        { keys: ["⇧", "Tab"], desc: "Cycle permission mode" },
        { keys: ["@"], desc: "Mention a file, folder or terminal" },
        ...sendRows,
        { keys: ["Esc"], desc: "Cancel / close modal" }
      ]
    },
    {
      label: "Navigation",
      rows: [{ keys: ["?"], desc: "Open this help" }]
    }
  ];
}

export function KeyboardHints({
  open,
  onClose
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { useCtrlEnterToSend } = useWebviewSettings();
  // Escape is `Overlay`'s. "?" stays here — it toggles the panel rather than
  // closing it, so it is this component's key and not every overlay's.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "?") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <Overlay
      open={open}
      onClose={onClose}
      label="Keyboard shortcuts"
      className={s.panel}
      backdropClassName={s.scrim}
      // The scrim blurs what sits behind it and `BACKDROP` carries opacity
      // only, so each state is re-stated with the blur folded in. The preset's
      // duration and curve are left untouched.
      backdropMotion={{
        initial: { ...BACKDROP.initial, backdropFilter: "blur(0px)" },
        animate: { ...BACKDROP.animate, backdropFilter: "blur(4px)" },
        exit: { ...BACKDROP.exit, backdropFilter: "blur(0px)" }
      }}
    >
      <div className={s.head}>
        <div className={s.headTitles}>
          <span className={s.headTile}>
            <Icon name="zap" size={13} />
          </span>
          <h2 className={s.headTitle}>Keyboard shortcuts</h2>
        </div>
        <Tooltip label="Close (Esc)">
          <button
            type="button"
            onClick={onClose}
            className={s.close}
            aria-label="Close"
          >
            <Icon name="x" size={13} />
          </button>
        </Tooltip>
      </div>

      <div className={s.body}>
        {groups(useCtrlEnterToSend).map((g, gi) => (
          <motion.section key={g.label} {...enterAt(gi)} className={s.group}>
            <div className={s.groupLabel}>{g.label}</div>
            <ul className={s.rows}>
              {g.rows.map((r, i) => (
                <li key={i} className={s.row}>
                  <span className={s.desc}>{r.desc}</span>
                  <span className={s.keys}>
                    {r.keys.map((k, ki) => (
                      <kbd key={ki} className={s.key}>
                        {k}
                      </kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </motion.section>
        ))}
      </div>

      <div className={s.foot}>
        <span>
          Press <kbd className={s.footKey}>?</kbd> to toggle
        </span>
        <span>
          <kbd className={s.footKey}>Esc</kbd> to close
        </span>
      </div>
    </Overlay>
  );
}
