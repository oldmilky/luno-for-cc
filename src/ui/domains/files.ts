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
import { execFile } from "node:child_process";
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
/**
 * @param workingRoot Where a relative path resolves. The conversation's own
 * tree, which is not the open folder when that conversation is isolated —
 * opening the main checkout's copy would show the user a file the agent never
 * touched.
 */
export async function openFile(
  post: Post,
  pathOrRel: string,
  startLine: number,
  endLine: number,
  workingRoot?: string
): Promise<void> {
  let target: vscode.Uri;
  if (isAbsolutePath(pathOrRel)) {
    target = vscode.Uri.file(pathOrRel);
  } else {
    const root = workingRoot
      ? vscode.Uri.file(workingRoot)
      : vscode.workspace.workspaceFolders?.[0]?.uri;
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
  pathOrRel: string,
  workingRoot?: string
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
      // The snapshot was written into the conversation's own checkout, so the
      // buffer to refresh is the one there — refreshing the main checkout's
      // copy would revert a file the restore never touched.
      const root = workingRoot
        ? vscode.Uri.file(workingRoot)
        : vscode.workspace.workspaceFolders?.[0]?.uri;
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

/**
 * Flush unsaved editors before the agent looks at the workspace.
 *
 * The CLI reads files from disk, so an editor holding unsaved changes hands it
 * a version of the code the user is not looking at: it explains a bug that has
 * already been fixed in the buffer, or writes over an edit it never saw.
 *
 * Untitled documents are left alone — saving one opens a Save As dialog, which
 * is not something sending a chat message should do.
 */
export async function saveDirtyEditors(): Promise<void> {
  try {
    const on = vscode.workspace
      .getConfiguration("luno")
      .get<boolean>("autosave", true);
    if (!on) return;

    const dirty = (vscode.workspace.textDocuments ?? []).filter(
      (d) => d.isDirty && !d.isUntitled
    );
    await Promise.all(
      dirty.map((d) =>
        Promise.resolve(d.save()).catch(() => {
          // A read-only file or a failing formatter is not a reason to refuse
          // the turn the user asked for.
        })
      )
    );
  } catch {
    // Whatever went wrong here, the turn still has to run: this is a
    // convenience ahead of the real work, not a precondition for it.
  }
}

/**
 * Filename matches for the composer's `@` mention popover.
 *
 * `workingRoot` is the checkout this conversation works in. It matters because
 * `vscode.workspace.findFiles` only ever searches the workspace folders, and a
 * conversation isolated in a git worktree works in a directory that is not one
 * of them: every mention it offered pointed into the main checkout, so the
 * agent was handed paths to files it was not editing.
 */
export async function searchFiles(
  post: Post,
  query: string,
  id: string,
  workingRoot?: string
): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const isolated =
    workingRoot !== undefined &&
    folder !== undefined &&
    !samePath(workingRoot, folder.uri.fsPath);

  if (!folder && !workingRoot) {
    post({ type: "fileSearchResults", id, results: [] });
    return;
  }

  // git first when the project is a repository: its ignore rules are the ones
  // the project actually declares, where the exclude list below is a guess that
  // offers up whatever the guess missed. `ghost.one/` in this very repo is
  // gitignored and was turned up by `@` regardless.
  const root = isolated ? workingRoot : folder!.uri.fsPath;
  const viaGit = respectGitIgnore()
    ? await listTrackedFiles(root, query)
    : null;
  const found =
    viaGit ??
    (isolated
      ? // Nothing else can see a worktree: it is not a workspace folder, so
        // `findFiles` would answer with the main checkout's files instead.
        []
      : await findInWorkspace(folder!, query));

  post({ type: "fileSearchResults", id, results: rankMatches(found, query) });
}

function respectGitIgnore(): boolean {
  return vscode.workspace
    .getConfiguration("luno")
    .get<boolean>("respectGitIgnore", true);
}

interface FileMatch {
  path: string;
  name: string;
}

async function findInWorkspace(
  folder: vscode.WorkspaceFolder,
  query: string
): Promise<FileMatch[]> {
  const glob = query ? `**/*${escapeGlob(query)}*` : "**/*";
  const found = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, glob),
    "**/{node_modules,.git,dist,build,out,.next,.venv,__pycache__}/**",
    40
  );
  return found.map((u) => ({
    path: vscode.workspace.asRelativePath(u),
    name: u.path.split("/").pop() ?? ""
  }));
}

/**
 * Everything git would show in a checkout: tracked files plus untracked ones
 * the repository does not ignore.
 *
 * `null` — not `[]` — when git cannot answer, so the caller can tell "this is
 * not a repository" from "this repository has no matches" and fall back to the
 * workspace index rather than reporting an empty result.
 */
function listTrackedFiles(
  root: string,
  query: string
): Promise<FileMatch[] | null> {
  return new Promise<FileMatch[] | null>((resolve) => {
    execFile(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: root, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        const q = query.toLowerCase();
        const out: FileMatch[] = [];
        for (const rel of stdout.split("\0")) {
          if (!rel) continue;
          const name = rel.split("/").pop() ?? "";
          if (q && !name.toLowerCase().includes(q)) continue;
          out.push({ path: rel, name });
          // The ranking below only ever surfaces 12; this bound keeps a
          // monorepo's worth of paths out of memory on an empty query.
          if (out.length >= 500) break;
        }
        resolve(out);
      }
    );
  });
}

/** A prefix match beats a substring match beats the rest; ties go
 *  alphabetically. Typing "pan" should surface panel.ts, not
 *  company-panel-legacy.ts. */
function rankMatches(found: FileMatch[], query: string): FileMatch[] {
  const q = query.toLowerCase();
  return [...found]
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
}

/** Path equality that survives the separator and drive-letter case differences
 *  Windows introduces between a configured root and one VS Code reports. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) =>
    p
      .replace(/[\\/]+$/, "")
      .replace(/\\/g, "/")
      .toLowerCase();
  return norm(a) === norm(b);
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
