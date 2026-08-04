// ─────────────────────────────────────────────────────────────
// PinnedContext — strip above the composer listing files the user
// has pinned for the current session. Pins persist in vscode.setState
// (alongside the timeline) and are prepended to each outgoing prompt
// as `@file` mentions so the agent always picks them up.
// ─────────────────────────────────────────────────────────────

import { motion, AnimatePresence } from "framer-motion";
import { ENTER, EXPAND, TRAVEL } from "../../../design/motion";
import { Icon } from "../../../design/icons";
import { Tooltip } from "../../../design/primitives";
import { send } from "../../../lib/rpc";
import bits from "../ChatBits.module.scss";

export interface PinnedFile {
  path: string;
  /** Display label (basename + optional line range). */
  label: string;
}

interface PinnedContextProps {
  pins: ReadonlyArray<PinnedFile>;
  onRemove: (path: string) => void;
  onClearAll: () => void;
}

export function PinnedContext({
  pins,
  onRemove,
  onClearAll
}: PinnedContextProps) {
  if (pins.length === 0) return null;
  return (
    <motion.div {...EXPAND} className={bits.pins}>
      <div className={bits.pinsRow}>
        <span className={bits.pinsLabel}>
          <Icon name="attach" size={10} />
          Pinned
        </span>
        <AnimatePresence initial={false}>
          {pins.map((p) => (
            // The pill reveals the full path, which the label above it cut
            // down to a basename — a value, so it wraps. The Tooltip clones
            // the pill rather than boxing it, so it is still the keyed child
            // AnimatePresence tracks.
            <Tooltip key={p.path} label={p.path} wrap>
              {/* ENTER carries the timing; the pill's own character — it also
                  scales, and it drops in from above the row rather than rising
                  into it — is re-stated on top, along with the exit ENTER lacks. */}
              <motion.span
                {...ENTER}
                initial={{ ...ENTER.initial, scale: 0.85, y: -TRAVEL.sm }}
                animate={{ ...ENTER.animate, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8, y: -TRAVEL.sm }}
                className={bits.pin}
              >
                <button
                  type="button"
                  onClick={() => send({ type: "openFile", path: p.path })}
                  className={bits.pinOpen}
                >
                  <Icon name="file" size={10} className={bits.pinIcon} />
                  <span className={bits.pinName}>{p.label}</span>
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(p.path);
                  }}
                  className={bits.pinRemove}
                  aria-label={`Unpin ${p.label}`}
                >
                  <Icon name="x" size={8} />
                </button>
              </motion.span>
            </Tooltip>
          ))}
        </AnimatePresence>
        {pins.length > 1 && (
          <Tooltip label="Unpin all">
            <button
              type="button"
              onClick={onClearAll}
              className={bits.pinsClear}
            >
              Clear
            </button>
          </Tooltip>
        )}
      </div>
    </motion.div>
  );
}
