import { describe, it, expect, beforeEach, vi } from "vitest";

// The editor half is the one part of Wave 1 the browser harness cannot reach,
// so this stands in for it: enough of the VS Code surface to pin the *shape*
// of every answer. It proves the mapping, not the API — that a `TabInputText`
// really behaves this way is what the by-hand pass in a real install is for.

interface FakeUri {
  fsPath: string;
  scheme: string;
  toString(skipEncoding?: boolean): string;
}

function fileUri(raw: string): FakeUri {
  // Normalised, so a test can spell a path either way and `path.join`'s own
  // separator does not decide whether two of them are the same file.
  const fsPath = raw.replace(/\\/g, "/");
  const url = `file:///${fsPath.replace(/^\/+/, "")}`;
  return { fsPath, scheme: "file", toString: () => url };
}

class FakeTabInputText {
  constructor(public uri: FakeUri) {}
}

const state = {
  workspaceFolders: [] as Array<{
    name: string;
    uri: FakeUri;
    index: number;
  }>,
  rootPath: undefined as string | undefined,
  workspaceFile: undefined as FakeUri | undefined,
  textDocuments: [] as Array<Record<string, unknown>>,
  activeTextEditor: undefined as Record<string, unknown> | undefined,
  tabGroups: [] as Array<Record<string, unknown>>,
  diagnostics: [] as Array<[FakeUri, unknown[]]>,
  selectionListener: undefined as ((e: unknown) => void) | undefined,
  /** Paths `workspace.fs.stat` will admit to. */
  onDisk: new Set<string>(),
  visibleTextEditors: [] as Array<Record<string, unknown>>,
  shown: [] as Array<{ uri: string; options: unknown }>
};

class FakeEmitter {
  event = () => ({ dispose: () => undefined });
  fire() {
    /* nothing listens in these tests */
  }
}

vi.mock("vscode", () => ({
  workspace: {
    get workspaceFolders() {
      return state.workspaceFolders.length ? state.workspaceFolders : undefined;
    },
    get rootPath() {
      return state.rootPath;
    },
    get workspaceFile() {
      return state.workspaceFile;
    },
    get textDocuments() {
      return state.textDocuments;
    },
    fs: {
      stat: async (uri: FakeUri) => {
        if (!state.onDisk.has(uri.fsPath)) throw new Error("ENOENT");
        return { type: 1, ctime: 0, mtime: 0, size: 0 };
      }
    },
    openTextDocument: async (uri: FakeUri) => {
      const doc = state.textDocuments.find(
        (d) => String((d.uri as FakeUri).toString()) === uri.toString()
      );
      if (!doc) throw new Error("no such document");
      return doc;
    },
    registerFileSystemProvider: () => ({ dispose: () => undefined }),
    onWillSaveTextDocument: () => ({ dispose: () => undefined })
  },
  window: {
    get activeTextEditor() {
      return state.activeTextEditor;
    },
    get tabGroups() {
      return {
        all: state.tabGroups,
        activeTabGroup: { activeTab: undefined },
        close: async () => undefined,
        onDidChangeTabs: () => ({ dispose: () => undefined })
      };
    },
    get visibleTextEditors() {
      return state.visibleTextEditors;
    },
    showTextDocument: async (
      doc: Record<string, unknown>,
      options: unknown
    ) => {
      state.shown.push({
        uri: String((doc.uri as FakeUri).toString()),
        options
      });
      const editor = {
        document: doc,
        selection: undefined,
        revealRange: () => undefined
      };
      state.visibleTextEditors.push(editor);
      return editor;
    },
    onDidChangeTextEditorSelection: (fn: (e: unknown) => void) => {
      state.selectionListener = fn;
      return { dispose: () => (state.selectionListener = undefined) };
    }
  },
  languages: {
    getDiagnostics: (uri?: FakeUri) =>
      uri
        ? (state.diagnostics.find(
            ([u]) => u.toString() === uri.toString()
          )?.[1] ?? [])
        : state.diagnostics
  },
  Uri: {
    file: (p: string) => fileUri(p),
    parse: (s: string) => ({
      fsPath: s.replace(/^file:\/\/\/?/, ""),
      scheme: s.split(":")[0],
      toString: () => s
    })
  },
  TabInputText: FakeTabInputText,
  DiagnosticSeverity: ["Error", "Warning", "Information", "Hint"],
  // Only reached because `editor.ts` imports `diff-tabs.ts`. That module's own
  // behaviour is proven in `ide-diff-tabs.test.ts`, not here.
  EventEmitter: FakeEmitter,
  Disposable: class {
    static from() {
      return { dispose: () => undefined };
    }
    dispose() {}
  },
  FileType: { File: 1 },
  FileChangeType: { Changed: 2 },
  FileSystemError: {
    FileNotFound: () => new Error("not found"),
    NoPermissions: () => new Error("read-only")
  },
  TabInputTextDiff: class {},
  Position: class {
    constructor(
      public line: number,
      public character: number
    ) {}
  },
  Range: class {
    constructor(
      public start: unknown,
      public end: unknown
    ) {}
  },
  Selection: class {
    constructor(
      public start: unknown,
      public end: unknown
    ) {}
  },
  TextEditorRevealType: { InCenter: 2 },
  commands: {
    registerCommand: () => ({ dispose: () => undefined }),
    executeCommand: async () => undefined
  }
}));

