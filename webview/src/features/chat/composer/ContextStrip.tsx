import { motion } from "framer-motion";
import { ENTER } from "../../../design/motion";
import { Icon } from "../../../design/icons";
import { Tooltip } from "../../../design/primitives";
import { send } from "../../../lib/rpc";
import type { EditorContext } from "../../../lib/rpc";
import bits from "../ChatBits.module.scss";

interface ContextStripProps {
  context: EditorContext | null;
  pinned: boolean;
  onPin: () => void;
  onUnpin: () => void;
}

export function ContextStrip({
  context,
  pinned,
  onPin,
  onUnpin
}: ContextStripProps) {
  if (!context) return null;
  const fileName = context.file.split("/").pop() ?? context.file;
  const sel = context.selection;
  // A row of inline chips, not a card — ENTER, not ENTER_CARD.
  return (
    <motion.div {...ENTER} className={bits.strip}>
      <Tooltip label={`Open ${context.file}`}>
        <button
          type="button"
          onClick={() =>
            send({
              type: "openFile",
              path: context.file,
              startLine: sel?.startLine ?? 0,
              endLine: sel?.endLine ?? 0
            })
          }
          className={bits.stripFile}
        >
          <Icon name="file" size={11} className={bits.stripIcon} />
          <span className={bits.stripName}>{fileName}</span>
          <span className={bits.stripLang}>{context.language}</span>
        </button>
      </Tooltip>
      {sel && (
        <span className={bits.stripSelection}>
          <Icon name="code" size={10} />L{sel.startLine}
          {sel.endLine !== sel.startLine && `–${sel.endLine}`}
        </span>
      )}
      <Tooltip label={pinned ? "Unpin from session" : "Pin to session context"}>
        <button
          type="button"
          onClick={pinned ? onUnpin : onPin}
          aria-label={pinned ? "Unpin file" : "Pin file"}
          className={`${bits.stripPin}${pinned ? ` ${bits.stripPinned}` : ""}`}
        >
          <Icon name="attach" size={10} />
          {pinned ? "Pinned" : "Pin"}
        </button>
      </Tooltip>
    </motion.div>
  );
}
