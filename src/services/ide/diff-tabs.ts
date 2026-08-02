// ─────────────────────────────────────────────────────────────
// `openDiff` — a wait, not a request.
//
// The tool call blocks until the user decides, which is READ from the
// reference: its implementation ends in `await Promise.race([…])` over the
// accept/reject event, the tab closing, and (with autosave off) a plain Ctrl+S.
// That is why accept and reject are editor-title buttons rather than anything
// in the panel.
//
// **Every exit resolves.** Four of them, and the fourth is ours: the reference
// has no answer for a turn that ends while a diff is open, and an unresolved
// call parks the turn forever. That is D6 in `.claude/plans/carried-forward.md`
// — a generator sitting on its resolver, `busy` stuck true, cleared only by a
// window reload. This module has paid that lesson already and spends it here.
//
// The proposed side is a virtual file rather than a read-only document, and
// deliberately: the user may edit it before accepting, and what the tool
// returns is then the buffer they edited, not what the model proposed.
// ─────────────────────────────────────────────────────────────

import * as path from "node:path";
import * as vscode from "vscode";
import type { IdeToolArgs, IdeToolResult } from "../../core/ide-tools.js";
import { log as logInfo } from "../logger.js";

/** The scheme the proposed side is served under. Its own, so a document from
 *  it can never be confused with a real file on disk. */
const PROPOSED_SCHEME = "luno-proposed";

/** Set while a proposed diff is open, and read by the `when` clause on the
 *  accept/reject buttons in the editor title bar. */
const CONTEXT_KEY = "luno.viewingProposedDiff";

/** What the tool answers with. The reference's own vocabulary — the model has
 *  seen these exact strings. */
const FILE_SAVED = "FILE_SAVED";
const DIFF_REJECTED = "DIFF_REJECTED";

function result(verdict: string, detail: string): IdeToolResult {
  return {
    content: [
      { type: "text", text: verdict },
      { type: "text", text: detail }
    ]
  };
}

// ── the proposed side, in memory ────────────────────────────────────────────

/**
 * A file system that exists only in this process.
 *
 * A `TextDocumentContentProvider` would be less code and is what "show the
 * model's version" sounds like it needs — but its documents are read-only, and
 * the user editing the proposal before accepting is the one thing this surface
 * can do that the old modal could not. A `FileSystemProvider` implements
 * `writeFile`, so the buffer is editable and `Ctrl+S` reaches us.
 */
class ProposedFileSystem implements vscode.FileSystemProvider {
  private readonly files = new Map<string, Uint8Array>();
  private readonly emitter = new vscode.EventEmitter<
    vscode.FileChangeEvent[]
  >();
  readonly onDidChangeFile = this.emitter.event;

  write(uri: vscode.Uri, text: string): void {
    this.files.set(uri.toString(), new TextEncoder().encode(text));
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  forget(uri: vscode.Uri): void {
    this.files.delete(uri.toString());
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const data = this.files.get(uri.toString());
    if (!data) throw vscode.FileSystemError.FileNotFound(uri);
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: 0,
      size: data.length
    };
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const data = this.files.get(uri.toString());
    if (!data) throw vscode.FileSystemError.FileNotFound(uri);
    return data;
  }

  writeFile(uri: vscode.Uri, content: Uint8Array): void {
    this.files.set(uri.toString(), content);
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }
  createDirectory(): void {
    /* every proposal is a single file */
  }
  delete(uri: vscode.Uri): void {
    this.forget(uri);
  }
  rename(): void {
    throw vscode.FileSystemError.NoPermissions("read-only");
  }
}

/**
 * Built on first use, not at import.
 *
 * The constructor calls `new vscode.EventEmitter()`, and this module is
 * reachable from `providers/factory.ts` — so building it eagerly made merely
 * *importing* the factory require a live VS Code, and took two unrelated test
 * files down with it.
 */
let proposedFsInstance: ProposedFileSystem | undefined;
function proposedFs(): ProposedFileSystem {
  return (proposedFsInstance ??= new ProposedFileSystem());
}

// ── the pending diffs ───────────────────────────────────────────────────────

