// ─────────────────────────────────────────────────────────────
// Conversation-row pill — whether this conversation can be driven
// from claude.ai/code or the Claude mobile app.
//
// Absent entirely when the bridge is off: a control for something
// nobody has switched on is noise.
//
// It sits beside the chat's name rather than in the identity row
// above, because what it describes is this conversation and not the
// panel. Unlike the row above it is not dropped at narrow widths —
// the name ellipsises instead, which is the cheaper thing to lose.
// ─────────────────────────────────────────────────────────────

import { AnimatePresence, motion } from "framer-motion";
import { ENTER_CARD } from "../../design/motion";
import { Chip } from "../../design/primitives/Chip";
import { Tooltip } from "../../design/primitives/Tooltip";
import { send } from "../../lib/rpc";
import type { ChipTone } from "../../design/primitives/Chip";
import type { RemoteControlStatus } from "../../lib/rpc";
import s from "./Header.module.scss";

interface RemoteControlPillProps {
  status: RemoteControlStatus;
}

/** Tone, label and explanation per state. The label stays short because it
 *  sits in a header that already competes for width; the tooltip carries the
 *  sentence. */
const FACES: Record<
  Exclude<RemoteControlStatus["state"], "off">,
  { tone: ChipTone; label: string; hint: string }
> = {
  ready: {
    tone: "info",
    label: "remote",
    hint: "Waiting for a device. Open the link on your phone or at claude.ai/code."
  },
  // Blue, not green: green in this header means "finished well", and a live
  // connection is a standing state rather than an outcome. The pulse, not the
  // hue, is what separates it from `ready`.
  connected: {
    tone: "info",
    label: "remote",
    hint: "A device is connected. Click to open this session at claude.ai/code."
  },
  disconnected: {
    tone: "warn",
    label: "remote",
    hint: "The bridge dropped. It reconnects on its own when the machine is back online."
  },
  error: {
    tone: "error",
    label: "remote",
    hint: "Remote Control failed to start."
  }
};

export function RemoteControlPill({ status }: RemoteControlPillProps) {
  const face = status.state === "off" ? null : FACES[status.state];

  return (
    <AnimatePresence initial={false}>
      {face && (
        <motion.span {...ENTER_CARD} className={s.sessionPill}>
          <Tooltip
            label={
              status.state === "error" && status.error
                ? status.error
                : `${face.hint} Type /rc again to turn it off.`
            }
          >
            <Chip
              tone={face.tone}
              interactive={Boolean(status.sessionUrl)}
              pulse={status.state === "connected"}
              onClick={() => {
                // Always the URL we hold right now, never one remembered from
                // earlier: replacing the CLI process mints a new session, and
                // the old link points at one that no longer exists.
                if (status.sessionUrl) {
                  send({ type: "openExternal", url: status.sessionUrl });
                }
              }}
            >
              <span className={s.dot} />
              {face.label}
            </Chip>
          </Tooltip>
        </motion.span>
      )}
    </AnimatePresence>
  );
}