const {
  ideEditorOps,
  registerIdeSelectionTracker,
  __setLatestSelectionForTest
} = await import("../../src/services/ide/editor.js");

/** The JSON every one of these tools wraps its answer in. */
async function payload(
  run: Promise<{ content: Array<{ type: string; text: string }> }>
) {
  const res = await run;
  expect(res.content).toHaveLength(1);
  expect(res.content[0].type).toBe("text");
  return JSON.parse(res.content[0].text);
}

const pos = (line: number, character: number) => ({ line, character });
const range = (sl: number, sc: number, el: number, ec: number) => ({
  start: pos(sl, sc),
  end: pos(el, ec),
  isEmpty: sl === el && sc === ec,
  isReversed: false
});

beforeEach(() => {
  state.workspaceFolders = [];
  state.rootPath = undefined;
  state.workspaceFile = undefined;
  state.textDocuments = [];
  state.activeTextEditor = undefined;
  state.tabGroups = [];
  state.diagnostics = [];
  state.selectionListener = undefined;
  state.onDisk = new Set();
  state.visibleTextEditors = [];
  state.shown = [];
  __setLatestSelectionForTest(null);
});

describe("getWorkspaceFolders", () => {
  it("reports every folder, with its index", async () => {
    state.workspaceFolders = [
      { name: "app", uri: fileUri("C:/work/app"), index: 0 },
      { name: "lib", uri: fileUri("C:/work/lib"), index: 1 }
    ];
    state.rootPath = "C:/work/app";
    const out = await payload(ideEditorOps.getWorkspaceFolders({}));
    expect(out.success).toBe(true);
    expect(out.folders).toEqual([
      {
        name: "app",
        uri: "file:///C:/work/app",
        path: "C:/work/app",
        index: 0
      },
      { name: "lib", uri: "file:///C:/work/lib", path: "C:/work/lib", index: 1 }
    ]);
    expect(out.rootPath).toBe("C:/work/app");
    expect(out.workspaceFile).toBeNull();
  });

  it("answers with an empty list rather than failing when no folder is open", async () => {
    const out = await payload(ideEditorOps.getWorkspaceFolders({}));
    expect(out).toEqual({
      success: true,
      folders: [],
      rootPath: null,
      workspaceFile: null
    });
  });
});

describe("getOpenEditors", () => {
  it("lists text tabs, enriched from the open document", async () => {
    const uri = fileUri("C:/work/a.ts");
    state.textDocuments = [
      {
        uri,
        fileName: "C:/work/a.ts",
        languageId: "typescript",
        lineCount: 42,
        isUntitled: false
      }
    ];
    state.tabGroups = [
      {
        viewColumn: 1,
        isActive: true,
        tabs: [
          {
            input: new FakeTabInputText(uri),
            isActive: true,
            isPinned: false,
            isPreview: false,
            isDirty: true,
            label: "a.ts"
          }
        ]
      }
    ];
    const out = await payload(ideEditorOps.getOpenEditors({}));
    expect(out.tabs).toHaveLength(1);
    expect(out.tabs[0]).toMatchObject({
      uri: "file:///C:/work/a.ts",
      isActive: true,
      isDirty: true,
      label: "a.ts",
      groupIndex: 0,
      viewColumn: 1,
      isGroupActive: true,
      fileName: "C:/work/a.ts",
      languageId: "typescript",
      lineCount: 42
    });
  });

  it("carries the selection only for the tab that is the active editor", async () => {
    const shown = fileUri("C:/work/a.ts");
    const other = fileUri("C:/work/b.ts");
    const doc = { uri: shown, fileName: "a", languageId: "ts", lineCount: 1 };
    const otherDoc = {
      uri: other,
      fileName: "b",
      languageId: "ts",
      lineCount: 1
    };
    state.textDocuments = [doc, otherDoc];
    state.activeTextEditor = { document: doc, selection: range(2, 0, 4, 7) };
    state.tabGroups = [
      {
        viewColumn: 1,
        isActive: true,
        tabs: [
          { input: new FakeTabInputText(shown), label: "a.ts" },
          { input: new FakeTabInputText(other), label: "b.ts" }
        ]
      }
    ];
    const out = await payload(ideEditorOps.getOpenEditors({}));
    expect(out.tabs[0].selection).toEqual({
      start: { line: 2, character: 0 },
      end: { line: 4, character: 7 },
      isReversed: false
    });
    expect(out.tabs[1].selection).toBeUndefined();
  });

  it("skips a tab that is not a text editor — a diff or a webview has no uri", async () => {
    state.tabGroups = [
      {
        viewColumn: 1,
        isActive: true,
        tabs: [{ input: { some: "other tab kind" }, label: "Settings" }]
      }
    ];
    expect(await payload(ideEditorOps.getOpenEditors({}))).toEqual({
      tabs: []
    });
  });
});

