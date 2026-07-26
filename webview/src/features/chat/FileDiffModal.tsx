// ─────────────────────────────────────────────────────────────
// FileDiffModal — modal that shows what changed for one file in a
// turn. Aggregates all Write / Edit / MultiEdit tool calls that
// targeted the same path and renders a unified diff per change.
//
// Visual layout:
//   ┌─────────────────────────────────────────────────┐
//   │  📄  app/foo / Bar.tsx       WROTE   +12 −3    │  ← sticky header
//   │  ~/proj/src/app/foo/Bar.tsx                     │
//   ├─────────────────────────────────────────────────┤
//   │  Write 1 / 2                  +120              │
//   │  1 + const dayjs = …                            │  ← diff body
//   │  2 + const …                                    │
//   └─────────────────────────────────────────────────┘
// ─────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Icon } from "../../design/icons";
import { Tooltip } from "../../design/primitives";
import {
  BACKDROP,
  EXPAND,
  OVERLAY_PANEL,
  SPRING_POP,
  enterAt,
  stagger
} from "../../design/motion";
import { send } from "../../lib/rpc";
import s from "./FileDiffModal.module.scss";

export type FileChange =
  | { kind: "write"; newText: string }
  | { kind: "edit"; oldText: string; newText: string };

export interface FileEditEntry {
  id: string;
  path: string;
  /** "Created", "Edited", "Wrote" — displayed in the row & header. */
  action: "Created" | "Edited" | "Wrote" | "Updated";
  changes: FileChange[];
  /** True when any tool call for this path is still streaming/awaiting result. */
  pending?: boolean;
  /** True when any tool call for this path returned an error. */
  errored?: boolean;
}

export interface DiffLineNote {
  path: string;
  lineNo: number;
  text: string;
  context: string;
}

interface FileDiffModalProps {
  entry: FileEditEntry;
  onClose: () => void;
  /** Where on screen the click originated — modal will spring out of this rect. */
  originRect?: DOMRect | null;
  onAddNote?: (note: DiffLineNote) => void;
}

