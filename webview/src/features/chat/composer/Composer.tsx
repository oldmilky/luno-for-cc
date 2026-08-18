// ─────────────────────────────────────────────────────────────
// Composer — chat input. Uses a contenteditable RichEditor for
// inline rich content (no markdown markers visible to the user;
// code from Cmd+U lands as a styled, editable block). The mode
// picker, skills picker, and model picker live in the toolbar
// below.
// ─────────────────────────────────────────────────────────────

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import { AnimatePresence } from "framer-motion";
import { Icon } from "../../../design/icons";
import {
  Dropdown,
  RichEditor,
  Tooltip,
  makeMentionBadge,
  type CodeInsert,
  type RichEditorHandle
} from "../../../design/primitives";
import {
  send,
  newId,
  onMessage,
  PermissionMode,
  EffortLevel,
  ModelInfo,
  SkillInfo,
  SlashCommand,
  PendingSetting
} from "../../../lib/rpc";
import { useWebviewSettings } from "../../../lib/settings";
import { MODES, findMode } from "../constants";
import {
  MentionPopover,
  TERMINAL_PREFIX,
  type MentionPick
} from "./MentionPopover";
import { SlashPopover } from "./SlashPopover";
import { slashQuery } from "./slash-filter";
import {
  classifyAttachment,
  toAttachmentBlock,
  type AttachmentBlock,
  type AttachmentKind
} from "./attachments";
import { SkillsPicker } from "../pickers/SkillsPicker";
import { ModelPicker } from "../pickers/ModelPicker";
import { EffortPicker } from "../pickers/EffortPicker";
import { PendingDot } from "../timeline/PendingDot";
import { ImageLightbox } from "../modals/ImageLightbox";
import type { AgentPanel } from "../timeline/subagent-state";
import type { VoiceState } from "./voice-state";
import { DictationStrip } from "./DictationStrip";
import s from "./Composer.module.scss";

export interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  /** @param attachments files picked or pasted, already in the API's block
   *   shape. Empty for an ordinary message. */
  onSubmit: (text: string, attachments: AttachmentBlock[]) => void;
  onCancel: () => void;
  busy: boolean;
  model: string;
  /** alias → resolved concrete id for every picker entry (shown per-row so
   *  the user sees what each alias actually maps to). */
  resolvedModels?: Record<string, string>;
  permissionMode: PermissionMode;
  /** Reasoning effort + extended-thinking toggle, surfaced in the model
   *  picker. Optional so the inline edit composer (toolbar hidden) can omit
   *  them; they fall back to the same defaults as luno config. */
  effort?: EffortLevel;
  thinking?: boolean;
  /** The sixth effort choice — see ULTRACODE_OPTION. */
  ultracode?: boolean;
  models: ReadonlyArray<ModelInfo>;
  skills: ReadonlyArray<SkillInfo>;
  /** Controls whose value the running CLI has not been given yet — marked so
   *  the chip does not quietly claim a posture the session is not in. */
  pendingSettings?: ReadonlyArray<PendingSetting>;
  /** Modes the user's settings forbid — kept out of the picker entirely. */
  disabledModes?: ReadonlyArray<PermissionMode>;
  /**
   * This chat's own sent messages, oldest first — what ArrowUp walks back
   * through on an empty composer.
   *
   * Text only, and the user's only: recalling a prompt is re-sending it, so
   * anything the model said has no business in the list. Empty in inline edit
   * mode, where the box already holds the one message being changed.
   */
  history?: ReadonlyArray<string>;
  /** External signal (from Cmd+U etc.) to focus the editor. */
  focusKey: number;
  /** When set, splice this code block at the caret then call onInserted. */
  pendingInsert: CodeInsert | null;
  onInserted: () => void;
  /** Text handed back rather than sent — what the CLI still held when Stop
   *  interrupted it, or a prompt arriving from a `vscode://` link. Appended to
   *  whatever is already typed, then cleared via onRestored. */
  pendingRestore?: string | null;
  onRestored?: () => void;
  /** A suggestion card from the empty state. Goes in *front* of whatever is
   *  typed, unlike pendingRestore: the CLI expands `/name` only at the start of
   *  a message, so appending one would file a dead command. */
  pendingPrefill?: string | null;
  onPrefilled?: () => void;
  /** Background work this conversation has dispatched, for the toolbar's agents
   *  button. Absent where the host has none — the button does not exist until
   *  the first task. */
  agents?: AgentPanel;
  onOpenAgents?: () => void;
  /** Dictation, when there is any. Absent in the inline edit composer, which
   *  has no toolbar to put a microphone in. */
  voice?: VoiceState;
  onDismissVoiceError?: () => void;
  /** Compact in-message edit mode: hides the toolbar, swaps in a Cancel/Send footer. */
  inline?: boolean;
  /** Inline mode only — called when the user discards the edit. */
  onDiscard?: () => void;
}