describe("getCurrentSelection", () => {
  it("returns the highlighted text and where it is", async () => {
    const uri = fileUri("C:/work/a.ts");
    state.activeTextEditor = {
      document: { uri, getText: () => "const x = 1;" },
      selection: range(3, 2, 3, 14)
    };
    const out = await payload(ideEditorOps.getCurrentSelection({}));
    expect(out).toEqual({
      success: true,
      text: "const x = 1;",
      filePath: "C:/work/a.ts",
      fileUrl: "file:///C:/work/a.ts",
      selection: {
        start: { line: 3, character: 2 },
        end: { line: 3, character: 14 },
        isEmpty: false
      }
    });
  });

  it("says so plainly when nothing is focused", async () => {
    expect(await payload(ideEditorOps.getCurrentSelection({}))).toEqual({
      success: false,
      message: "No active editor found"
    });
  });
});

describe("getLatestSelection", () => {
  it("answers that there is none before the user has selected anything", async () => {
    expect(await payload(ideEditorOps.getLatestSelection({}))).toEqual({
      success: false,
      message: "No selection available"
    });
  });

  it("remembers a selection the tracker saw, after focus moved on", async () => {
    registerIdeSelectionTracker();
    expect(state.selectionListener).toBeTypeOf("function");
    const uri = fileUri("C:/work/a.ts");
    state.selectionListener!({
      textEditor: {
        document: { uri, getText: () => "widget" },
        selection: range(9, 1, 9, 7)
      }
    });
    // Focus has since gone elsewhere — this is the whole point of the tool.
    state.activeTextEditor = undefined;
    const out = await payload(ideEditorOps.getLatestSelection({}));
    expect(out).toEqual({
      text: "widget",
      filePath: "C:/work/a.ts",
      fileUrl: "file:///C:/work/a.ts",
      selection: {
        start: { line: 9, character: 1 },
        end: { line: 9, character: 7 },
        isEmpty: false
      }
    });
  });

  // Measured in a real install: after selecting a line in one file and then
  // clicking into another, the tool answered with the bare caret — which makes
  // it a slower `getCurrentSelection` and nothing more.
  it("survives a later caret move that selects nothing", async () => {
    registerIdeSelectionTracker();
    state.selectionListener!({
      textEditor: {
        document: { uri: fileUri("C:/work/a.ts"), getText: () => "widget" },
        selection: range(9, 1, 9, 7)
      }
    });
    state.selectionListener!({
      textEditor: {
        document: { uri: fileUri("C:/work/b.ts"), getText: () => "" },
        selection: range(3, 3, 3, 3)
      }
    });
    expect(await payload(ideEditorOps.getLatestSelection({}))).toMatchObject({
      text: "widget",
      filePath: "C:/work/a.ts"
    });
  });

  it("ignores a comment box and the output panel, which are not code", async () => {
    registerIdeSelectionTracker();
    for (const scheme of ["comment", "output"]) {
      state.selectionListener!({
        textEditor: {
          document: {
            uri: { ...fileUri("C:/x"), scheme },
            getText: () => "noise"
          },
          selection: range(0, 0, 0, 5)
        }
      });
    }
    expect(await payload(ideEditorOps.getLatestSelection({}))).toEqual({
      success: false,
      message: "No selection available"
    });
  });

  it("stops listening once disposed", () => {
    const sub = registerIdeSelectionTracker();
    sub.dispose();
    expect(state.selectionListener).toBeUndefined();
  });
});

