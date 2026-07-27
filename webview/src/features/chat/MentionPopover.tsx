// ─────────────────────────────────────────────────────────────
// @-mention popover. Listens to the extension's file search RPC
// and shows the matching files inline above the textarea. Handles
// keyboard navigation (↑/↓ to move, ↵ to pick, Esc to dismiss).
// ─────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { send, onMessage, newId, FileSearchResult } from "../../lib/rpc";
import { Icon } from "../../design/icons";
import { OVERLAY_PANEL } from "../../design/motion";
import s from "./MentionPopover.module.scss";

export interface MentionPopoverProps {
  query: string;
  open: boolean;
  onPick: (result: FileSearchResult) => void;
  onClose: () => void;
}

export function MentionPopover({
  query,
  open,
  onPick,
  onClose
}: MentionPopoverProps) {
  const [results, setResults] = useState<FileSearchResult[]>([]);
  const [active, setActive] = useState(0);
  const requestId = useRef<string>("");

  useEffect(() => {
    if (!open) return;
    const id = newId();
    requestId.current = id;
    const t = setTimeout(
      () => send({ type: "requestFileSearch", id, query }),
      60
    );
    return () => clearTimeout(t);
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    return onMessage((m) => {
      if (m.type === "fileSearchResults" && m.id === requestId.current) {
        setResults(m.results);
        setActive(0);
      }
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // The editor submits from its own keydown handler and never checks
      // `defaultPrevented`, so preventing the default was not enough: picking
      // a file with Enter inserted the mention *and* sent the message, which
      // went out as a bare "@file.ts" before the user had written their
      // question. The event has to stop here.
      const consume = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      if (e.key === "ArrowDown") {
        consume();
        setActive((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
      } else if (e.key === "ArrowUp") {
        consume();
        setActive((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" || e.key === "Tab") {
        if (results.length > 0) {
          consume();
          onPick(results[active]);
        }
      } else if (e.key === "Escape") {
        consume();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, results, active, onPick, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className={s.popover}
          role="listbox"
          aria-label="File suggestions"
          {...OVERLAY_PANEL}
        >
          <div className={s.head}>
            <Icon name="at" size={11} />
            <span>
              {query ? `Files matching "${query}"` : "Mention a file"}
            </span>
            <span className={s.hint}>↑↓ navigate · ↵ select · Esc</span>
          </div>
          {results.length === 0 ? (
            <div className={s.empty}>No matches</div>
          ) : (
            <div className={s.list}>
              {results.map((r, i) => (
                <button
                  key={r.path}
                  role="option"
                  aria-selected={i === active}
                  type="button"
                  className={i === active ? `${s.item} ${s.active}` : s.item}
                  onMouseEnter={() => setActive(i)}
                  onClick={(e) => {
                    e.preventDefault();
                    onPick(r);
                  }}
                >
                  <Icon name="file" size={12} />
                  <span className={s.name}>{r.name}</span>
                  <span className={s.path}>
                    {r.path.length > 56 ? "…" + r.path.slice(-55) : r.path}
                  </span>
                </button>
              ))}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
