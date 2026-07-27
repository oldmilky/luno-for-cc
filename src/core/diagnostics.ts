// ─────────────────────────────────────────────────────────────
// Formatting for the editor's Problems, on their way to the model.
//
// Pure so it can be tested without an editor: collection lives in
// `ui/domains/diagnostics.ts`, which is the half that needs vscode.
//
// The point of sending these at all is that the language servers have already
// done the work. Without them the agent shells out to `tsc` or `eslint` to
// rediscover what the IDE is displaying — slower, billed in tokens, and in
// watch mode it reads a stale build.
// ─────────────────────────────────────────────────────────────

export type DiagnosticSeverity = "error" | "warning";

export interface DiagnosticItem {
  /** Workspace-relative, forward slashes. */
  file: string;
  /** 1-based, as an editor shows them. */
  line: number;
  column: number;
  severity: DiagnosticSeverity;
  message: string;
  /** Rule or code the language server attached, when it did. */
  source?: string;
}

/** Errors before warnings, then by file and position, so a truncated list
 *  keeps what the user most likely cares about. */
export function sortDiagnostics(items: DiagnosticItem[]): DiagnosticItem[] {
  const rank = (s: DiagnosticSeverity) => (s === "error" ? 0 : 1);
  return [...items].sort(
    (a, b) =>
      rank(a.severity) - rank(b.severity) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.column - b.column
  );
}

/**
 * Render diagnostics as a system-prompt section, or null when there is nothing
 * worth saying.
 *
 * @param max hard cap on lines. A repository mid-refactor can report thousands,
 *   and the whole point is to spend fewer tokens than a compiler run would.
 */
export function formatDiagnostics(
  items: DiagnosticItem[],
  max = 40
): string | null {
  if (items.length === 0) return null;

  const sorted = sortDiagnostics(items);
  const shown = sorted.slice(0, max);
  const lines = shown.map((d) => {
    const where = `${d.file}:${d.line}:${d.column}`;
    const code = d.source ? ` [${d.source}]` : "";
    return `${where} ${d.severity}${code}: ${collapse(d.message)}`;
  });

  const errors = sorted.filter((d) => d.severity === "error").length;
  const omitted = sorted.length - shown.length;
  const tail =
    omitted > 0
      ? `\n\n${omitted} more not shown. Totals: ${errors} error(s), ${sorted.length - errors} warning(s).`
      : "";

  return `# Problems currently reported in the editor

These come from the language servers already running over this workspace, and
they reflect the files as saved. Read them before reaching for a compiler or
linter through the shell — that would rediscover the same thing more slowly.
They are the editor's view, not proof: a diagnostic can be stale for a file the
language server has not re-analysed yet.

${lines.join("\n")}${tail}`;
}

/** One line per diagnostic — multi-line messages from type checkers otherwise
 *  break the file:line:col shape the list is scanned by. */
function collapse(message: string): string {
  return message.replace(/\s*\r?\n\s*/g, " ").trim();
}