interface PendingDiff {
  /** The proposed side's uri — also how its tab is recognised. */
  proposed: vscode.Uri;
  tabName: string;
  /** Called exactly once, by whichever exit gets there first. */
  settle: (r: IdeToolResult) => void;
  dispose: () => void;
}

const pending = new Map<string, PendingDiff>();

function refreshContextKey(): void {
  void vscode.commands.executeCommand(
    "setContext",
    CONTEXT_KEY,
    pending.size > 0
  );
}

/** Finish one pending diff, whatever the reason, and leave nothing behind. */
function settle(entry: PendingDiff, answer: IdeToolResult): void {
  if (!pending.delete(entry.proposed.toString())) return;
  entry.dispose();
  proposedFs().forget(entry.proposed);
  refreshContextKey();
  entry.settle(answer);
}

function findPending(uri: vscode.Uri | undefined): PendingDiff | undefined {
  return uri ? pending.get(uri.toString()) : undefined;
}

/** The proposed side of the tab the user is looking at, if it is one of ours. */
function activeProposedUri(): vscode.Uri | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab?.input;
  if (!(input instanceof vscode.TabInputTextDiff)) return undefined;
  return input.modified.scheme === PROPOSED_SCHEME ? input.modified : undefined;
}

function isOurDiffTab(tab: vscode.Tab): boolean {
  return (
    tab.input instanceof vscode.TabInputTextDiff &&
    tab.input.modified.scheme === PROPOSED_SCHEME
  );
}

async function closeTabFor(uri: vscode.Uri): Promise<void> {
  const wanted = uri.toString();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (
        tab.input instanceof vscode.TabInputTextDiff &&
        tab.input.modified.toString() === wanted
      ) {
        try {
          await vscode.window.tabGroups.close(tab);
        } catch {
          // A tab the user already closed is the outcome we wanted anyway.
        }
      }
    }
  }
}

// ── registration ────────────────────────────────────────────────────────────

/**
 * Wire the proposed-file scheme and the two title-bar commands.
 *
 * Called once from `activate`. Without it `openDiff` has nowhere to put the
 * proposed side and no way for the user to answer — so it would block forever,
 * which is the one failure this whole module exists to prevent.
 */
export function registerDiffTabs(): vscode.Disposable {
  const subs: vscode.Disposable[] = [
    vscode.workspace.registerFileSystemProvider(PROPOSED_SCHEME, proposedFs(), {
      isCaseSensitive: true
    }),
    vscode.commands.registerCommand("luno.acceptProposedDiff", () => {
      const entry = findPending(activeProposedUri());
      if (!entry) return;
      // The buffer, not what the model sent: the user may have edited the
      // proposal before accepting, and that edit is the whole point.
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.toString() === entry.proposed.toString()
      );
      const text = doc?.getText() ?? "";
      void closeTabFor(entry.proposed);
      settle(entry, result(FILE_SAVED, text));
    }),
    vscode.commands.registerCommand("luno.rejectProposedDiff", () => {
      const entry = findPending(activeProposedUri());
      if (!entry) return;
      void closeTabFor(entry.proposed);
      settle(entry, result(DIFF_REJECTED, entry.tabName));
    }),
    // Exit 3: the tab closed with no decision. Reads as a rejection, because a
    // user who closes the diff has declined it — and because the alternative is
    // a call nobody will ever answer.
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      for (const tab of e.closed) {
        if (!(tab.input instanceof vscode.TabInputTextDiff)) continue;
        const entry = findPending(tab.input.modified);
        if (entry) settle(entry, result(DIFF_REJECTED, entry.tabName));
      }
    })
  ];
  refreshContextKey();
  return vscode.Disposable.from(...subs, {
    dispose: () => rejectAllPendingDiffs("the extension is shutting down")
  });
}

/**
 * Exit 4: nothing is coming. Called when a turn is interrupted or a
 * conversation goes away, and it is the reason this module cannot park a turn.
 *
 * Rejecting is the only honest answer — the user never decided, and claiming
 * they accepted would write the model's version into the conversation as
 * though it had been approved.
 */
export function rejectAllPendingDiffs(reason: string): void {
  if (pending.size === 0) return;
  logInfo(`[luno] rejecting ${pending.size} open diff(s): ${reason}`);
  for (const entry of [...pending.values()]) {
    void closeTabFor(entry.proposed);
    settle(entry, result(DIFF_REJECTED, entry.tabName));
  }
}