interface MentionState {
  active: boolean;
  query: string;
}

/**
 * A file waiting above the composer.
 *
 * One shape for all four kinds rather than one per kind: the chip strip, the
 * remove button and the submit path treat them identically, and the only thing
 * that differs is what `toAttachmentBlock` makes of it at send time. `width`
 * and `height` are zero for everything that is not an image, which is what the
 * chip reads to decide whether it has dimensions to show.
 */
interface Attachment {
  id: string;
  name: string;
  kind: AttachmentKind;
  /** Bytes, as the file system reported them — shown on the chip so a 40 MB
   *  PDF is visible before it is sent rather than after. */
  size: number;
  dataUrl: string;
  width: number;
  height: number;
}

/** What each kind is called when the chip has to say it in words. `unsupported`
 *  never reaches a chip — it is reported separately — but the map is total so
 *  a new kind cannot be added without deciding its label. */
const KIND_LABEL: Record<AttachmentKind, string> = {
  image: "an image",
  pdf: "a PDF",
  text: "a text file",
  unsupported: "unsupported"
};

const KIND_ICON: Record<AttachmentKind, "image" | "file"> = {
  image: "image",
  pdf: "file",
  text: "file",
  unsupported: "file"
};

const NO_MENTION: MentionState = { active: false, query: "" };

/** A slash command is the whole message or nothing — the CLI only expands one
 *  at the very start — so unlike `@`, this token is anchored to offset 0. */
const NO_SLASH: MentionState = { active: false, query: "" };

