import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The extension host imports `vscode` at module load, which does not exist off
// a real editor. Only what the registry and a host touch while being built and
// attached is stubbed — anything missing surfaces as an import error rather
// than a silent pass, which is the point of keeping the stub this small.
const disposable = { dispose: () => {} };

/** Panels the code under test asked VS Code to create, newest last. */
const panels = vi.hoisted(
  () => [] as { webview: FakeWebview; revealed: number }[]
);

interface FakeWebview {
  options: unknown;
  html: string;
  cspSource: string;
  asWebviewUri(u: unknown): unknown;
  postMessage(m: { type?: string }): Promise<boolean>;
  onDidReceiveMessage(cb: (m: unknown) => void): { dispose(): void };
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
    sent,
    deliver: (m: unknown) => handler?.(m)
  };
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
      const webview = makeWebview();
      const panel = {
        webview,
        revealed: 0,
        iconPath: undefined as unknown,
        title: "",
        reveal() {
          panel.revealed++;
        },
        onDidChangeViewState: () => disposable,
        onDidDispose: () => disposable,
        dispose: () => {}
      };
      panels.push(panel);
      return panel;
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

/** A stored conversation on disk, the way HistoryService writes one. */
function writeStoredSession(id: string): void {
  const dir = path.join(storage, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      title: "Stored chat",
      createdAt: 1,
      updatedAt: 2,
      messages: [{ role: "user", content: "hi" }],
      timeline: [{ id: "e1", ts: 1, kind: "user", title: "user", body: "hi" }]
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

  it("opens a picked chat beside a conversation that has work in it", async () => {
    writeStoredSession("stored-1");
    const registry = new ConversationRegistry(fakeContext() as never);
    const busy = fakeTarget();
    const busyHost = registry.create();
    busyHost.attach(busy.target as never);
    // Give it a conversation of its own to be protective of.
    writeStoredSession("stored-2");
    busy.webview.deliver({ type: "loadSession", id: "stored-2" });
    await settle();
    expect(busyHost.sessionId).toBe("stored-2");

    busy.webview.sent.length = 0;
    busy.webview.deliver({ type: "loadSession", id: "stored-1" });
    await settle();

    // The chat the user was in keeps its session — replacing it in place is
    // what used to kill a running turn.
    expect(busyHost.sessionId).toBe("stored-2");
    expect(typesOf(busy.webview.sent)).not.toContain("loadedSession");
    // The picked one opened next to it instead.
    expect(registry.conversationFor("stored-1")).toBeDefined();
    expect(panels).toHaveLength(1);
  });

  it("reuses a blank conversation rather than opening a tab for it", async () => {
    writeStoredSession("stored-1");
    const registry = new ConversationRegistry(fakeContext() as never);
    const blank = fakeTarget();
    const blankHost = registry.create();
    blankHost.attach(blank.target as never);

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
