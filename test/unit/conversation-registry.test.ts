import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { HistoryEntry } from "../../src/services/history.js";

// The extension host imports `vscode` at module load, which does not exist off
// a real editor. Only what the registry and a host touch while being built and
// attached is stubbed — anything missing surfaces as an import error rather
// than a silent pass, which is the point of keeping the stub this small.
const disposable = { dispose: () => {} };

/** Panels the code under test asked VS Code to create, newest last. */
const panels = vi.hoisted(
  () =>
    [] as {
      webview: FakeWebview;
      revealed: number;
      disposed: number;
      title?: string;
    }[]
);

/** The tab serializer the registry registers, so a test can hand a panel back
 *  the way VS Code does after a window reload. */
const serializer = vi.hoisted(
  () =>
    ({}) as {
      current?: {
        deserializeWebviewPanel(panel: unknown, state: unknown): Thenable<void>;
      };
      viewType?: string;
    }
);

interface FakeWebview {
  options: unknown;
  html: string;
  cspSource: string;
  asWebviewUri(u: unknown): unknown;
  postMessage(m: { type?: string }): Promise<boolean>;
  onDidReceiveMessage(cb: (m: unknown) => void): { dispose(): void };
  /** Bind this surface to whoever occupies it, the way the panel does. */
  route(pick: () => { receiveMessage(m: never): void } | undefined): void;
  sent: { type?: string }[];
  deliver(m: unknown): void;
}

const makeWebview = vi.hoisted(() => (): FakeWebview => {
  const sent: { type?: string }[] = [];
  let handler: ((m: unknown) => void) | undefined;
  return {
    options: {},
    html: "",
    cspSource: "vscode-webview:",
    asWebviewUri: (u: unknown) => u,
    postMessage: (m: { type?: string }) => {
      sent.push(m);
      return Promise.resolve(true);
    },
    onDidReceiveMessage: (cb: (m: unknown) => void) => {
      handler = cb;
      return disposable;
    },
    route: (pick: () => { receiveMessage(m: never): void } | undefined) => {
      handler = (m: unknown) => pick()?.receiveMessage(m as never);
    },
    sent,
    deliver: (m: unknown) => handler?.(m)
  };
});

/**
 * An editor-tab panel, whether VS Code was asked for it or handed it back.
 *
 * `dispose()` fires `onDidDispose`, as the real one does. That is not a detail:
 * closing a tab is how a conversation gets retired, so a fake that swallowed
 * the callback would report every close as a no-op.
 */
const makePanel = vi.hoisted(() => () => {
  const onDispose: (() => void)[] = [];
  const panel = {
    webview: makeWebview(),
    revealed: 0,
    disposed: 0,
    iconPath: undefined as unknown,
    title: "",
    reveal() {
      panel.revealed++;
    },
    onDidChangeViewState: () => disposable,
    onDidDispose: (cb: () => void) => {
      onDispose.push(cb);
      return disposable;
    },
    dispose() {
      panel.disposed++;
      for (const cb of onDispose) cb();
    }
  };
  return panel;
});

vi.mock("vscode", () => ({
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({
      get: (_key: string, fallback?: unknown) => fallback,
      inspect: () => undefined,
      update: async () => {}
    }),
    onDidChangeConfiguration: () => disposable,
    asRelativePath: (p: unknown) => String(p)
  },
  window: {
    activeTextEditor: undefined,
    visibleTextEditors: [] as unknown[],
    createTextEditorDecorationType: () => disposable,
    onDidChangeActiveTextEditor: () => disposable,
    onDidChangeTextEditorSelection: () => disposable,
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    createWebviewPanel: () => {
      const panel = makePanel();
      panels.push(panel);
      return panel;
    },
    registerWebviewPanelSerializer: (
      viewType: string,
      s: {
        deserializeWebviewPanel(panel: unknown, state: unknown): Thenable<void>;
      }
    ) => {
      serializer.viewType = viewType;
      serializer.current = s;
      return disposable;
    }
  },
  ViewColumn: { Active: -1 },
  OverviewRulerLane: { Right: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  Uri: {
    file: (p: string) => ({ fsPath: p, toString: () => p }),
    joinPath: (base: { fsPath: string }, ...parts: string[]) => {
      const joined = [base.fsPath, ...parts].join("/");
      return { fsPath: joined, toString: () => joined };
    }
  }
}));

