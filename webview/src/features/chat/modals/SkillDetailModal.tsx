// ─────────────────────────────────────────────────────────────
// Skill detail modal — opened from the inline SkillSuggestion's
// "View skill" button. Instead of bouncing the user out to
// claude-plugins.dev, we fetch the skill's SKILL.md (via the
// `requestSkillDetail` RPC) and preview it in-panel, with install
// actions and a "Source ↗" escape hatch.
// ─────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { send, onMessage, MarketplaceSkill } from "../../../lib/rpc";
import { formatCount } from "../../../lib/format";
import { Icon } from "../../../design/icons";
import { BACKDROP, OVERLAY_PANEL } from "../../../design/motion";
import { Tooltip } from "../../../design/primitives";
import { MarkdownBody } from "../markdown";
import s from "./SkillDetailModal.module.scss";
// The loading ring is the marketplace's, not ToolCard's — same modal family.
import mk from "./SkillsMarketplace.module.scss";

interface SkillDetailModalProps {
  /** Skill name to resolve and preview (matches the marketplace `name`). */
  skillName: string;
  onClose: () => void;
}

interface DetailState {
  status: "loading" | "ready" | "error";
  skill?: MarketplaceSkill;
  content?: string;
  error?: string;
}

type InstallState =
  | { phase: "idle" }
  | { phase: "busy"; scope: "user" | "project" }
  | { phase: "done"; ok: boolean; text: string };

export function SkillDetailModal({
  skillName,
  onClose
}: SkillDetailModalProps) {
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [install, setInstall] = useState<InstallState>({ phase: "idle" });

  // Fetch the skill detail + install result subscription.
  useEffect(() => {
    const off = onMessage((m) => {
      if (m.type === "skillDetail" && m.name === skillName) {
        if (m.error) {
          setState({ status: "error", error: m.error });
        } else {
          setState({ status: "ready", skill: m.skill, content: m.content });
        }
      } else if (
        m.type === "marketplaceInstallResult" &&
        m.name === skillName
      ) {
        const scopeLabel =
          m.scope === "user" ? "globally" : "for this workspace";
        if (m.action === "install") {
          setInstall({
            phase: "done",
            ok: m.ok,
            text: m.ok
              ? `Installed ${scopeLabel}.`
              : `Couldn't install: ${m.error ?? "unknown error"}.`
          });
        }
      }
    });
    send({ type: "requestSkillDetail", name: skillName });
    return off;
  }, [skillName]);

  // Esc to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const skill = state.skill;

  const doInstall = (scope: "user" | "project") => {
    if (!skill) return;
    setInstall({ phase: "busy", scope });
    send({
      type: "installMarketplaceSkill",
      target: {
        name: skill.name,
        repoOwner: skill.repoOwner,
        repoName: skill.repoName,
        directoryPath: skill.directoryPath
      },
      scope
    });
  };

  return createPortal(
    <motion.div
      {...BACKDROP}
      className={s.backdrop}
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${skillName} skill`}
    >
      <motion.div
        {...OVERLAY_PANEL}
        className={s.panel}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className={s.hairline} />

        {/* Header */}
        <header className={s.head}>
          <div className={s.tile}>
            <Icon name="bolt" size={20} />
          </div>
          <div className={s.titles}>
            <h2 className={s.title}>{skill?.name ?? skillName}</h2>
            <div className={s.meta}>
              {skill?.author && <span>@{skill.author}</span>}
              {skill && skill.installs > 0 && (
                <>
                  <span className={s.dot} />
                  <span>{formatCount(skill.installs)} installs</span>
                </>
              )}
              {skill && skill.stars > 0 && (
                <>
                  <span className={s.dot} />
                  <span>★ {formatCount(skill.stars)}</span>
                </>
              )}
            </div>
          </div>
          <button
            type="button"
            className={s.close}
            onClick={onClose}
            aria-label="Close"
          >
            <Icon name="x" size={14} />
          </button>
        </header>

        {/* Body */}
        <div className={s.body}>
          {state.status === "loading" ? (
            <div className={s.state}>
              <span className={mk.spinnerLg} />
              <span>Loading skill…</span>
            </div>
          ) : state.status === "error" ? (
            <div className={s.state}>
              <Icon name="x" size={20} />
              <span>Couldn&rsquo;t load this skill: {state.error}</span>
            </div>
          ) : (
            <>
              {skill?.description && (
                <p className={s.desc}>{skill.description}</p>
              )}
              {state.content ? (
                <div className={`md ${s.markdown}`}>
                  <MarkdownBody text={state.content} preserveHeadings />
                </div>
              ) : (
                <p className={s.empty}>
                  No preview available. Use “Source” to view the full skill.
                </p>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <footer className={s.foot}>
          {skill?.sourceUrl && (
            <Tooltip label={skill.sourceUrl} wrap>
              <button
                type="button"
                className={s.btn}
                onClick={() =>
                  send({ type: "openExternal", url: skill.sourceUrl })
                }
              >
                <Icon name="book" size={12} />
                Source ↗
              </button>
            </Tooltip>
          )}

          <div className={s.footActions}>
            {install.phase === "done" && (
              <span
                className={`${s.result} ${install.ok ? s.resultOk : s.resultBad}`}
              >
                <Icon name={install.ok ? "check" : "x"} size={11} />
                {install.text}
              </span>
            )}
            {skill && install.phase !== "done" && (
              <>
                <button
                  type="button"
                  className={s.btn}
                  onClick={() => doInstall("user")}
                  disabled={install.phase === "busy"}
                >
                  {install.phase === "busy" && install.scope === "user"
                    ? "Adding…"
                    : "Add globally"}
                </button>
                <button
                  type="button"
                  className={s.btnPrimary}
                  onClick={() => doInstall("project")}
                  disabled={install.phase === "busy"}
                >
                  <Icon name="plus" size={12} />
                  {install.phase === "busy" && install.scope === "project"
                    ? "Adding…"
                    : "Add to workspace"}
                </button>
              </>
            )}
          </div>
        </footer>
      </motion.div>
    </motion.div>,
    document.body
  );
}
