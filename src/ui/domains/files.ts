// ─────────────────────────────────────────────────────────────
// Files and the editor's own state: opening, reverting, searching,
// hydrating attachments, and reporting what the user is looking at.
//
// Everything here takes `post`; only `revertFile` needs anything else, and it
// takes the checkpoint service rather than the provider that owns it.
//
// `wireEditorContext` deliberately stayed on the provider: subscribing to
// editor changes also refreshes plan decorations against the session timeline,
// which is provider state. Only the broadcast moved.
// ─────────────────────────────────────────────────────────────

import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CheckpointService } from "../../services/checkpoint.js";
import type { Post } from "../messages.js";

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif"
};

/** Absolute on either platform — `/usr/x` or `C:\x`. */
function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Reveal a file in the editor. Takes an absolute path or one relative to the
 * workspace root. With a line range, the editor scrolls to it and selects the
 * span; without, it just opens.
 */
export async function openFile(
  post: Post,
  pathOrRel: string,
  startLine: number,
  endLine: number
): Promise<void> {
  let target: vscode.Uri;
  if (isAbsolutePath(pathOrRel)) {
    target = vscode.Uri.file(pathOrRel);
  } else {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      post({ type: "error", message: "Open a workspace folder first." });
      return;
    }
    target = vscode.Uri.joinPath(root, pathOrRel);
  }

  try {
    const doc = await vscode.workspace.openTextDocument(target);
    const options: vscode.TextDocumentShowOptions = { preview: false };
    if (startLine > 0) {
      options.selection = spanFor(doc, startLine, endLine || startLine);
    }
    await vscode.window.showTextDocument(doc, options);
  } catch (err) {
    post({
      type: "error",
      message: `Could not open ${pathOrRel}: ${why(err)}`
    });
  }
}

/**
 * Jump to a file range cited by a plan step.
 *
 * Near-identical to `openFile`, and deliberately still separate: this one
 * refuses absolute paths, always selects a range, and says "to navigate plan
 * steps" when there is no workspace. Merging the two would be a behaviour
 * change wearing a refactor's clothes — worth doing, worth doing on purpose.
 */
export async function openPlanFileRef(
  post: Post,
  relPath: string,
  startLine: number,
  endLine: number
): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    post({
      type: "error",
      message: "Open a workspace folder to navigate plan steps."
    });
    return;
  }

  try {
    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(root, relPath)
    );
    await vscode.window.showTextDocument(doc, {
      selection: spanFor(doc, startLine, endLine),
      preview: false
    });
  } catch (err) {
    post({ type: "error", message: `Could not open ${relPath}: ${why(err)}` });
  }
}

/** A 1-based line range clamped to what the document actually has. */
function spanFor(
  doc: vscode.TextDocument,
  startLine: number,
  endLine: number
): vscode.Range {
  const start = new vscode.Position(Math.max(0, startLine - 1), 0);
  const endIdx = Math.max(start.line, endLine - 1);
  const lineLen = doc.lineAt(Math.min(endIdx, doc.lineCount - 1)).text.length;
  return new vscode.Range(start, new vscode.Position(endIdx, lineLen));
}

/**
 * Roll one file back to its pre-turn snapshot.
 *
 * The disk write is only half the job: an editor already showing the file
 * keeps its stale buffer, so the user sees nothing happen. Hence the second
 * pass — close the tab for a file the snapshot says should not exist,
 * otherwise force the buffer to re-read from disk. Unsaved edits are dropped
 * on purpose; they were the agent's own writes.
 */
