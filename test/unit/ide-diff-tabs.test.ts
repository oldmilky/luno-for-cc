import { describe, it, expect, beforeEach, vi } from "vitest";

// `openDiff` is the one tool that parks a turn if it gets this wrong, so every
// way it can end is proven separately here. The lesson is already paid for:
// D6 in `.claude/plans/carried-forward.md` was a generator sitting on its
// resolver with `busy` stuck true until the window was reloaded.

interface FakeUri {
  scheme: string;
  path: string;
  fsPath: string;
  toString(): string;
}

function uriFrom(scheme: string, p: string): FakeUri {
  return {
    scheme,
    path: p,
    fsPath: p,
    toString: () => `${scheme}://${p}`
  };
}

class FakeTabInputTextDiff {
  constructor(
    public original: FakeUri,
    public modified: FakeUri
  ) {}
}

class FakeEventEmitter<T> {
  private handlers: Array<(e: T) => void> = [];
  event = (fn: (e: T) => void) => {
    this.handlers.push(fn);
    return {
      dispose: () => (this.handlers = this.handlers.filter((h) => h !== fn))
    };
  };
  fire(e: T) {
    for (const h of [...this.handlers]) h(e);
  }
}

interface FakeTab {
  input: unknown;
  label: string;
}

const state = {
  commands: new Map<string, (...a: unknown[]) => unknown>(),
  contextKeys: new Map<string, unknown>(),
  tabs: [] as FakeTab[],
  activeTab: undefined as FakeTab | undefined,
  documents: [] as Array<{ uri: FakeUri; getText(): string }>,
  activeTextEditor: undefined as { document: { uri: FakeUri } } | undefined,
  closedTabs: [] as FakeTab[],
  diffCalls: [] as unknown[][],
  diffThrows: undefined as string | undefined,
  onWillSave: new FakeEventEmitter<{
    document: { uri: FakeUri; getText(): string };
  }>(),
  onDidChangeTabs: new FakeEventEmitter<{ closed: FakeTab[] }>()
};

vi.mock("../../src/services/logger.js", () => ({
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined
}));

vi.mock("vscode", () => {
  class Disposable {
    constructor(private fn: () => void) {}
    dispose() {
      this.fn();
    }
    static from(...items: Array<{ dispose(): void }>) {
      return new Disposable(() => items.forEach((i) => i.dispose()));
    }
  }
  return {
    Disposable,
    EventEmitter: FakeEventEmitter,
    FileType: { File: 1 },
    FileChangeType: { Changed: 2 },
    FileSystemError: {
      FileNotFound: (u: FakeUri) => new Error(`not found: ${u}`),
      NoPermissions: (m: string) => new Error(m)
    },
    TabInputTextDiff: FakeTabInputTextDiff,
    Uri: {
      from: ({ scheme, path }: { scheme: string; path: string }) =>
        uriFrom(scheme, path),
      file: (p: string) => uriFrom("file", p.replace(/\\/g, "/"))
    },
    workspace: {
      registerFileSystemProvider: () => ({ dispose: () => undefined }),
      // Subscribed lazily: `beforeEach` swaps the emitter for a fresh one, and
      // binding `.event` here would leave the subject under test listening to
      // the previous test's emitter.
      onWillSaveTextDocument: (fn: (e: unknown) => void) =>
        state.onWillSave.event(fn as never),
      get textDocuments() {
        return state.documents;
      },
      openTextDocument: async (uri: FakeUri) => {
        const doc = state.documents.find(
          (d) => d.uri.toString() === uri.toString()
        );
        if (!doc) throw new Error("no such document");
        return doc;
      }
    },
    window: {
      get activeTextEditor() {
        return state.activeTextEditor;
      },
      tabGroups: {
        get all() {
          return [{ tabs: state.tabs }];
        },
        get activeTabGroup() {
          return { activeTab: state.activeTab };
        },
        close: async (tab: FakeTab) => {
          state.closedTabs.push(tab);
          state.tabs = state.tabs.filter((t) => t !== tab);
          if (state.activeTab === tab) state.activeTab = undefined;
        },
        onDidChangeTabs: (fn: (e: unknown) => void) =>
          state.onDidChangeTabs.event(fn as never)
      }
    },
    commands: {
      registerCommand: (id: string, fn: (...a: unknown[]) => unknown) => {
        state.commands.set(id, fn);
        return { dispose: () => state.commands.delete(id) };
      },
      executeCommand: async (id: string, ...rest: unknown[]) => {
        if (id === "setContext") {
          state.contextKeys.set(String(rest[0]), rest[1]);
          return;
        }
        if (id === "vscode.diff") {
          state.diffCalls.push(rest);
          if (state.diffThrows) throw new Error(state.diffThrows);
          // The editor opens the tab and focuses it.
          const [original, modified, label] = rest as [
            FakeUri,
            FakeUri,
            string
          ];
          const tab: FakeTab = {
            input: new FakeTabInputTextDiff(original, modified),
            label
          };
          state.tabs.push(tab);
          state.activeTab = tab;
          state.documents.push({
            uri: modified,
            getText: () => "PROPOSED"
          });
          return;
        }
        const fn = state.commands.get(id);
        return fn ? fn(...rest) : undefined;
      }
    }
  };
});

