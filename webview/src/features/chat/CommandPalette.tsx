// ─────────────────────────────────────────────────────────────
// CommandPalette — Cmd+K spotlight-style fuzzy finder. Searches
// across:
//   • Recent chat sessions
//   • Available skills (installed + togglable)
//   • Available models
//   • Built-in commands (new chat, history, mode cycle, settings…)
// Arrow keys navigate, Enter executes, Esc closes.
// ─────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Icon, IconName } from "../../design/icons";
import { BACKDROP, OVERLAY_PANEL } from "../../design/motion";
import {
  send,
  onMessage,
  HistoryEntry,
  ModelInfo,
  SkillInfo,
  PermissionMode
} from "../../lib/rpc";
import { MODES } from "./constants";
import s from "./CommandPalette.module.scss";

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  models: ReadonlyArray<ModelInfo>;
  skills: ReadonlyArray<SkillInfo>;
  permissionMode: PermissionMode;
  onLoadSession: (id: string) => void;
  onOpenKeyboardHints: () => void;
  onOpenHistory: () => void;
}

interface Item {
  id: string;
  group: "Command" | "History" | "Model" | "Skill" | "Mode";
  icon: IconName;
  title: string;
  subtitle?: string;
  action: () => void;
  /** Search-only keywords (not displayed). */
  keywords?: string;
}

