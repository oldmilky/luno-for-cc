// ─────────────────────────────────────────────────────────────
// Skills picker. Surfaces every skill the agent has access to:
//   - Built-in tools (Read/Write/Bash) — always on
//   - Claude Code agent (Glob/Grep/Edit/WebFetch/Task) — CLI-native
//   - Project skills (<workspace>/.claude/skills/) — toggleable
//   - User skills (~/.claude/skills/) — toggleable
//   - Integrations (placeholder)
// "Add skills" opens the live Marketplace (claude-plugins.dev),
// which handles real install/uninstall via the extension host.
// ─────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from "react";
import { POPOVER_ABOVE } from "../../design/motion";
import { AnimatePresence, motion } from "framer-motion";
import { Icon, IconName } from "../../design/icons";
import { Tooltip } from "../../design/primitives";
import { send, SkillInfo } from "../../lib/rpc";
import { SkillsMarketplace } from "./SkillsMarketplace";
import d from "../../design/primitives/Dropdown.module.scss";
import s from "./SkillsPicker.module.scss";

export interface SkillsPickerProps {
  skills: ReadonlyArray<SkillInfo>;
}

export function SkillsPicker({ skills }: SkillsPickerProps) {
  const [open, setOpen] = useState(false);
  const [marketOpen, setMarketOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !marketOpen) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, marketOpen]);

  // The on-disk skill list is the only source of truth now — every entry
  // honors its own `enabled` flag (driven by the disabled-skills set in
  // globalState).
  const totalEnabled = skills.filter((sk) => sk.enabled).length;
  const totalCount = skills.length;

  const grouped = useMemo(
    () => ({
      tool: skills.filter((sk) => sk.category === "tool"),
      // CLI-native skills (Glob/Grep/Edit/WebFetch/Task) carry external=true
      // but no `source`. Filesystem-discovered skills (~/.claude/skills,
      // <ws>/.claude/skills) carry `source` so we can split them out.
      cli: skills.filter((sk) => sk.category === "skill" && !sk.source),
      user: skills.filter((sk) => sk.source === "user"),
      project: skills.filter((sk) => sk.source === "project"),
      integration: skills.filter((sk) => sk.category === "integration")
    }),
    [skills]
  );

  // For the marketplace modal: a name → installed-source map built from the
  // skills the extension just discovered on disk. This is the source of
  // truth for scope badges (User vs Project) — the old localStorage `added`
  // list is purely a cosmetic carry-over for marketplace items the user
  // toggled on/off without a real install.
  const installedMap = useMemo(() => {
    const m = new Map<
      string,
      { source: "user" | "project"; displayName: string; description: string }
    >();
    for (const sk of skills) {
      if (sk.source === "user" || sk.source === "project") {
        m.set(sk.id, {
          source: sk.source,
          displayName: sk.name,
          description: sk.description
        });
      }
    }
    return m;
  }, [skills]);

  return (
    <>
      <div className={d.picker} ref={ref}>
        {/* No `title` alongside this — the OS would draw its own grey box
            under ours a beat later. */}
        <Tooltip
          icon="bolt"
          label={`${totalEnabled} of ${totalCount} skills enabled`}
          hint="Click to choose what Luno can use"
        >
          <button
            type="button"
            className={s.trigger}
            onClick={() => setOpen((o) => !o)}
            aria-haspopup="dialog"
            aria-expanded={open}
          >
            <Icon name="bolt" size={11} />
            <span>Skills</span>
            <span className={s.count}>
              {totalEnabled}/{totalCount}
            </span>
            <Icon name="chevronD" size={9} />
          </button>
        </Tooltip>

        <AnimatePresence>
        {open && (
          <motion.div
            className={`${d.menu} ${d.left} ${d.above} ${s.menu}`}
            role="dialog"
            {...POPOVER_ABOVE}
          >
            <div className={s.head}>
              <span className={s.title}>Skills</span>
              <span className={s.sub}>
                Tools and capabilities Luno can use this session.
              </span>
            </div>

            <div className={s.scroll}>
              {grouped.tool.length > 0 && (
                <SkillSection title="Built-in tools">
                  {grouped.tool.map((sk) => (
                    <SkillRow key={sk.id} skill={sk} />
                  ))}
                </SkillSection>
              )}
              {grouped.cli.length > 0 && (
                <SkillSection title="Claude Code agent">
                  {grouped.cli.map((sk) => (
                    <SkillRow key={sk.id} skill={sk} />
                  ))}
                </SkillSection>
              )}
              {grouped.project.length > 0 && (
                <SkillSection title="Project skills">
                  {grouped.project.map((sk) => (
                    <DiscoveredRow key={sk.id} skill={sk} />
                  ))}
                </SkillSection>
              )}
              {grouped.user.length > 0 && (
                <SkillSection title="Your skills">
                  {grouped.user.map((sk) => (
                    <DiscoveredRow key={sk.id} skill={sk} />
                  ))}
                </SkillSection>
              )}
              {grouped.integration.length > 0 && (
                <SkillSection title="Integrations">
                  {grouped.integration.map((sk) => (
                    <SkillRow key={sk.id} skill={sk} />
                  ))}
                </SkillSection>
              )}
            </div>

            <div className={s.foot}>
              <button
                type="button"
                className={s.addBtn}
                onClick={() => setMarketOpen(true)}
              >
                <Icon name="plus" size={11} />
                Add skills
              </button>
              <span className={s.footHint}>{totalEnabled} enabled</span>
            </div>
          </motion.div>
        )}
        </AnimatePresence>
      </div>

      <SkillsMarketplace
        open={marketOpen}
        installed={installedMap}
        onClose={() => setMarketOpen(false)}
      />
    </>
  );
}

