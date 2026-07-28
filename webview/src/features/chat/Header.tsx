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

/** Icon and tone per state; the words come from `chat-status.ts`. `working`
 *  carries the spinner instead of an icon, so it names none. */
const LOOK: Record<ChatStatus, { icon: IconName | null; tone: ChipTone }> = {
  "needs-you": { icon: "danger", tone: "warn" },
  working: { icon: null, tone: "accent" },
  failed: { icon: "x", tone: "error" },
  interrupted: { icon: "stop", tone: "warn" },
  "no-reply": { icon: "clock", tone: "warn" },
  done: { icon: "check", tone: "default" }
};

export function Header({
  title,
  storedStatus,
  busy,
  awaitingApproval,
  errored,
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
          <RemoteControlPill status={remoteControl} />
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
            title="Standing permissions"
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
        {status && (
          <>
            <span className={s.sessionRule} aria-hidden />
            {/* Keyed on the state so a change crosses over rather than
                mutating in place — the word and its colour move together. */}
            <AnimatePresence mode="wait" initial={false}>
              <motion.span key={status} className={s.sessionStatus} {...SWAP}>
                <Chip tone={LOOK[status].tone} pulse={status === "working"}>
                  {status === "working" ? (
                    // The rotation is the `spin` mixin's, in the stylesheet —
                    // see the note there for why framer could not hold it.
                    <span className={s.chipSpinner} />
                  ) : (
                    <Icon name={LOOK[status].icon as IconName} size={10} />
                  )}
                  {HEADER_LABEL[status]}
                </Chip>
              </motion.span>
            </AnimatePresence>
          </>
        )}
      </div>
    </header>
  );
}
