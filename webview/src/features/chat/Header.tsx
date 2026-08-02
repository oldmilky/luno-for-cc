// ─────────────────────────────────────────────────────────────
// Panel header — two rows. The top one is the product and what
// it costs: brand, plan, quota, and the actions that act on the
// whole panel. The bottom one is this conversation: what it is
// called and how it stands.
//
// The model and permission-mode pickers live in the Composer,
// where the posture is chosen. The header used to mirror the
// mode as a chip; two indicators for one setting is one too
// many, and the composer's is the one with the affordance.
// ─────────────────────────────────────────────────────────────

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Icon, BrandMark } from "../../design/icons";
import { IconButton, Chip, Tooltip } from "../../design/primitives";
import {
  PRESS,
  SPRING_POP,
  SWAP,
  DURATION,
  EASE_OUT
} from "../../design/motion";
import { send, ChatStatus, TimelineEvent } from "../../lib/rpc";
import { HEADER_LABEL, headerStatus } from "./chat-status";
import { TokenMeter } from "./TokenMeter";
import { RemoteControlPill } from "./RemoteControlPill";
import { ThemePicker } from "../theme/ThemePicker";
import type { RemoteControlStatus } from "../../lib/rpc";
import type { IconName } from "../../design/icons";
import type { ChipTone } from "../../design/primitives";
import s from "./Header.module.scss";

interface HeaderProps {
  /** What the host calls this conversation — the same string its tab shows. */
  title: string;
  /** The host's reading of the stored timeline; `null` until it says. */
  storedStatus: ChatStatus | null;
  busy: boolean;
  awaitingApproval: boolean;
  errored: boolean;
  /** Background agents still running with the turn over. The CLI process
   *  outlives its turn, so the panel can be idle while the work is not. */
  agentsRunning: boolean;
  /** How many of them, for the chip that says so. Same number the composer's
   *  agents button carries — one count, or the two surfaces disagree. */
  agentCount: number;
  onOpenAgents: () => void;
  events: ReadonlyArray<TimelineEvent>;
  streaming: string;
  onOpenHistory: () => void;
  onOpenConnectors: () => void;
  /** The standing-grants list. In the header rather than behind a menu because
   *  a permission you cannot find is one you cannot revoke. */
  onOpenPermissions: () => void;
  /** Whether this conversation is reachable from another device. */
  remoteControl: RemoteControlStatus;
}

/** Icon and tone per state; the words come from `chat-status.ts`. The two live
 *  states carry the spinner instead of an icon, so they name none. */
const LOOK: Record<ChatStatus, { icon: IconName | null; tone: ChipTone }> = {
  "needs-you": { icon: "danger", tone: "warn" },
  working: { icon: null, tone: "accent" },
  agents: { icon: null, tone: "info" },
  failed: { icon: "x", tone: "error" },
  interrupted: { icon: "stop", tone: "warn" },
  "no-reply": { icon: "clock", tone: "warn" },
  done: { icon: "check", tone: "default" }
};

/** The states that spin: something is running, whether or not it is composing
 *  text at you. */
const LIVE: ReadonlySet<ChatStatus> = new Set<ChatStatus>([
  "working",
  "agents"
]);

