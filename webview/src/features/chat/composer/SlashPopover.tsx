// ─────────────────────────────────────────────────────────────
// Slash-command popover. Typing `/` at the start of an empty prompt offers
// what the CLI can run; typing more filters it.
//
// The list is static for the session, so filtering happens here rather than
// over the seam — the mention popover round-trips because file search must hit
// the disk, and there is nothing here worth a request per keystroke.
//
// Nothing is expanded on this side. The CLI resolves `/name` itself, so the
// pick only writes text into the composer.
//
// Wears the mention popover's stylesheet on purpose: same surface, same
// geometry, one place to change it. A copy would drift the first time either
// is touched.
// ─────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { SlashCommand } from "../../../lib/rpc";
import { filterCommands } from "./slash-filter";
import { Icon } from "../../../design/icons";
import { OVERLAY_PANEL } from "../../../design/motion";
import s from "./MentionPopover.module.scss";

export interface SlashPopoverProps {
  query: string;
  open: boolean;
  commands: SlashCommand[];
  onPick: (command: SlashCommand) => void;
  onClose: () => void;
}

export function SlashPopover({
  query,
  open,
  commands,
  onPick,
  onClose
}: SlashPopoverProps) {
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Everything that matches. The list scrolls rather than truncating: a cap
  // hides commands the user knows they have, and "it is not in the list" is
  // indistinguishable from "it does not exist".
  const matches = useMemo(
    () => filterCommands(commands, query),
    [commands, query]
  );

  useEffect(() => {
    setActive(0);
  }, [query]);

  // Arrowing past the visible rows would otherwise move a selection nobody can
  // see — the list is 260px tall and the CLI reports well over a hundred.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // `preventDefault` alone is not enough: the editor submits from its own
      // keydown handler and never looks at `defaultPrevented`, so Enter picked
      // a command *and* sent the half-written message. The event has to stop
      // here.
      const consume = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      if (e.key === "ArrowDown") {
        consume();
        setActive((i) => Math.min(i + 1, Math.max(matches.length - 1, 0)));
      } else if (e.key === "ArrowUp") {
        consume();
        setActive((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" || e.key === "Tab") {
        if (matches.length > 0) {
          consume();
          onPick(matches[active]);
        }
      } else if (e.key === "Escape") {
        consume();
        onClose();
      }
    };
    // Capture phase so this runs before the editor sees the key at all.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, matches, active, onPick, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className={s.popover}
          role="listbox"
          aria-label="Slash commands"
          {...OVERLAY_PANEL}
        >
          <div className={s.head}>
            <Icon name="terminal" size={11} />
            <span>
              {query
                ? `Commands matching "${query}" (${matches.length})`
                : `Run a command (${matches.length})`}
            </span>
            <span className={s.hint}>↑↓ navigate · ↵ select · Esc</span>
          </div>
          {matches.length === 0 ? (
            <div className={s.empty}>No matching command</div>
          ) : (
            <div className={s.list} ref={listRef}>
              {matches.map((c, i) => (
                <button
                  key={c.name}
                  role="option"
                  aria-selected={i === active}
                  type="button"
                  className={i === active ? `${s.item} ${s.active}` : s.item}
                  onMouseEnter={() => setActive(i)}
                  onClick={(e) => {
                    e.preventDefault();
                    onPick(c);
                  }}
                >
                  <Icon name={c.source === "cli" ? "bolt" : "code"} size={12} />
                  <span className={s.name}>/{c.name}</span>
                  <span className={s.path}>{c.description ?? ""}</span>
                </button>
              ))}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
