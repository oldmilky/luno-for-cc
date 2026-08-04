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
//                              Where it is kept is the picker beside it, and
//                              the two answers differ in kind: LUNO's own
//                              storage keeps our gate on the path, a settings
//                              file takes it off — the CLI then stops asking
//                              us about the call at all.
// ─────────────────────────────────────────────────────────────

import { useEffect, useMemo, useRef, useState } from "react";
import { ENTER_CARD } from "../../design/motion";
import { motion } from "framer-motion";
import type { GrantScope, PermissionRequestView } from "../../lib/rpc";
import { Dropdown, Tooltip } from "../../design/primitives";
import { Icon } from "../../design/icons";
import { extractFileEdits } from "./timeline/extract-file-edits";
import { InlineEditPreview } from "./timeline/InlineEditPreview";
import { QuestionRequest } from "./QuestionRequest";
import {
  allAnswered,
  buildUpdatedInput,
  readQuestions,
  type QuestionDraft
} from "./timeline/question-answers";
import type { ToolGroupItem } from "./timeline/ToolGroupCard";
import s from "./PermissionRequest.module.scss";

interface PermissionRequestProps {
  request: PermissionRequestView;
  onRespond: (
    behavior: "allow" | "deny",
    opts?: {
      restOfTurn?: boolean;
      always?: boolean;
      /** Where the standing grant goes. Absent means LUNO's own storage. */
      alwaysScope?: GrantScope;
      /** Replaces the input the tool proposed. Filled for `AskUserQuestion`,
       *  whose answers ARE its input; and for an edited shell command. */
      updatedInput?: Record<string, unknown>;
      /** Deny only: what the user typed to do instead. */
      reason?: string;
    }
  ) => void;
}

// Unanchored, matching the host's own reading in `isDestructiveRequest`. It
// was `/^…/`, which misses `PowerShell` — the shell the CLI actually reaches
// for on Windows — so its command rendered as an anonymous input blob and
// could not be edited, while the host had already classified it as a shell.
const BASH_TOOLS = /(bash|shell|run|exec|terminal)/i;

/** How close to the deadline the auto-continue countdown becomes visible.
 *  20s is the reference client's own threshold, read out of claude 2.1.219.
 *  Earlier than that it is a clock ticking at someone who is reading. */
const COUNTDOWN_VISIBLE_MS = 20_000;