function SkillSection({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className={s.section}>
      <div className={s.sectionTitle}>{title}</div>
      <div className={s.list}>{children}</div>
    </div>
  );
}

function SkillRow({ skill }: { skill: SkillInfo }) {
  const icon = iconFor(skill.id);
  return (
    <div className={`${s.row}${skill.enabled ? ` ${s.enabled}` : ""}`}>
      <span className={s.rowIcon}>
        <Icon name={icon} size={12} />
      </span>
      <div className={s.rowBody}>
        <div className={s.rowName}>
          {skill.name}
          {skill.external && <span className={s.rowTag}>CLI</span>}
        </div>
        <div className={s.rowDesc}>{skill.description}</div>
      </div>
      <span className={`${s.rowState}${skill.enabled ? ` ${s.on}` : ""}`}>
        {skill.enabled ? <Icon name="check" size={11} /> : <Icon name="x" size={11} />}
      </span>
    </div>
  );
}

/**
 * Filesystem-discovered skill row — Read-only metadata (name, description,
 * source tag) plus a Switch that flips enabled state via the setSkillEnabled
 * RPC. No remove button: the user manages the underlying SKILL.md file
 * outside the extension.
 */
function DiscoveredRow({ skill }: { skill: SkillInfo }) {
  const icon = iconFor(skill.id);
  return (
    <div className={`${s.row}${skill.enabled ? ` ${s.enabled}` : ""}`}>
      <span className={s.rowIcon}>
        <Icon name={icon} size={12} />
      </span>
      <div className={s.rowBody}>
        <div className={s.rowName}>
          {skill.name}
          {skill.source && (
            <span className={`${s.rowTag} ${s.rowTagMarket}`}>
              {skill.source === "user" ? "User" : "Project"}
            </span>
          )}
        </div>
        <div className={s.rowDesc}>{skill.description}</div>
      </div>
      <div className={s.rowControls}>
        <Switch
          checked={skill.enabled}
          onChange={() =>
            send({ type: "setSkillEnabled", id: skill.id, enabled: !skill.enabled })
          }
          label={skill.name}
        />
      </div>
    </div>
  );
}

function Switch({
  checked,
  onChange,
  label
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={`Toggle ${label}`}
      className={`${s.switch}${checked ? ` ${s.on}` : ""}`}
      onClick={onChange}
    >
      <span className={s.knob} />
    </button>
  );
}

function iconFor(id: string): IconName {
  switch (id) {
    case "fs_read":
    case "Read":
      return "file";
    case "fs_write":
    case "Write":
    case "Edit":
      return "edit";
    case "bash":
      return "terminal";
    case "Glob":
      return "folder";
    case "Grep":
      return "search";
    case "WebFetch":
      return "cloud";
    case "Task":
      return "layers";
    case "mcp":
      return "git";
    case "github":
    case "git":
      return "branch";
    case "postgres":
      return "layers";
    case "linear":
    case "notion":
      return "book";
    case "slack":
      return "cloud";
    case "playwright":
    case "puppeteer":
      return "eye";
    case "filesystem":
      return "folder";
    case "memory":
      return "book";
    case "brave-search":
      return "search";
    case "figma":
      return "edit";
    default:
      return "code";
  }
}
