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

import { useEffect, useMemo, useRef, useState } from "react";
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
import { send, onMessage, ChatStatus, HistoryEntry } from "../../lib/rpc";
import { STATUS_LABEL } from "./chat-status";
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
  const [renamingId, setRenamingId] = useState<string | null>(null);

  useEffect(() => {
    return onMessage((m) => {
      if (m.type === "historyList") setSessions(m.sessions);
    });
  }, []);

  // Deliberately depends on `open` alone. `onClose` arrives as an inline arrow
  // and so has a new identity on every parent render — with it in the deps this
  // re-ran on every streamed delta, blanking the list to skeletons and
  // refetching it several times a second while the agent was answering.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setConfirmId(null);
      setRenamingId(null);
      return;
    }
    setSessions(null);
    send({ type: "requestHistory" });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Escape backs out one step at a time: a rename in progress is what the
      // user is looking at, so closing the whole drawer would answer a question
      // they did not ask.
      if (renamingId) setRenamingId(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, renamingId]);

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

  const handleRename = (id: string, name: string) => {
    send({ type: "renameSession", id, name });
    setRenamingId(null);
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
                <EmptyState
                  title="No previous chats yet"
                  sub="Start a conversation — it'll appear here."
                />
              )}
              {sessions !== null &&
                sessions.length > 0 &&
                grouped.length === 0 && (
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
                          renaming={renamingId === session.id}
                          onStartRename={() => setRenamingId(session.id)}
                          onRename={(name) => handleRename(session.id, name)}
                          onCancelRename={() => setRenamingId(null)}
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

/**
 * Which tone carries each state; the names come from `chat-status.ts`, which
 * the header reads too. One table so the six stay consistent as a set — six
 * colours invented at six call sites is how a list stops meaning anything.
 *
 * `done` is deliberately quiet and deliberately last: it is the resting state
 * of most rows, and a list where everything shouts says nothing. What earns
 * colour is what wants the user.
 */
const STATUS: Record<ChatStatus, { label: string; tone: string }> = {
  "needs-you": { label: STATUS_LABEL["needs-you"], tone: "toneWarn" },
  working: { label: STATUS_LABEL.working, tone: "toneWorking" },
  // Its own tone, not `working`'s: this is the row the user opened the list to
  // find — a chat running a workflow with nothing streaming — and it has to be
  // tellable from the one they are mid-turn in.
  agents: { label: STATUS_LABEL.agents, tone: "toneAgents" },
  failed: { label: STATUS_LABEL.failed, tone: "toneErr" },
  interrupted: { label: STATUS_LABEL.interrupted, tone: "toneErr" },
  "no-reply": { label: STATUS_LABEL["no-reply"], tone: "toneWarn" },
  done: { label: STATUS_LABEL.done, tone: "toneQuiet" }
};

function HistoryItem({
  session,
  onSelect,
  onDelete,
  confirming,
  renaming,
  onStartRename,
  onRename,
  onCancelRename
}: {
  session: HistoryEntry;
  onSelect: () => void;
  onDelete: () => void;
  confirming: boolean;
  renaming: boolean;
  onStartRename: () => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
}) {
  const status = STATUS[session.status] ?? STATUS.done;
  return (
    <div
      // A row being renamed is a text field, not a button: clicking into it,
      // or pressing space in it, must not load the chat underneath.
      onClick={renaming ? undefined : onSelect}
      role={renaming ? "presentation" : "button"}
      tabIndex={renaming ? -1 : 0}
      onKeyDown={(e) => {
        if (renaming) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={s.item}
    >
      {/* Two facts, two marks. The dot is the status; the ring around it says
          a conversation is holding this chat right now, which is a different
          question and used to compete for the same word. */}
      <span
        className={[s.dot, s[status.tone], session.open ? s.dotOpen : ""]
          .join(" ")
          .trim()}
        aria-hidden
      />
      <div className={s.itemMain}>
        {renaming ? (
          <RenameField
            initial={session.named ? session.title : ""}
            onCommit={onRename}
            onCancel={onCancelRename}
          />
        ) : (
          <span className={s.itemTitle}>
            {session.title || "Untitled chat"}
          </span>
        )}
        {session.snippet && (
          <span className={s.itemSnippet}>{session.snippet}</span>
        )}
        <span className={s.itemMeta}>
          <span>{formatRelativeShort(session.updatedAt)}</span>
          <span className={s.itemMetaDot}>·</span>
          <span>
            {session.eventCount} {session.eventCount === 1 ? "event" : "events"}
          </span>
          <span className={s.itemMetaDot}>·</span>
          <span className={[s.statusPill, s[status.tone]].join(" ")}>
            {status.label}
          </span>
          {session.open && (
            <>
              <span className={s.itemMetaDot}>·</span>
              <span className={s.openMark}>open</span>
            </>
          )}
        </span>
      </div>
      {!renaming && (
        <Tooltip label={session.named ? "Rename or clear name" : "Name chat"}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onStartRename();
            }}
            className={s.itemRename}
            aria-label={session.named ? "Rename chat" : "Name chat"}
          >
            <Icon name="edit" size={10} />
          </button>
        </Tooltip>
      )}
      {!renaming && (
        <Tooltip label={confirming ? "Click again to confirm" : "Delete chat"}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className={[s.itemDelete, confirming ? s.armed : ""]
              .join(" ")
              .trim()}
            aria-label={confirming ? "Confirm delete" : "Delete chat"}
          >
            <Icon name={confirming ? "check" : "x"} size={10} />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

/**
 * The inline name field.
 *
 * Its own component so the draft dies with it: a field keyed to the row would
 * carry one row's half-typed name onto the next one the user opens.
 */
function RenameField({
  initial,
  onCommit,
  onCancel
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.select();
  }, []);

  return (
    <input
      ref={ref}
      autoFocus
      type="text"
      value={draft}
      placeholder="Name this chat…"
      className={s.renameInput}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") onCommit(draft.trim());
        if (e.key === "Escape") onCancel();
      }}
      // Clicking away commits what was typed. Discarding it would be the
      // surprising half of the two, and an empty field is already the
      // documented way to clear a name.
      onBlur={() => onCommit(draft.trim())}
    />
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
            <span
              className={s.skeletonBar}
              style={{ width: `${60 + i * 8}%` }}
            />
            <span
              className={s.skeletonBarSub}
              style={{ width: `${30 + i * 4}%` }}
            />
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

// Not `features/plan/summary.ts`'s `formatRelativeTime`, which is exported and
// says "12 minutes ago" out to 30 days. This one is for a dense list: "12m
// ago", and a bare date past a week. Same job, two formats, on purpose.
function formatRelativeShort(ts: number): string {
  const diff = Date.now() - ts;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < 30_000) return "just now";
  if (diff < min) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric"
  });
}
