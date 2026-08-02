// ─────────────────────────────────────────────────────────────
// The editor half of the `luno_ide` MCP server.
//
// Everything here is a thin wrapper over a VS Code API, and thin is the point:
// the table, the validation and the dispatch live in `core/ide-tools.ts` where
// they are unit-testable, and this file holds only what genuinely needs an
// editor. Nothing in here can be reached from the browser harness, so each
// operation is verified by hand in a real install — a standing debt of Wave 1,
// written down in `docs/PARITY-PLAN.md` rather than discovered later.
//
// Result shapes follow the reference extension's own, field for field. The
// model has been trained against them, and a renamed field is a silent
// downgrade in how well it reads the answer.
//
// This is a *second* channel for two things LUNO already sends. The turn
// preamble carries a formatted, capped snapshot of the Problems list and the
// active selection (`core/diagnostics.ts`, `core/editor-context.ts`) — read
// once, at turn start, for the model to notice unprompted. These tools are the
// pull side: uncapped, current, and callable again after an edit. Neither
// replaces the other.
// ─────────────────────────────────────────────────────────────

import * as path from "node:path";
import * as vscode from "vscode";
import type {
  IdeToolArgs,
  IdeToolOps,
  IdeToolResult
} from "../../core/ide-tools.js";
import { closeOwnDiffTabs, openProposedDiff } from "./diff-tabs.js";

/** MCP results are text blocks; a structured answer travels as pretty-printed
 *  JSON inside one. Indent 2 is the reference's own — the model reads this. */
function jsonResult(value: unknown): IdeToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** A position, the way every one of these results spells it. */
function position(p: vscode.Position) {
  return { line: p.line, character: p.character };
}

function selectionShape(sel: vscode.Selection | vscode.Range) {
  return {
    start: position(sel.start),
    end: position(sel.end),
    isEmpty: sel.isEmpty
  };
}

/**
 * Turn whatever the model passed into a URI.
 *
 * A relative path is resolved against **every** workspace folder rather than
 * only the first, and the folder holding an already-open document wins. The
 * reference resolves against `workspaceFolders[0]` alone, which in a multi-root
 * window answers "not open" about a file that is; decision 9 in the plan is
 * that every folder counts, and this is the smallest place to honour it.
 */
function resolveDocumentUri(filePath: string): vscode.Uri {
  if (path.isAbsolute(filePath)) return vscode.Uri.file(filePath);
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const candidate = vscode.Uri.file(path.join(folder.uri.fsPath, filePath));
    if (openDocument(candidate)) return candidate;
  }
  const first = folders[0];
  return first
    ? vscode.Uri.file(path.join(first.uri.fsPath, filePath))
    : vscode.Uri.file(filePath);
}

function openDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  const wanted = uri.toString();
  return vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === wanted
  );
}

/**
 * Like {@link resolveDocumentUri}, but for a file that is not open yet — so
 * existence on disk decides which workspace folder wins rather than an open
 * document does.
 */
async function resolveFileUri(filePath: string): Promise<vscode.Uri> {
  if (path.isAbsolute(filePath)) return vscode.Uri.file(filePath);
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const candidate = vscode.Uri.file(path.join(folder.uri.fsPath, filePath));
    try {
      await vscode.workspace.fs.stat(candidate);
      return candidate;
    } catch {
      // Not in this folder. The next one may have it.
    }
  }
  const first = folders[0];
  return first
    ? vscode.Uri.file(path.join(first.uri.fsPath, filePath))
    : vscode.Uri.file(filePath);
}

/**
 * A URI argument, which the model may spell as a `file://` URL or as a plain
 * path.
 *
 * The reference additionally shells out to `wsl.exe wslpath` on win32 to
 * translate a Linux path. Deliberately not copied: that is a synchronous
 * subprocess on every call of a read-only tool, and this extension already
 * treats process spawning as something to justify rather than sprinkle.
 */
function parseUriArgument(raw: string): vscode.Uri {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)
    ? vscode.Uri.parse(raw)
    : vscode.Uri.file(raw);
}

// ── the most recent selection, tracked ──────────────────────────────────────

/** What `getLatestSelection` answers with. Shaped by the reference. */
interface TrackedSelection {
  text: string;
  filePath: string;
  fileUrl: string;
  selection: ReturnType<typeof selectionShape>;
}

let latestSelection: TrackedSelection | null = null;

/**
 * Remember the last selection the user made anywhere, so the model can ask
 * about it after focus has moved on — which is the whole difference between
 * this and `getCurrentSelection`.
 *
 * Registered from `activate`. Without it `getLatestSelection` is honest but
 * useless: it answers "no selection available" forever.
 *
 * `comment` and `output` documents are skipped, as in the reference: a review
 * comment box and the output panel are not code the user is pointing at.
 */
