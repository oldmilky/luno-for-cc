// ─────────────────────────────────────────────────────────────
// HistoryDrawer — slide-in panel listing prior chat sessions.
// Features:
//   • Search by title (live filter, debounced via React batching).
//   • Sessions grouped by relative-time bucket ("Today", "Yesterday",
//     "Last 7 days", "This month", "Earlier").
//   • Empty/loading/no-match states.
//   • Smooth slide-in via Framer Motion, with staggered row entrance.
//   • Delete-with-undo via inline two-step confirm.
// ─────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Icon } from "../../design/icons";
import { Tooltip } from "../../design/primitives";
import {
  BACKDROP,
  DRAWER,
  ENTER,
  SPRING_POP,
  TRAVEL,
  enterAt,
  stagger
} from "../../design/motion";
import { send, onMessage, HistoryEntry } from "../../lib/rpc";
import s from "./HistoryDrawer.module.scss";

interface HistoryDrawerProps {
  open: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
}

export function HistoryDrawer({ open, onClose, onSelect }: HistoryDrawerProps) {
  const [sessions, setSessions] = useState<HistoryEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);

  useEffect(() => {
    return onMessage((m) => {
      if (m.type === "historyList") setSessions(m.sessions);
    });
  }, []);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setConfirmId(null);
      return;
    }
    setSessions(null);
    send({ type: "requestHistory" });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const filtered = useMemo(() => {
    if (!sessions) return null;
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (entry) =>
        entry.title.toLowerCase().includes(q) ||
        (entry.snippet?.toLowerCase().includes(q) ?? false)
    );
  }, [sessions, query]);

  const grouped = useMemo(() => groupByBucket(filtered ?? []), [filtered]);

  const handleDelete = (id: string) => {
    if (confirmId === id) {
      send({ type: "deleteHistoryEntry", id });
      setConfirmId(null);
    } else {
      setConfirmId(id);
      setTimeout(() => {
        setConfirmId((curr) => (curr === id ? null : curr));
      }, 2400);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="drawer-backdrop"
          className={s.backdrop}
          {...BACKDROP}
          // This scrim also blurs the chat behind it, which BACKDROP has no
          // field for. Folded into the preset's own states so the blur and the
          // fade stay on one timing instead of drifting apart.
          initial={{ ...BACKDROP.initial, backdropFilter: "blur(0px)" }}
          animate={{ ...BACKDROP.animate, backdropFilter: "blur(4px)" }}
          exit={{ ...BACKDROP.exit, backdropFilter: "blur(0px)" }}
          onClick={onClose}
          role="dialog"
          aria-modal="true"
          aria-label="Chat history"
        >
          <motion.aside
            key="drawer-panel"
            {...DRAWER}
            // DRAWER owns the slide and the exit. The panel also settles a hair
            // of scale — not part of the preset, so it is folded into its states
            // rather than given a transition of its own. `transform-origin` in
            // the module anchors that scale to the screen edge.
            initial={{ ...DRAWER.initial, scale: 0.985 }}
            animate={{ ...DRAWER.animate, scale: 1 }}
            exit={{ ...DRAWER.exit, scale: 0.99 }}
            className={s.panel}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <header className={s.head}>
              <div className={s.headLeft}>
                <motion.span
                  className={s.headIcon}
                  initial={{ scale: 0.85, rotate: -12 }}
                  animate={{ scale: 1, rotate: 0 }}
                  // A mark rather than a row, so it keeps its bit of character:
                  // SPRING_POP. The delay is a stagger step, not a literal — it
                  // only has to land after the panel, not at a precise moment.
                  transition={{ ...SPRING_POP, delay: stagger(2) }}
                >
                  <Icon name="history" size={13} />
                </motion.span>
                <h2 className={s.headTitle}>Chat history</h2>
              </div>
              <Tooltip label="Close (Esc)">
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close (Esc)"
                  className={s.close}
                >
                  <Icon name="x" size={13} />
                </button>
              </Tooltip>
            </header>

            {/* Search */}
            <div className={s.search}>
              <div className={s.searchField}>
                <span className={s.searchIcon}>
                  <Icon name="search" size={12} />
                </span>
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search chats…"
                  className={s.searchInput}
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    className={s.searchClear}
                    aria-label="Clear search"
                  >
                    <Icon name="x" size={10} />
                  </button>
                )}
              </div>
            </div>

            {/* Body */}
            <div className={s.body}>
              {sessions === null && <LoadingState />}
              {sessions !== null && sessions.length === 0 && (
                <EmptyState title="No previous chats yet" sub="Start a conversation — it'll appear here." />
              )}
              {sessions !== null && sessions.length > 0 && grouped.length === 0 && (
                <EmptyState
                  title="No matches"
                  sub={`Nothing matched "${query}". Try a different keyword.`}
                />
              )}

              {grouped.map((group, gi) => (
                <motion.section
                  key={group.label}
                  {...enterAt(gi)}
                  className={s.group}
                >
                  <div className={s.groupLabel}>{group.label}</div>
                  <ul className={s.list}>
                    {group.items.map((session, i) => (
                      <motion.li
                        key={session.id}
                        // Rows come in from the left, so they cannot take ENTER
                        // whole — same duration and curve, TRAVEL.sm turned
                        // sideways. The delay still compounds group and row.
                        initial={{ opacity: 0, x: -TRAVEL.sm }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{
                          ...ENTER.transition,
                          delay: stagger(gi) + stagger(i)
                        }}
                      >
                        <HistoryItem
                          session={session}
                          onSelect={() => onSelect(session.id)}
                          onDelete={() => handleDelete(session.id)}
                          confirming={confirmId === session.id}
                        />
                      </motion.li>
                    ))}
                  </ul>
                </motion.section>
              ))}
            </div>

            {/* Footer */}
            <div className={s.foot}>
              <span>
                {sessions ? sessions.length : 0}{" "}
                {sessions && sessions.length === 1 ? "chat" : "chats"} total
              </span>
              <span>
                <kbd className={s.kbd}>Esc</kbd>
                <span className={s.footHint}>to close</span>
              </span>
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ─────────────────── Sub-components ───────────────────

