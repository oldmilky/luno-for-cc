// ─────────────────────────────────────────────────────────────
// Composer — chat input. Uses a contenteditable RichEditor for
// inline rich content (no markdown markers visible to the user;
// code from Cmd+U lands as a styled, editable block). The mode
// picker, skills picker, and model picker live in the toolbar
// below.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { Icon } from "../../design/icons";
import {
  Dropdown,
  RichEditor,
  Tooltip,
  makeMentionBadge,
  type CodeInsert,
  type RichEditorHandle
} from "../../design/primitives";
import {
  send,
  newId,
  onMessage,
  PermissionMode,
  EffortLevel,
  ModelInfo,
  SkillInfo,
  SlashCommand
} from "../../lib/rpc";
import { useWebviewSettings } from "../../lib/settings";
import { MODES, findMode } from "./constants";
import {
  MentionPopover,
  TERMINAL_PREFIX,
  type MentionPick
} from "./MentionPopover";
import { SlashPopover } from "./SlashPopover";
import { slashQuery } from "./slash-filter";
import { SkillsPicker } from "./SkillsPicker";
import { ModelPicker } from "./ModelPicker";
import { EffortPicker } from "./EffortPicker";
import { ImageLightbox } from "./ImageLightbox";
import s from "./Composer.module.scss";

export interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (text: string) => void;
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
  /** Compact in-message edit mode: hides the toolbar, swaps in a Cancel/Send footer. */
  inline?: boolean;
  /** Inline mode only — called when the user discards the edit. */
  onDiscard?: () => void;
}

interface MentionState {
  active: boolean;
  query: string;
}