export function registerIdeSelectionTracker(): vscode.Disposable {
  return vscode.window.onDidChangeTextEditorSelection((e) => {
    const doc = e.textEditor.document;
    if (doc.uri.scheme === "comment" || doc.uri.scheme === "output") return;
    const sel = e.textEditor.selection;
    // A bare caret move fires this event too. Recording it would overwrite the
    // remembered selection with an empty one, so the first click anywhere
    // collapses this tool into `getCurrentSelection`.
    if (sel.isEmpty) return;
    latestSelection = {
      text: doc.getText(sel),
      filePath: doc.uri.fsPath,
      fileUrl: doc.uri.toString(),
      selection: selectionShape(sel)
    };
  });
}

/** Exported for the unit tests, which have no editor to change a selection
 *  in. Not called anywhere in production. */
export function __setLatestSelectionForTest(
  value: TrackedSelection | null
): void {
  latestSelection = value;
}

// ── the operations ──────────────────────────────────────────────────────────

/**
 * One instance for the whole extension host, not one per conversation. Paths
 * are absolute, so a conversation running in its own git worktree needs no
 * special case here.
 */
export const ideEditorOps: IdeToolOps = {
  async getWorkspaceFolders(): Promise<IdeToolResult> {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => ({
      name: f.name,
      uri: f.uri.toString(),
      path: f.uri.fsPath,
      index: f.index
    }));
    return jsonResult({
      success: true,
      folders,
      rootPath: vscode.workspace.rootPath ?? null,
      workspaceFile: vscode.workspace.workspaceFile?.toString() ?? null
    });
  },

  async getOpenEditors(): Promise<IdeToolResult> {
    const active = vscode.window.activeTextEditor;
    const tabs: Array<Record<string, unknown>> = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (!(tab.input instanceof vscode.TabInputText)) continue;
        const uri = tab.input.uri;
        const doc = openDocument(uri);
        const entry: Record<string, unknown> = {
          uri: uri.toString(),
          isActive: tab.isActive,
          isPinned: tab.isPinned,
          isPreview: tab.isPreview,
          isDirty: tab.isDirty,
          label: tab.label,
          groupIndex: group.viewColumn ? group.viewColumn - 1 : 0,
          viewColumn: group.viewColumn,
          isGroupActive: group.isActive
        };
        if (doc) {
          entry.fileName = doc.fileName;
          entry.languageId = doc.languageId;
          entry.lineCount = doc.lineCount;
          entry.isUntitled = doc.isUntitled;
          if (active && active.document.uri.toString() === uri.toString()) {
            entry.selection = {
              start: position(active.selection.start),
              end: position(active.selection.end),
              isReversed: active.selection.isReversed
            };
          }
        }
        tabs.push(entry);
      }
    }
    return jsonResult({ tabs });
  },

  async getCurrentSelection(): Promise<IdeToolResult> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return jsonResult({ success: false, message: "No active editor found" });
    }
    const { selection, document } = editor;
    return jsonResult({
      success: true,
      text: document.getText(selection),
      filePath: document.uri.fsPath,
      fileUrl: document.uri.toString(),
      selection: selectionShape(selection)
    });
  },

  async getLatestSelection(): Promise<IdeToolResult> {
    return jsonResult(
      latestSelection ?? {
        success: false,
        message: "No selection available"
      }
    );
  },

  async getDiagnostics({
    uri
  }: IdeToolArgs["getDiagnostics"]): Promise<IdeToolResult> {
    const pairs: Array<[vscode.Uri, readonly vscode.Diagnostic[]]> = uri
      ? [
          [
            parseUriArgument(uri),
            vscode.languages.getDiagnostics(parseUriArgument(uri))
          ]
        ]
      : [...vscode.languages.getDiagnostics()];
    return jsonResult(
      pairs.map(([target, list]) => ({
        uri: target.toString(true),
        linesInFile: openDocument(target)?.lineCount,
        diagnostics: list.map((d) => ({
          message: d.message,
          // The name, not the enum's number: `Error`, not `0`. The reference
          // indexes the enum by value for exactly this, and a bare integer
          // would be one more thing for the model to decode.
          severity: vscode.DiagnosticSeverity[d.severity],
          range: {
            start: position(d.range.start),
            end: position(d.range.end)
          },
          source: d.source,
          code: severityCode(d)
        }))
      }))
    );
  },

  async checkDocumentDirty({
    filePath
  }: IdeToolArgs["checkDocumentDirty"]): Promise<IdeToolResult> {
    const uri = resolveDocumentUri(filePath);
    const doc = openDocument(uri);
    if (!doc) {
      return jsonResult({
        success: false,
        message: `Document not open: ${uri.fsPath}`
      });
    }
    return jsonResult({
      success: true,
      filePath: uri.fsPath,
      isDirty: doc.isDirty,
      isUntitled: doc.isUntitled
    });
  },

  async openFile(args: IdeToolArgs["openFile"]): Promise<IdeToolResult> {
    const makeFrontmost = args.makeFrontmost ?? true;
    const uri = await resolveFileUri(args.filePath);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      throw new Error(`File not found: ${uri.fsPath}`);
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const alreadyVisible = vscode.window.visibleTextEditors.some(
      (e) => e.document.uri.toString() === uri.toString()
    );
    const editor =
      makeFrontmost || !alreadyVisible
        ? await vscode.window.showTextDocument(doc, {
            preview: args.preview,
            preserveFocus: !makeFrontmost
          })
        : vscode.window.visibleTextEditors.find(
            (e) => e.document.uri.toString() === uri.toString()
          );

    if (args.startText && editor) {
      return textResult(
        selectRange(editor, doc, {
          startText: args.startText,
          endText: args.endText,
          selectToEndOfLine: args.selectToEndOfLine
        })
      );
    }

    const answer: Record<string, unknown> = {
      success: true,
      filePath: uri.fsPath,
      fileUrl: doc.uri.toString(),
      message: `Opened file: ${uri.fsPath}`
    };
    // Opened in the background, so the model cannot see it and gets told what
    // it would otherwise have to ask for. Frontmost, the user is looking at it
    // and the one-line message is the whole answer. The reference's inversion,
    // kept.
    if (!makeFrontmost) {
      answer.languageId = doc.languageId;
      answer.lineCount = doc.lineCount;
      answer.isDirty = doc.isDirty;
      answer.isUntitled = doc.isUntitled;
      answer.isClosed = doc.isClosed;
    }
    return makeFrontmost
      ? textResult(String(answer.message))
      : jsonResult(answer);
  },

  async saveDocument({
    filePath
  }: IdeToolArgs["saveDocument"]): Promise<IdeToolResult> {
    const uri = resolveDocumentUri(filePath);
    const doc = openDocument(uri);
    if (!doc) {
      return jsonResult({
        success: false,
        message: `Document not open: ${uri.fsPath}`
      });
    }
    const saved = await doc.save();
    return jsonResult({
      success: true,
      filePath: uri.fsPath,
      saved,
      message: saved
        ? "Document saved successfully"
        : "Document was not dirty or save failed"
    });
  },

  openDiff(args: IdeToolArgs["openDiff"]): Promise<IdeToolResult> {
    return openProposedDiff(args);
  },

  async closeAllDiffTabs(): Promise<IdeToolResult> {
    const closed = await closeOwnDiffTabs();
    return textResult(`CLOSED_${closed}_DIFF_TABS`);
  }
};