function HistoryItem({
  session,
  onSelect,
  onDelete,
  confirming
}: {
  session: HistoryEntry;
  onSelect: () => void;
  onDelete: () => void;
  confirming: boolean;
}) {
  return (
    <div
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={s.item}
    >
      <span className={s.dot} aria-hidden />
      <div className={s.itemMain}>
        <span className={s.itemTitle}>{session.title || "Untitled chat"}</span>
        {session.snippet && <span className={s.itemSnippet}>{session.snippet}</span>}
        <span className={s.itemMeta}>
          <span>{formatRelativeTime(session.updatedAt)}</span>
          <span className={s.itemMetaDot}>·</span>
          <span>
            {session.eventCount} {session.eventCount === 1 ? "event" : "events"}
          </span>
        </span>
      </div>
      <Tooltip label={confirming ? "Click again to confirm" : "Delete chat"}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className={[s.itemDelete, confirming ? s.armed : ""].join(" ").trim()}
          aria-label={confirming ? "Confirm delete" : "Delete chat"}
        >
          <Icon name={confirming ? "check" : "x"} size={10} />
        </button>
      </Tooltip>
    </div>
  );
}

function LoadingState() {
  return (
    <div className={s.skeletons}>
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className={s.skeleton}
          // Phase offset into the ambient breathe in the module, not an enter
          // delay — hence the wider step: the default one is invisible against
          // a loop that long.
          style={{ animationDelay: `${stagger(i, 0.08)}s` }}
        >
          <span className={s.skeletonDot} />
          <div className={s.skeletonLines}>
            <span className={s.skeletonBar} style={{ width: `${60 + i * 8}%` }} />
            <span className={s.skeletonBarSub} style={{ width: `${30 + i * 4}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ title, sub }: { title: string; sub: string }) {
  return (
    <motion.div
      // Two stagger steps: the state should land after the panel has arrived,
      // not with it.
      {...enterAt(2)}
      className={s.empty}
    >
      <div className={s.emptyIcon}>
        <Icon name="history" size={18} />
      </div>
      <div className={s.emptyTitle}>{title}</div>
      <div className={s.emptySub}>{sub}</div>
    </motion.div>
  );
}

// ─────────────────── Helpers ───────────────────

interface Bucket {
  label: string;
  items: HistoryEntry[];
}

function groupByBucket(sessions: HistoryEntry[]): Bucket[] {
  if (sessions.length === 0) return [];
  const oneDay = 86_400_000;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  const yesterday = today - oneDay;
  const sevenDaysAgo = today - 7 * oneDay;
  const thirtyDaysAgo = today - 30 * oneDay;

  const buckets: Record<string, HistoryEntry[]> = {
    Today: [],
    Yesterday: [],
    "Last 7 days": [],
    "This month": [],
    Earlier: []
  };

  for (const entry of sessions) {
    const t = entry.updatedAt;
    if (t >= today) buckets["Today"].push(entry);
    else if (t >= yesterday) buckets["Yesterday"].push(entry);
    else if (t >= sevenDaysAgo) buckets["Last 7 days"].push(entry);
    else if (t >= thirtyDaysAgo) buckets["This month"].push(entry);
    else buckets["Earlier"].push(entry);
  }

  const order = ["Today", "Yesterday", "Last 7 days", "This month", "Earlier"];
  return order
    .map((label) => ({ label, items: buckets[label] }))
    .filter((b) => b.items.length > 0);
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < 30_000) return "just now";
  if (diff < min) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