const { ConversationRegistry } =
  await import("../../src/ui/conversation-registry.js");

let storage: string;

beforeEach(() => {
  panels.length = 0;
  delete serializer.current;
  delete serializer.viewType;
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "luno-registry-"));
});

afterEach(() => {
  fs.rmSync(storage, { recursive: true, force: true });
});

function fakeContext() {
  return {
    subscriptions: [] as { dispose(): void }[],
    extensionUri: { fsPath: "/ext", toString: () => "/ext" },
    globalStorageUri: { fsPath: storage, toString: () => storage },
    globalState: {
      get: (_k: string, d?: unknown) => d,
      update: async () => {}
    },
    workspaceState: {
      get: (_k: string, d?: unknown) => d,
      update: async () => {}
    },
    secrets: {
      get: async () => undefined,
      store: async () => {},
      delete: async () => {}
    }
  };
}

/** A stored conversation on disk, the way HistoryService writes one.
 *  `updatedAt` is what `list()` sorts on, so anything asserting *which* chat
 *  gets resumed has to set it rather than rely on tie-break order. */
function writeStoredSession(
  id: string,
  updatedAt = 2,
  /** The first user message. Its length decides whether a snippet is derived
   *  at all — a message the title already captures gets none. */
  body = "hi"
): void {
  const dir = path.join(storage, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      title: "Stored chat",
      createdAt: 1,
      updatedAt,
      messages: [{ role: "user", content: body }],
      timeline: [{ id: "e1", ts: 1, kind: "user", title: "user", body }]
    })
  );
}

function fakeTarget() {
  const webview = makeWebview();
  let revealed = 0;
  return {
    webview,
    get revealed() {
      return revealed;
    },
    target: {
      webview,
      reveal: () => {
        revealed++;
      }
    }
  };
}

function typesOf(sent: { type?: string }[]): string[] {
  return sent.map((m) => m.type ?? "");
}

