// ─────────────────────────────────────────────────────────────
// ToolGroupCard — collapsible chip wrapping 1+ tool calls of the
// same semantic bucket. Header reads "Read 3 files" or "Ran ls"
// (single-tool groups inline the target into the header so the
// chip is self-explanatory without expanding).
// ─────────────────────────────────────────────────────────────

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ENTER, EXPAND, DURATION, EASE_SOFT } from "../../design/motion";
import { Icon } from "../../design/icons";
import { ToolCard } from "./ToolCard";
import { ToolBucket, bucketMeta, bucketSummary } from "./tool-buckets";
import s from "./Turn.module.scss";
import tool from "./ToolCard.module.scss";

export interface ToolGroupItem {
  id: string;
  name: string;
  input: string;
  result?: string;
  isError?: boolean;
  /** Set when auto mode refused the call — the reason, not the failure. */
  blockedReason?: string;
}

interface ToolGroupCardProps {
  bucket: ToolBucket;
  items: ToolGroupItem[];
}

export function ToolGroupCard({ bucket, items }: ToolGroupCardProps) {
  const [open, setOpen] = useState(false);
  const meta = bucketMeta(bucket);
  const anyPending = items.some((i) => i.result === undefined && !i.isError);
  const anyError = items.some((i) => i.isError);
  // A refusal is not an error and no longer sets `isError`, so without its own
  // reading the collapsed row — the default view — showed a green tick over a
  // call that never ran.
  const anyBlocked = items.some((i) => i.blockedReason);
  const status = anyPending
    ? "pending"
    : anyError
      ? "error"
      : anyBlocked
        ? "blocked"
        : "ok";

  // Single-tool groups show the target inline in the header so users don't
  // need to expand to see what one happened. Multi-tool groups show the
  // count and let the user expand for details.
  const single = items.length === 1;
  const headerLabel = single
    ? `${meta.verb} ${shortTarget(items[0])}`
    : bucketSummary(bucket, items.length);

  return (
    <motion.div
      {...ENTER}
      className={[
        s.group,
        status === "pending" ? s.groupPending : "",
        status === "error" ? s.groupError : "",
        status === "blocked" ? s.groupBlocked : ""
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <button
        type="button"
        className={s.groupHead}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={s.groupIcon} aria-hidden>
          <Icon name={meta.icon} size={11} />
        </span>
        <span className={s.groupLabel}>{headerLabel}</span>
        <span className={s.groupStatus}>
          {status === "pending" && <span className={tool.spinner} />}
          {status === "ok" && (
            <span className={s.groupOk}>
              <Icon name="check" size={11} />
            </span>
          )}
          {status === "error" && (
            <span className={s.groupErr}>
              <Icon name="x" size={11} />
            </span>
          )}
          {status === "blocked" && (
            <span className={s.groupBlocked}>
              <Icon name="shield" size={11} />
            </span>
          )}
        </span>
        {/* The chevron is part of the same open/collapse gesture as the body,
            so it takes EXPAND's timing — but it rotates rather than growing,
            so the preset itself (height + opacity) can't be spread here. */}
        <motion.span
          className={s.groupChev}
          animate={{ rotate: open ? 90 : 0 }}
          transition={{ duration: DURATION.expand, ease: EASE_SOFT }}
        >
          <Icon name="chevronR" size={10} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            {...EXPAND}
            className={s.groupBody}
            style={{ overflow: "hidden" }}
          >
            {items.map((it) => (
              <ToolCard
                key={it.id}
                name={it.name}
                input={it.input}
                result={it.result}
                isError={it.isError}
                blockedReason={it.blockedReason}
                pending={it.result === undefined && !it.isError}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function shortTarget(item: ToolGroupItem): string {
  try {
    const obj = JSON.parse(item.input) as Record<string, unknown>;
    const path = obj.path ?? obj.file_path ?? obj.filePath ?? obj.new_file_path;
    if (typeof path === "string" && path) return shortenPath(path);
    const cmd = obj.command;
    if (typeof cmd === "string" && cmd)
      return cmd.length > 60 ? cmd.slice(0, 60) + "…" : cmd;
    const pattern = obj.pattern ?? obj.query;
    if (typeof pattern === "string" && pattern) return pattern;
    const url = obj.url;
    if (typeof url === "string" && url) return url;
  } catch {
    /* fallthrough */
  }
  return item.name;
}

function shortenPath(p: string): string {
  if (p.length <= 50) return p;
  const parts = p.split("/");
  if (parts.length <= 3) return p;
  return parts.slice(0, 1).concat(["…"], parts.slice(-2)).join("/");
}
