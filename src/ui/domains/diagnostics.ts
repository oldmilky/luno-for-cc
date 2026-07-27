// ─────────────────────────────────────────────────────────────
// The editor's Problems, collected for the turn about to run.
//
// Read fresh each turn rather than subscribed to: `onDidChangeDiagnostics`
// fires constantly while the user types, and nothing between turns would do
// anything with the result.
// ─────────────────────────────────────────────────────────────

import * as vscode from "vscode";
import {
  formatDiagnostics,
  type DiagnosticItem
} from "../../core/diagnostics.js";

/**
 * Diagnostics for files under `root`, as a system-prompt section.
 *
 * Scoped to the conversation's own checkout: an isolated chat working in a
 * worktree would otherwise be handed errors from files it cannot see, which
 * reads to the agent as breakage it caused.
 *
 * Returns null when the feature is off, nothing is wrong, or no folder is open.
 */
export function collectDiagnostics(root: string | undefined): string | null {
  if (!root) return null;
  try {
    const on = vscode.workspace
      .getConfiguration("luno")
      .get<boolean>("sendDiagnostics", true);
    if (!on) return null;

    const items: DiagnosticItem[] = [];
    for (const [uri, list] of vscode.languages.getDiagnostics()) {
      if (uri.scheme !== "file") continue;
      const rel = relativeTo(root, uri.fsPath);
      if (rel === null) continue;
      for (const d of list) {
        const severity = severityOf(d.severity);
        if (!severity) continue;
        items.push({
          file: rel,
          // VS Code positions are 0-based; every editor UI shows them 1-based,
          // and so does every compiler the agent might otherwise run.
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
          severity,
          message: d.message,
          source: codeOf(d)
        });
      }
    }

    return formatDiagnostics(items);
  } catch {
    // Extra context for the model is worth nothing next to the turn itself:
    // whatever the editor did here, the prompt still has to go out.
    return null;
  }
}

function severityOf(
  s: vscode.DiagnosticSeverity
): "error" | "warning" | undefined {
  if (s === vscode.DiagnosticSeverity.Error) return "error";
  if (s === vscode.DiagnosticSeverity.Warning) return "warning";
  // Information and Hint are editor affordances — spelling nits, "did you
  // mean" prompts — not things the agent should act on.
  return undefined;
}

/** `eslint(no-unused-vars)` or `ts(2304)`, whichever the server supplied. */
function codeOf(d: vscode.Diagnostic): string | undefined {
  const code =
    typeof d.code === "object" && d.code !== null
      ? String((d.code as { value?: unknown }).value ?? "")
      : d.code !== undefined
        ? String(d.code)
        : "";
  if (d.source && code) return `${d.source}(${code})`;
  return d.source || code || undefined;
}

/** Workspace-relative with forward slashes, or null when the file sits outside
 *  the checkout this conversation works in. */
function relativeTo(root: string, abs: string): string | null {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const r = norm(root);
  const a = norm(abs);
  if (a === r) return null;
  if (!a.toLowerCase().startsWith(r.toLowerCase() + "/")) return null;
  return a.slice(r.length + 1);
}