/** Let the floating work `attach` kicks off settle before asserting. */
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("ConversationRegistry", () => {
  it("builds independent conversations, each with its own session", () => {
    const registry = new ConversationRegistry(fakeContext() as never);
    const a = registry.create();
    const b = registry.create();

    // The whole point of the extraction: two conversations can exist at once,
    // and they are not two views onto the same one.
    expect(a).not.toBe(b);
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it("fans a shared message out to every open conversation", () => {
    const registry = new ConversationRegistry(fakeContext() as never);
    const first = fakeTarget();
    const second = fakeTarget();
    registry.create().attach(first.target as never);
    registry.create().attach(second.target as never);

    registry.broadcast({ type: "models", models: [] });

    expect(typesOf(first.webview.sent)).toContain("models");
    expect(typesOf(second.webview.sent)).toContain("models");
  });

  it("stops publishing to a conversation once it is closed", () => {
    const registry = new ConversationRegistry(fakeContext() as never);
    const kept = fakeTarget();
    const closed = fakeTarget();
    const keptHost = registry.create();
    const closedHost = registry.create();
    keptHost.attach(kept.target as never);
    closedHost.attach(closed.target as never);

    registry.close(closedHost);
    kept.webview.sent.length = 0;
    closed.webview.sent.length = 0;
    registry.broadcast({ type: "models", models: [] });

    expect(typesOf(kept.webview.sent)).toContain("models");
    expect(closed.webview.sent).toEqual([]);
  });

  it("gives each conversation its own webview to post into", () => {
    const registry = new ConversationRegistry(fakeContext() as never);
    const first = fakeTarget();
    const second = fakeTarget();
    registry.create().attach(first.target as never);
    const secondHost = registry.create();
    secondHost.attach(second.target as never);

    // `hello` carries the session id and is posted by `attach` to its own
    // surface only. If conversations shared a webview this would land twice.
    const hellos = first.webview.sent.filter((m) => m.type === "hello");
    expect(hellos).toHaveLength(1);
    expect((hellos[0] as { sessionId?: string }).sessionId).not.toBe(
      secondHost.sessionId
    );
  });

  it("swaps the sidebar to a picked chat and leaves the old one running", async () => {
    writeStoredSession("stored-1");
    writeStoredSession("stored-2");
    const registry = new ConversationRegistry(fakeContext() as never);
    const sidebar = fakeTarget();
    const first = registry.create();
    registry.useSidebar(sidebar.target as never, first);
    // The panel binds one listener to the surface and routes it to whoever
    // occupies it; a test that bound it to `first` would not exercise the swap.
    sidebar.webview.route(() => registry.sidebarConversation() as never);
    first.attach(sidebar.target as never);
    // Give it a conversation of its own to be protective of.
    sidebar.webview.deliver({ type: "loadSession", id: "stored-2" });
    await settle();
    expect(first.sessionId).toBe("stored-2");

    sidebar.webview.deliver({ type: "loadSession", id: "stored-1" });
    await settle();

    // The picked chat is now on the sidebar — no editor tab was opened, which
    // is what moved work somewhere the user had not asked for.
    expect(panels).toHaveLength(0);
    expect(registry.sidebarConversation()?.sessionId).toBe("stored-1");
    // And the one it replaced is still alive, just off screen.
    expect(first.sessionId).toBe("stored-2");
    expect(first.hasSurface).toBe(false);
    expect(registry.conversationFor("stored-2")).toBe(first);
  });

  it("brings a detached conversation back rather than building a second one", async () => {
    writeStoredSession("stored-1");
    writeStoredSession("stored-2");
    const registry = new ConversationRegistry(fakeContext() as never);
    const sidebar = fakeTarget();
    const first = registry.create();
    registry.useSidebar(sidebar.target as never, first);
    // The panel binds one listener to the surface and routes it to whoever
    // occupies it; a test that bound it to `first` would not exercise the swap.
    sidebar.webview.route(() => registry.sidebarConversation() as never);
    first.attach(sidebar.target as never);
    sidebar.webview.deliver({ type: "loadSession", id: "stored-2" });
    await settle();

    sidebar.webview.deliver({ type: "loadSession", id: "stored-1" });
    await settle();
    sidebar.webview.deliver({ type: "loadSession", id: "stored-2" });
    await settle();

    expect(registry.sidebarConversation()).toBe(first);
    expect(first.hasSurface).toBe(true);
  });

  it("reuses a blank conversation rather than switching away from it", async () => {
    writeStoredSession("stored-1");
    const registry = new ConversationRegistry(fakeContext() as never);
    const blank = fakeTarget();
    const blankHost = registry.create();
    blankHost.attach(blank.target as never);
    blank.webview.route(() => blankHost as never);

    blank.webview.deliver({ type: "loadSession", id: "stored-1" });
    await settle();

    // Nothing to protect, and the user is plainly choosing what to put here.
    expect(blankHost.sessionId).toBe("stored-1");
    expect(panels).toHaveLength(0);
  });

  it("resumes the stored conversation only where asked to", async () => {
    writeStoredSession("stored-1");
    const registry = new ConversationRegistry(fakeContext() as never);

    const sidebar = registry.create();
    sidebar.attach(fakeTarget().target as never, {
      resumeLastConversation: true
    });
    const tab = registry.openInTab();
    await settle();

    // The sidebar is the surface a window reload should bring back.
    expect(sidebar.sessionId).toBe("stored-1");
    // A tab that also resumed would open a second view onto a conversation
    // already on screen — and two hosts on one session resume the same CLI
    // session from two processes.
    expect(tab.sessionId).not.toBe("stored-1");
  });

  it("hands a session over instead of opening it twice", async () => {
    writeStoredSession("stored-1");
    const registry = new ConversationRegistry(fakeContext() as never);
    const owner = fakeTarget();
    const other = fakeTarget();
    const ownerHost = registry.create();
    const otherHost = registry.create();
    ownerHost.attach(owner.target as never);
    otherHost.attach(other.target as never);
    owner.webview.route(() => ownerHost as never);
    other.webview.route(() => otherHost as never);

    owner.webview.deliver({ type: "loadSession", id: "stored-1" });
    await settle();
    expect(ownerHost.sessionId).toBe("stored-1");

    other.webview.sent.length = 0;
    other.webview.deliver({ type: "loadSession", id: "stored-1" });
    await settle();

    // The second conversation must not adopt it: it reveals the one that has it.
    expect(otherHost.sessionId).not.toBe("stored-1");
    expect(typesOf(other.webview.sent)).not.toContain("loadedSession");
    expect(owner.revealed).toBeGreaterThan(0);
  });

  it("opens a tab conversation on its own webview", async () => {
    const registry = new ConversationRegistry(fakeContext() as never);
    const tab = registry.openInTab();
    await settle();

    expect(panels).toHaveLength(1);
    const hellos = panels[0].webview.sent.filter((m) => m.type === "hello");
    expect((hellos[0] as { sessionId?: string }).sessionId).toBe(tab.sessionId);
  });
});

// Deleting a chat used to remove its file and leave the conversation showing it
// running — so the next debounced save wrote the file straight back, and a CLI
// process kept burning on a chat the user believed was gone.
describe("deleting a chat ends the conversation showing it", () => {
  const sessionFile = (id: string) =>
    path.join(storage, "sessions", `${id}.json`);

  it("closes the tab it was open in", async () => {
    writeStoredSession("stored-1");
    const registry = new ConversationRegistry(fakeContext() as never);
    const sidebar = fakeTarget();
    const first = registry.create();
    registry.useSidebar(sidebar.target as never, first);
    first.attach(sidebar.target as never);
    sidebar.webview.route(() => registry.sidebarConversation() as never);
    registry.openInTab("stored-1");
    await settle();
    expect(registry.conversationFor("stored-1")).toBeDefined();

    sidebar.webview.deliver({ type: "deleteHistoryEntry", id: "stored-1" });
    await settle();

    expect(panels[0].disposed).toBe(1);
    expect(registry.conversationFor("stored-1")).toBeUndefined();
    expect(fs.existsSync(sessionFile("stored-1"))).toBe(false);
  });

  it("does not let a queued save write the file back", async () => {
    writeStoredSession("stored-1");
    const registry = new ConversationRegistry(fakeContext() as never);
    const sidebar = fakeTarget();
    const first = registry.create();
    registry.useSidebar(sidebar.target as never, first);
    first.attach(sidebar.target as never);
    sidebar.webview.route(() => registry.sidebarConversation() as never);
    const tab = registry.openInTab("stored-1");
    await settle();

    // Stand in for the conversation having just done anything at all: every
    // timeline event queues one of these, so a live chat almost always has one
    // in flight.
    (tab as unknown as { scheduleSave(): void }).scheduleSave();
    sidebar.webview.deliver({ type: "deleteHistoryEntry", id: "stored-1" });

    // Past the store's 400ms debounce — the window the resurrection happened in.
    await new Promise((r) => setTimeout(r, 600));
    expect(fs.existsSync(sessionFile("stored-1"))).toBe(false);
  });

  it("leaves a new chat on the sidebar when its own chat is deleted", async () => {
    writeStoredSession("stored-1");
    const registry = new ConversationRegistry(fakeContext() as never);
    const sidebar = fakeTarget();
    const host = registry.create();
    registry.useSidebar(sidebar.target as never, host);
    host.attach(sidebar.target as never, { resumeLastConversation: true });
    sidebar.webview.route(() => registry.sidebarConversation() as never);
    await settle();
    expect(host.sessionId).toBe("stored-1");

    sidebar.webview.deliver({ type: "deleteHistoryEntry", id: "stored-1" });
    await settle();

    // The sidebar cannot close itself, so the ending is a blank chat rather
    // than an empty surface still claiming to be the deleted conversation.
    expect(host.sessionId).not.toBe("stored-1");
    expect(host.hasWork).toBe(false);
    expect(registry.sidebarConversation()).toBe(host);
    expect(fs.existsSync(sessionFile("stored-1"))).toBe(false);
  });

  it("ignores a delete for a chat nobody has open", async () => {
    writeStoredSession("stored-1");
    writeStoredSession("stored-2");
    const registry = new ConversationRegistry(fakeContext() as never);
    const sidebar = fakeTarget();
    const host = registry.create();
    registry.useSidebar(sidebar.target as never, host);
    host.attach(sidebar.target as never, { resumeLastConversation: true });
    sidebar.webview.route(() => registry.sidebarConversation() as never);
    await settle();
    const before = host.sessionId;

    sidebar.webview.deliver({
      type: "deleteHistoryEntry",
      id: before === "stored-1" ? "stored-2" : "stored-1"
    });
    await settle();

    // Deleting someone else's chat must not disturb the one in front of you.
    expect(host.sessionId).toBe(before);
    expect(host.hasSurface).toBe(true);
  });
});

// Titles are derived from the first prompt, which is not how anyone thinks
// about a chat they keep open for a week.
describe("naming a conversation", () => {
  /** The last history list the surface was told about. */
  function lastList(sent: { type?: string }[]) {
    const lists = sent.filter((m) => m.type === "historyList");
    return (lists[lists.length - 1] as { sessions?: HistoryRow[] }).sessions;
  }

  /** The row as the host actually posts it: a stored entry, plus the `open`
   *  flag the registry adds for a session a conversation is holding. A local
   *  hand-copy of this drifted from the real type without anything noticing —
   *  `test/` was outside the type gate. */
  type HistoryRow = HistoryEntry & { open?: boolean };

  it("gives a stored chat a name that outranks its first prompt", async () => {
    writeStoredSession("stored-1", 2, "the auth token expires mid-turn");
    const registry = new ConversationRegistry(fakeContext() as never);
    const sidebar = fakeTarget();
    const host = registry.create();
    registry.useSidebar(sidebar.target as never, host);
    host.attach(sidebar.target as never);
    sidebar.webview.route(() => registry.sidebarConversation() as never);

    sidebar.webview.deliver({
      type: "renameSession",
      id: "stored-1",
      name: "Bugs"
    });
    await settle();

    const row = lastList(sidebar.webview.sent)?.find(
      (r) => r.id === "stored-1"
    );
    expect(row?.title).toBe("Bugs");
    expect(row?.named).toBe(true);
    // The snippet is suppressed when it would merely repeat the title. A name
    // says nothing about the conversation, so suppressing it there would leave
    // a row that is only a label.
    expect(row?.snippet).toBeTruthy();
  });

  it("clears a name back to the derived title", async () => {
    writeStoredSession("stored-1");
    const registry = new ConversationRegistry(fakeContext() as never);
    const sidebar = fakeTarget();
    const host = registry.create();
    registry.useSidebar(sidebar.target as never, host);
    host.attach(sidebar.target as never);
    sidebar.webview.route(() => registry.sidebarConversation() as never);

    sidebar.webview.deliver({
      type: "renameSession",
      id: "stored-1",
      name: "Bugs"
    });
    await settle();
    sidebar.webview.deliver({
      type: "renameSession",
      id: "stored-1",
      name: "   "
    });
    await settle();

    const row = lastList(sidebar.webview.sent)?.find(
      (r) => r.id === "stored-1"
    );
    // "hi" is the stored timeline's only user message.
    expect(row?.title).toBe("hi");
    expect(row?.named).toBe(false);
  });

  it("renames the tab of a conversation that is open", async () => {
    writeStoredSession("stored-1");
    const registry = new ConversationRegistry(fakeContext() as never);
    const sidebar = fakeTarget();
    const first = registry.create();
    registry.useSidebar(sidebar.target as never, first);
    first.attach(sidebar.target as never);
    sidebar.webview.route(() => registry.sidebarConversation() as never);
    registry.openInTab("stored-1");
    await settle();

    sidebar.webview.deliver({
      type: "renameSession",
      id: "stored-1",
      name: "Refactoring"
    });
    await settle();

    // A live conversation owns its own name: writing the file underneath it
    // would be overwritten by its next save, and its tab would keep the old one.
    expect(panels[0].title).toBe("Refactoring");
  });

  it("keeps the name when the conversation is reopened", async () => {
    writeStoredSession("stored-1");
    const registry = new ConversationRegistry(fakeContext() as never);
    const sidebar = fakeTarget();
    const host = registry.create();
    registry.useSidebar(sidebar.target as never, host);
    host.attach(sidebar.target as never);
    sidebar.webview.route(() => registry.sidebarConversation() as never);

    sidebar.webview.deliver({
      type: "renameSession",
      id: "stored-1",
      name: "Bugs"
    });
    await settle();
    sidebar.webview.deliver({ type: "loadSession", id: "stored-1" });
    await settle();
    sidebar.webview.deliver({ type: "requestHistory" });
    await settle();

    const row = lastList(sidebar.webview.sent)?.find(
      (r) => r.id === "stored-1"
    );
    expect(row?.title).toBe("Bugs");
  });

  it("tells the list which chats are open", async () => {
    writeStoredSession("stored-1");
    writeStoredSession("stored-2");
    const registry = new ConversationRegistry(fakeContext() as never);
    const sidebar = fakeTarget();
    const first = registry.create();
    registry.useSidebar(sidebar.target as never, first);
    first.attach(sidebar.target as never);
    sidebar.webview.route(() => registry.sidebarConversation() as never);
    registry.openInTab("stored-1");
    await settle();

    sidebar.webview.deliver({ type: "requestHistory" });
    await settle();

    const rows = lastList(sidebar.webview.sent);
    const held = rows?.find((r) => r.id === "stored-1");
    const idle = rows?.find((r) => r.id === "stored-2");
    expect(held?.open).toBe(true);
    expect(idle?.open).toBe(false);
    // Being open is not a state: both chats were left the same way, so both
    // report the same status regardless of which one a conversation holds.
    expect(held?.status).toBe("no-reply");
    expect(idle?.status).toBe("no-reply");
  });
});

// A conversation in a tab used to be gone after `Developer: Reload Window`:
// VS Code brought the tab back and had nobody to hand it to, so parallel work —
// the entire reason tabs exist — did not survive a reload. The session id
// travels in the webview's own persisted state, the only thing VS Code keeps.
describe("a tab's conversation survives a window reload", () => {
  /** Hand a panel back the way VS Code does on restore. */
  async function deserialize(state: unknown) {
    const panel = makePanel();
    panels.push(panel);
    await serializer.current?.deserializeWebviewPanel(panel, state);
    await settle();
    return panel;
  }

  it("registers a serializer for the tab's own view type", () => {
    new ConversationRegistry(fakeContext() as never);
    expect(serializer.viewType).toBe("luno.conversation");
    expect(serializer.current).toBeDefined();
  });

  it("puts the tab's conversation back behind it", async () => {
    writeStoredSession("stored-1");
    const registry = new ConversationRegistry(fakeContext() as never);

    await deserialize({ sessionId: "stored-1" });

    expect(registry.conversationFor("stored-1")).toBeDefined();
    expect(registry.conversationFor("stored-1")?.hasSurface).toBe(true);
  });

  it("tells the restored webview which conversation it settled on", async () => {
    writeStoredSession("stored-1");
    new ConversationRegistry(fakeContext() as never);

    const panel = await deserialize({ sessionId: "stored-1" });

    // Without this the webview would persist the empty session the host was
    // born with, and the *next* reload would restore a chat that was never
    // saved — the reload after the reload is where that shows up.
    const hellos = panel.webview.sent.filter((m) => m.type === "hello");
    const last = hellos[hellos.length - 1] as { sessionId?: string };
    expect(last.sessionId).toBe("stored-1");
  });

  it("comes back as a new chat when the id names nothing", async () => {
    const registry = new ConversationRegistry(fakeContext() as never);

    const panel = await deserialize({ sessionId: "deleted-while-closed" });

    // A tab the user still has open must not vanish because its chat was
    // deleted from another window.
    expect(panel.disposed).toBe(0);
    expect(registry.conversationFor("deleted-while-closed")).toBeUndefined();
  });

  it("survives a webview that persisted no id at all", async () => {
    const registry = new ConversationRegistry(fakeContext() as never);

    const panel = await deserialize(undefined);
    await deserialize({ sessionId: 42 });

    expect(panel.disposed).toBe(0);
    expect(panels[0].webview.html.length).toBeGreaterThan(0);
    expect(registry.attentionCount()).toBe(0);
  });

  it("does not open a second view onto a conversation already restored", async () => {
    writeStoredSession("stored-1");
    const registry = new ConversationRegistry(fakeContext() as never);
    const sidebar = fakeTarget();
    const first = registry.create();
    registry.useSidebar(sidebar.target as never, first);
    first.attach(sidebar.target as never, { resumeLastConversation: true });
    await settle();
    expect(first.sessionId).toBe("stored-1");

    const panel = await deserialize({ sessionId: "stored-1" });

    // Two hosts on one session would resume the same CLI session from two
    // processes, which is the contention this whole design exists to avoid.
    expect(registry.conversationFor("stored-1")).toBe(first);
    expect(panel.disposed).toBe(1);
    expect(sidebar.revealed).toBeGreaterThan(0);
  });

  it("leaves a restored tab's chat alone when the sidebar resumes", async () => {
    writeStoredSession("stored-1", 2);
    writeStoredSession("stored-2", 9);
    const registry = new ConversationRegistry(fakeContext() as never);

    // Restore happens during activation, before the sidebar view resolves.
    await deserialize({ sessionId: "stored-2" });

    const sidebar = registry.create();
    sidebar.attach(fakeTarget().target as never, {
      resumeLastConversation: true
    });
    await settle();

    // `stored-2` is the most recently updated, but a tab is already holding it,
    // so the sidebar takes the newest chat nobody else has.
    expect(sidebar.sessionId).toBe("stored-1");
  });
});

describe("switching away from a running conversation", () => {
  it("restores what streamed while the conversation was off screen", async () => {
    writeStoredSession("stored-1");
    const registry = new ConversationRegistry(fakeContext() as never);
    const sidebar = fakeTarget();
    const running = registry.create();
    registry.useSidebar(sidebar.target as never, running as never);
    running.attach(sidebar.target as never);

    // Drive the messages a live turn produces, without a real CLI.
    const host = running as unknown as { post: (m: unknown) => void };
    host.post({ type: "turnStart" });
    host.post({ type: "delta", delta: { type: "text", text: "half an " } });
    host.post({ type: "delta", delta: { type: "text", text: "answer" } });

    running.hide();
    sidebar.webview.sent.length = 0;
    running.show(sidebar.target as never);

    const kinds = typesOf(sidebar.webview.sent);
    // Coming back must show the turn still running and the text so far, not a
    // conversation that looks finished and empty.
    expect(kinds).toContain("loadedSession");
    expect(kinds).toContain("turnStart");
    const delta = sidebar.webview.sent.find((m) => m.type === "delta") as {
      delta?: { text?: string };
    };
    expect(delta?.delta?.text).toBe("half an answer");
  });

  it("drops the buffer once the text lands in the timeline", () => {
    const registry = new ConversationRegistry(fakeContext() as never);
    const sidebar = fakeTarget();
    const running = registry.create();
    registry.useSidebar(sidebar.target as never, running);
    running.attach(sidebar.target as never);

    const host = running as unknown as { post: (m: unknown) => void };
    host.post({ type: "turnStart" });
    host.post({ type: "delta", delta: { type: "text", text: "flushed" } });
    // The orchestrator writes a real assistant event once the text is settled.
    host.post({
      type: "timeline",
      event: { id: "a1", ts: 1, kind: "assistant", title: "A", body: "flushed" }
    });

    running.hide();
    sidebar.webview.sent.length = 0;
    running.show(sidebar.target as never);

    // Replaying the buffer here would print the answer twice: once from the
    // timeline, once from the buffer it was flushed out of.
    expect(sidebar.webview.sent.filter((m) => m.type === "delta")).toEqual([]);
  });
});

describe("the sidebar's listener follows its occupant", () => {
  it("answers into the sidebar after switching conversations", async () => {
    writeStoredSession("stored-1");
    writeStoredSession("stored-2");
    const registry = new ConversationRegistry(fakeContext() as never);
    const sidebar = fakeTarget();
    const first = registry.create();
    registry.useSidebar(sidebar.target as never, first);
    sidebar.webview.route(() => registry.sidebarConversation() as never);
    first.attach(sidebar.target as never);

    sidebar.webview.deliver({ type: "loadSession", id: "stored-1" });
    await settle();
    sidebar.webview.deliver({ type: "loadSession", id: "stored-2" });
    await settle();

    sidebar.webview.sent.length = 0;
    sidebar.webview.deliver({ type: "requestHistory" });
    await settle();

    // The reported failure: a listener bound to the conversation that happened
    // to be first kept receiving after the swap and answered into a webview it
    // no longer posted to — a history panel stuck on skeletons, and a composer
    // that swallowed every prompt.
    expect(typesOf(sidebar.webview.sent)).toContain("historyList");
  });

  it("does not let a conversation capture the surface it is attached to", () => {
    const registry = new ConversationRegistry(fakeContext() as never);
    const surface = fakeTarget();
    registry.create().attach(surface.target as never);

    surface.webview.sent.length = 0;
    // Nothing routed this surface, so nothing should be listening. A host that
    // registers its own listener would answer here and outlive its own tenancy.
    surface.webview.deliver({ type: "requestHistory" });

    expect(surface.webview.sent).toEqual([]);
  });
});
