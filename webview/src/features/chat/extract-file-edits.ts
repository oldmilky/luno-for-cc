// ─────────────────────────────────────────────────────────────
// extract-file-edits — pull a FileEditEntry[] out of the tool
// calls inside a turn. Aggregates multiple Write/Edit calls to
// the same path into one entry so the summary card shows one row
// per file. Defensive: skips entries whose JSON we can't parse.
// ─────────────────────────────────────────────────────────────

import type { ToolGroupItem } from "./ToolGroupCard";
import type { FileChange, FileEditEntry } from "./FileDiffModal";

const WRITE_NAMES = /^(write|create|fs_write|str_replace_editor)/i;
const EDIT_NAMES = /^(edit|multiedit|update|patch|replace)/i;

interface RawInput {
  path?: unknown;
  file_path?: unknown;
  filePath?: unknown;
  target_file?: unknown;
  content?: unknown;
  text?: unknown;
  new_str?: unknown;
  new_string?: unknown;
  newString?: unknown;
  old_str?: unknown;
  old_string?: unknown;
  oldString?: unknown;
  edits?: unknown;
}

function readPath(o: RawInput): string {
  return String(
    o.path ?? o.file_path ?? o.filePath ?? o.target_file ?? ""
  );
}

function readString(...vals: unknown[]): string {
  for (const v of vals) if (typeof v === "string") return v;
  return "";
}

function classify(name: string): "write" | "edit" | null {
  if (WRITE_NAMES.test(name)) return "write";
  if (EDIT_NAMES.test(name)) return "edit";
  return null;
}

/**
 * Extract a single tool call's change(s). Returns the file path + list of
 * FileChange entries (a single multiedit becomes multiple FileChange items).
 */
function extractOne(item: ToolGroupItem): {
  path: string;
  kind: "write" | "edit";
  changes: FileChange[];
} | null {
  const kind = classify(item.name);
  if (!kind) return null;
  let parsed: RawInput;
  try {
    parsed = JSON.parse(item.input) as RawInput;
  } catch {
    return null;
  }
  const path = readPath(parsed);
  if (!path) return null;

  if (kind === "write") {
    const text = readString(parsed.content, parsed.text, parsed.new_str, parsed.new_string);
    if (!text && text !== "") return { path, kind, changes: [] };
    return { path, kind, changes: [{ kind: "write", newText: text }] };
  }

  // edit / multiedit — try MultiEdit's `edits` array first
  if (Array.isArray(parsed.edits)) {
    const changes: FileChange[] = [];
    for (const e of parsed.edits as Array<Record<string, unknown>>) {
      const oldText = readString(e.old_string, e.oldString, e.old_str);
      const newText = readString(e.new_string, e.newString, e.new_str);
      if (oldText || newText) changes.push({ kind: "edit", oldText, newText });
    }
    return { path, kind, changes };
  }

  const oldText = readString(parsed.old_string, parsed.oldString, parsed.old_str);
  const newText = readString(parsed.new_string, parsed.newString, parsed.new_str);
  return { path, kind, changes: [{ kind: "edit", oldText, newText }] };
}

/** Aggregate file edits across an entire turn into one entry per path. */
export function extractFileEdits(items: ReadonlyArray<ToolGroupItem>): FileEditEntry[] {
  const map = new Map<string, FileEditEntry>();
  for (const it of items) {
    const x = extractOne(it);
    if (!x) continue;
    const itemPending = it.result === undefined && !it.isError;
    const existing = map.get(x.path);
    if (existing) {
      existing.changes.push(...x.changes);
      // upgrade label if a Write happens after an Edit
      if (x.kind === "write") existing.action = "Wrote";
      existing.pending = existing.pending || itemPending;
      existing.errored = existing.errored || !!it.isError;
    } else {
      map.set(x.path, {
        id: `fe-${x.path}-${it.id}`,
        path: x.path,
        action: x.kind === "write" ? "Wrote" : "Edited",
        changes: [...x.changes],
        pending: itemPending,
        errored: !!it.isError
      });
    }
  }
  return Array.from(map.values());
}
