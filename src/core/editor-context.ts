// ─────────────────────────────────────────────────────────────
// What the user is looking at, on its way to the model.
//
// Pure so it can be tested without an editor; the reading half lives in
// `ui/domains/editor-context.ts`.
//
// The gap this closes: until now the model learned about a selection only when
// the user pressed Ctrl+U to paste it in. "Why does this crash?" with a line
// highlighted was a question with no subject — the agent had to guess which
// file, or ask.
// ─────────────────────────────────────────────────────────────

export interface EditorSnapshot {
  /** Workspace-relative path of the file in front of the user. */
  file: string;
  language: string;
  /** The highlighted text, when there is a selection. */
  selection?: {
    startLine: number;
    endLine: number;
    text: string;
    /** True when `text` was cut to fit — the model must not read it as the
     *  whole of what the user highlighted. */
    truncated: boolean;
  };
}

/** Selection text beyond this is summarised rather than sent. A deliberate
 *  cap: this rides on *every* turn, and a whole file highlighted by Ctrl+A
 *  would otherwise be re-sent with each message. */
export const MAX_SELECTION_CHARS = 6000;

export function truncateSelection(text: string): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= MAX_SELECTION_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_SELECTION_CHARS), truncated: true };
}

/**
 * Render the snapshot as a system-prompt section, or null when there is
 * nothing to say.
 *
 * Phrased as context rather than instruction on purpose. The user's message is
 * the request; this only says what they are looking at while making it, and an
 * agent that treats an open file as a command starts editing files nobody
 * asked it to touch.
 */
export function formatEditorContext(
  snapshot: EditorSnapshot | null
): string | null {
  if (!snapshot) return null;

  const lines = [
    "# What the user is looking at",
    "",
    "This is the state of their editor as they sent the message — context, not",
    'an instruction. Act on it only when the message refers to it ("this",',
    '"here", "the selection", or a question with no other subject).',
    "",
    `Active file: ${snapshot.file}${snapshot.language ? ` (${snapshot.language})` : ""}`
  ];

  if (snapshot.selection) {
    const { startLine, endLine, text, truncated } = snapshot.selection;
    const span =
      startLine === endLine
        ? `line ${startLine}`
        : `lines ${startLine}-${endLine}`;
    lines.push(
      "",
      `Selected ${span}${truncated ? " (truncated)" : ""}:`,
      "",
      "```" + (snapshot.language || ""),
      text,
      "```"
    );
  } else {
    lines.push("", "No selection.");
  }

  return lines.join("\n");
}