/** Close every diff this server opened, rejecting each. Nothing else is
 *  touched: a diff tab the user opened themselves is not ours to close. */
export async function closeOwnDiffTabs(): Promise<number> {
  let closed = 0;
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (!isOurDiffTab(tab)) continue;
      const entry = findPending(
        (tab.input as vscode.TabInputTextDiff).modified
      );
      if (entry) settle(entry, result(DIFF_REJECTED, entry.tabName));
      try {
        await vscode.window.tabGroups.close(tab);
      } catch {
        // Already gone. Still counts — the caller asked for it to be closed.
      }
      closed++;
    }
  }
  return closed;
}

// ── the tool ────────────────────────────────────────────────────────────────

/** A unique proposed-side uri that still ends in the original's filename, so
 *  the editor picks the right language for syntax highlighting. */
let diffCounter = 0;
function proposedUriFor(filePath: string): vscode.Uri {
  const name = path.basename(filePath) || "proposed";
  return vscode.Uri.from({
    scheme: PROPOSED_SCHEME,
    path: `/${diffCounter++}/${name}`
  });
}

/**
 * Open the diff and wait for the user.
 *
 * Every argument is optional, and each absent one has a defined fallback — the
 * reference's descriptions promise that even though its schema does not.
 */
export async function openProposedDiff(
  args: IdeToolArgs["openDiff"]
): Promise<IdeToolResult> {
  const active = vscode.window.activeTextEditor?.document;
  const oldPath = args.old_file_path ?? active?.uri.fsPath;
  const newPath = args.new_file_path ?? oldPath;
  if (!oldPath || !newPath) {
    return result(
      DIFF_REJECTED,
      "No file to diff: no path was given and no editor is active."
    );
  }

  const original = vscode.Uri.file(oldPath);
  let proposedText = args.new_file_contents;
  if (proposedText === undefined) {
    try {
      proposedText = (
        await vscode.workspace.openTextDocument(vscode.Uri.file(newPath))
      ).getText();
    } catch {
      proposedText = "";
    }
  }

  const tabName = args.tab_name ?? defaultTabName(oldPath, newPath);
  const proposed = proposedUriFor(newPath);
  proposedFs().write(proposed, proposedText);

  const subs: vscode.Disposable[] = [];
  const answer = new Promise<IdeToolResult>((resolve) => {
    const entry: PendingDiff = {
      proposed,
      tabName,
      settle: resolve,
      dispose: () => {
        for (const s of subs) s.dispose();
      }
    };
    pending.set(proposed.toString(), entry);
    // A plain Ctrl+S on the proposed buffer is an accept — the reference races
    // it in too, and a user who saves has plainly decided.
    subs.push(
      vscode.workspace.onWillSaveTextDocument((e) => {
        if (e.document.uri.toString() !== proposed.toString()) return;
        const text = e.document.getText();
        void closeTabFor(proposed);
        settle(entry, result(FILE_SAVED, text));
      })
    );
  });
  refreshContextKey();

  try {
    await vscode.commands.executeCommand(
      "vscode.diff",
      original,
      proposed,
      tabName,
      { preview: false }
    );
  } catch (err) {
    // The tab never opened, so nothing can ever close it. Settle now rather
    // than leave the turn holding a promise with no path to an answer.
    const entry = pending.get(proposed.toString());
    const message = err instanceof Error ? err.message : String(err);
    if (entry)
      settle(entry, result(DIFF_REJECTED, `Could not open: ${message}`));
    return answer;
  }

  return answer;
}

/** `✻ [LUNO] a.ts` — or `a.ts → b.ts` when the proposal renames. Marked so the
 *  user can tell at a glance which tab the agent put there. */
function defaultTabName(oldPath: string, newPath: string): string {
  const from = path.basename(oldPath);
  const to = path.basename(newPath);
  return `✻ [LUNO] ${from === to ? from : `${from} → ${to}`}`;
}

/** How many diffs are waiting on a decision. For tests and for the log. */
export function pendingDiffCount(): number {
  return pending.size;
}