describe("getDiagnostics", () => {
  const diag = (message: string, severity: number, code?: unknown) => ({
    message,
    severity,
    range: { start: pos(1, 4), end: pos(1, 9) },
    source: "ts",
    code
  });

  it("reports every file when given no uri, and names the severity", async () => {
    const a = fileUri("C:/work/a.ts");
    state.diagnostics = [[a, [diag("Type error", 0, 2322)]]];
    state.textDocuments = [{ uri: a, lineCount: 120 }];
    const out = await payload(ideEditorOps.getDiagnostics({}));
    expect(out).toEqual([
      {
        uri: "file:///C:/work/a.ts",
        linesInFile: 120,
        diagnostics: [
          {
            message: "Type error",
            severity: "Error",
            range: {
              start: { line: 1, character: 4 },
              end: { line: 1, character: 9 }
            },
            source: "ts",
            code: "2322"
          }
        ]
      }
    ]);
  });

  it("narrows to one file when given a uri", async () => {
    const a = fileUri("C:/work/a.ts");
    const b = fileUri("C:/work/b.ts");
    state.diagnostics = [
      [a, [diag("in a", 1)]],
      [b, [diag("in b", 0)]]
    ];
    const out = await payload(
      ideEditorOps.getDiagnostics({ uri: "file:///C:/work/b.ts" })
    );
    expect(out).toHaveLength(1);
    expect(out[0].diagnostics[0].message).toBe("in b");
    expect(out[0].diagnostics[0].severity).toBe("Error");
  });

  it("takes a plain path as well as a file URL", async () => {
    const a = fileUri("C:/work/a.ts");
    state.diagnostics = [[a, [diag("found", 1)]]];
    const out = await payload(
      ideEditorOps.getDiagnostics({ uri: "C:/work/a.ts" })
    );
    expect(out[0].diagnostics[0].message).toBe("found");
  });

  it("flattens a code that arrived as an object with a link", async () => {
    const a = fileUri("C:/work/a.ts");
    state.diagnostics = [
      [a, [diag("rule", 1, { value: "no-unused", target: "https://x" })]]
    ];
    const out = await payload(ideEditorOps.getDiagnostics({}));
    expect(out[0].diagnostics[0].code).toBe("no-unused");
  });

  it("omits a code the language server did not attach", async () => {
    const a = fileUri("C:/work/a.ts");
    state.diagnostics = [[a, [diag("plain", 1, undefined)]]];
    const out = await payload(ideEditorOps.getDiagnostics({}));
    expect(out[0].diagnostics[0].code).toBeUndefined();
  });

  it("returns an empty list when the workspace is clean", async () => {
    expect(await payload(ideEditorOps.getDiagnostics({}))).toEqual([]);
  });
});

describe("checkDocumentDirty", () => {
  it("reports the dirty state of an open document", async () => {
    const uri = fileUri("C:/work/a.ts");
    state.textDocuments = [{ uri, isDirty: true, isUntitled: false }];
    const out = await payload(
      ideEditorOps.checkDocumentDirty({ filePath: "C:/work/a.ts" })
    );
    expect(out).toEqual({
      success: true,
      filePath: "C:/work/a.ts",
      isDirty: true,
      isUntitled: false
    });
  });

  it("says a document is not open rather than claiming it is clean", async () => {
    // The distinction matters: "not dirty" would read as "your edit is saved".
    const out = await payload(
      ideEditorOps.checkDocumentDirty({ filePath: "C:/work/gone.ts" })
    );
    expect(out.success).toBe(false);
    expect(out.message).toContain("Document not open");
  });

  it("resolves a relative path against the folder that actually holds it", async () => {
    // The reference resolves against workspaceFolders[0] only, so in a
    // multi-root window it answers "not open" about a file that is.
    const uri = fileUri("C:\\work\\lib\\b.ts");
    state.workspaceFolders = [
      { name: "app", uri: fileUri("C:\\work\\app"), index: 0 },
      { name: "lib", uri: fileUri("C:\\work\\lib"), index: 1 }
    ];
    state.textDocuments = [{ uri, isDirty: false, isUntitled: false }];
    const out = await payload(
      ideEditorOps.checkDocumentDirty({ filePath: "b.ts" })
    );
    expect(out.success).toBe(true);
    expect(out.isDirty).toBe(false);
  });
});