const {
  registerDiffTabs,
  openProposedDiff,
  rejectAllPendingDiffs,
  closeOwnDiffTabs,
  pendingDiffCount
} = await import("../../src/services/ide/diff-tabs.js");

/** The verdict and detail an answer carries. */
function verdictOf(res: { content: Array<{ text: string }> }) {
  return { verdict: res.content[0].text, detail: res.content[1]?.text };
}

/** The tab `openProposedDiff` just opened. */
function ourTab(): FakeTab {
  const tab = state.tabs.at(-1);
  if (!tab) throw new Error("no tab was opened");
  return tab;
}

async function run(id: string) {
  const fn = state.commands.get(id);
  if (!fn) throw new Error(`${id} was never registered`);
  await fn();
}

/** Give the pending promise a tick to settle without blocking on it. */
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  state.commands.clear();
  state.contextKeys.clear();
  state.tabs = [];
  state.activeTab = undefined;
  state.documents = [];
  state.activeTextEditor = undefined;
  state.closedTabs = [];
  state.diffCalls = [];
  state.diffThrows = undefined;
  state.onWillSave = new FakeEventEmitter();
  state.onDidChangeTabs = new FakeEventEmitter();
  rejectAllPendingDiffs("test reset");
});

describe("openDiff — it blocks", () => {
  it("does not resolve while the user has decided nothing", async () => {
    registerDiffTabs();
    let settled = false;
    void openProposedDiff({
      old_file_path: "/w/a.ts",
      new_file_contents: "next"
    }).then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
    expect(pendingDiffCount()).toBe(1);
  });

  it("opens a real diff tab, not a preview one", async () => {
    registerDiffTabs();
    void openProposedDiff({ old_file_path: "/w/a.ts", new_file_contents: "x" });
    await tick();
    const [original, modified, label, opts] = state.diffCalls[0] as [
      FakeUri,
      FakeUri,
      string,
      { preview: boolean }
    ];
    expect(original.toString()).toBe("file:///w/a.ts");
    expect(modified.scheme).toBe("luno-proposed");
    expect(label).toContain("a.ts");
    // A preview tab is replaced by the next thing the user opens, which would
    // silently reject the diff they were about to read.
    expect(opts.preview).toBe(false);
  });

  it("raises the context key that puts the two buttons in the title bar", async () => {
    registerDiffTabs();
    expect(state.contextKeys.get("luno.viewingProposedDiff")).toBe(false);
    void openProposedDiff({ old_file_path: "/w/a.ts", new_file_contents: "x" });
    await tick();
    expect(state.contextKeys.get("luno.viewingProposedDiff")).toBe(true);
  });
});

describe("openDiff — exit 1, accepted", () => {
  it("answers FILE_SAVED with the proposed text", async () => {
    registerDiffTabs();
    const answer = openProposedDiff({
      old_file_path: "/w/a.ts",
      new_file_contents: "next"
    });
    await tick();
    await run("luno.acceptProposedDiff");
    expect(verdictOf(await answer)).toEqual({
      verdict: "FILE_SAVED",
      detail: "PROPOSED"
    });
  });

  it("returns what the user edited, not what the model proposed", async () => {
    // The one thing this surface can do that the old modal could not.
    registerDiffTabs();
    const answer = openProposedDiff({
      old_file_path: "/w/a.ts",
      new_file_contents: "model's version"
    });
    await tick();
    const doc = state.documents.at(-1)!;
    doc.getText = () => "the user's own edit";
    await run("luno.acceptProposedDiff");
    expect(verdictOf(await answer).detail).toBe("the user's own edit");
  });

  it("closes the tab and lowers the context key", async () => {
    registerDiffTabs();
    const answer = openProposedDiff({
      old_file_path: "/w/a.ts",
      new_file_contents: "x"
    });
    await tick();
    await run("luno.acceptProposedDiff");
    await answer;
    await tick();
    expect(state.closedTabs).toHaveLength(1);
    expect(pendingDiffCount()).toBe(0);
    expect(state.contextKeys.get("luno.viewingProposedDiff")).toBe(false);
  });
});