export function PermissionRequest({
  request,
  onRespond
}: PermissionRequestProps) {
  const allowRef = useRef<HTMLButtonElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  // A question, not a gate: the answers ARE the payload, so this card's
  // "allow" carries a rebuilt input rather than the one the tool proposed.
  const questions = useMemo(
    () =>
      request.toolName === "AskUserQuestion"
        ? readQuestions(request.input)
        : null,
    [request.toolName, request.input]
  );
  const [drafts, setDrafts] = useState<QuestionDraft[]>([]);
  const canSubmit = questions ? allAnswered(questions, drafts) : true;
  const submitAnswers = () => {
    if (!questions || !canSubmit) return;
    onRespond("allow", {
      updatedInput: buildUpdatedInput(request.input, questions, drafts)
    });
  };

  // Auto-continue. Only ever set when the user chose a "Question auto-continue
  // timeout" in their own Claude settings — unset is the CLI's default and
  // means the card waits, like every other permission prompt here.
  const deadlineMs = questions ? request.afkTimeoutMs : undefined;
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  // Held in a ref so the countdown effect does not restart every render: it
  // closes over `drafts`, which changes on every keystroke.
  const autoContinue = useRef<() => void>(() => {});
  useEffect(() => {
    autoContinue.current = () => {
      if (!questions) return;
      // Sent whether or not every question was answered — that is the point of
      // the deadline, and the CLI has a defined result for a partial one.
      onRespond("allow", {
        updatedInput: {
          ...buildUpdatedInput(request.input, questions, drafts),
          afkTimeoutMs: deadlineMs
        }
      });
    };
  });
  useEffect(() => {
    if (!deadlineMs) return;
    const endsAt = Date.now() + deadlineMs;
    const id = setInterval(() => {
      const left = endsAt - Date.now();
      if (left > 0) {
        setRemainingMs(left);
        return;
      }
      clearInterval(id);
      autoContinue.current();
    }, 1000);
    return () => clearInterval(id);
  }, [deadlineMs, request.requestId]);
  const countdown =
    remainingMs !== null && remainingMs <= COUNTDOWN_VISIBLE_MS
      ? Math.max(1, Math.ceil(remainingMs / 1000))
      : null;
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

  // A nearly-right command should be a one-character fix, not an all-or-nothing
  // refusal. `null` until touched, so an untouched card sends no `updatedInput`
  // and every existing path stays byte-identical.
  const [editedCommand, setEditedCommand] = useState<string | null>(null);
  const commandInput =
    editedCommand !== null && editedCommand !== command
      ? // `description` goes with it: the model wrote that label about the
        // command it proposed, and a live run showed an edited `rm -rf …`
        // still travelling as "Create probe-dir directory".
        { ...request.input, command: editedCommand, description: undefined }
      : undefined;
  // What the user typed to do instead of the call they are refusing.
  const [reason, setReason] = useState("");

  // Where an "Always" would be kept. Defaults to LUNO's own storage — the one
  // that keeps our destructive/network check on the path — so choosing nothing
  // is choosing the safer of the two kinds.
  const [scope, setScope] = useState<GrantScope>("luno");
  const scopeOptions = useMemo(
    () =>
      (request.grantScopes ?? ["luno"]).map((value) => ({
        value,
        label: SCOPE_LABEL[value],
        note: SCOPE_NOTE[value]
      })),
    [request.grantScopes]
  );

  const deny = () => {
    // Skipping a question is not refusing an action. Denying said "the user
    // does not want this performed, do not attempt an alternative", and a live
    // run showed exactly what that costs: the model concluded *"the question
    // was never shown"*. Allowing with no answers is the CLI's own way to say
    // it — its result for an empty `answers` is "The user did not answer the
    // questions", which is the truth and nothing more.
    if (questions) {
      onRespond("allow", {
        updatedInput: { ...request.input, answers: {} }
      });
      return;
    }
    onRespond("deny", reason.trim() ? { reason } : undefined);
  };
  const allow = (extra?: {
    restOfTurn?: boolean;
    always?: boolean;
    alwaysScope?: GrantScope;
  }) =>
    onRespond("allow", {
      ...extra,
      ...(commandInput && { updatedInput: commandInput })
    });

  // `sug`, not `s` — `s` is the style module in this file now.
  const canAllowTurn = request.suggestions?.some(
    (sug) => sug.type === "setMode" && typeof sug.mode === "string"
  );

  const title = questions
    ? "Needs your input"
    : describe(isEdit, isCommand, destructive, network, request.toolName);

  // Focus a button on mount so the scoped shortcuts work right away. For
  // destructive calls focus DENY so a reflexive Enter rejects. A question
  // focuses nothing: the first thing to do with it is read it, and stealing
  // focus to a Submit that is disabled anyway helps no one.
  useEffect(() => {
    if (questions) return;
    const target = destructive ? denyRef : allowRef;
    const id = requestAnimationFrame(() => target.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [request.requestId, destructive, questions]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      deny();
      return;
    }
    if (e.key === "Enter") {
      if (questions) {
        e.preventDefault();
        submitAnswers();
        return;
      }
      // Enter inside the reason field denies with what was typed — the field
      // exists to be acted on, and reaching for the mouse to confirm a
      // sentence you just finished is a step for nothing.
      if (reason.trim()) {
        e.preventDefault();
        deny();
        return;
      }
      if (destructive) return; // focused Deny handles Enter
      e.preventDefault();
      if (e.shiftKey && canAllowTurn) allow({ restOfTurn: true });
      else allow();
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
        {/* Which turn is asking. A background agent wanting to write a file
            reads exactly like the conversation on screen wanting to, and the
            two deserve different answers. */}
        {request.agentId && <span className={s.agentTag}>subagent</span>}
        <span className={s.toolTag}>{request.toolName}</span>
      </div>

      {/* Preview */}
      <div className={s.preview}>
        {questions ? (
          <QuestionRequest questions={questions} onChange={setDrafts} />
        ) : isEdit ? (
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
          <div className={s.commandWrap}>
            <span className={s.prompt} aria-hidden>
              ${" "}
            </span>
            {/* Editable, and the host re-classifies whatever comes back: an
                approval given for `ls` must not carry an edited `rm -rf`. */}
            <textarea
              className={s.command}
              value={editedCommand ?? command ?? ""}
              spellCheck={false}
              rows={Math.min(
                6,
                (editedCommand ?? command ?? "").split("\n").length
              )}
              aria-label="Command to run — editable"
              onChange={(e) => setEditedCommand(e.target.value)}
              // The card's own Enter would approve mid-word.
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>
        ) : (
          <InputSummary input={request.input} />
        )}
      </div>

      {/* What to do instead. Optional: empty keeps the standing refusal
          wording, which is what stops the model re-proposing the same call.
          Not offered on a question — there is nothing there to refuse. */}
      {!questions && (
        <div className={s.reasonRow}>
          <input
            type="text"
            className={s.reason}
            placeholder="Tell Claude what to do instead…"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-label="What to do instead"
          />
        </div>
      )}

      {/* Actions */}
      <div className={s.actions}>
        {/* A question has no "deny" in it — there is nothing to refuse. The
            way out is to leave it unanswered, which the CLI has a defined
            result for. Upstream spells this as the widget's close button;
            this card has no X, so it is a labelled Skip on the same path. */}
        {countdown !== null && (
          <span className={s.countdown} role="status">
            continuing in {countdown}s
          </span>
        )}
        <button ref={denyRef} type="button" onClick={deny} className={s.deny}>
          {questions ? "Skip" : "Deny"}
        </button>
        {questions && (
          <button
            type="button"
            onClick={submitAnswers}
            disabled={!canSubmit}
            className={s.allow}
          >
            Submit answers
          </button>
        )}
        {!questions && canAllowTurn && !destructive && (
          <button
            type="button"
            onClick={() => allow({ restOfTurn: true })}
            className={s.allowTurn}
          >
            Allow this turn
          </button>
        )}
        {/* The host decides whether a standing grant is on offer and how it
            reads. Absent means there is none: a destructive or network call,
            or a command with no single prefix that describes it. */}
        {request.grantLabel && (
          <div className={s.alwaysGroup}>
            <Tooltip label={alwaysHint(request.grantLabel, scope)}>
              <button
                type="button"
                onClick={() => allow({ always: true, alwaysScope: scope })}
                className={s.allowAlways}
              >
                Always
              </button>
            </Tooltip>
            {/* Only when there is a choice to make. One scope is not a picker,
                it is a control that cannot be operated. */}
            {scopeOptions.length > 1 && (
              <Dropdown
                options={scopeOptions}
                value={scope}
                onSelect={setScope}
                align="right"
                placement="above"
                ariaLabel="Where to store this permission"
                triggerClassName={s.scopeTrigger}
                trigger={({ open }) => (
                  <Icon name={open ? "chevronD" : "chevronU"} size={11} />
                )}
              />
            )}
          </div>
        )}
        {/* Said in words. An option that is simply not in the menu reads as an
            option nobody thought of, which is the opposite of what happened. */}
        {request.grantScopeReason && (
          <span className={s.scopeNote}>{request.grantScopeReason}</span>
        )}
        {!questions && (
          <button
            ref={allowRef}
            type="button"
            onClick={() => allow()}
            className={s.allow}
          >
            Allow
          </button>
        )}
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

/** How each storage choice reads in the picker. */
const SCOPE_LABEL: Record<GrantScope, string> = {
  luno: "In LUNO only",
  project: "This project, shared",
  local: "This project, just me",
  user: "Every project"
};

/** What choosing it actually means. The difference between the first and the
 *  rest is not where a line of JSON lands — it is whether LUNO's own
 *  destructive/network check still runs on the call. */
const SCOPE_NOTE: Record<GrantScope, string> = {
  luno: "LUNO keeps checking every call",
  project: ".claude/settings.json — committed",
  local: ".claude/settings.local.json — not committed",
  user: "~/.claude/settings.json"
};

/** The tooltip on Always, which has to say where it is about to put this. */
function alwaysHint(label: string, scope: GrantScope): string {
  if (scope === "luno") {
    return `Never ask about ${label} again. Kept in LUNO, which still checks every call for destructive or network access. Revoke from the shield in the header.`;
  }
  return `Never ask about ${label} again. Written to ${SCOPE_NOTE[scope]}, which the Claude CLI reads directly — it will stop asking LUNO about this call at all.`;
}