export function Header({
  title,
  storedStatus,
  busy,
  awaitingApproval,
  errored,
  agentsRunning,
  agentCount,
  onOpenAgents,
  events,
  streaming,
  onOpenHistory,
  onOpenConnectors,
  onOpenPermissions,
  remoteControl
}: HeaderProps) {
  const [newChatTick, setNewChatTick] = useState(0);
  const handleNewChat = () => {
    send({ type: "newSession" });
    setNewChatTick((t) => t + 1);
  };

  const status = headerStatus({
    busy,
    awaitingApproval,
    errored,
    agentsRunning,
    stored: storedStatus
  });
  // Nothing has been said yet, so whatever the host called this is its
  // fallback rather than a name. Asking the timeline beats comparing against
  // the host's literal — that string is free to change without telling us.
  const named = events.length > 0 && title.length > 0;

  return (
    <header className={s.header}>
      <div className={s.row}>
        <div className={s.left}>
          <motion.div
            className={s.tile}
            aria-hidden
            whileHover={{ scale: 1.12, rotate: -8 }}
            // SPRING_POP, not SPRING_PRESS: the brand mark is exactly the
            // "used sparingly, with character" case — the press spring is
            // damped flat on purpose and would kill the tilt.
            transition={SPRING_POP}
          >
            <span className={s.halo} aria-hidden />
            <BrandMark size={17} />
          </motion.div>
          <span className={s.title}>Luno</span>
          <span className={s.optional}>
            <Tooltip label="Claude Code subscription">
              <Chip tone="accent">
                <span className={s.dot} />
                subscription
              </Chip>
            </Tooltip>
          </span>
          <TokenMeter events={events} streaming={streaming} />
        </div>

        <div className={s.right}>
          <Tooltip label="New chat">
            <motion.button
              key={`new-chat-${newChatTick}`}
              type="button"
              aria-label="New chat"
              className={s.newChat}
              onClick={handleNewChat}
              {...PRESS}
              whileHover={{ scale: 1.08 }}
            >
              <motion.span
                initial={false}
                animate={
                  newChatTick > 0
                    ? { rotate: 90, scale: [1, 1.2, 1] }
                    : { rotate: 0, scale: 1 }
                }
                // Press feedback, so it takes the tap role. Not SPRING_PRESS:
                // framer only supports two keyframes on a spring, and the scale
                // pulse has three.
                transition={{ duration: DURATION.tap, ease: EASE_OUT }}
                className={s.newChatGlyph}
              >
                <Icon name="plus" size={14} />
              </motion.span>
              {newChatTick > 0 && (
                <motion.span
                  key={`ripple-${newChatTick}`}
                  className={s.ripple}
                  initial={{ opacity: 0.5, scale: 0.6 }}
                  animate={{ opacity: 0, scale: 1.6 }}
                  // The one thing here that travels a real distance, so it takes
                  // the expand role — the longest the language allows.
                  transition={{ duration: DURATION.expand, ease: EASE_OUT }}
                />
              )}
            </motion.button>
          </Tooltip>
          <IconButton
            icon="history"
            title="Chat history"
            size={28}
            onClick={onOpenHistory}
          />
          <ThemePicker />
          <IconButton
            icon="plug"
            title="Connectors (MCP servers)"
            size={28}
            onClick={onOpenConnectors}
          />
          <IconButton
            icon="shield"
            title="Permissions"
            size={28}
            onClick={onOpenPermissions}
          />
          <div className={s.divider} />
          <IconButton
            icon="logout"
            title="Sign out of Claude Code"
            size={28}
            onClick={() => send({ type: "claudeLogout" })}
          />
        </div>
      </div>

      <div className={s.session}>
        <span className={named ? s.sessionName : s.sessionPlaceholder}>
          {named ? title : "New chat"}
        </span>
        {/* Reachability belongs to the conversation, not to the panel, so it
            reads beside the name and ahead of the status it qualifies. */}
        <RemoteControlPill status={remoteControl} />
        {status && (
          <>
            <span className={s.sessionRule} aria-hidden />
            {/* Keyed on the state so a change crosses over rather than
                mutating in place — the word and its colour move together. */}
            <AnimatePresence mode="wait" initial={false}>
              <motion.span key={status} className={s.sessionStatus} {...SWAP}>
                <StatusChip
                  status={status}
                  agentCount={agentCount}
                  onOpenAgents={onOpenAgents}
                />
              </motion.span>
            </AnimatePresence>
          </>
        )}
      </div>
    </header>
  );
}

/**
 * The conversation's state, as one chip.
 *
 * `agents` is the only one that is also a control. It says the same thing the
 * composer's agents button says, so it opens the same panel rather than being
 * a second, dimmer report of it — and it carries the count for the same reason
 * the button does: "agents" alone leaves the one question people actually have
 * unanswered.
 *
 * That count is why this diverges from `HEADER_LABEL`, which the history list
 * shares. The list reads stored sessions and has no live number to show; the
 * header does.
 */
function StatusChip({
  status,
  agentCount,
  onOpenAgents
}: {
  status: ChatStatus;
  agentCount: number;
  onOpenAgents: () => void;
}) {
  const isAgents = status === "agents";
  const chip = (
    <Chip
      tone={LOOK[status].tone}
      pulse={status === "working"}
      interactive={isAgents || undefined}
      onClick={isAgents ? onOpenAgents : undefined}
      aria-label={isAgents ? "Show background agents" : undefined}
    >
      {LIVE.has(status) ? (
        // The rotation is the `spin` mixin's, in the stylesheet — see the note
        // there for why framer could not hold it.
        <span className={s.chipSpinner} />
      ) : (
        <Icon name={LOOK[status].icon as IconName} size={10} />
      )}
      {isAgents
        ? `${agentCount} ${agentCount === 1 ? "agent" : "agents"}`
        : HEADER_LABEL[status]}
    </Chip>
  );

  return isAgents ? (
    <Tooltip label="Still working in the background — open the panel">
      {chip}
    </Tooltip>
  ) : (
    chip
  );
}