export function CommandPalette({
  open,
  onClose,
  models,
  skills,
  permissionMode,
  onLoadSession,
  onOpenKeyboardHints,
  onOpenHistory
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState<HistoryEntry[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Fetch latest history when palette opens, regardless of whether the
  // history drawer has been opened before.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    send({ type: "requestHistory" });
    const off = onMessage((m) => {
      if (m.type === "historyList") setSessions(m.sessions);
    });
    queueMicrotask(() => inputRef.current?.focus());
    return off;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, total - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        results[active]?.item.action();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const allItems: Item[] = useMemo(() => {
    const items: Item[] = [];

    // Built-in commands
    items.push({
      id: "cmd-new",
      group: "Command",
      icon: "plus",
      title: "New chat",
      subtitle: "Clear the current session",
      action: () => {
        send({ type: "newSession" });
        onClose();
      },
      keywords: "reset start fresh"
    });
    items.push({
      id: "cmd-history",
      group: "Command",
      icon: "history",
      title: "Open chat history",
      subtitle: "Browse and resume past sessions",
      action: () => {
        onClose();
        queueMicrotask(onOpenHistory);
      },
      keywords: "list previous"
    });
    items.push({
      id: "cmd-help",
      group: "Command",
      icon: "zap",
      title: "Keyboard shortcuts",
      subtitle: "View all available shortcuts",
      action: () => {
        onClose();
        queueMicrotask(onOpenKeyboardHints);
      },
      keywords: "kbd hotkeys help ?"
    });

    // Permission modes
    for (const m of MODES) {
      items.push({
        id: `mode-${m.value}`,
        group: "Mode",
        icon: m.icon,
        title: `Set mode: ${m.label}`,
        subtitle: m.note,
        action: () => {
          send({ type: "setPermissionMode", mode: m.value });
          onClose();
        },
        keywords: `${m.value} ${m.short} permission ${permissionMode === m.value ? "current" : ""}`
      });
    }

    // Models
    for (const m of models) {
      items.push({
        id: `model-${m.value}`,
        group: "Model",
        icon: "bolt",
        title: `Use model: ${m.label}`,
        subtitle: m.note,
        action: () => {
          send({ type: "setModel", model: m.value });
          onClose();
        },
        keywords: m.value
      });
    }

    // Skills
    for (const sk of skills.slice(0, 60)) {
      items.push({
        id: `skill-${sk.id}`,
        group: "Skill",
        icon: "bolt",
        title: `${sk.enabled ? "Disable" : "Enable"} skill: ${sk.name}`,
        subtitle: sk.description,
        action: () => {
          send({ type: "setSkillEnabled", id: sk.id, enabled: !sk.enabled });
          onClose();
        },
        keywords: `${sk.id} ${sk.category} ${sk.enabled ? "on" : "off"}`
      });
    }

    // History sessions
    for (const sess of sessions.slice(0, 40)) {
      items.push({
        id: `session-${sess.id}`,
        group: "History",
        icon: "history",
        title: sess.title || "Untitled chat",
        subtitle: relTime(sess.updatedAt),
        action: () => {
          onLoadSession(sess.id);
          onClose();
        }
      });
    }

    return items;
  }, [models, skills, sessions, permissionMode, onLoadSession, onClose, onOpenKeyboardHints, onOpenHistory]);

  const results = useMemo(() => fuzzy(allItems, query), [allItems, query]);
  const total = results.length;

  // Group results for display order while preserving filter rank.
  const grouped = useMemo(() => groupBy(results), [results]);

  // Scroll the active item into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-idx="${active}"]`);
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [active]);

  if (!open) return null;

  return (
    <motion.div
      className={s.overlay}
      {...BACKDROP}
      // This scrim also blurs what sits behind it, and BACKDROP only carries
      // opacity. Each preset state is re-stated with the blur folded in — the
      // preset's duration and curve are left untouched.
      initial={{ ...BACKDROP.initial, backdropFilter: "blur(0px)" }}
      animate={{ ...BACKDROP.animate, backdropFilter: "blur(6px)" }}
      exit={{ ...BACKDROP.exit, backdropFilter: "blur(0px)" }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <motion.div
        {...OVERLAY_PANEL}
        className={s.panel}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className={s.search}>
          <span className={s.searchIcon}>
            <Icon name="search" size={14} />
          </span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            placeholder="Type a command, session, skill, or model…"
            className={s.input}
            autoFocus
          />
          <kbd className={s.escKey}>Esc</kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className={s.results}>
          {total === 0 ? (
            <div className={s.empty}>
              <div className={s.emptyText}>
                {query
                  ? `No matches for "${query}"`
                  : "Start typing to find anything."}
              </div>
            </div>
          ) : (
            grouped.map((bucket) => (
              <div key={bucket.group} className={s.group}>
                <div className={s.groupLabel}>{bucket.group}</div>
                {bucket.items.map((r) => (
                  <PaletteRow
                    key={r.item.id}
                    item={r.item}
                    idx={r.idx}
                    active={r.idx === active}
                    onHover={() => setActive(r.idx)}
                  />
                ))}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className={s.footer}>
          <span className={s.footerNav}>
            <kbd className={s.key}>↑</kbd>
            <kbd className={s.key}>↓</kbd>
            to navigate
          </span>
          <span className={s.footerSelect}>
            <kbd className={s.key}>↵</kbd>
            to select
          </span>
        </div>
      </motion.div>
    </motion.div>
  );
}

function PaletteRow({
  item,
  idx,
  active,
  onHover
}: {
  item: Item;
  idx: number;
  active: boolean;
  onHover: () => void;
}) {
  return (
    <div
      data-idx={idx}
      onClick={item.action}
      onMouseEnter={onHover}
      role="button"
      tabIndex={0}
      className={active ? `${s.row} ${s.active}` : s.row}
    >
      <span className={active ? `${s.tile} ${s.active}` : s.tile}>
        <Icon name={item.icon} size={12} />
      </span>
      <div className={s.rowBody}>
        <div className={s.rowTitle}>{item.title}</div>
        {item.subtitle && (
          <div className={s.rowSubtitle}>{item.subtitle}</div>
        )}
      </div>
      {active && <span className={s.rowEnter}>↵</span>}
    </div>
  );
}

// ─────────────────── Fuzzy match + grouping ───────────────────

interface ScoredResult {
  item: Item;
  score: number;
  idx: number;
}

function fuzzy(items: Item[], query: string): ScoredResult[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    // When empty, show commands first, then 8 most recent sessions, then a
    // few model/mode options.
    const ordered = items
      .map((item, i) => ({ item, score: groupRank(item.group) * 1000 + i, idx: i }))
      .sort((a, b) => a.score - b.score)
      .slice(0, 48);
    return ordered.map((r, idx) => ({ ...r, idx }));
  }
  const out: ScoredResult[] = [];
  for (const item of items) {
    const hay = (item.title + " " + (item.subtitle ?? "") + " " + (item.keywords ?? "")).toLowerCase();
    const score = scoreMatch(hay, q);
    if (score > 0) out.push({ item, score: -score, idx: 0 });
  }
  out.sort((a, b) => a.score - b.score);
  return out.slice(0, 60).map((r, idx) => ({ ...r, idx }));
}

function scoreMatch(hay: string, q: string): number {
  if (!q) return 1;
  let score = 0;
  let hi = 0;
  let lastMatch = -1;
  for (const ch of q) {
    const found = hay.indexOf(ch, hi);
    if (found === -1) return 0;
    score += 10;
    if (lastMatch !== -1 && found === lastMatch + 1) score += 5;
    if (found === 0 || hay[found - 1] === " " || hay[found - 1] === "-") score += 4;
    lastMatch = found;
    hi = found + 1;
  }
  return score;
}

function groupRank(g: Item["group"]): number {
  return ({ Command: 0, History: 1, Mode: 2, Model: 3, Skill: 4 } as const)[g];
}

interface Bucket {
  group: Item["group"];
  items: ScoredResult[];
}

function groupBy(results: ScoredResult[]): Bucket[] {
  const map = new Map<Item["group"], ScoredResult[]>();
  for (const r of results) {
    const list = map.get(r.item.group) ?? [];
    list.push(r);
    map.set(r.item.group, list);
  }
  const order: Item["group"][] = ["Command", "History", "Mode", "Model", "Skill"];
  return order
    .filter((g) => map.has(g))
    .map((g) => ({ group: g, items: map.get(g) ?? [] }));
}

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return "just now";
  if (diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