export function FileDiffModal({
  entry,
  onClose,
  originRect,
  onAddNote
}: FileDiffModalProps) {
  const [copied, setCopied] = useState(false);
  const [noteFor, setNoteFor] = useState<{
    lineNo: number;
    context: string;
  } | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  // Derive initial translate so the modal appears to morph out of the row that
  // was clicked. Only the offset is bespoke — the scale it starts at is the
  // overlay preset's, and with no origin the preset's own start is used whole.
  const initialTransform = useMemo(() => {
    if (!originRect) return OVERLAY_PANEL.initial;
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const ox = originRect.left + originRect.width / 2;
    const oy = originRect.top + originRect.height / 2;
    return {
      x: (ox - cx) * 0.25,
      y: (oy - cy) * 0.25,
      scale: OVERLAY_PANEL.initial.scale,
      opacity: 0
    };
  }, [originRect]);

  // ESC to dismiss
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const totals = useMemo(() => computeTotals(entry), [entry]);
  const crumbs = useMemo(() => makeCrumbs(entry.path), [entry.path]);
  const ext = useMemo(() => extOf(entry.path), [entry.path]);

  const copyDiff = async () => {
    const text = entry.changes
      .map((c) =>
        diffChange(c)
          .map(
            (r) =>
              `${r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}${r.text}`
          )
          .join("\n")
      )
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <motion.div className={s.overlay} {...BACKDROP} onClick={onClose}>
      <motion.div
        {...OVERLAY_PANEL}
        // Two overrides, both because of the origin morph: where the panel
        // starts is computed per-open so it grows out of the row that was
        // clicked, and the resting state has to name `x` — the preset never
        // travels sideways, so without it the horizontal offset would stick.
        initial={initialTransform}
        animate={{ ...OVERLAY_PANEL.animate, x: 0 }}
        className={s.panel}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Diff for ${baseName(entry.path)}`}
      >
        {/* ─────────────────── Header ─────────────────── */}
        <div className={s.header}>
          <div className={s.headerMain}>
            <motion.div
              initial={{ scale: 0.85, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              // The pop spring is reserved for brand marks; this tile is one.
              // The delay keeps it a beat behind the panel rather than riding in
              // with it.
              transition={{ ...SPRING_POP, delay: stagger(2) }}
              className={s.tile}
              // Per-language brand color — not themeable, so it stays data in
              // this file (EXT_COLORS). Unknown extensions keep the module's
              // --accent-glow.
              style={ext.color ? { color: ext.color } : undefined}
            >
              <Icon name="edit" size={14} />
            </motion.div>
            <div className={s.titleWrap}>
              {/* Title row: filename + action + stats */}
              <div className={s.titleRow}>
                <span className={s.fileName}>{baseName(entry.path)}</span>
                <ActionPill action={entry.action} />
                {(totals.added > 0 || totals.removed > 0) && (
                  <span className={s.stats}>
                    {totals.added > 0 && (
                      <span className={s.added}>+{totals.added}</span>
                    )}
                    {totals.removed > 0 && (
                      <span className={s.removed}>−{totals.removed}</span>
                    )}
                  </span>
                )}
              </div>
              {/* Breadcrumb row */}
              <BreadcrumbRow crumbs={crumbs} />
            </div>
          </div>

          <div className={s.actions}>
            <HeaderButton
              icon="copy"
              label={copied ? "Copied" : "Copy diff"}
              onClick={copyDiff}
              active={copied}
            />
            <HeaderButton
              icon="arrow"
              label="Open"
              onClick={() => send({ type: "openFile", path: entry.path })}
            />
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
        </div>

        {/* ─────────────────── Body ─────────────────── */}
        <div className={s.body}>
          {entry.changes.length === 0 ? (
            <EmptyDiff path={entry.path} />
          ) : (
            <div className={s.changes}>
              {entry.changes.map((c, i) => (
                <ChangeBlock
                  key={i}
                  change={c}
                  index={i}
                  total={entry.changes.length}
                  onLineClick={
                    onAddNote
                      ? (lineNo, context) => {
                          setNoteFor({ lineNo, context });
                          setNoteDraft("");
                        }
                      : undefined
                  }
                />
              ))}
            </div>
          )}
        </div>

        <AnimatePresence>
          {noteFor && (
            <motion.div
              key="note-popover"
              {...OVERLAY_PANEL}
              className={s.note}
            >
              <div className={s.noteHead}>
                <div className={s.noteTitle}>
                  Comment on line {noteFor.lineNo}
                </div>
                <button
                  type="button"
                  onClick={() => setNoteFor(null)}
                  className={s.noteClose}
                  aria-label="Close note"
                >
                  <Icon name="x" size={11} />
                </button>
              </div>
              <pre className={s.noteContext}>{noteFor.context}</pre>
              <textarea
                value={noteDraft}
                autoFocus
                rows={2}
                onChange={(e) => setNoteDraft(e.target.value)}
                placeholder="Leave a note — it'll be added to your next prompt as context."
                className={s.noteInput}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (!noteDraft.trim() || !onAddNote) return;
                    onAddNote({
                      path: entry.path,
                      lineNo: noteFor.lineNo,
                      text: noteDraft.trim(),
                      context: noteFor.context
                    });
                    setNoteFor(null);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setNoteFor(null);
                  }
                }}
              />
              <div className={s.noteFoot}>
                <div className={s.noteHint}>
                  <kbd className={s.noteKbd}>↵</kbd> to add ·{" "}
                  <kbd className={s.noteKbd}>Esc</kbd> to cancel
                </div>
                <button
                  type="button"
                  disabled={!noteDraft.trim()}
                  onClick={() => {
                    if (!noteDraft.trim() || !onAddNote) return;
                    onAddNote({
                      path: entry.path,
                      lineNo: noteFor.lineNo,
                      text: noteDraft.trim(),
                      context: noteFor.context
                    });
                    setNoteFor(null);
                  }}
                  className={s.noteAdd}
                >
                  Add to next prompt
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ─────────────────── Footer ─────────────────── */}
        <div className={s.footer}>
          <span>
            <kbd className={s.footerKbd}>Esc</kbd>
            <span className={s.footerKbdLabel}>to close</span>
          </span>
          <span className={s.footerCount}>
            {entry.changes.length}{" "}
            {entry.changes.length === 1 ? "change" : "changes"}
          </span>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ─────────────────── Sub-components ───────────────────

function ActionPill({ action }: { action: FileEditEntry["action"] }) {
  const tone =
    action === "Wrote" || action === "Created" ? s.actionNew : s.actionEdit;
  return <span className={`${s.actionPill} ${tone}`}>{action}</span>;
}

function BreadcrumbRow({ crumbs }: { crumbs: string[] }) {
  if (crumbs.length === 0) return null;
  return (
    <div className={s.crumbs}>
      {crumbs.map((c, i) => (
        <span key={i} className={s.crumb}>
          {i > 0 && <span className={s.crumbSep}>/</span>}
          <span className={s.crumbName}>{c}</span>
        </span>
      ))}
    </div>
  );
}

function HeaderButton({
  icon,
  label,
  onClick,
  active
}: {
  icon: "copy" | "arrow";
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    // No tooltip: `label` is rendered right there next to the icon, and the
    // old `title` repeated it word for word. A hint that restates what is
    // already on screen is not a hint.
    <button
      type="button"
      onClick={onClick}
      className={[s.hBtn, active ? s.hBtnActive : s.hBtnIdle].join(" ")}
    >
      <Icon name={icon} size={11} />
      {label}
    </button>
  );
}

function EmptyDiff({ path }: { path: string }) {
  return (
    <div className={s.empty}>
      <div className={s.emptyIcon}>
        <Icon name="file" size={18} />
      </div>
      <div className={s.emptyTitle}>No diff payload</div>
      <div className={s.emptyPath}>{path}</div>
      <div className={s.emptyHint}>
        Open the file in the editor to inspect its current state.
      </div>
      <button
        type="button"
        onClick={() => send({ type: "openFile", path })}
        className={s.emptyBtn}
      >
        <Icon name="arrow" size={11} />
        Open file
      </button>
    </div>
  );
}

function ChangeBlock({
  change,
  index,
  total,
  onLineClick
}: {
  change: FileChange;
  index: number;
  total: number;
  onLineClick?: (lineNo: number, context: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const rows = useMemo(() => diffChange(change), [change]);
  const added = rows.filter((r) => r.kind === "add").length;
  const removed = rows.filter((r) => r.kind === "del").length;
  // Compute line-numbers for old/new sides like a real unified diff
  const numbered = useMemo(() => assignLineNumbers(rows), [rows]);

  return (
    <motion.div {...enterAt(index)} className={s.change}>
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className={s.changeHead}
      >
        <span className={s.changeLeft}>
          <span className={s.changeChev}>
            <Icon name={collapsed ? "chevronR" : "chevronD"} size={9} />
          </span>
          <span
            className={[
              s.kindPill,
              change.kind === "write" ? s.kindWrite : s.kindEdit
            ].join(" ")}
          >
            {change.kind === "write" ? "Write" : "Edit"}
          </span>
          {total > 1 && (
            <span className={s.changeIndex}>
              {index + 1} of {total}
            </span>
          )}
        </span>
        <span className={s.changeStats}>
          {added > 0 && <span className={s.added}>+{added}</span>}
          {removed > 0 && <span className={s.removed}>−{removed}</span>}
        </span>
      </button>
      {!collapsed && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          // This body belongs to the collapse above it, so it takes EXPAND's
          // timing; the preset itself animates height, which this fade does not.
          transition={EXPAND.transition}
          className={s.diff}
        >
          {numbered.map((r, i) => (
            <DiffLine
              key={i}
              row={r}
              onClick={
                onLineClick && (r.kind === "add" || r.kind === "del")
                  ? () => onLineClick(r.newNo ?? r.oldNo ?? i + 1, r.text)
                  : undefined
              }
            />
          ))}
        </motion.div>
      )}
    </motion.div>
  );
}

interface NumberedRow {
  kind: "add" | "del" | "ctx";
  text: string;
  oldNo?: number;
  newNo?: number;
}

function assignLineNumbers(rows: ReadonlyArray<DiffRow>): NumberedRow[] {
  let o = 0;
  let n = 0;
  return rows.map((r) => {
    if (r.kind === "add") {
      n++;
      return { ...r, newNo: n };
    }
    if (r.kind === "del") {
      o++;
      return { ...r, oldNo: o };
    }
    o++;
    n++;
    return { ...r, oldNo: o, newNo: n };
  });
}

function DiffLine({
  row,
  onClick
}: {
  row: NumberedRow;
  onClick?: () => void;
}) {
  const isAdd = row.kind === "add";
  const isDel = row.kind === "del";
  const tone = isAdd ? s.lineAdd : isDel ? s.lineDel : s.lineCtx;
  const marker = isAdd ? "+" : isDel ? "−" : " ";
  const markerTone = isAdd ? s.markerAdd : isDel ? s.markerDel : s.markerCtx;
  return (
    <div
      className={[s.line, tone, onClick ? s.lineClickable : ""].join(" ")}
      onClick={onClick}
      // The one native `title` left in the app, deliberately. This renders once
      // per line of every diff — thousands of nodes in a large write — and the
      // Tooltip primitive brings a timer, a portal and two state hooks with it
      // each time. Here the attribute costs nothing and says the same thing.
      // Do not "finish the migration" by converting this one.
      title={onClick ? "Click to comment on this line" : undefined}
    >
      <span className={s.gutter}>{row.oldNo ?? ""}</span>
      <span className={s.gutter}>{row.newNo ?? ""}</span>
      <span className={`${s.marker} ${markerTone}`}>{marker}</span>
      <span className={s.lineText}>
        {row.text || " "}
        {onClick && <span className={s.noteChip}>+ note</span>}
      </span>
    </div>
  );
}

// ─────────────────── Diff helpers ───────────────────

type DiffRow = { kind: "add" | "del" | "ctx"; text: string };

function diffChange(c: FileChange): DiffRow[] {
  if (c.kind === "write") {
    return c.newText.split("\n").map((line) => ({ kind: "add", text: line }));
  }
  return diffLines(c.oldText, c.newText);
}

function diffLines(a: string, b: string): DiffRow[] {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const m = aLines.length;
  const n = bLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0)
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        aLines[i] === bLines[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (aLines[i] === bLines[j]) {
      rows.push({ kind: "ctx", text: aLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ kind: "del", text: aLines[i++] });
    } else {
      rows.push({ kind: "add", text: bLines[j++] });
    }
  }
  while (i < m) rows.push({ kind: "del", text: aLines[i++] });
  while (j < n) rows.push({ kind: "add", text: bLines[j++] });
  return rows;
}

function computeTotals(entry: FileEditEntry): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const c of entry.changes) {
    const rows = diffChange(c);
    for (const r of rows) {
      if (r.kind === "add") added++;
      else if (r.kind === "del") removed++;
    }
  }
  return { added, removed };
}

function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function makeCrumbs(path: string): string[] {
  const cleaned = path.replace(/^\/(Users|home)\/[^/]+/, "~");
  const parts = cleaned.split("/").filter(Boolean);
  // Drop the last part (filename) — already shown in the title row.
  const dir = parts.slice(0, -1);
  // Trim middle if it's very long
  if (dir.length <= 5) return dir;
  return [...dir.slice(0, 2), "…", ...dir.slice(-2)];
}

// Per-language brand colors. Deliberately NOT tokens: TypeScript blue and Go
// cyan are identities, not theme decisions, so they must not shift when the
// palette does. Applied as an inline `color` on the header tile.
const EXT_COLORS: Record<string, string> = {
  ts: "#3b82f6",
  tsx: "#3b82f6",
  js: "#eab308",
  jsx: "#eab308",
  py: "#22c55e",
  rs: "#f97316",
  go: "#06b6d4",
  json: "#eab308",
  md: "#60a5fa",
  css: "#ec4899",
  html: "#ef4444",
  java: "#f97316",
  rb: "#ef4444"
};

function extOf(path: string): { color?: string } {
  const m = path.match(/\.([a-zA-Z0-9]+)$/);
  if (!m) return {};
  return { color: EXT_COLORS[m[1].toLowerCase()] };
}
