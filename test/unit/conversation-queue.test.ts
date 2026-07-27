import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// What this file guards: sending during a turn must never cost the turn. The
// old behaviour killed it and started over, and the composer's `busy` gate was
// the only thing standing between a user and that. With the gate gone, the
// host is the whole safety net — so every path that ends a turn is asserted
// here, not just the happy one.
const disposable = { dispose: () => {} };
const root = vi.hoisted(() => ({ path: "" }));
const settings = vi.hoisted(() => ({}) as Record<string, unknown>);

/** Turns the fake provider has been asked to run, in order. Each holds its own
 *  release, so a test can keep a turn open for exactly as long as it needs. */
const turns = vi.hoisted(
  () =>
    [] as {
      release: () => void;
      fail: (message: string) => void;
      done: Promise<void>;
    }[]
);

vi.mock("../../src/providers/factory.js", () => ({
  createProvider: () => ({
    id: "fake",
    async *stream() {
      let release!: () => void;
      let fail!: (message: string) => void;
      let failure: string | undefined;
      const done = new Promise<void>((resolve) => {
        release = () => resolve();
        fail = (message: string) => {
          failure = message;
          resolve();
        };
      });
      turns.push({ release, fail, done });
      await done;
      if (failure) throw new Error(failure);
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

interface Posted {
  type?: string;
  text?: string;
}

interface FakeWebview {
  options: unknown;
  html: string;
  cspSource: string;
  asWebviewUri(u: unknown): unknown;
  postMessage(m: Posted): Promise<boolean>;
  onDidReceiveMessage(cb: (m: unknown) => void): { dispose(): void };
  route(pick: () => { receiveMessage(m: never): void } | undefined): void;
  sent: Posted[];
  deliver(m: unknown): void;
}

const makeWebview = vi.hoisted(() => (): FakeWebview => {
  const sent: Posted[] = [];
  let handler: ((m: unknown) => void) | undefined;
  return {
    options: {},
    html: "",
    cspSource: "vscode-webview:",
    asWebviewUri: (u: unknown) => u,
    postMessage: (m: Posted) => {
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

const { ConversationRegistry } =
  await import("../../src/ui/conversation-registry.js");

let storage: string;

beforeEach(() => {
  turns.length = 0;
  for (const key of Object.keys(settings)) delete settings[key];
  settings.worktree = "off";
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "luno-queue-storage-"));
  root.path = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "luno-queue-root-"))
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

function open() {
  const registry = new ConversationRegistry(fakeContext() as never);
  const host = registry.create();
  const webview = makeWebview();
  host.attach({ webview, reveal: () => {} } as never, {});
  webview.route(() => host as never);
  return { registry, host, webview };
}

const settle = () => new Promise((r) => setTimeout(r, 250));

/** The last `queued` the surface was told about — "" once the queue drains. */
const queuedNow = (w: FakeWebview): string | undefined =>
  [...w.sent].reverse().find((m) => m.type === "queued")?.text;

describe("sending while a turn is running", () => {
  it("queues the follow-up instead of starting a second turn", async () => {
    const { webview } = open();
    webview.deliver({ type: "prompt", text: "first" });
    await settle();
    expect(turns).toHaveLength(1);

    webview.deliver({ type: "prompt", text: "and check the tests" });
    await settle();

    // Still the one turn: the running one was neither cancelled nor doubled.
    expect(turns).toHaveLength(1);
    expect(queuedNow(webview)).toBe("and check the tests");
  });

  it("merges everything typed during one turn into a single message", async () => {
    const { webview } = open();
    webview.deliver({ type: "prompt", text: "first" });
    await settle();

    webview.deliver({ type: "prompt", text: "and check the tests" });
    webview.deliver({ type: "prompt", text: "no new dependencies" });
    await settle();

    expect(queuedNow(webview)).toBe(
      "and check the tests\n\nno new dependencies"
    );
    expect(turns).toHaveLength(1);
  });

  it("sends the queue as its own turn once the running one ends", async () => {
    const { webview } = open();
    webview.deliver({ type: "prompt", text: "first" });
    await settle();
    webview.deliver({ type: "prompt", text: "and check the tests" });
    await settle();

    turns[0].release();
    await settle();

    expect(turns).toHaveLength(2);
    expect(queuedNow(webview)).toBe("");
  });

  it("keeps queueing while the follow-up's own turn runs", async () => {
    const { webview } = open();
    webview.deliver({ type: "prompt", text: "first" });
    await settle();
    webview.deliver({ type: "prompt", text: "second" });
    await settle();
    turns[0].release();
    await settle();

    // Turn two is now the one in flight; a third message waits on it.
    webview.deliver({ type: "prompt", text: "third" });
    await settle();
    expect(turns).toHaveLength(2);
    expect(queuedNow(webview)).toBe("third");

    turns[1].release();
    await settle();
    expect(turns).toHaveLength(3);
  });

  it("shows a re-attached surface what is still waiting", async () => {
    const { host, webview } = open();
    webview.deliver({ type: "prompt", text: "first" });
    await settle();
    webview.deliver({ type: "prompt", text: "and check the tests" });
    await settle();

    const second = makeWebview();
    host.show({ webview: second, reveal: () => {} } as never);

    expect(queuedNow(second)).toBe("and check the tests");
  });
});

describe("a queue that never gets sent", () => {
  it("comes back to the composer when the turn is stopped", async () => {
    const { webview } = open();
    webview.deliver({ type: "prompt", text: "first" });
    await settle();
    webview.deliver({ type: "prompt", text: "and check the tests" });
    await settle();

    webview.deliver({ type: "cancel" });
    await settle();

    const returned = webview.sent.find((m) => m.type === "returnToComposer");
    expect(returned?.text).toBe("and check the tests");
    expect(queuedNow(webview)).toBe("");
    // Nothing was sent on the user's behalf: still just the stopped turn.
    expect(turns).toHaveLength(1);
  });

  it("comes back to the composer when the turn fails", async () => {
    const { webview } = open();
    webview.deliver({ type: "prompt", text: "first" });
    await settle();
    webview.deliver({ type: "prompt", text: "and check the tests" });
    await settle();

    turns[0].fail("stream broke");
    await settle();

    const returned = webview.sent.find((m) => m.type === "returnToComposer");
    expect(returned?.text).toBe("and check the tests");
    expect(turns).toHaveLength(1);
  });

  it("is discarded, not returned, when the user dismisses it", async () => {
    const { webview } = open();
    webview.deliver({ type: "prompt", text: "first" });
    await settle();
    webview.deliver({ type: "prompt", text: "and check the tests" });
    await settle();

    webview.deliver({ type: "dropQueued" });
    await settle();
    turns[0].release();
    await settle();

    expect(queuedNow(webview)).toBe("");
    expect(webview.sent.some((m) => m.type === "returnToComposer")).toBe(false);
    expect(turns).toHaveLength(1);
  });

  it("does not follow the user into a new chat", async () => {
    const { webview } = open();
    webview.deliver({ type: "prompt", text: "first" });
    await settle();
    webview.deliver({ type: "prompt", text: "and check the tests" });
    await settle();

    webview.deliver({ type: "newSession" });
    await settle();

    expect(queuedNow(webview)).toBe("");
    expect(webview.sent.some((m) => m.type === "returnToComposer")).toBe(false);
  });
});

describe("two conversations", () => {
  it("keep their queues to themselves", async () => {
    const registry = new ConversationRegistry(fakeContext() as never);
    const one = registry.create();
    const two = registry.create();
    const wOne = makeWebview();
    const wTwo = makeWebview();
    one.attach({ webview: wOne, reveal: () => {} } as never, {});
    two.attach({ webview: wTwo, reveal: () => {} } as never, {});
    wOne.route(() => one as never);
    wTwo.route(() => two as never);

    wOne.deliver({ type: "prompt", text: "first" });
    wTwo.deliver({ type: "prompt", text: "first" });
    await settle();

    wOne.deliver({ type: "prompt", text: "only for one" });
    await settle();

    expect(queuedNow(wOne)).toBe("only for one");
    expect(queuedNow(wTwo)).toBeUndefined();
  });
});
