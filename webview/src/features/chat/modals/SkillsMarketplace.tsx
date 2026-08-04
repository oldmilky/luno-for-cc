// ─────────────────────────────────────────────────────────────
// Skills Marketplace modal — fetches the live catalog from
// claude-plugins.dev/api/skills and lets the user install any
// skill at user-scope (~/.claude/skills/) or project-scope
// (<workspace>/.claude/skills/). Already-installed skills show
// a scope badge so the user can see where each one lives.
//
// Pagination is server-side (the API has 49k+ entries; we ask
// for 24 at a time and load more on demand). Search hits the
// API's `q` parameter for relevance ranking rather than
// filtering client-side.
// ─────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from "react";
import { send, onMessage, MarketplaceSkill } from "../../../lib/rpc";
import { formatCount } from "../../../lib/format";
import { Icon, IconName } from "../../../design/icons";
import { Overlay, Tooltip } from "../../../design/primitives";
// `mk`, not the usual `s` — this file already binds `s` to a
// MarketplaceSkill in several callbacks.
import mk from "./SkillsMarketplace.module.scss";
import dd from "../../../design/primitives/Dropdown.module.scss";

const PAGE_SIZE = 24;

export type InstallScope = "user" | "project";

export interface InstalledMatch {
  /** "user" | "project" — which directory the matching SKILL.md lives in. */
  source: "user" | "project";
  /** Human-readable name from the SKILL.md frontmatter (falls back to id). */
  displayName: string;
  description: string;
}

export interface SkillsMarketplaceProps {
  open: boolean;
  /**
   * Discovered skills from disk (passed down from SkillsPicker → here).
   * Keyed by skill `id` (which is the directory name == marketplace
   * skill `name`). Used to render "Installed (User|Project)" badges and
   * swap Install for Uninstall.
   */
  installed: ReadonlyMap<string, InstalledMatch>;
  onClose: () => void;
}

interface MarketState {
  status: "idle" | "loading" | "loadingMore" | "ready" | "error";
  skills: MarketplaceSkill[];
  total: number;
  offset: number;
  error?: string;
}