describe("openDiff — exit 2, rejected", () => {
  it("answers DIFF_REJECTED with the tab name", async () => {
    registerDiffTabs();
    const answer = openProposedDiff({
      old_file_path: "/w/a.ts",
      new_file_contents: "x",
      tab_name: "my diff"
    });
    await tick();
    await run("luno.rejectProposedDiff");
    expect(verdictOf(await answer)).toEqual({
      verdict: "DIFF_REJECTED",
      detail: "my diff"
    });
    expect(pendingDiffCount()).toBe(0);
  });
});

describe("openDiff — exit 3, the tab closed with no decision", () => {
  it("reads a closed tab as a rejection rather than waiting forever", async () => {
    registerDiffTabs();
    const answer = openProposedDiff({
      old_file_path: "/w/a.ts",
      new_file_contents: "x",
      tab_name: "closed one"
    });
    await tick();
    const tab = ourTab();
    state.onDidChangeTabs.fire({ closed: [tab] });
    expect(verdictOf(await answer)).toEqual({
      verdict: "DIFF_REJECTED",
      detail: "closed one"
    });
    expect(pendingDiffCount()).toBe(0);
  });

  it("ignores a tab that is not one of ours closing", async () => {
    registerDiffTabs();
    const answer = openProposedDiff({
      old_file_path: "/w/a.ts",
      new_file_contents: "x"
    });
    await tick();
    const foreign: FakeTab = {
      input: new FakeTabInputTextDiff(
        uriFrom("file", "/w/x.ts"),
        uriFrom("file", "/w/y.ts")
      ),
      label: "someone else's diff"
    };
    state.onDidChangeTabs.fire({ closed: [foreign] });
    let settled = false;
    void answer.then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
    expect(pendingDiffCount()).toBe(1);
  });
});

describe("openDiff — exit 4, the turn went away", () => {
  it("rejects every open diff rather than parking the turn", async () => {
    registerDiffTabs();
    const first = openProposedDiff({
      old_file_path: "/w/a.ts",
      new_file_contents: "x",
      tab_name: "one"
    });
    await tick();
    const second = openProposedDiff({
      old_file_path: "/w/b.ts",
      new_file_contents: "y",
      tab_name: "two"
    });
    await tick();
    expect(pendingDiffCount()).toBe(2);

    rejectAllPendingDiffs("the turn was cancelled");

    expect(verdictOf(await first).verdict).toBe("DIFF_REJECTED");
    expect(verdictOf(await second).verdict).toBe("DIFF_REJECTED");
    expect(pendingDiffCount()).toBe(0);
  });

  it("closes the tabs it rejected, so nothing is left to click", async () => {
    registerDiffTabs();
    const answer = openProposedDiff({
      old_file_path: "/w/a.ts",
      new_file_contents: "x"
    });
    await tick();
    rejectAllPendingDiffs("cancelled");
    await answer;
    await tick();
    expect(state.closedTabs).toHaveLength(1);
  });

  it("is safe to call when nothing is open", () => {
    registerDiffTabs();
    expect(() => rejectAllPendingDiffs("nothing to do")).not.toThrow();
  });
});

