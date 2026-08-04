// ─────────────────────────────────────────────────────────────
// EditedFilesCard — Cursor-style compact summary panel shown at
// the end of a turn that performed file writes/edits. Mimics the
// bottom "1 File … Undo Review" footer in Cursor:
//
//   ┌─────────────────────────────────────────────────┐
//   │ ▾ 1 File                          Undo  Review  │
//   ├─────────────────────────────────────────────────┤
//   │ JS budgetAdvisor.js                    +23 -1   │
//   └─────────────────────────────────────────────────┘
//
//   • Click the chevron to collapse/expand the file list.
//   • Click a row to open the full diff modal.
//   • "Undo" reverts every file in the bunch to its pre-turn
//     snapshot via the per-file revert RPC (two-click confirm).
//   • "Review" opens each file's diff modal sequentially (or just
//     the first one).
// ─────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { send, onMessage } from "../../lib/rpc";
import { Icon } from "../../design/icons";
import { Tooltip } from "../../design/primitives";
import { ENTER_CARD, EXPAND, TRAVEL, enterAt } from "../../design/motion";
import { FileDiffModal, FileEditEntry, DiffLineNote } from "./FileDiffModal";
import { FileBadge } from "./FileBadge";
import tool from "./ToolCard.module.scss";
import s from "./EditedFilesCard.module.scss";

interface EditedFilesCardProps {
  edits: FileEditEntry[];
  onAddDiffNote?: (note: DiffLineNote) => void;
}

type RevertState = "idle" | "confirming" | "reverting" | "done" | "failed";