export function Composer({
  value,
  onChange,
  onSubmit,
  onCancel,
  busy,
  model,
  resolvedModels = {},
  permissionMode,
  effort = "high",
  thinking = true,
  ultracode = false,
  models,
  skills,
  pendingSettings = [],
  disabledModes = [],
  history = [],
  focusKey,
  pendingInsert,
  onInserted,
  pendingRestore,
  onRestored,
  pendingPrefill,
  onPrefilled,
  agents,
  onOpenAgents,
  voice,
  onDismissVoiceError,
  inline = false,
  onDiscard
}: ComposerProps) {
  const editorRef = useRef<RichEditorHandle | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { useCtrlEnterToSend } = useWebviewSettings();
  const [focused, setFocused] = useState(false);
  const [mention, setMention] = useState<MentionState>(NO_MENTION);
  const [slash, setSlash] = useState<MentionState>(NO_SLASH);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [preview, setPreview] = useState<Attachment | null>(null);
  // The editor is mounted once with its persisted text; React shouldn't keep
  // re-pushing `value` into it (it owns its DOM after mount). We freeze the
  // initial value to avoid remount churn.
  const initialTextRef = useRef(value);

  // Latest-onDiscard ref so the inline-mode listeners below don't have
  // `onDiscard` as a useEffect dep — `onDiscard` is a fresh closure on
  // every parent (ChatScreen) render, and re-running the effect would
  // tear down/re-register listeners and re-focus the editor mid-keystroke,
  // racing the EditConfirmModal mount.
  const discardRef = useRef(onDiscard);
  useEffect(() => {
    discardRef.current = onDiscard;
  }, [onDiscard]);

  useEffect(() => {
    if (focusKey > 0) editorRef.current?.focus();
  }, [focusKey]);

  // A queue handed back lands *after* whatever has been typed since, because
  // the two were written in that order and neither may be dropped.
  useEffect(() => {
    if (!pendingRestore) return;
    const current = (editorRef.current?.serialize() ?? "").trim();
    editorRef.current?.setText(
      current ? `${current}\n\n${pendingRestore}` : pendingRestore
    );
    onRestored?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRestore]);

  useEffect(() => {
    if (!pendingPrefill) return;
    const current = (editorRef.current?.serialize() ?? "").trim();
    editorRef.current?.setText(
      current ? `${pendingPrefill.trimEnd()} ${current}` : pendingPrefill
    );
    editorRef.current?.focus();
    onPrefilled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPrefill]);

  // Inline edit mode: focus once on mount, then keep listeners alive for
  // the lifetime of the inline editor.
  //   • Esc          → discard
  //   • click outside → discard, EXCEPT clicks landing inside a modal/dialog
  //                     (the EditConfirmModal that opens on submit), so the
  //                     editor stays mounted while the user picks Revert /
  //                     Don't revert / Cancel on the modal.
  useEffect(() => {
    if (!inline) return;
    editorRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        discardRef.current?.();
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      const wrap = wrapperRef.current;
      if (!wrap) return;
      const target = e.target as Element | null;
      if (!target) return;
      if (wrap.contains(target)) return;
      if (target.closest('[role="dialog"]')) return;
      discardRef.current?.();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [inline]);

  // Detect a mention query by inspecting the current selection. The popover
  // tracks the trailing `@<query>` chunk just before the caret in plain text.
  const refreshMention = useCallback(() => {
    const sel = window.getSelection();
    const node = sel?.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE) {
      setMention(NO_MENTION);
      return;
    }
    const text = node.textContent ?? "";
    const offset = sel?.anchorOffset ?? 0;
    let i = offset - 1;
    while (i >= 0 && !/\s/.test(text[i])) i--;
    const tokenStart = i + 1;
    if (text[tokenStart] !== "@") {
      setMention(NO_MENTION);
      return;
    }
    const before = tokenStart === 0 ? " " : text[tokenStart - 1];
    if (!/\s/.test(before) && tokenStart !== 0) {
      setMention(NO_MENTION);
      return;
    }
    const query = text.slice(tokenStart + 1, offset);
    if (query.includes(" ")) {
      setMention(NO_MENTION);
      return;
    }
    setMention({ active: true, query });
  }, []);

  useEffect(() => {
    document.addEventListener("selectionchange", refreshMention);
    return () =>
      document.removeEventListener("selectionchange", refreshMention);
  }, [refreshMention]);

  // The list is the same for every conversation and changes only when the user
  // writes a command file, so it is fetched once per mount rather than on `/`.
  useEffect(() => {
    send({ type: "requestSlashCommands" });
    return onMessage((m) => {
      if (m.type === "slashCommands") setCommands(m.commands);
    });
  }, []);

  const refreshSlash = useCallback((text: string) => {
    const query = slashQuery(text);
    setSlash(query === null ? NO_SLASH : { active: true, query });
  }, []);

  const handleEditorChange = (text: string) => {
    // Typing ends the walk. What is in the box is the user's again, so the next
    // ArrowUp starts from the newest message rather than resuming a tour they
    // have already stepped off. The walk's own writes are exempt: they arrive
    // here too, through the editor's change event.
    if (!recallingRef.current) historyAt.current = null;
    onChange(text);
    refreshMention();
    refreshSlash(text);
  };

  /**
   * Walk back through this chat's own sent messages, terminal style.
   *
   * Gated on an empty composer, which is the whole reason it can be a bare
   * arrow key: with anything typed, ArrowUp is line navigation and stealing it
   * would break editing a multi-line prompt. Stepping forward past the newest
   * message empties the box again — the way out of the history is the same key
   * that got you in.
   */
  const historyAt = useRef<number | null>(null);
  /** True only while the walk is writing, so `handleEditorChange` can tell its
   *  own writes from the user's and leave the position alone. */
  const recallingRef = useRef(false);

  const recall = (index: number | null) => {
    const text = index === null ? "" : history[index];
    recallingRef.current = true;
    historyAt.current = index;
    editorRef.current?.setText(text);
    onChange(text);
    recallingRef.current = false;
    editorRef.current?.focus();
  };

  const handleEditorKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (inline || history.length === 0) return;
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    // A popover owns the arrows while it is open — it is choosing a row.
    if (mention.active || slash.active) return;

    const at = historyAt.current;
    if (e.key === "ArrowUp") {
      // The empty box gates *entering* the walk. Inside it the box is never
      // empty, so from then on the walk itself is the gate.
      if (at === null && (editorRef.current?.serialize() ?? "").trim() !== "") {
        return;
      }
      e.preventDefault();
      recall(Math.max(0, (at ?? history.length) - 1));
      return;
    }
    // Down does nothing outside the walk: there is nothing ahead of the newest
    // message, and the caret owns the key the rest of the time.
    if (at === null) return;
    e.preventDefault();
    recall(at + 1 > history.length - 1 ? null : at + 1);
  };

  const handleSubmit = () => {
    // Submitting mid-turn is deliberate, in both modes. Inline (edit) rewinds
    // and re-prompts; a normal send goes into the turn already running, which
    // picks it up at its next tool boundary. Neither needs the composer to
    // police it, and the `busy` gate that used to sit here swallowed every
    // follow-up typed while the model was still talking.
    const text = (editorRef.current?.serialize() ?? "").trim();
    // Blocks, not markdown in the prompt. A data URI written into the text is
    // a wall of base64 the model reads as characters; a block is the file
    // itself. The typed words go last, after what they are about — the
    // reference's order, and the one that reads correctly.
    const blocks = attachments
      .map((a) => toAttachmentBlock(a.name, a.dataUrl))
      .filter((b): b is AttachmentBlock => b !== null);
    if (!text && blocks.length === 0) return;
    onSubmit(text, blocks);
    // Don't clear in inline mode — the parent shows a confirmation modal,
    // and if the user cancels we want the text preserved so they can keep
    // editing without retyping.
    if (!inline) {
      editorRef.current?.clear();
      setAttachments([]);
      setRefused([]);
    }
    setMention(NO_MENTION);
  };

  const handleMentionPick = useCallback(
    (pick: MentionPick) => {
      // Replace the trailing `@<query>` token immediately before the caret
      // with an atomic mention pill carrying the full path on data-path.
      // Falls back to plain `@basename ` text when something about the
      // current selection prevents the in-place splice (e.g. caret outside
      // a text node).
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      editorRef.current?.recordUndoPoint();
      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      if (node.nodeType !== Node.TEXT_NODE) return;

      const text = node.textContent ?? "";
      const offset = range.startOffset;
      let i = offset - 1;
      while (i >= 0 && !/\s/.test(text[i])) i--;
      const tokenStart = i + 1;
      if (text[tokenStart] !== "@") return;

      const before = text.slice(0, tokenStart);
      const after = text.slice(offset);

      // Split the original text node into a leading text node, the pill,
      // and a trailing text node so the caret can land cleanly after.
      const parent = node.parentNode;
      if (!parent) return;
      node.textContent = before;
      const pill = makeMentionBadge(pick.path, pick.label, pick.token);
      parent.insertBefore(pill, node.nextSibling);
      const trailingSpace = document.createTextNode(" " + after);
      parent.insertBefore(trailingSpace, pill.nextSibling);

      // Caret right after the inserted space — ready for more typing.
      const r = document.createRange();
      r.setStart(trailingSpace, 1);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);

      setMention(NO_MENTION);
      onChange(editorRef.current?.serialize() ?? "");
    },
    [onChange]
  );

  /** Files that were picked and cannot be sent, by name. */
  const [refused, setRefused] = useState<string[]>([]);
  /** Lit while a file is over the panel. */
  const [dropping, setDropping] = useState(false);

  /** The window listener below needs the handler defined further down, and a
   *  `[]`-dep effect must not close over a stale one. */
  const dropRef = useRef<(dt: DataTransfer | null) => Promise<void>>(
    async () => {}
  );

  /**
   * The whole panel is the drop target, not just this box.
   *
   * Reported from the installed extension: dragging a file in did nothing. The
   * handlers were on the composer's own wrapper, which is a strip at the bottom
   * of a tall panel — a drop anywhere else met no `dragover` that accepted it,
   * so the browser refused the drag and no `drop` event ever fired. Nothing was
   * broken about the handling; there was simply almost nowhere to drop.
   *
   * Bound on `window` rather than by wrapping the app in a div: the composer
   * already owns the attachment state, and lifting that out to the shell would
   * move it away from everything that reads it.
   *
   * Gated on the drag actually carrying files. A drag of selected text inside
   * the chat is not an attachment, and claiming it would break selecting.
   */
  useEffect(() => {
    if (inline) return;
    const carriesFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onOver = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      // The one that matters: without a prevented `dragover` the drop is
      // rejected before any handler is consulted.
      e.preventDefault();
      setDropping(true);
    };
    const onLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDropping(false);
    };
    const onDropAnywhere = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      void dropRef.current(e.dataTransfer);
    };
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDropAnywhere);
    return () => {
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDropAnywhere);
    };
  }, [inline]);

  /**
   * Take files from wherever they came — the paperclip, Ctrl+V, a drop — and
   * hold them above the composer until the message goes.
   *
   * One path for all three sources on purpose: the picker was the third way in
   * and the other two already existed, so anything that only knew about one of
   * them would have been a third behaviour to keep in step.
   */
  const addFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    const read = await Promise.all(files.map(readAttachment));
    // Refused files are held rather than dropped: the reference logs them to a
    // console nobody opens, and a file that silently does not arrive is the
    // worst outcome available. What the panel does with them is the next step.
    setRefused((prev) => [
      ...prev,
      ...read.filter((a) => a.kind === "unsupported").map((a) => a.name)
    ]);
    const usable = read.filter((a) => a.kind !== "unsupported");
    if (usable.length > 0) setAttachments((prev) => [...prev, ...usable]);
  }, []);

  const canSend = value.trim().length > 0 || attachments.length > 0;
  const mode = findMode(permissionMode);

  const wrapperCls = [
    s.wrapper,
    inline && s.inline,
    focused && s.focused,
    busy && s.busy,
    dropping && s.dropping
  ]
    .filter(Boolean)
    .join(" ");

  /**
   * Drop handler: a file becomes an attachment, a path becomes a mention.
   *
   * Which one a drop is depends on what the agent can already reach. A path
   * means the file is on disk where the `Read` tool can open it on demand, and
   * a mention costs nothing until it does; an attachment spends the tokens up
   * front. So a drop that resolves to a path is mentioned, and a drop that does
   * not — a PDF from Downloads, a file dragged out of a browser — is attached,
   * which is the case that used to do nothing at all.
   *
   * **Images are the exception and always attach.** Dropping a picture is
   * asking someone to look at it; a path to it is the wrong answer even when
   * one exists.
   *
   * The reference does both to every drop — attach *and* mention. That sends a
   * workspace file twice, once as a whole text block and once as a pointer, and
   * the pointer alone was already enough.
   *
   * Paths are read in priority order:
   *   a) `text/uri-list` — the standard when dragging from Finder / Explorer /
   *      the VS Code tree.
   *   b) `application/vnd.code.uri-list` — VS Code's own format.
   *   c) `dataTransfer.files` — names only, when the host strips paths.
   */
  /**
   * Splice a mention pill at the current caret position.
   *
   * Splices a pill straight into the editor's DOM, so the editor is told to
   *  take an undo point first — it sees no input event for an edit made from
   *  out here. */
  const insertMentionAtCursor = (fullPath: string, basename: string) => {
    editorRef.current?.recordUndoPoint();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const pill = makeMentionBadge(fullPath, basename);
    range.insertNode(pill);
    const space = document.createTextNode(" ");
    pill.parentNode?.insertBefore(space, pill.nextSibling);
    const r = document.createRange();
    r.setStart(space, 1);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  };

  const handleDrop = async (dt: DataTransfer | null) => {
    setDropping(false);
    if (!dt) return;
    const dropped = Array.from(dt.files);

    const images = dropped.filter((f) => f.type.startsWith("image/"));
    if (images.length > 0) {
      await addFiles(images);
      return;
    }

    const paths = collectDroppedPaths(dt);
    if (paths.length > 0) {
      editorRef.current?.focus();
      for (const p of paths) {
        const basename = p.split("/").pop() || p;
        insertMentionAtCursor(p, basename);
      }
      onChange(editorRef.current?.serialize() ?? "");
      return;
    }

    // Nothing the agent can reach by path — a PDF from Downloads, a file
    // dragged out of a browser. Attaching is the only way it arrives, and
    // `addFiles` reports whatever it cannot take.
    await addFiles(dropped);
  };

  // Kept current for the window listener, which is registered once.
  useEffect(() => {
    dropRef.current = handleDrop;
  });

  /**
   * Replace the half-typed command with the one that was picked.
   *
   * Plain text, and a trailing space so arguments can be typed straight on:
   * the CLI reads `/name args` from the message itself, so anything richer
   * here would have to be flattened back to exactly this before sending.
   */
  const handleSlashPick = (command: SlashCommand) => {
    editorRef.current?.setText(`/${command.name} `);
    onChange(`/${command.name} `);
    setSlash(NO_SLASH);
    editorRef.current?.focus();
  };


  return (
    <div
      ref={wrapperRef}
      className={wrapperCls}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes("Files")) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={(e) => {
        // Only un-drop when leaving the wrapper itself (not a child).
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDropping(false);
      }}
      // Kept beside the window listener rather than replaced by it: a drop on
      // the composer itself must not depend on the effect having run.
      onDrop={(e) => {
        e.preventDefault();
        void handleDrop(e.dataTransfer);
      }}
    >
      <MentionPopover
        open={mention.active}
        query={mention.query}
        onPick={handleMentionPick}
        onClose={() => setMention(NO_MENTION)}
      />

      <SlashPopover
        open={slash.active && !mention.active}
        query={slash.query}
        commands={commands}
        onPick={handleSlashPick}
        onClose={() => setSlash(NO_SLASH)}
      />

      {dropping && (
        <div className={s.dropOverlay}>
          <div className={s.dropBadge}>
            <Icon name="attach" size={13} />
            Drop to attach
          </div>
        </div>
      )}

      {/* Said out loud, which the reference does not do: it drops an
          unsupported file with a `console.error` nobody opens. Naming the file
          and the reason is the difference between "Word documents are not
          supported" and a file that appears to have been attached and was
          not. */}
      {refused.length > 0 && (
        <div className={s.refused} role="status">
          <Icon name="info" size={12} />
          <span>
            {refused.join(", ")} — not supported. Images, PDFs and text files
            can be attached; Word, Excel and PowerPoint cannot.
          </span>
          <button
            type="button"
            className={s.refusedDismiss}
            onClick={() => setRefused([])}
            aria-label="Dismiss"
          >
            <Icon name="x" size={10} />
          </button>
        </div>
      )}

      {attachments.length > 0 && (
        <div className={s.attachments}>
          {attachments.map((a) => (
            <Tooltip
              key={a.id}
              label={
                a.kind === "image"
                  ? `Preview ${a.name}${a.width ? ` (${a.width}×${a.height})` : ""}`
                  : `${a.name} — sent as ${KIND_LABEL[a.kind]}`
              }
            >
              <button
                type="button"
                // Only an image has anything to preview. A PDF chip is a label,
                // and a button that opens an empty lightbox is worse than one
                // that does nothing.
                onClick={a.kind === "image" ? () => setPreview(a) : undefined}
                className={s.attachment}
              >
                <span className={s.attachmentIcon}>
                  <Icon name={KIND_ICON[a.kind]} size={12} />
                </span>
                <span className={s.attachmentName}>{a.name}</span>
                <span className={s.attachmentDims}>
                  {a.width > 0 ? `${a.width}×${a.height}` : formatBytes(a.size)}
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    setAttachments((prev) => prev.filter((x) => x.id !== a.id));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      setAttachments((prev) =>
                        prev.filter((x) => x.id !== a.id)
                      );
                    }
                  }}
                  aria-label={`Remove ${a.name}`}
                  className={s.attachmentRemove}
                >
                  <Icon name="x" size={10} />
                </span>
              </button>
            </Tooltip>
          ))}
        </div>
      )}

      <ImageLightbox
        open={preview !== null}
        name={preview?.name ?? ""}
        src={preview?.dataUrl}
        width={preview?.width}
        height={preview?.height}
        onClose={() => setPreview(null)}
      />

      <div
        className={`${s.editorArea}${voice && !inline ? ` ${s.editorAreaMic}` : ""}`}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      >
        <RichEditor
          ref={editorRef}
          initialText={initialTextRef.current}
          pendingInsert={pendingInsert}
          onInserted={onInserted}
          onChange={handleEditorChange}
          onSubmit={handleSubmit}
          useCtrlEnterToSend={useCtrlEnterToSend}
          onOpenBadge={(file, startLine, endLine) =>
            send({ type: "openFile", path: file, startLine, endLine })
          }
          onOpenMention={(path) => {
            // A terminal pill names no file. Clicking one used to ask the host
            // to open `terminal:bash` and get an error toast for it.
            if (path.startsWith(TERMINAL_PREFIX)) return;
            send({ type: "openFile", path });
          }}
          onImagePaste={addFiles}
          onKeyDown={handleEditorKeyDown}
        />
      </div>
      {/* Beside the microphone, and inside the input for the same reason: both
          controls put something *into* the message, so they belong where the
          message is rather than in the toolbar of settings below it.

          A hidden `<input type="file" multiple>` clicked from a button, which
          is what the reference client does too — a webview can open the OS
          picker itself, and routing it through the host would be a protocol
          hop for nothing. `value` is cleared on change so picking the same
          file twice in a row still fires. */}
      {!inline && (
        <>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className={s.fileInput}
            onChange={(e) => {
              void addFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
            tabIndex={-1}
            aria-hidden
          />
          <Tooltip label="Attach files — images, PDFs, text">
            <button
              type="button"
              className={s.attachBtn}
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach files"
            >
              <Icon name="attach" size={14} />
            </button>
          </Tooltip>
        </>
      )}
      {/* Inside the input, not in the toolbar below it: dictation fills this
          box, and the control that fills it belongs where the text goes.
          Listening turns it into a stop — one control, two states, so a
          recording can never be started twice or left with no way out. */}
      {voice && !inline && (
        <Tooltip
          label={voice.listening ? "Stop dictation" : "Dictate a message"}
        >
          <button
            type="button"
            className={`${s.micBtn}${
              voice.listening ? ` ${s.micBtnLive}` : ""
            }`}
            onClick={() => {
              if (voice.error) onDismissVoiceError?.();
              send({ type: voice.listening ? "voiceStop" : "voiceStart" });
            }}
            aria-label={voice.listening ? "Stop dictation" : "Dictate"}
            aria-pressed={voice.listening}
          >
            <Icon name={voice.listening ? "stop" : "mic"} size={14} />
          </button>
        </Tooltip>
      )}

      <AnimatePresence>
        {voice && (voice.listening || voice.error) && (
          <div className={s.dictation}>
            <DictationStrip
              listening={voice.listening}
              committed={voice.committed}
              interim={voice.interim}
              error={voice.error}
              language={voice.language}
              level={voice.level}
            />
          </div>
        )}
      </AnimatePresence>

      {inline ? null : (
        <div className={s.toolbar}>
          <Dropdown<PermissionMode>
            options={MODES.filter((m) => !disabledModes.includes(m.value)).map(
              (m) => ({
                value: m.value,
                label: m.label,
                note: m.note,
                icon: m.icon,
                // Bypass renders in `--err`, never the accent — the picker is
                // the last thing between a click and a mode with no approval
                // gate.
                danger: m.danger
              })
            )}
            value={permissionMode}
            onSelect={(v) => send({ type: "setPermissionMode", mode: v })}
            align="left"
            placement="above"
            ariaLabel="Permission mode"
            triggerClassName={`${s.modeBtn}${
              mode.danger ? ` ${s.modeBtnDanger}` : ""
            }`}
            trigger={() => (
              <>
                <Icon name={mode.icon} size={12} />
                <span>{mode.short}</span>
                {pendingSettings.includes("mode") && <PendingDot />}
                <Icon name="chevronD" size={9} />
              </>
            )}
          />

          <SkillsPicker
            skills={skills}
            pending={pendingSettings.includes("skills")}
          />

          <div className={s.divider} />

          <Tooltip label="Insert editor selection (⌘U)">
            <button
              type="button"
              className={s.selectionBtn}
              aria-label="Insert editor selection"
              onClick={() => send({ type: "captureSelection" })}
            >
              {/* Icon and chord, no word. The toolbar is the narrowest row in
                  the panel and this control is the least often reached; the
                  tooltip and the `aria-label` still say what it is. */}
              <Icon name="code" size={12} />
              <kbd className={s.kbd}>⌘U</kbd>
            </button>
          </Tooltip>

          {/* Only once something has been dispatched: a control for work that
              does not exist is noise in a panel this narrow. It stays for the
              rest of the conversation afterwards, so "what did that audit
              cost" is still answerable once it is over. */}
          {agents && agents.total > 0 && onOpenAgents && (
            <Tooltip
              label={
                agents.running > 0
                  ? `${agents.running} background agent${
                      agents.running === 1 ? "" : "s"
                    } running`
                  : "Background agents — all finished"
              }
            >
              <button
                type="button"
                className={`${s.agentsBtn}${
                  agents.running > 0 ? ` ${s.agentsBtnLive}` : ""
                }`}
                aria-label="Background agents"
                onClick={onOpenAgents}
              >
                <Icon name="layers" size={12} />
                {agents.running > 0 ? (
                  <span>{agents.running}</span>
                ) : (
                  <Icon name="check" size={11} />
                )}
              </button>
            </Tooltip>
          )}

          <div className={s.spacer} />

          {/* Left of the model, and its own control: how hard to work is a
              different question from which model answers, and the two were
              sharing one panel that had room for neither. */}
          <EffortPicker
            model={model}
            models={models}
            effort={effort}
            pending={
              pendingSettings.includes("effort") ||
              pendingSettings.includes("thinking")
            }
            ultracode={ultracode}
            onEffort={(level, ultra) =>
              send({ type: "setEffort", effort: level, ultracode: ultra })
            }
            thinking={thinking}
            onThinking={(on) => send({ type: "setThinking", thinking: on })}
          />

          <ModelPicker
            models={models}
            value={model}
            resolvedModels={resolvedModels}
            onSelect={(v) => send({ type: "setModel", model: v })}
            effort={effort}
            ultracode={ultracode}
            onEffort={(level, ultra) =>
              send({ type: "setEffort", effort: level, ultracode: ultra })
            }
          />

          {/* Both, mid-turn: stopping and adding to what is running are two
              different intentions, and typing a follow-up must not take the
              only way to stop off the screen. */}
          {busy && (
            <Tooltip label="Cancel">
              <button
                type="button"
                className={s.cancelBtn}
                onClick={onCancel}
                aria-label="Cancel"
              >
                <Icon name="stop" size={11} />
              </button>
            </Tooltip>
          )}
          {(!busy || canSend) && (
            <Tooltip
              icon="send"
              label={
                busy
                  ? "Add to this turn — sent as soon as it ends"
                  : canSend
                    ? "Send"
                    : "Nothing to send yet"
              }
              hint={canSend ? "↵" : "Type a message first"}
            >
              <button
                type="button"
                className={s.sendBtn}
                onClick={handleSubmit}
                disabled={!canSend}
                aria-label={busy ? "Add to this turn" : "Send"}
              >
                <Icon name="send" size={13} />
              </button>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Pull file paths out of a drop's DataTransfer in priority order:
 *   1. `text/uri-list` — standard, multi-line, `file://` URIs
 *   2. `application/vnd.code.uri-list` — VS Code's internal drag format
 *   3. `e.dataTransfer.files` — falls back to plain File names
 *
 * Returns a deduplicated, ordered list of file paths (workspace-relative
 * or absolute, however the OS handed them to us).
 */
/**
 * Read an image file into a data URL and probe its intrinsic dimensions.
 * Dimensions feed the attachment chip's "WxH" label so users can sanity-check
 * the image they're about to send without having to expand it. We swallow
 * dimension-probe failures (corrupt SVG, etc.) and fall back to zero — the
 * chip just hides the size line in that case.
 */
async function readAttachment(file: File): Promise<Attachment> {
  const dataUrl = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
  // `File.type` is empty for most source files — the browser names a media
  // type only for what it knows how to render — so the classifier is given the
  // name as well and reads whichever of the two answers.
  const kind = classifyAttachment(file.type, file.name);
  // Measured only for images, and only so the chip can say `1920×1080`. An
  // `Image` that never loads answers zero, which is the same answer a PDF
  // gives, so nothing has to branch twice.
  const dims =
    kind === "image"
      ? await new Promise<{ width: number; height: number }>((res) => {
          const img = new Image();
          img.onload = () =>
            res({ width: img.naturalWidth, height: img.naturalHeight });
          img.onerror = () => res({ width: 0, height: 0 });
          img.src = dataUrl;
        })
      : { width: 0, height: 0 };
  return {
    id: newId(),
    name: file.name,
    kind,
    size: file.size,
    dataUrl,
    ...dims
  };
}

/** `48 kB`, `2.4 MB` — one decimal past a megabyte and none below it, because
 *  `1.0 kB` is noise and `41.7 MB` is the number that stops someone sending a
 *  file they did not mean to. */
function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1000 * 1000) return `${Math.round(bytes / 1000)} kB`;
  return `${(bytes / 1000 / 1000).toFixed(1)} MB`;
}

function collectDroppedPaths(dt: DataTransfer): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const trimmed = s.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  };

  const decodeUri = (u: string): string => {
    try {
      const url = new URL(u);
      if (url.protocol !== "file:") return u;
      // `file:///Users/foo/bar` → `/Users/foo/bar`. decodeURIComponent
      // handles spaces (`%20`) and other escapes.
      return decodeURIComponent(url.pathname);
    } catch {
      return u;
    }
  };

  const uriList =
    dt.getData("text/uri-list") || dt.getData("application/vnd.code.uri-list");
  if (uriList) {
    for (const raw of uriList.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      push(decodeUri(line));
    }
  }

  if (out.length === 0) {
    for (const f of Array.from(dt.files)) {
      // Only a real path. A `File` in a webview usually exposes nothing but
      // `name`, and this used to fall back to that — which made every drop
      // "a path", including files with no path at all. A bare basename is a
      // mention that resolves to whatever the agent happens to find under that
      // name, or to nothing; the file's own bytes are the better answer, and
      // the caller attaches them when this comes back empty.
      const p = (f as File & { path?: string }).path;
      if (p) push(p);
    }
  }

  return out;
}
