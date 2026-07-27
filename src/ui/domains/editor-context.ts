// ─────────────────────────────────────────────────────────────
// Reading the editor for the turn about to run.
//
// Read fresh per turn rather than subscribed to: the selection changes on
// every cursor move, and nothing between turns would do anything with it.
// ─────────────────────────────────────────────────────────────

import * as vscode from "vscode";
import {
  formatEditorContext,
  truncateSelection,
  type EditorSnapshot
} from "../../core/editor-context.js";

/**
 * The active file and selection, as a system-prompt section.
 *
 * Scoped to `root` for the same reason diagnostics are: a conversation
 * isolated in a worktree would otherwise be told about a file in the main
 * checkout, whose path resolves to different content in the tree it works in.
 *
 * Returns null when the feature is off, no editor is focused, or the file
 * being edited is not part of this conversation's checkout.
 */
export function collectEditorContext(root: string | undefined): string | null {
  if (!root) return null;
  try {
    const on = vscode.workspace
      .getConfiguration("luno")
      .get<boolean>("sendEditorContext", true);
    if (!on) return null;

    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.uri.scheme !== "file") return null;

    const rel = relativeTo(root, ed.document.uri.fsPath);
    if (rel === null) return null;

    const snapshot: EditorSnapshot = {
      file: rel,
      language: ed.document.languageId
    };

    const sel = ed.selection;
    if (!sel.isEmpty) {
      const { text, truncated } = truncateSelection(ed.document.getText(sel));
      snapshot.selection = {
        startLine: sel.start.line + 1,
        endLine: sel.end.line + 1,
        text,
        truncated
      };
    }

    return formatEditorContext(snapshot);
  } catch {
    // Context for the model is worth nothing next to the turn itself.
    return null;
  }
}

/** Workspace-relative with forward slashes, or null for a file outside the
 *  checkout this conversation works in. */
function relativeTo(root: string, abs: string): string | null {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const r = norm(root);
  const a = norm(abs);
  if (a === r) return null;
  if (!a.toLowerCase().startsWith(r.toLowerCase() + "/")) return null;
  return a.slice(r.length + 1);
}