export async function revertFile(
  post: Post,
  checkpoints: CheckpointService | undefined,
  pathOrRel: string
): Promise<void> {
  if (!checkpoints) {
    post({
      type: "revertResult",
      path: pathOrRel,
      ok: false,
      error:
        "Checkpoints aren't initialized yet — run at least one prompt first."
    });
    return;
  }

  try {
    const result = await checkpoints.restoreFile(pathOrRel);
    if (!result) {
      post({
        type: "revertResult",
        path: pathOrRel,
        ok: false,
        error:
          "No prior snapshot for this file (the agent created it before checkpointing started, or it's outside the workspace)."
      });
      return;
    }

    try {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      const uri = isAbsolutePath(pathOrRel)
        ? vscode.Uri.file(pathOrRel)
        : root
          ? vscode.Uri.joinPath(root, pathOrRel)
          : null;
      if (uri) {
        if (result.deleted) {
          await vscode.commands.executeCommand(
            "vscode.removeFromRecentlyOpened",
            uri
          );
        } else {
          await vscode.window.showTextDocument(uri, {
            preview: false,
            preserveFocus: false
          });
          await vscode.commands.executeCommand("workbench.action.files.revert");
        }
      }
    } catch {
      // best-effort refresh; failure here does not change the revert outcome
    }

    post({ type: "revertResult", path: pathOrRel, ok: true });
  } catch (err) {
    post({
      type: "revertResult",
      path: pathOrRel,
      ok: false,
      error: why(err)
    });
  }
}

/** Filename matches for the composer's `@` mention popover. */
export async function searchFiles(
  post: Post,
  query: string,
  id: string
): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) {
    post({ type: "fileSearchResults", id, results: [] });
    return;
  }

  const glob = query ? `**/*${escapeGlob(query)}*` : "**/*";
  const found = await vscode.workspace.findFiles(
    new vscode.RelativePattern(root, glob),
    "**/{node_modules,.git,dist,build,out,.next,.venv,__pycache__}/**",
    40
  );

  const q = query.toLowerCase();
  const results = found
    .map((u) => ({
      path: vscode.workspace.asRelativePath(u),
      name: u.path.split("/").pop() ?? ""
    }))
    // A prefix match beats a substring match beats the rest; ties go
    // alphabetically. Typing "pan" should surface panel.ts, not
    // company-panel-legacy.ts.
    .sort((a, b) => {
      const an = a.name.toLowerCase();
      const bn = b.name.toLowerCase();
      if (q) {
        const aRank = an.startsWith(q) ? 0 : an.includes(q) ? 1 : 2;
        const bRank = bn.startsWith(q) ? 0 : bn.includes(q) ? 1 : 2;
        if (aRank !== bRank) return aRank - bRank;
      }
      return a.path.localeCompare(b.path);
    })
    .slice(0, 12);

  post({ type: "fileSearchResults", id, results });
}

function escapeGlob(s: string): string {
  return s.replace(/[[\]{}*?!()]/g, "\\$&");
}

/**
 * Hydrate an attachment back into a data URL for the webview.
 *
 * The wire format stores a relative path, not the bytes, so a past message
 * showing the image it was sent with has to ask for it. The path is confined
 * to the workspace: it arrives from a webview message, and `path.resolve`
 * happily walks out of the root on `..`.
 */
export async function readAttachment(
  post: Post,
  id: string,
  attachmentPath: string
): Promise<void> {
  const fail = (error: string) =>
    post({ type: "attachmentData", id, path: attachmentPath, error });

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return fail("No workspace open.");

  const abs = path.resolve(root, attachmentPath);
  if (!abs.startsWith(root + path.sep) && abs !== root) {
    return fail("Attachment path is outside the workspace.");
  }

  try {
    const buffer = await fs.promises.readFile(abs);
    const ext = path.extname(abs).slice(1).toLowerCase();
    const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
    post({
      type: "attachmentData",
      id,
      path: attachmentPath,
      dataUrl: `data:${mime};base64,${buffer.toString("base64")}`
    });
  } catch (err) {
    fail(why(err));
  }
}

/** What the user is currently looking at — file, language, selected range. */
export function broadcastEditorContext(post: Post): void {
  const ed = vscode.window.activeTextEditor;
  if (!ed) {
    post({ type: "editorContext", context: null });
    return;
  }

  const sel = ed.selection;
  post({
    type: "editorContext",
    context: {
      file: vscode.workspace.asRelativePath(ed.document.uri),
      language: ed.document.languageId,
      selection: sel.isEmpty
        ? null
        : { startLine: sel.start.line + 1, endLine: sel.end.line + 1 }
    }
  });
}
