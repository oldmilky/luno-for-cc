// ─────────────────────────────────────────────────────────────
// Slim session header — Forge ForgeSessionHeader. The model and
// permission-mode pickers live in the Composer, per the Forge
// design. The header carries identity + global session actions.
// ─────────────────────────────────────────────────────────────

import { useState } from "react";
import { motion } from "framer-motion";
import { Icon, BrandMark } from "../../design/icons";
import { IconButton, Chip, Tooltip } from "../../design/primitives";
import { PRESS, SPIN, SPRING_POP, DURATION, EASE_OUT } from "../../design/motion";
import { send, ConventionsSource, TimelineEvent } from "../../lib/rpc";
import { findMode } from "./constants";
import type { PermissionMode } from "../../lib/rpc";
import { ConventionsStatusPill } from "./ConventionsStatusPill";
import { TokenMeter } from "./TokenMeter";
import { ThemePicker } from "../theme/ThemePicker";
import s from "./Header.module.scss";

interface HeaderProps {
  permissionMode: PermissionMode;
  busy: boolean;
  conventions: {
    source: ConventionsSource | null;
    path: string | null;
    relativePath: string | null;
  };
  events: ReadonlyArray<TimelineEvent>;
  streaming: string;
  onOpenHistory: () => void;
  onOpenConnectors: () => void;
}

export function Header({
  permissionMode,
  busy,
  conventions,
  events,
  streaming,
  onOpenHistory,
  onOpenConnectors
}: HeaderProps) {
  const mode = findMode(permissionMode);
  const [newChatTick, setNewChatTick] = useState(0);
  const handleNewChat = () => {
    send({ type: "newSession" });
    setNewChatTick((t) => t + 1);
  };
  return (
    <header className={s.header}>
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
        <Tooltip label="Claude Code subscription">
          <Chip tone="accent">
            <span className={s.dot} />
            subscription
          </Chip>
        </Tooltip>
        <Tooltip label={mode.note}>
          <Chip tone="default">
            <Icon name={mode.icon} size={10} />
            {mode.short}
          </Chip>
        </Tooltip>
        <ConventionsStatusPill
          source={conventions.source}
          path={conventions.path}
          relativePath={conventions.relativePath}
        />
        {busy && (
          <Chip tone="accent" pulse>
            {/* SPIN, not a period derived from DURATION.enter. This is the
                same ring the three CSS spinners draw, and deriving its cadence
                here made it a fourth rate (0.72s) alongside their 700/700/800 —
                the exact drift the shared preset exists to stop. */}
            <motion.span
              className={s.chipSpinner}
              animate={{ rotate: 360 }}
              transition={SPIN}
            />
            streaming
          </Chip>
        )}
      </div>

      <div className={s.right}>
        <TokenMeter events={events} streaming={streaming} />
        <div className={s.divider} />
        <ThemePicker />
        <IconButton
          icon="plug"
          title="Connectors (MCP servers)"
          size={28}
          onClick={onOpenConnectors}
        />
        <IconButton icon="history" title="Chat history" size={28} onClick={onOpenHistory} />
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
        <div className={s.divider} />
        <IconButton
          icon="logout"
          title="Sign out of Claude Code"
          size={28}
          onClick={() => send({ type: "claudeLogout" })}
        />
      </div>
    </header>
  );
}
