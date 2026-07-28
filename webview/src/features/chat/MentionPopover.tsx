// ─────────────────────────────────────────────────────────────
// @-mention popover. Listens to the extension's file search RPC
// and shows the matching files and folders inline above the textarea.
// Handles keyboard navigation (↑/↓ to move, ↵ to pick, Esc to dismiss).
//
// `@terminal:` switches the same list to what each terminal last ran. It is
// one popover rather than two because it is one token: the user is still
// answering "what should the model see", and a second overlay for the second
// answer would be a mode nobody asked to enter.
// ─────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  send,
  onMessage,
  newId,
  FileSearchResult,
  TerminalRunView
} from "../../lib/rpc";
import { Icon } from "../../design/icons";
import { OVERLAY_PANEL } from "../../design/motion";
import s from "./MentionPopover.module.scss";

/** The prefix that turns the file list into the terminal list. */
export const TERMINAL_PREFIX = "terminal:";

/** What picking a row inserts: an atomic pill whose `token` is what the
 *  prompt will carry, and whose `label` is what the pill shows. */
export interface MentionPick {
  token: string;
  label: string;
  /** Workspace path for a file or folder; the token itself for a terminal,
   *  which has no path. Kept on the pill for the open-on-click affordance. */
  path: string;
}

export interface MentionPopoverProps {
  query: string;
  open: boolean;
  onPick: (pick: MentionPick) => void;
  onClose: () => void;
}

interface Row {
  key: string;
  icon: "file" | "folder" | "terminal";
  label: string;
  detail: string;
  pick: MentionPick;
}

export function MentionPopover({
  query,
  open,
  onPick,
  onClose
}: MentionPopoverProps) {
  const [files, setFiles] = useState<FileSearchResult[]>([]);
  const [terminals, setTerminals] = useState<TerminalRunView[]>([]);
  const [active, setActive] = useState(0);
  const requestId = useRef<string>("");

  const terminalMode = query.toLowerCase().startsWith(TERMINAL_PREFIX);
  const terminalQuery = terminalMode
    ? query.slice(TERMINAL_PREFIX.length).toLowerCase()
    : "";

  useEffect(() => {
    if (!open) return;
    const id = newId();
    requestId.current = id;
    // Re-asked on every keystroke in terminal mode too: a build can finish
    // while the popover is open, and a list that was right when it opened is
    // the one thing worse than an empty one.
    const t = setTimeout(
      () =>
        send(
          terminalMode
            ? { type: "requestTerminals", id }
            : { type: "requestFileSearch", id, query }
        ),
      60
    );
    return () => clearTimeout(t);
  }, [query, open, terminalMode]);

  useEffect(() => {
    if (!open) return;
    return onMessage((m) => {
      if (m.type === "fileSearchResults" && m.id === requestId.current) {
        setFiles(m.results);
        setActive(0);
      }
      if (m.type === "terminalList" && m.id === requestId.current) {
        setTerminals(m.terminals);
        setActive(0);
      }
    });
  }, [open]);

  const rows = useMemo<Row[]>(
    () =>
      terminalMode
        ? terminalRows(terminals, terminalQuery)
        : files.map(fileRow),
    [terminalMode, terminals, terminalQuery, files]
  );

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
        setActive((i) => Math.min(i + 1, Math.max(rows.length - 1, 0)));
      } else if (e.key === "ArrowUp") {
        consume();
        setActive((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" || e.key === "Tab") {
        if (rows.length > 0) {
          consume();
          onPick(rows[active].pick);
        }
      } else if (e.key === "Escape") {
        consume();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, rows, active, onPick, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className={s.popover}
          role="listbox"
          aria-label={
            terminalMode ? "Terminal suggestions" : "File suggestions"
          }
          {...OVERLAY_PANEL}
        >
          <div className={s.head}>
            <Icon name={terminalMode ? "terminal" : "at"} size={11} />
            <span>{headline(query, terminalMode)}</span>
            <span className={s.hint}>↑↓ navigate · ↵ select · Esc</span>
          </div>
          {rows.length === 0 ? (
            <div className={s.empty}>
              {terminalMode ? EMPTY_TERMINALS : "No matches"}
            </div>
          ) : (
            <div className={s.list}>
              {rows.map((r, i) => (
                <button
                  key={r.key}
                  role="option"
                  aria-selected={i === active}
                  type="button"
                  className={i === active ? `${s.item} ${s.active}` : s.item}
                  onMouseEnter={() => setActive(i)}
                  onClick={(e) => {
                    e.preventDefault();
                    onPick(r.pick);
                  }}
                >
                  <Icon name={r.icon} size={12} />
                  <span className={s.name}>{r.label}</span>
                  <span className={s.path}>{ellipsize(r.detail)}</span>
                </button>
              ))}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Says why the list is empty rather than implying nothing ran. The capture
 *  needs shell integration and only sees commands run after Luno started —
 *  both look identical from here, and neither is a bug to report. */
const EMPTY_TERMINALS =
  "No captured runs. Needs shell integration, and only sees commands run since Luno started.";

function headline(query: string, terminalMode: boolean): string {
  if (terminalMode) return "Terminal output";
  return query ? `Matching "${query}"` : "Mention a file, folder or @terminal:";
}

function fileRow(r: FileSearchResult): Row {
  const folder = r.kind === "folder";
  return {
    key: r.path,
    icon: folder ? "folder" : "file",
    // A folder's whole path is the token: `@utils` names as many directories
    // as the project has, and the agent resolves what it is given.
    label: folder ? `${r.name}/` : r.name,
    detail: r.path,
    pick: { token: folder ? r.path : r.name, label: r.name, path: r.path }
  };
}

function terminalRows(
  terminals: ReadonlyArray<TerminalRunView>,
  filter: string
): Row[] {
  return terminals
    .filter((t) => t.terminalName.toLowerCase().includes(filter))
    .map((t) => {
      const token = `${TERMINAL_PREFIX}${t.terminalName}`;
      return {
        key: token,
        icon: "terminal" as const,
        label: t.terminalName,
        detail:
          t.exitCode === undefined
            ? t.commandLine
            : `${t.commandLine} · exit ${t.exitCode}`,
        pick: { token, label: token, path: token }
      };
    });
}

function ellipsize(text: string): string {
  return text.length > 56 ? "…" + text.slice(-55) : text;
}
