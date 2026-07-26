// ─────────────────────────────────────────────────────────────
// Which tool call means "snapshot this file before it changes".
//
// Small, and load-bearing: this decision is the difference between rewind
// restoring a file and rewind silently losing it. Get the tool name wrong and
// nothing errors — the file just is not in the checkpoint, and the user finds
// out when they try to undo.
//
// Pure on purpose. It was a private method on a class no test imports, which
// meant the tool-name list and the path extraction had never been exercised.
// ─────────────────────────────────────────────────────────────

/**
 * Tools that write to a path. Matched against a lowercased name, prefix-wise,
 * because the CLI has shipped several spellings over time and namespaced
 * variants (`mcp__x__write_file`) are not the concern here — those are matched
 * by the caller's own gate, not this one.
 *
 * `str_replace_editor` is Anthropic's older computer-use editor; `multiedit`
 * and `update` are legacy Claude Code names. Kept because a session restored
 * from an older history file still replays them.
 */
const WRITE_TOOL_PREFIX =
  /^(write|edit|multiedit|notebookedit|update|create|str_replace_editor)/;

/** The keys a write tool might use for its target path, in precedence order. */
const PATH_KEYS = ["path", "file_path", "filePath"] as const;

export interface ToolCallEvent {
  kind: string;
  /** JSON-encoded tool input. */
  body?: string;
  meta?: Record<string, unknown>;
}

/**
 * The path a write/edit tool is about to touch, or null when the event is not
 * one.
 *
 * Returns null rather than throwing on malformed input: the body is JSON from
 * a subprocess, and a parse failure must not take down the event listener that
 * the whole timeline flows through.
 */
export function fileTouchedByTool(e: ToolCallEvent): string | null {
  if (e.kind !== "tool_call") return null;

  let input: Record<string, unknown>;
  try {
    input = JSON.parse(e.body ?? "{}");
  } catch {
    return null;
  }
  if (!input || typeof input !== "object") return null;

  const name = String(e.meta?.name ?? "").toLowerCase();
  if (!WRITE_TOOL_PREFIX.test(name)) return null;

  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}