export function SkillsMarketplace({
  open,
  installed,
  onClose
}: SkillsMarketplaceProps) {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"all" | "installed">("all");
  const [state, setState] = useState<MarketState>({
    status: "idle",
    skills: [],
    total: 0,
    offset: 0
  });
  const [busyName, setBusyName] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(
    null
  );
  const debounceRef = useRef<number | null>(null);

  // Subscribe to marketplace responses + install results.
  useEffect(() => {
    if (!open) return;
    return onMessage((m) => {
      if (m.type === "marketplaceList") {
        setState((prev) => ({
          status: "ready",
          // If offset is 0 we replace; otherwise we're paginating.
          skills: m.offset === 0 ? m.skills : [...prev.skills, ...m.skills],
          total: m.total,
          offset: m.offset + m.skills.length
        }));
      } else if (m.type === "marketplaceError") {
        setState((prev) => ({ ...prev, status: "error", error: m.message }));
      } else if (m.type === "marketplaceInstallResult") {
        setBusyName(null);
        const scopeLabel =
          m.scope === "user" ? "globally" : "for this workspace";
        if (m.ok) {
          if (m.action === "uninstall") {
            setToast({ ok: true, text: `Removed ${m.name} (${scopeLabel}).` });
          } else {
            setToast({
              ok: true,
              text: `Installed ${m.name} ${scopeLabel}${
                m.filesWritten ? ` · ${m.filesWritten} files` : ""
              }.`
            });
          }
        } else {
          const verb = m.action === "uninstall" ? "remove" : "install";
          setToast({
            ok: false,
            text: `Couldn't ${verb} ${m.name}: ${m.error ?? "unknown error"}.`
          });
        }
        // Auto-clear after a few seconds.
        window.setTimeout(() => setToast(null), 4000);
      }
    });
  }, [open]);

  // Initial fetch + refetch on query change (debounced).
  // We deliberately keep the previous `skills` visible while the new
  // batch loads — clearing them would cause the modal/grid to collapse
  // and re-expand on every keystroke.
  useEffect(() => {
    if (!open) return;
    setState((s) => ({ ...s, status: "loading" }));
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      send({
        type: "requestMarketplace",
        offset: 0,
        limit: PAGE_SIZE,
        query: query || undefined
      });
    }, 200);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [open, query]);

  const loadMore = () => {
    setState((s) => ({ ...s, status: "loadingMore" }));
    send({
      type: "requestMarketplace",
      offset: state.offset,
      limit: PAGE_SIZE,
      query: query || undefined
    });
  };

  const install = (s: MarketplaceSkill, scope: InstallScope) => {
    setBusyName(s.name);
    send({
      type: "installMarketplaceSkill",
      target: {
        name: s.name,
        repoOwner: s.repoOwner,
        repoName: s.repoName,
        directoryPath: s.directoryPath
      },
      scope
    });
  };

  const uninstall = (name: string, scope: InstallScope) => {
    setBusyName(name);
    send({ type: "uninstallMarketplaceSkill", name, scope });
  };

  // Installed tab pulls directly from the on-disk installed map so the user
  // always sees their installed skills here, even if they haven't scrolled
  // through the (49k+ entry) marketplace far enough to hit the matching row.
  // Must be declared above the `if (!open) return null` early return so the
  // hook order stays stable across renders.
  const installedEntries = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows: Array<{
      name: string;
      displayName: string;
      description: string;
      source: "user" | "project";
    }> = [];
    installed.forEach((meta, name) => {
      if (
        q &&
        !name.toLowerCase().includes(q) &&
        !meta.displayName.toLowerCase().includes(q) &&
        !meta.description.toLowerCase().includes(q)
      ) {
        return;
      }
      rows.push({ name, ...meta });
    });
    rows.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return rows;
  }, [installed, query]);

  const isSearching = state.status === "loading" && state.skills.length > 0;
  const hasMore = tab === "all" && state.skills.length < state.total;

  return (
    <Overlay
      open={open}
      onClose={onClose}
      label="Skills marketplace"
      className={mk.modal}
      backdropClassName={mk.backdrop}
    >
      <header className={mk.head}>
        <div className={mk.headTitles}>
          <span className={mk.eyebrow}>Marketplace</span>
          <h2 className={mk.title}>Claude Code Skills</h2>
          <p className={mk.sub}>
            Browse and install skills from{" "}
            <span className={mk.link}>claude-plugins.dev</span>.
          </p>
        </div>
        <button
          type="button"
          className={mk.close}
          onClick={onClose}
          aria-label="Close"
        >
          <Icon name="x" size={14} />
        </button>
      </header>

      <div className={mk.toolbar}>
        <div className={mk.search}>
          <Icon name="search" size={13} />
          <input
            type="text"
            placeholder="Search skills…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
            spellCheck={false}
          />
          {isSearching ? (
            <span className={mk.searchSpinner} aria-label="Searching" />
          ) : state.total > 0 && state.status === "ready" ? (
            <span className={mk.searchCount}>
              {state.skills.length} of {state.total.toLocaleString()}
            </span>
          ) : null}
        </div>
        <div className={mk.tabs} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "all"}
            className={`${mk.tab}${tab === "all" ? ` ${mk.tabActive}` : ""}`}
            onClick={() => setTab("all")}
          >
            All
          </button>
          <Tooltip
            label={
              installed.size === 0
                ? "No skills installed yet"
                : `${installed.size} installed`
            }
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab === "installed"}
              className={`${mk.tab}${tab === "installed" ? ` ${mk.tabActive}` : ""}`}
              onClick={() => setTab("installed")}
              disabled={installed.size === 0}
            >
              Installed
              {installed.size > 0 && (
                <span className={mk.tabCount}>{installed.size}</span>
              )}
            </button>
          </Tooltip>
        </div>
      </div>

      <div
        className={`${mk.grid}${isSearching && tab === "all" ? ` ${mk.gridSearching}` : ""}`}
        aria-busy={state.status === "loading"}
      >
        {tab === "installed" ? (
          installedEntries.length === 0 ? (
            <div className={mk.empty}>
              <Icon name="search" size={20} />
              <span>
                {installed.size === 0
                  ? "Nothing installed yet. Install a skill from the All tab."
                  : `No installed skills match "${query}".`}
              </span>
            </div>
          ) : (
            installedEntries.map((row) => (
              <InstalledCard
                key={row.name}
                name={row.name}
                displayName={row.displayName}
                description={row.description}
                source={row.source}
                busy={busyName === row.name}
                onUninstall={() => uninstall(row.name, row.source)}
              />
            ))
          )
        ) : state.status === "loading" && state.skills.length === 0 ? (
          <div className={mk.empty}>
            <span className={mk.spinnerLg} />
            <span>Loading skills…</span>
          </div>
        ) : state.status === "error" ? (
          <div className={mk.empty}>
            <Icon name="x" size={20} />
            <span>Couldn't load: {state.error ?? "network error"}</span>
          </div>
        ) : state.skills.length === 0 ? (
          <div className={mk.empty}>
            <Icon name="search" size={20} />
            <span>No skills match {query ? `"${query}"` : "your filter"}.</span>
          </div>
        ) : (
          <>
            {state.skills.map((s) => (
              <MarketCard
                key={s.id}
                skill={s}
                installed={installed.get(s.name) ?? null}
                busy={busyName === s.name}
                onInstall={(scope) => install(s, scope)}
                onUninstall={(scope) => uninstall(s.name, scope)}
              />
            ))}
            {hasMore && (
              <div className={mk.loadMore}>
                <button
                  type="button"
                  className={`${mk.cardBtn} ${mk.ghost}`}
                  onClick={loadMore}
                  disabled={state.status === "loadingMore"}
                >
                  {state.status === "loadingMore"
                    ? "Loading…"
                    : `Load ${Math.min(PAGE_SIZE, state.total - state.skills.length)} more`}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {toast && (
        <div className={`${mk.toast} ${toast.ok ? mk.toastOk : mk.toastErr}`}>
          <Icon name={toast.ok ? "check" : "x"} size={11} />
          <span>{toast.text}</span>
        </div>
      )}

      <footer className={mk.foot}>
        <span>Powered by claude-plugins.dev</span>
        <button
          type="button"
          className={mk.inlineBtn}
          onClick={() =>
            send({
              type: "openExternal",
              url: "https://claude-plugins.dev/skills"
            })
          }
        >
          Browse all ↗
        </button>
      </footer>
    </Overlay>
  );
}

// ── Card ───────────────────────────────────────────────────

function MarketCard({
  skill,
  installed,
  busy,
  onInstall,
  onUninstall
}: {
  skill: MarketplaceSkill;
  installed: InstalledMatch | null;
  busy: boolean;
  onInstall: (scope: InstallScope) => void;
  onUninstall: (scope: InstallScope) => void;
}) {
  const icon = iconFor(skill.name);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <article className={`${mk.card}${installed ? ` ${mk.cardInstalled}` : ""}`}>
      <div className={mk.cardHead}>
        <span className={mk.cardIcon}>
          <Icon name={icon} size={14} />
        </span>
        <div className={mk.cardTitles}>
          <span className={mk.cardName}>{skill.name}</span>
          <span className={mk.cardPub}>
            <span className={mk.cardCat}>@{skill.author}</span>
            {skill.installs > 0 && (
              <>
                <span className={mk.cardDot} />
                {formatCount(skill.installs)} installs
              </>
            )}
            {skill.stars > 0 && (
              <>
                <span className={mk.cardDot} />★ {formatCount(skill.stars)}
              </>
            )}
          </span>
        </div>
      </div>
      <p className={mk.cardDesc}>{truncate(skill.description, 220)}</p>
      <div className={mk.cardActions}>
        <Tooltip label={skill.sourceUrl} wrap>
          <button
            type="button"
            className={`${mk.cardBtn} ${mk.ghost}`}
            onClick={() => send({ type: "openExternal", url: skill.sourceUrl })}
          >
            <Icon name="book" size={11} />
            Source
          </button>
        </Tooltip>
        {installed ? (
          <>
            <span
              className={`${mk.installedBadge} ${
                installed.source === "user" ? mk.scopeUser : mk.scopeProject
              }`}
            >
              <Icon name="check" size={11} />
              {installed.source === "user"
                ? "Installed · User"
                : "Installed · Project"}
            </span>
            <Tooltip label={`Uninstall (${installed.source} scope)`}>
              <button
                type="button"
                className={`${mk.cardBtn} ${mk.danger}`}
                onClick={() => onUninstall(installed.source)}
                disabled={busy}
              >
                {busy ? "Working…" : "Uninstall"}
              </button>
            </Tooltip>
          </>
        ) : (
          <div className={mk.split} ref={menuRef}>
            <Tooltip label="Install for this workspace">
              <button
                type="button"
                className={`${mk.cardBtn} ${mk.primary} ${mk.splitMain}`}
                onClick={() => onInstall("project")}
                disabled={busy}
              >
                {busy ? "Working…" : "Install"}
              </button>
            </Tooltip>
            <button
              type="button"
              className={`${mk.cardBtn} ${mk.primary} ${mk.splitToggle}`}
              onClick={() => setMenuOpen((o) => !o)}
              disabled={busy}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="More install options"
            >
              <Icon name="chevronD" size={9} />
            </button>
            {menuOpen && (
              <div className={`${dd.menu} ${dd.below} ${dd.right}`} role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className={mk.installItem}
                  onClick={() => {
                    setMenuOpen(false);
                    onInstall("project");
                  }}
                >
                  <span className={mk.itemTitle}>
                    Install for this workspace
                  </span>
                  <span className={mk.itemSub}>
                    Only available while you're working in this project.
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={mk.installItem}
                  onClick={() => {
                    setMenuOpen(false);
                    onInstall("user");
                  }}
                >
                  <span className={mk.itemTitle}>Install globally</span>
                  <span className={mk.itemSub}>
                    Available across every workspace you open.
                  </span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

// ── Installed-only card ────────────────────────────────────
// Rendered in the "Installed" tab. Sources its data from the on-disk
// SKILL.md (passed via the `installed` map), so it's available even when
// the marketplace API hasn't paged that far yet.

function InstalledCard({
  name,
  displayName,
  description,
  source,
  busy,
  onUninstall
}: {
  name: string;
  displayName: string;
  description: string;
  source: "user" | "project";
  busy: boolean;
  onUninstall: () => void;
}) {
  const icon = iconFor(name);
  return (
    <article className={`${mk.card} ${mk.cardInstalled}`}>
      <div className={mk.cardHead}>
        <span className={mk.cardIcon}>
          <Icon name={icon} size={14} />
        </span>
        <div className={mk.cardTitles}>
          <span className={mk.cardName}>{displayName}</span>
          <span className={mk.cardPub}>
            <span className={mk.cardCat}>
              {source === "user" ? "Global" : "This workspace"}
            </span>
          </span>
        </div>
      </div>
      <p className={mk.cardDesc}>
        {description
          ? truncate(description, 220)
          : "Installed skill — no description provided."}
      </p>
      <div className={mk.cardActions}>
        <span
          className={`${mk.installedBadge} ${
            source === "user" ? mk.scopeUser : mk.scopeProject
          }`}
        >
          <Icon name="check" size={11} />
          {source === "user" ? "Global" : "Workspace"}
        </span>
        <button
          type="button"
          className={`${mk.cardBtn} ${mk.danger}`}
          onClick={onUninstall}
          disabled={busy}
        >
          {busy ? "Working…" : "Uninstall"}
        </button>
      </div>
    </article>
  );
}

// ── Helpers ────────────────────────────────────────────────

function iconFor(name: string): IconName {
  const n = name.toLowerCase();
  if (/web|browser|playwright|test/.test(n)) return "eye";
  if (/pdf|doc|file|download/.test(n)) return "file";
  if (/sql|postgres|db|database/.test(n)) return "layers";
  if (/git|github|branch/.test(n)) return "branch";
  if (/edit|write|create/.test(n)) return "edit";
  if (/grep|search|find/.test(n)) return "search";
  if (/design|ui|ux|frontend/.test(n)) return "edit";
  if (/architect/.test(n)) return "layers";
  return "bolt";
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n).replace(/\s+\S*$/, "") + "…";
}

/**
 * Re-export so SkillsPicker can build the `installed` map without
 * pulling in marketplace.ts directly.
 */
export type { MarketplaceSkill };
