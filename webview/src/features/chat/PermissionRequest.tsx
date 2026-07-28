// ─────────────────────────────────────────────────────────────
// PermissionRequest — inline approval card shown when the agent
// wants to run a mutating tool (Write / Edit / Bash / …). The CLI
// blocks the turn until the user answers.
//
// Minimal by design: a one-line question, a preview of exactly what
// will run (diff / command / inputs), and Deny / Allow. Risk is
// conveyed by a single tone accent (left stripe + colored tool tag
// + Allow color) — no badges, pills, or banners.
//
// Outcomes:
//   • Deny           (Esc)   — reject this one call
//   • Allow          (↵)     — run this one call
//   • Allow this turn (⇧↵)   — also stop asking about similar calls
//                              this turn (only when the CLI offers it)
//   • Always                 — a standing grant, kept until revoked. Only
//                              offered when the host says one is available:
//                              never for a destructive or network call.
// ─────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef } from "react";
import { ENTER_CARD } from "../../design/motion";
import { motion } from "framer-motion";
import type { PermissionRequestView } from "../../lib/rpc";
import { Tooltip } from "../../design/primitives";
import { extractFileEdits } from "./extract-file-edits";
import { InlineEditPreview } from "./InlineEditPreview";
import type { ToolGroupItem } from "./ToolGroupCard";
import s from "./PermissionRequest.module.scss";

interface PermissionRequestProps {
  request: PermissionRequestView;
  onRespond: (
    behavior: "allow" | "deny",
    opts?: { restOfTurn?: boolean; always?: boolean }
  ) => void;
}

const BASH_TOOLS = /^(bash|shell|run|exec|terminal)/i;

export function PermissionRequest({
  request,
  onRespond
}: PermissionRequestProps) {
  const allowRef = useRef<HTMLButtonElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  const destructive = request.destructive === true;
  const network = request.network === true && !destructive;
  // One modifier drives the whole risk signal — stripe, tool tag, Allow fill.
  const toneClass = destructive ? s.danger : network ? s.network : "";

  const edits = useMemo(() => {
    const item: ToolGroupItem = {
      id: request.requestId,
      name: request.toolName,
      input: JSON.stringify(request.input ?? {})
    };
    return extractFileEdits([item]);
  }, [request]);

  const command =
    BASH_TOOLS.test(request.toolName) &&
    typeof request.input?.command === "string"
      ? (request.input.command as string)
      : null;
  const isEdit = edits.length > 0;
  const isCommand = command !== null;

  // `sug`, not `s` — `s` is the style module in this file now.
  const canAllowTurn = request.suggestions?.some(
    (sug) => sug.type === "setMode" && typeof sug.mode === "string"
  );

  const title = describe(
    isEdit,
    isCommand,
    destructive,
    network,
    request.toolName
  );

  // Focus a button on mount so the scoped shortcuts work right away. For
  // destructive calls focus DENY so a reflexive Enter rejects.
  useEffect(() => {
    const target = destructive ? denyRef : allowRef;
    const id = requestAnimationFrame(() => target.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [request.requestId, destructive]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onRespond("deny");
      return;
    }
    if (e.key === "Enter") {
      if (destructive) return; // focused Deny handles Enter
      e.preventDefault();
      if (e.shiftKey && canAllowTurn) onRespond("allow", { restOfTurn: true });
      else onRespond("allow");
    }
  };

  return (
    <motion.div
      role="dialog"
      aria-label="Tool permission request"
      onKeyDown={onKeyDown}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={ENTER_CARD.transition}
      className={`${s.card} ${toneClass}`}
    >
      {/* Title + tool tag */}
      <div className={s.head}>
        <span className={s.title}>{title}</span>
        <span className={s.toolTag}>{request.toolName}</span>
      </div>

      {/* Preview */}
      <div className={s.preview}>
        {isEdit ? (
          <div className={s.edits}>
            {edits.map((entry) => (
              <InlineEditPreview
                key={entry.id}
                entry={entry}
                onOpenFull={() => undefined}
              />
            ))}
          </div>
        ) : isCommand ? (
          <pre className={s.command}>
            <span className={s.prompt}>$ </span>
            {command}
          </pre>
        ) : (
          <InputSummary input={request.input} />
        )}
      </div>

      {/* Actions */}
      <div className={s.actions}>
        <button
          ref={denyRef}
          type="button"
          onClick={() => onRespond("deny")}
          className={s.deny}
        >
          Deny
        </button>
        {canAllowTurn && !destructive && (
          <button
            type="button"
            onClick={() => onRespond("allow", { restOfTurn: true })}
            className={s.allowTurn}
          >
            Allow this turn
          </button>
        )}
        {/* The host decides whether a standing grant is on offer and how it
            reads. Absent means there is none: a destructive or network call,
            or a command with no single prefix that describes it. */}
        {request.grantLabel && (
          <Tooltip
            label={`Never ask about ${request.grantLabel} again, in any project. Revoke from the shield in the header.`}
          >
            <button
              type="button"
              onClick={() => onRespond("allow", { always: true })}
              className={s.allowAlways}
            >
              Always
            </button>
          </Tooltip>
        )}
        <button
          ref={allowRef}
          type="button"
          onClick={() => onRespond("allow")}
          className={s.allow}
        >
          Allow
        </button>
      </div>
    </motion.div>
  );
}

// ─────────────────── helpers ───────────────────

function describe(
  isEdit: boolean,
  isCommand: boolean,
  destructive: boolean,
  network: boolean,
  toolName: string
): string {
  if (isCommand) {
    if (destructive) return "Run destructive command?";
    if (network) return "Run network command?";
    return "Run command?";
  }
  if (isEdit) return destructive ? "Overwrite files?" : "Apply changes?";
  if (network) return "Access the network?";
  return `Allow ${toolName}?`;
}

function InputSummary({ input }: { input: Record<string, unknown> }) {
  const entries = Object.entries(input ?? {}).slice(0, 5);
  if (entries.length === 0) return null;
  return (
    <div className={s.inputs}>
      {entries.map(([k, v]) => (
        <div key={k} className={s.inputRow}>
          <span className={s.inputKey}>{k}</span>
          <span className={s.inputValue}>{stringify(v)}</span>
        </div>
      ))}
    </div>
  );
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