/** A bare string answer, for the tools whose result is a sentence rather than
 *  a record. */
function textResult(text: string): IdeToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * Move the selection to what `startText`/`endText` describe, and say what
 * happened. Every branch reports, including the two where the text was not
 * found — a silent "opened" would read as "and selected what you asked for".
 */
function selectRange(
  editor: vscode.TextEditor,
  doc: vscode.TextDocument,
  args: {
    startText: string;
    endText?: string;
    selectToEndOfLine?: boolean;
  }
): string {
  const text = doc.getText();
  const startIdx = text.indexOf(args.startText);
  if (startIdx === -1) {
    return `Opened file, but text "${args.startText}" not found`;
  }
  const start = doc.positionAt(startIdx);
  const after = startIdx + args.startText.length;

  const reveal = (end: vscode.Position) => {
    editor.selection = new vscode.Selection(start, end);
    editor.revealRange(
      new vscode.Range(start, end),
      vscode.TextEditorRevealType.InCenter
    );
  };

  if (!args.endText) {
    reveal(doc.positionAt(after));
    return `Opened file and selected text "${args.startText}"`;
  }

  const offset = text.slice(after).indexOf(args.endText);
  if (offset === -1) {
    reveal(start);
    return `Opened file and positioned at "${args.startText}" (end text "${args.endText}" not found)`;
  }
  let end = doc.positionAt(after + offset + args.endText.length);
  if (args.selectToEndOfLine) {
    end = new vscode.Position(end.line, Number.MAX_SAFE_INTEGER);
  }
  reveal(end);
  return `Opened file and selected text from "${args.startText}" to "${args.endText}"`;
}

/** A diagnostic's `code` is a string, a number, or an object carrying both a
 *  value and a link. Flattened to a string, as the reference does. */
function severityCode(d: vscode.Diagnostic): string | undefined {
  const code = d.code;
  if (code === undefined || code === null) return undefined;
  if (typeof code === "object" && "value" in code) return String(code.value);
  return String(code);
}
