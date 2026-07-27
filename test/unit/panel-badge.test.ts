import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The badge is the only thing that speaks for a conversation the user cannot
// see, so a stale one is worse than none: it says "answer me" about a chat that
// has nothing to ask. What makes it stale is routing — the sidebar is a fixed
// surface whose occupant changes, and telling the wrong conversation that the
// user is looking at it leaves the right one marked forever.
const disposable = { dispose: () => {} };
const root = vi.hoisted(() => ({ path: "" }));
const settings = vi.hoisted(() => ({}) as Record<string, unknown>);

/** Turns the fake provider was asked to run; each ends when released. */
const turns = vi.hoisted(() => [] as { release: () => void }[]);

vi.mock("../../src/providers/factory.js", () => ({
  createProvider: () => ({
    id: "fake",
    async *stream() {
      let release!: () => void;
      const done = new Promise<void>((resolve) => {
        release = () => resolve();
      });
      turns.push({ release });
      await done;
      yield { type: "text", text: "ok" } as never;
    },
    cancel() {
      turns[turns.length - 1]?.release();
    }
  }),
  resolveClaudeBinary: () => "claude"
}));

vi.mock("vscode", () => ({
  workspace: {
    get workspaceFolders() {
      return root.path
        ? [{ uri: { fsPath: root.path }, name: "repo" }]
        : undefined;
    },
    getConfiguration: () => ({
      get: (key: string, fallback?: unknown) => settings[key] ?? fallback,
      inspect: () => undefined,
      update: async () => {}
    }),
    onDidChangeConfiguration: () => disposable,
    asRelativePath: (p: unknown) => String(p),
    createFileSystemWatcher: () => ({
      onDidChange: () => disposable,
      onDidCreate: () => disposable,
      onDidDelete: () => disposable,
      dispose: () => {}
    })
  },
  window: {
    activeTextEditor: undefined,
    visibleTextEditors: [] as unknown[],
    createTextEditorDecorationType: () => disposable,
    onDidChangeActiveTextEditor: () => disposable,
    onDidChangeTextEditorSelection: () => disposable,
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    createWebviewPanel: () => ({
      webview: makeWebview(),
      title: "",
      iconPath: undefined as unknown,
      reveal: () => {},
      onDidChangeViewState: () => disposable,
      onDidDispose: () => disposable,
      dispose: () => {}
    }),
    registerWebviewPanelSerializer: () => disposable
  },
  commands: { executeCommand: async () => undefined },
  ViewColumn: { Active: -1 },
  OverviewRulerLane: { Right: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  RelativePattern: class {
    constructor(
      public base: unknown,
      public pattern: string
    ) {}
  },
  Uri: {
    file: (p: string) => ({ fsPath: p, toString: () => p }),
    joinPath: (base: { fsPath: string }, ...parts: string[]) => {
      const joined = [base.fsPath, ...parts].join("/");
      return { fsPath: joined, toString: () => joined };
    }
  }
}));

interface FakeWebview {
  options: unknown;
  html: string;
  cspSource: string;
  asWebviewUri(u: unknown): unknown;
  postMessage(m: unknown): Promise<boolean>;
  onDidReceiveMessage(cb: (m: unknown) => void): { dispose(): void };
  deliver(m: unknown): void;
}

const makeWebview = vi.hoisted(() => (): FakeWebview => {
  let handler: ((m: unknown) => void) | undefined;
  return {
    options: {},
    html: "",
    cspSource: "vscode-webview:",
    asWebviewUri: (u: unknown) => u,
    postMessage: () => Promise.resolve(true),
    onDidReceiveMessage: (cb: (m: unknown) => void) => {
      handler = cb;
      return disposable;
    },
    deliver: (m: unknown) => handler?.(m)
  };
});

const { ChatPanelProvider } = await import("../../src/ui/panel.js");

let storage: string;

beforeEach(() => {
  turns.length = 0;
  for (const key of Object.keys(settings)) delete settings[key];
  settings.worktree = "off";
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "luno-badge-storage-"));
  root.path = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "luno-badge-root-"))
  );
});

afterEach(() => {
  fs.rmSync(storage, { recursive: true, force: true });
  fs.rmSync(root.path, { recursive: true, force: true });
  root.path = "";
});

function fakeContext() {
  return {
    subscriptions: [] as { dispose(): void }[],
    extensionUri: { fsPath: "/ext", toString: () => "/ext" },
    globalStorageUri: { fsPath: storage, toString: () => storage },
    globalState: {
      // Passes the turn's credential gate without a token: the CLI is treated
      // as holding its own creds.
      get: (key: string, d?: unknown) =>
        key === "luno.claudeCredsReady.v1" ? true : d,
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

/** The sidebar view, with the one control the real one gives us: it can be
 *  hidden and shown, and it carries the badge. */
function fakeView() {
  const webview = makeWebview();
  let onVisibility: (() => void) | undefined;
  const view = {
    webview,
    visible: true,
    badge: undefined as { value: number; tooltip: string } | undefined,
    show: () => {},
    onDidChangeVisibility: (cb: () => void) => {
      onVisibility = cb;
      return disposable;
    },
    /** What VS Code does when the user moves between view tabs. */
    setVisible(next: boolean) {
      view.visible = next;
      onVisibility?.();
    }
  };
  return view;
}

const settle = () => new Promise((r) => setTimeout(r, 250));

describe("the sidebar badge", () => {
  it("clears when the user looks at the chat that finished off screen", async () => {
    const provider = new ChatPanelProvider(fakeContext() as never);
    const view = fakeView();
    provider.resolveWebviewView(view as never);

    // The first conversation has to end up with work in it, or New Chat reuses
    // it in place and the sidebar never changes occupant — which is the whole
    // condition this guards.
    view.webview.deliver({ type: "prompt", text: "first" });
    await settle();
    turns[0].release();
    await settle();

    provider.newSession();
    await settle();

    // The user moves to another view, and the second conversation finishes
    // while nobody is watching.
    view.setVisible(false);
    view.webview.deliver({ type: "prompt", text: "second" });
    await settle();
    turns[1].release();
    await settle();

    expect(view.badge?.value).toBe(1);
    expect(view.badge?.tooltip).toBe("1 chat finished while you were away");

    view.setVisible(true);
    await settle();

    expect(view.badge).toBeUndefined();
  });

  it("counts nothing while the user is watching the turn", async () => {
    const provider = new ChatPanelProvider(fakeContext() as never);
    const view = fakeView();
    provider.resolveWebviewView(view as never);

    view.webview.deliver({ type: "prompt", text: "first" });
    await settle();
    turns[0].release();
    await settle();

    expect(view.badge).toBeUndefined();
  });
});
