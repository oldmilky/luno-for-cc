import * as vscode from "vscode";
import {
  TimelineEvent,
  PlanCommentMeta,
  PlanRevisionMeta,
  PlanTask
} from "../core/types.js";

/**
 * Mirrors plan_comment quotes and the active plan step into VS Code editor
 * decorations. Re-applies on every relevant timeline change and on active-
 * editor switch — so the Luno chat panel and the editor stay in sync.
 *
 * Two decoration types:
 *   - comment:  green underline + overview-ruler tick for any plan_comment
 *               whose `quote` matches a substring of the file's text.
 *   - active:   accent-colored block highlight for the active step's fileRef
 *               so the user immediately sees where the work is happening.
 */
export class PlanDecorationService {
  private commentDeco = vscode.window.createTextEditorDecorationType({
    backgroundColor: "rgba(16, 185, 129, 0.15)",
    borderColor: "#10b981",
    borderStyle: "solid",
    borderWidth: "0 0 1px 0",
    overviewRulerColor: "#10b981",
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    isWholeLine: false
  });

  private activeStepDeco = vscode.window.createTextEditorDecorationType({
    backgroundColor: "rgba(211, 115, 80, 0.12)",
    borderColor: "#d37350",
    borderStyle: "solid",
    borderWidth: "0 0 0 3px",
    isWholeLine: true,
    overviewRulerColor: "#d37350",
    overviewRulerLane: vscode.OverviewRulerLane.Left
  });

  constructor(private workspaceRoot?: string) {}

  setWorkspaceRoot(root: string | undefined): void {
    this.workspaceRoot = root;
  }

  /** Recompute decorations for every visible editor based on the current timeline. */
  syncFromTimeline(timeline: TimelineEvent[]): void {
    const latestRevision = lastRevision(timeline);
    const activeTask = latestRevision
      ? findActiveTask(latestRevision)
      : undefined;
    const liveComments = collectLiveComments(timeline);

    for (const editor of vscode.window.visibleTextEditors) {
      this.applyToEditor(editor, liveComments, latestRevision, activeTask);
    }
  }

  /** Re-apply decorations to a single editor (called on editor switch). */
  refreshEditor(editor: vscode.TextEditor, timeline: TimelineEvent[]): void {
    const latestRevision = lastRevision(timeline);
    const activeTask = latestRevision
      ? findActiveTask(latestRevision)
      : undefined;
    const liveComments = collectLiveComments(timeline);
    this.applyToEditor(editor, liveComments, latestRevision, activeTask);
  }

  private applyToEditor(
    editor: vscode.TextEditor,
    comments: PlanCommentMeta[],
    revision: PlanRevisionMeta | undefined,
    activeTask: PlanTask | undefined
  ) {
    const docPath = this.relPath(editor.document.uri);
    if (!docPath) {
      editor.setDecorations(this.commentDeco, []);
      editor.setDecorations(this.activeStepDeco, []);
      return;
    }

    // Comment ranges: search for each quote substring in the document text.
    const text = editor.document.getText();
    const commentRanges: vscode.DecorationOptions[] = [];
    for (const c of comments) {
      if (!c.quote || c.resolvedAt) continue;
      // Quotes typically come from the rendered plan body, not source code;
      // most won't match. That's fine — only the ones that do show up.
      const idx = text.indexOf(c.quote);
      if (idx === -1) continue;
      const start = editor.document.positionAt(idx);
      const end = editor.document.positionAt(idx + c.quote.length);
      commentRanges.push({
        range: new vscode.Range(start, end),
        hoverMessage: new vscode.MarkdownString(`💬 ${escapeMd(c.body)}`)
      });
    }
    editor.setDecorations(this.commentDeco, commentRanges);

    // Active-step decoration: any fileRef on the active task that lives in
    // this file.
    const activeRanges: vscode.DecorationOptions[] = [];
    if (activeTask?.fileRefs && revision) {
      for (const ref of activeTask.fileRefs) {
        if (ref.path !== docPath) continue;
        const startLine = Math.max(0, ref.startLine - 1);
        const endLine = Math.min(
          editor.document.lineCount - 1,
          ref.endLine - 1
        );
        if (endLine < startLine) continue;
        const range = new vscode.Range(
          new vscode.Position(startLine, 0),
          new vscode.Position(
            endLine,
            editor.document.lineAt(endLine).text.length
          )
        );
        activeRanges.push({
          range,
          hoverMessage: new vscode.MarkdownString(
            `▶️ **Active plan step:** ${escapeMd(activeTask.content)}`
          )
        });
      }
    }
    editor.setDecorations(this.activeStepDeco, activeRanges);
  }

  private relPath(uri: vscode.Uri): string | undefined {
    if (!this.workspaceRoot) return undefined;
    const rel = vscode.workspace.asRelativePath(uri, false);
    // asRelativePath returns the absolute path when the uri is outside the
    // workspace; treat that as "not in workspace, no decorations".
    if (rel.startsWith("/") || rel.includes(":\\")) return undefined;
    return rel;
  }

  dispose(): void {
    this.commentDeco.dispose();
    this.activeStepDeco.dispose();
  }
}

function lastRevision(timeline: TimelineEvent[]): PlanRevisionMeta | undefined {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i];
    if (e.kind === "plan_revision" && e.meta) {
      return e.meta as unknown as PlanRevisionMeta;
    }
  }
  return undefined;
}

function findActiveTask(rev: PlanRevisionMeta): PlanTask | undefined {
  if (!rev.tasks) return undefined;
  return (
    rev.tasks.find((t) => t.status === "in_progress") ??
    rev.tasks.find((t) => t.status === "pending")
  );
}

function collectLiveComments(timeline: TimelineEvent[]): PlanCommentMeta[] {
  const out: PlanCommentMeta[] = [];
  for (const e of timeline) {
    if (e.kind !== "plan_comment") continue;
    const meta = e.meta as PlanCommentMeta | undefined;
    if (!meta || meta.deleted) continue;
    out.push(meta);
  }
  return out;
}

function escapeMd(s: string): string {
  return s.replace(/[*_`[\]]/g, "\\$&");
}