describe("openDiff — the failures that would otherwise hang", () => {
  it("settles when the diff tab could not be opened at all", async () => {
    registerDiffTabs();
    state.diffThrows = "editor refused";
    const res = await openProposedDiff({
      old_file_path: "/w/a.ts",
      new_file_contents: "x"
    });
    expect(verdictOf(res).verdict).toBe("DIFF_REJECTED");
    expect(verdictOf(res).detail).toContain("editor refused");
    expect(pendingDiffCount()).toBe(0);
  });

  it("answers rather than throwing when there is no file to diff", async () => {
    registerDiffTabs();
    const res = await openProposedDiff({});
    expect(verdictOf(res).verdict).toBe("DIFF_REJECTED");
    expect(verdictOf(res).detail).toContain("no editor is active");
  });

  it("does nothing when accept is pressed on a tab that is not ours", async () => {
    registerDiffTabs();
    const answer = openProposedDiff({
      old_file_path: "/w/a.ts",
      new_file_contents: "x"
    });
    await tick();
    state.activeTab = {
      input: new FakeTabInputTextDiff(
        uriFrom("file", "/w/x.ts"),
        uriFrom("file", "/w/y.ts")
      ),
      label: "not ours"
    };
    await run("luno.acceptProposedDiff");
    let settled = false;
    void answer.then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
  });
});

describe("openDiff — a plain Ctrl+S counts as accepting", () => {
  it("answers FILE_SAVED with the buffer that was saved", async () => {
    registerDiffTabs();
    const answer = openProposedDiff({
      old_file_path: "/w/a.ts",
      new_file_contents: "x"
    });
    await tick();
    const doc = state.documents.at(-1)!;
    state.onWillSave.fire({
      document: { uri: doc.uri, getText: () => "saved by hand" }
    });
    expect(verdictOf(await answer)).toEqual({
      verdict: "FILE_SAVED",
      detail: "saved by hand"
    });
  });

  it("ignores a save of some other document", async () => {
    registerDiffTabs();
    const answer = openProposedDiff({
      old_file_path: "/w/a.ts",
      new_file_contents: "x"
    });
    await tick();
    state.onWillSave.fire({
      document: { uri: uriFrom("file", "/w/other.ts"), getText: () => "nope" }
    });
    let settled = false;
    void answer.then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
  });
});

describe("closeAllDiffTabs", () => {
  it("closes only the diffs this server opened", async () => {
    registerDiffTabs();
    const answer = openProposedDiff({
      old_file_path: "/w/a.ts",
      new_file_contents: "x"
    });
    await tick();
    const foreign: FakeTab = {
      input: new FakeTabInputTextDiff(
        uriFrom("file", "/w/x.ts"),
        uriFrom("file", "/w/y.ts")
      ),
      label: "the user's own git diff"
    };
    state.tabs.push(foreign);

    expect(await closeOwnDiffTabs()).toBe(1);
    expect(state.closedTabs).toHaveLength(1);
    expect(state.tabs).toContain(foreign);
    // And the call it closed is answered, not orphaned.
    expect(verdictOf(await answer).verdict).toBe("DIFF_REJECTED");
  });

  it("counts zero when there is nothing of ours open", async () => {
    registerDiffTabs();
    expect(await closeOwnDiffTabs()).toBe(0);
  });
});

describe("openDiff — the arguments the reference leaves out", () => {
  it("falls back to the active editor when no path is given", async () => {
    registerDiffTabs();
    state.activeTextEditor = {
      document: { uri: uriFrom("file", "/w/live.ts") }
    };
    void openProposedDiff({ new_file_contents: "x" });
    await tick();
    const [original] = state.diffCalls[0] as [FakeUri];
    expect(original.toString()).toBe("file:///w/live.ts");
  });

  it("names the tab after the file when the model names nothing", async () => {
    registerDiffTabs();
    const answer = openProposedDiff({
      old_file_path: "/w/a.ts",
      new_file_contents: "x"
    });
    await tick();
    await run("luno.rejectProposedDiff");
    // Marked, so the user can tell which tab the agent put there.
    expect(verdictOf(await answer).detail).toBe("✻ [LUNO] a.ts");
  });

  it("says both names when the proposal renames the file", async () => {
    registerDiffTabs();
    const answer = openProposedDiff({
      old_file_path: "/w/a.ts",
      new_file_path: "/w/b.ts",
      new_file_contents: "x"
    });
    await tick();
    await run("luno.rejectProposedDiff");
    expect(verdictOf(await answer).detail).toBe("✻ [LUNO] a.ts → b.ts");
  });

  it("reads the file's own contents when the model proposes none", async () => {
    registerDiffTabs();
    state.documents.push({
      uri: uriFrom("file", "/w/a.ts"),
      getText: () => "what is already there"
    });
    void openProposedDiff({ old_file_path: "/w/a.ts" });
    await tick();
    expect(state.diffCalls).toHaveLength(1);
    expect(pendingDiffCount()).toBe(1);
  });
});