describe("openFile", () => {
  /** A file both on disk and openable as a document. */
  function place(fsPath: string, text: string) {
    const uri = fileUri(fsPath);
    state.onDisk.add(uri.fsPath);
    const doc = {
      uri,
      getText: () => text,
      positionAt: (offset: number) => {
        const before = text.slice(0, offset);
        const line = before.split("\n").length - 1;
        const character = offset - (before.lastIndexOf("\n") + 1);
        return { line, character };
      },
      languageId: "typescript",
      lineCount: text.split("\n").length,
      isDirty: false,
      isUntitled: false,
      isClosed: false
    };
    state.textDocuments.push(doc);
    return doc;
  }

  /** The bare text a one-sentence answer carries. */
  async function message(run: Promise<{ content: Array<{ text: string }> }>) {
    return (await run).content[0].text;
  }

  it("opens the file and says so", async () => {
    place("C:/work/a.ts", "const x = 1;");
    const out = await message(
      ideEditorOps.openFile({ filePath: "C:/work/a.ts" })
    );
    expect(out).toBe("Opened file: C:/work/a.ts");
    expect(state.shown).toHaveLength(1);
  });

  it("refuses a file that is not there, rather than opening nothing quietly", async () => {
    await expect(
      ideEditorOps.openFile({ filePath: "C:/work/ghost.ts" })
    ).rejects.toThrow("File not found");
  });

  it("keeps focus where it was when asked to, and reports the details instead", async () => {
    // makeFrontmost:false is the model saying "do not steal my user's focus",
    // so it gets the file's properties it cannot see for itself.
    place("C:/work/a.ts", "a\nb\nc");
    const res = await ideEditorOps.openFile({
      filePath: "C:/work/a.ts",
      makeFrontmost: false
    });
    const out = JSON.parse(res.content[0].text);
    expect(out.languageId).toBe("typescript");
    expect(out.lineCount).toBe(3);
    expect(state.shown[0].options).toMatchObject({ preserveFocus: true });
  });

  it("selects the startText match when no endText is given", async () => {
    place("C:/work/a.ts", "alpha\nbeta\ngamma");
    const out = await message(
      ideEditorOps.openFile({ filePath: "C:/work/a.ts", startText: "beta" })
    );
    expect(out).toBe('Opened file and selected text "beta"');
  });

  it("selects from startText through endText", async () => {
    place("C:/work/a.ts", "alpha\nbeta\ngamma");
    const out = await message(
      ideEditorOps.openFile({
        filePath: "C:/work/a.ts",
        startText: "alpha",
        endText: "gamma"
      })
    );
    expect(out).toBe('Opened file and selected text from "alpha" to "gamma"');
  });

  it("says which pattern was missing rather than reporting a selection it did not make", async () => {
    place("C:/work/a.ts", "alpha\nbeta");
    expect(
      await message(
        ideEditorOps.openFile({
          filePath: "C:/work/a.ts",
          startText: "nowhere"
        })
      )
    ).toBe('Opened file, but text "nowhere" not found');

    expect(
      await message(
        ideEditorOps.openFile({
          filePath: "C:/work/a.ts",
          startText: "alpha",
          endText: "nowhere"
        })
      )
    ).toBe(
      'Opened file and positioned at "alpha" (end text "nowhere" not found)'
    );
  });

  it("finds a relative path in the workspace folder that actually has it", async () => {
    state.workspaceFolders = [
      { name: "app", uri: fileUri("C:/work/app"), index: 0 },
      { name: "lib", uri: fileUri("C:/work/lib"), index: 1 }
    ];
    place("C:/work/lib/b.ts", "in lib");
    expect(await message(ideEditorOps.openFile({ filePath: "b.ts" }))).toBe(
      "Opened file: C:/work/lib/b.ts"
    );
  });
});

describe("saveDocument", () => {
  it("saves an open document and says it did", async () => {
    const uri = fileUri("C:/work/a.ts");
    state.textDocuments = [{ uri, save: async () => true }];
    const out = await payload(
      ideEditorOps.saveDocument({ filePath: "C:/work/a.ts" })
    );
    expect(out).toEqual({
      success: true,
      filePath: "C:/work/a.ts",
      saved: true,
      message: "Document saved successfully"
    });
  });

  it("distinguishes a document that was not dirty from a successful write", async () => {
    const uri = fileUri("C:/work/a.ts");
    state.textDocuments = [{ uri, save: async () => false }];
    const out = await payload(
      ideEditorOps.saveDocument({ filePath: "C:/work/a.ts" })
    );
    expect(out.saved).toBe(false);
    expect(out.message).toContain("not dirty");
  });

  it("says a document is not open rather than pretending to save it", async () => {
    const out = await payload(
      ideEditorOps.saveDocument({ filePath: "C:/work/gone.ts" })
    );
    expect(out.success).toBe(false);
    expect(out.message).toContain("Document not open");
  });
});