export function EditedFilesCard({
  edits,
  onAddDiffNote
}: EditedFilesCardProps) {
  const [openState, setOpenState] = useState<{
    entry: FileEditEntry;
    rect: DOMRect | null;
  } | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [undoConfirm, setUndoConfirm] = useState(false);
  const openEntry = openState?.entry ?? null;
  const [revertState, setRevertState] = useState<Map<string, RevertState>>(
    new Map()
  );
  const [revertError, setRevertError] = useState<Map<string, string>>(
    new Map()
  );

  useEffect(() => {
    return onMessage((m) => {
      if (m.type !== "revertResult") return;
      setRevertState((prev) => {
        const next = new Map(prev);
        next.set(m.path, m.ok ? "done" : "failed");
        return next;
      });
      setRevertError((prev) => {
        const next = new Map(prev);
        if (!m.ok && m.error) next.set(m.path, m.error);
        else next.delete(m.path);
        return next;
      });
      if (!m.ok) {
        setTimeout(() => {
          setRevertState((prev) => {
            const next = new Map(prev);
            if (next.get(m.path) === "failed") next.delete(m.path);
            return next;
          });
          setRevertError((prev) => {
            const next = new Map(prev);
            next.delete(m.path);
            return next;
          });
        }, 5000);
      }
    });
  }, []);

  const stats = useMemo(() => computeStats(edits), [edits]);
  // True when every file in the bunch has been successfully reverted.
  // Drives the "all reverted" header treatment + hides the Undo button so
  // the user can't double-undo (which would just hit "no prior snapshot").
  const allReverted = useMemo(
    () =>
      edits.length > 0 &&
      edits.every((e) => revertState.get(e.path) === "done"),
    [edits, revertState]
  );
  const anyReverting = useMemo(
    () => edits.some((e) => revertState.get(e.path) === "reverting"),
    [edits, revertState]
  );

  const handleUndoAll = () => {
    if (!undoConfirm) {
      setUndoConfirm(true);
      setTimeout(() => setUndoConfirm(false), 2500);
      return;
    }
    setUndoConfirm(false);
    // Fire revertFile per file. Each one independently resolves with a
    // revertResult event; the per-file state will animate accordingly.
    for (const e of edits) {
      if (revertState.get(e.path) === "done") continue;
      setRevertState((prev) => {
        const next = new Map(prev);
        next.set(e.path, "reverting");
        return next;
      });
      send({ type: "revertFile", path: e.path });
    }
  };

  const handleReview = () => {
    // Open the first non-reverted file's diff modal as the review starting point.
    const first = edits.find((e) => revertState.get(e.path) !== "done");
    if (first) setOpenState({ entry: first, rect: null });
  };

  if (edits.length === 0) return null;

  return (
    <>
      <motion.div {...ENTER_CARD} className={s.card}>
        {/* Header bar: chevron + file count, then Undo / Review */}
        <div className={s.head}>
          <button
            type="button"
            onClick={() => setExpanded((x) => !x)}
            className={s.toggle}
          >
            <motion.span
              animate={{ rotate: expanded ? 0 : -90 }}
              // Borrows EXPAND's timing so the chevron and the list it controls
              // read as one gesture. The preset itself animates height, which a
              // rotation cannot use.
              transition={EXPAND.transition}
              className={s.chev}
            >
              <Icon name="chevronD" size={10} />
            </motion.span>
            <span className={s.count}>
              {edits.length} File{edits.length === 1 ? "" : "s"}
            </span>
            <span className={s.headStats}>
              {stats.added > 0 && <span className={s.add}>+{stats.added}</span>}
              {stats.removed > 0 && (
                <span className={s.del}>−{stats.removed}</span>
              )}
            </span>
          </button>
          <div className={s.actions}>
            {allReverted ? (
              // Terminal "all reverted" state — Undo is no longer applicable
              // (the file is already at its pre-turn snapshot). Show a single
              // status pill so the panel reads as resolved.
              <Tooltip label="Every file has been restored to its pre-turn state.">
                <span className={s.revertedPill}>
                  <Icon name="check" size={9} />
                  Reverted
                </span>
              </Tooltip>
            ) : (
              <>
                {/* This button declares `disabled`, so the Tooltip puts its
                    handlers on a wrapper — a disabled control fires nothing and
                    the hit test never reaches an ancestor. The wrapper is an
                    inline-flex flex item in a flex row, so the pair still sits
                    where it did. */}
                <Tooltip
                  label={
                    undoConfirm
                      ? "Click again to confirm — replaces every file with its pre-turn snapshot"
                      : "Revert every file in this turn to its pre-turn state"
                  }
                >
                  <button
                    type="button"
                    onClick={handleUndoAll}
                    disabled={anyReverting}
                    className={[
                      s.btn,
                      undoConfirm ? s.undoArmed : s.undo,
                      anyReverting ? s.busy : ""
                    ].join(" ")}
                  >
                    {anyReverting
                      ? "Undoing…"
                      : undoConfirm
                        ? "Click again"
                        : "Undo"}
                  </button>
                </Tooltip>
                <Tooltip label="Review changes in a full diff view">
                  <button
                    type="button"
                    onClick={handleReview}
                    className={[s.btn, s.review].join(" ")}
                  >
                    Review
                  </button>
                </Tooltip>
              </>
            )}
          </div>
        </div>

        {/* File list */}
        <AnimatePresence initial={false}>
          {expanded && (
            <motion.ul {...EXPAND} className={s.list}>
              {edits.map((e, i) => (
                <motion.li
                  key={e.id}
                  // Rows arrive from the left, not from below — that axis is the
                  // component's, and only the timing is being unified here.
                  initial={{ opacity: 0, x: -TRAVEL.sm }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={enterAt(i).transition}
                  className={s.row}
                >
                  <FileRow
                    entry={e}
                    revertState={revertState.get(e.path) ?? "idle"}
                    revertError={revertError.get(e.path)}
                    onOpenInEditor={() =>
                      send({ type: "openFile", path: e.path })
                    }
                  />
                </motion.li>
              ))}
            </motion.ul>
          )}
        </AnimatePresence>
      </motion.div>

      <FileDiffModal
        entry={openEntry}
        originRect={openState?.rect ?? null}
        onClose={() => setOpenState(null)}
        onAddNote={onAddDiffNote}
      />
    </>
  );
}

// ─────────────────── Row ───────────────────

function FileRow({
  entry,
  revertState,
  revertError,
  onOpenInEditor
}: {
  entry: FileEditEntry;
  revertState: RevertState;
  revertError?: string;
  onOpenInEditor: () => void;
}) {
  const name = baseName(entry.path);
  const counts = useMemo(() => countDelta(entry), [entry]);
  const isReverted = revertState === "done";
  const isReverting = revertState === "reverting";
  const isFailed = revertState === "failed";

  return (
    // `wrap`: the row shows the basename only, so the whole point of the label
    // is the directory the ellipsis dropped. On one line the cap would cut it
    // again — and it cuts from the right, taking the filename with it.
    <Tooltip label={`Open ${entry.path}`} wrap>
      <div
        onClick={onOpenInEditor}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpenInEditor();
          }
        }}
        className={[s.file, isReverted ? s.fileReverted : ""].join(" ")}
      >
        <FileBadge path={entry.path} size={16} />
        <span className={[s.name, isReverted ? s.nameReverted : ""].join(" ")}>
          {name}
        </span>
        {isReverting ? (
          <span className={s.reverting}>
            <span className={tool.spinner} />
            reverting
          </span>
        ) : isReverted ? (
          <span className={[s.chip, s.chipOk].join(" ")}>
            <Icon name="check" size={8} />
            Reverted
          </span>
        ) : isFailed ? (
          // `wrap`: this is the raw failure text off the extension host — a
          // value of whatever length the filesystem felt like, not a phrase.
          <Tooltip label={revertError ?? "Revert failed"} wrap>
            <span className={[s.chip, s.chipErr].join(" ")}>
              <Icon name="x" size={8} />
              Failed
            </span>
          </Tooltip>
        ) : (
          <span className={s.rowStats}>
            {counts.added > 0 && <span className={s.add}>+{counts.added}</span>}
            {counts.removed > 0 && (
              <span className={s.del}>−{counts.removed}</span>
            )}
          </span>
        )}
      </div>
    </Tooltip>
  );
}

// ─────────────────── Helpers ───────────────────

function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function computeStats(edits: FileEditEntry[]): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const e of edits) {
    const c = countDelta(e);
    added += c.added;
    removed += c.removed;
  }
  return { added, removed };
}

function countDelta(entry: FileEditEntry): { added: number; removed: number } {
  if (entry.changes.length === 0) return { added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const c of entry.changes) {
    if (c.kind === "write") {
      added += c.newText.split("\n").length;
    } else if (c.kind === "edit") {
      const a = c.oldText.split("\n");
      const b = c.newText.split("\n");
      const { adds, dels } = lcsCounts(a, b);
      added += adds;
      removed += dels;
    }
  }
  return { added, removed };
}

function lcsCounts(a: string[], b: string[]): { adds: number; dels: number } {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0)
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  let adds = 0;
  let dels = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      dels++;
      i++;
    } else {
      adds++;
      j++;
    }
  }
  dels += m - i;
  adds += n - j;
  return { adds, dels };
}
