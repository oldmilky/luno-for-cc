// ─────────────────────────────────────────────────────────────
// KeyboardHints — overlay listing the extension's shortcuts.
// Triggered by pressing "?" (when not focused in an input). Esc to
// dismiss. Useful for discoverability of Cmd+I / Cmd+U / Shift+Tab
// and the in-webview shortcuts (Cmd+K palette, n new chat).
// ─────────────────────────────────────────────────────────────

import { useEffect } from "react";
import { motion } from "framer-motion";
import { Icon } from "../../design/icons";
import { Tooltip } from "../../design/primitives";
import { BACKDROP, OVERLAY_PANEL, enterAt } from "../../design/motion";
import s from "./KeyboardHints.module.scss";

interface Group {
  label: string;
  rows: Array<{ keys: string[]; desc: string }>;
}

const GROUPS: Group[] = [
  {
    label: "In editor",
    rows: [
      { keys: ["⌘", "I"], desc: "Inline edit at cursor" },
      { keys: ["⌘", "U"], desc: "Send selection to chat" },
      { keys: ["⌘", "⇧", "I"], desc: "Toggle chat panel" }
    ]
  },
  {
    label: "In chat",
    rows: [
      { keys: ["⌘", "K"], desc: "Command palette" },
      { keys: ["⇧", "Tab"], desc: "Cycle permission mode" },
      { keys: ["@"], desc: "Mention a file" },
      { keys: ["↵"], desc: "Send message" },
      { keys: ["⇧", "↵"], desc: "New line" },
      { keys: ["Esc"], desc: "Cancel / close modal" }
    ]
  },
  {
    label: "Navigation",
    rows: [
      { keys: ["?"], desc: "Open this help" },
      { keys: ["⌘", "/"], desc: "Toggle keyboard hints" }
    ]
  }
];

export function KeyboardHints({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "?") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <motion.div
      className={s.scrim}
      {...BACKDROP}
      // This scrim also blurs what sits behind it, and BACKDROP only carries
      // opacity. Each preset state is re-stated with the blur folded in — the
      // preset's duration and curve are left untouched.
      initial={{ ...BACKDROP.initial, backdropFilter: "blur(0px)" }}
      animate={{ ...BACKDROP.animate, backdropFilter: "blur(4px)" }}
      exit={{ ...BACKDROP.exit, backdropFilter: "blur(0px)" }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <motion.div
        {...OVERLAY_PANEL}
        className={s.panel}
        onClick={(e) => e.stopPropagation()}
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
          {GROUPS.map((g, gi) => (
            <motion.section
              key={g.label}
              {...enterAt(gi)}
              className={s.group}
            >
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
      </motion.div>
    </motion.div>
  );
}