interface ImageAttachment {
  id: string;
  name: string;
  dataUrl: string;
  width: number;
  height: number;
}

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
  focusKey,
  pendingInsert,
  onInserted,
  pendingRestore,
  onRestored,
  inline = false,
  onDiscard
}: ComposerProps) {
  const editorRef = useRef<RichEditorHandle | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const { useCtrlEnterToSend } = useWebviewSettings();
  const [focused, setFocused] = useState(false);
  const [mention, setMention] = useState<MentionState>(NO_MENTION);
  const [slash, setSlash] = useState<MentionState>(NO_SLASH);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [preview, setPreview] = useState<ImageAttachment | null>(null);
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
    onChange(text);
    refreshMention();
    refreshSlash(text);
  };

  const handleSubmit = () => {
    // Submitting mid-turn is deliberate, in both modes. Inline (edit) rewinds
    // and re-prompts; a normal send goes into the turn already running, which
    // picks it up at its next tool boundary. Neither needs the composer to
    // police it, and the `busy` gate that used to sit here swallowed every
    // follow-up typed while the model was still talking.
    const text = (editorRef.current?.serialize() ?? "").trim();
    const imageMd = attachments
      .map((a) => `![${a.name}](${a.dataUrl})`)
      .join("\n");
    const combined = [imageMd, text].filter(Boolean).join("\n\n");
    if (!combined) return;
    onSubmit(combined);
    // Don't clear in inline mode — the parent shows a confirmation modal,
    // and if the user cancels we want the text preserved so they can keep
    // editing without retyping.
    if (!inline) {
      editorRef.current?.clear();
      setAttachments([]);
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

  const addImageAttachments = useCallback(async (files: File[]) => {
    const added = await Promise.all(files.map(readImageAttachment));
    setAttachments((prev) => [...prev, ...added]);
  }, []);

  const canSend = value.trim().length > 0 || attachments.length > 0;
  const mode = findMode(permissionMode);
  const [dropping, setDropping] = useState(false);

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
   * Drop handler for both images and file paths.
   *
   * 1. If the DataTransfer carries any image file → embed it as a markdown
   *    image (`![name](data:…)`). Lets users drop a screenshot in.
   *
   * 2. Otherwise we look for file references in priority order:
   *    a) `text/uri-list` (the standard MIME type when dragging files from
   *       OS file managers like Finder / Explorer / VS Code's tree view).
   *    b) `application/vnd.code.uri-list` (VS Code's own drag format).
   *    c) `e.dataTransfer.files` — name only when the host strips paths.
   *
   *    Each resolved path becomes a `re-mention` pill. The same path
   *    serializes to `@basename` so the agent picks it up normally.
   */
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDropping(false);
    const dt = e.dataTransfer;

    // 1) Image attach — collect every image file and show them as
    // thumbnails above the editor. They're injected as markdown into the
    // outgoing message at submit time, so the agent still receives the
    // image data, but the editor itself stays clean (no giant data: URL
    // pasted into the text).
    const images = Array.from(dt.files).filter((f) =>
      f.type.startsWith("image/")
    );
    if (images.length > 0) {
      await addImageAttachments(images);
      return;
    }

    // 2) Files-as-mentions
    const paths = collectDroppedPaths(dt);
    if (paths.length === 0) return;
    editorRef.current?.focus();
    for (const p of paths) {
      const basename = p.split("/").pop() || p;
      insertMentionAtCursor(p, basename);
    }
    onChange(editorRef.current?.serialize() ?? "");
  };

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

  /** Splice a mention pill at the current caret position. */
  const insertMentionAtCursor = (fullPath: string, basename: string) => {
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
      onDrop={handleDrop}
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

      {attachments.length > 0 && (
        <div className={s.attachments}>
          {attachments.map((a) => (
            <Tooltip
              key={a.id}
              label={`Preview ${a.name}${a.width ? ` (${a.width}×${a.height})` : ""}`}
            >
              <button
                type="button"
                onClick={() => setPreview(a)}
                className={s.attachment}
              >
                <span className={s.attachmentIcon}>
                  <Icon name="file" size={12} />
                </span>
                <span className={s.attachmentName}>{a.name}</span>
                {a.width > 0 && (
                  <span className={s.attachmentDims}>
                    {a.width}×{a.height}
                  </span>
                )}
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

      <AnimatePresence>
        {preview && (
          <ImageLightbox
            name={preview.name}
            src={preview.dataUrl}
            width={preview.width}
            height={preview.height}
            onClose={() => setPreview(null)}
          />
        )}
      </AnimatePresence>

      <div
        className={s.editorArea}
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
          onImagePaste={addImageAttachments}
        />
      </div>

      {inline ? null : (
        <div className={s.toolbar}>
          <Dropdown<PermissionMode>
            options={MODES.map((m) => ({
              value: m.value,
              label: m.label,
              note: m.note,
              icon: m.icon,
              // Bypass renders in `--err`, never the accent — the picker is the
              // last thing between a click and a mode with no approval gate.
              danger: m.danger
            }))}
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
                <Icon name="chevronD" size={9} />
              </>
            )}
          />

          <SkillsPicker skills={skills} />

          <div className={s.divider} />

          <Tooltip label="Insert editor selection (⌘U)">
            <button
              type="button"
              className={s.selectionBtn}
              aria-label="Insert editor selection"
              onClick={() => send({ type: "captureSelection" })}
            >
              <Icon name="code" size={12} />
              <span>Selection</span>
              <kbd className={s.kbd}>⌘U</kbd>
            </button>
          </Tooltip>

          <div className={s.spacer} />

          {/* Left of the model, and its own control: how hard to work is a
              different question from which model answers, and the two were
              sharing one panel that had room for neither. */}
          <EffortPicker
            model={model}
            models={models}
            effort={effort}
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
async function readImageAttachment(file: File): Promise<ImageAttachment> {
  const dataUrl = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
  const dims = await new Promise<{ width: number; height: number }>((res) => {
    const img = new Image();
    img.onload = () =>
      res({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => res({ width: 0, height: 0 });
    img.src = dataUrl;
  });
  return { id: newId(), name: file.name, dataUrl, ...dims };
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
      // Webview File objects often only expose `name`. We still pass that
      // along — the agent's file resolver can match by basename.
      const p = (f as File & { path?: string }).path || f.name;
      push(p);
    }
  }

  return out;
}
