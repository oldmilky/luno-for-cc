import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

// The hazard this file exists for: a conversation can be given its own checkout
// and still spawn the CLI in the shared one. That failure is silent — the agent
// edits the files everybody else is editing, which is precisely what isolation
// was turned on to prevent — so the spawn's `cwd` is asserted directly.
const disposable = { dispose: () => {} };
const repo = vi.hoisted(() => ({ root: "" }));
const spawned = vi.hoisted(() => [] as { cwd: string }[]);

vi.mock("../../src/providers/factory.js", () => ({
  createProvider: (opts: { cwd: string }) => {
    spawned.push(opts);
    return {
      id: "fake",
      // eslint-disable-next-line require-yield
      async *stream() {
        return;
      }
    };
  },
  resolveClaudeBinary: () => "claude"
}));

vi.mock("vscode", () => ({
  workspace: {
    get workspaceFolders() {
      return repo.root
        ? [{ uri: { fsPath: repo.root }, name: "repo" }]
        : undefined;
    },
    getConfiguration: () => ({
      get: (_key: string, fallback?: unknown) => fallback,
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
    })
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

interface FakeWebview {
  options: unknown;
  html: string;
  cspSource: string;
  asWebviewUri(u: unknown): unknown;
  postMessage(m: unknown): Promise<boolean>;
  onDidReceiveMessage(cb: (m: unknown) => void): { dispose(): void };
  /** Bind this surface to whoever occupies it, the way the panel does. */
  route(pick: () => { receiveMessage(m: never): void } | undefined): void;
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
    route: (pick: () => { receiveMessage(m: never): void } | undefined) => {
      handler = (m: unknown) => pick()?.receiveMessage(m as never);
    },
    deliver: (m: unknown) => handler?.(m)
  };
});

const { ConversationRegistry } =
  await import("../../src/ui/conversation-registry.js");
const { WORKTREE_DIR } = await import("../../src/services/worktree.js");

let storage: string;

beforeEach(() => {
  spawned.length = 0;
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "luno-wt-storage-"));
  repo.root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "luno-wt-repo-"))
  );
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: repo.root, encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo.root, "app.ts"), "export const a = 1;\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
});

afterEach(() => {
  fs.rmSync(storage, { recursive: true, force: true });
  fs.rmSync(repo.root, { recursive: true, force: true });
  repo.root = "";
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

function fakeTarget() {
  const webview = makeWebview();
  return { webview, target: { webview, reveal: () => {} } };
}

const settle = () => new Promise((r) => setTimeout(r, 400));

describe("worktree isolation", () => {
  it("runs an isolated conversation's CLI inside its own checkout", async () => {
    const registry = new ConversationRegistry(fakeContext() as never);
    const host = registry.create();
    const surface = fakeTarget();
    host.attach(surface.target as never, { isolate: true });
    surface.webview.route(() => host as never);

    surface.webview.deliver({ type: "prompt", text: "hello" });
    await settle();

    expect(spawned).toHaveLength(1);
    const cwd = spawned[0].cwd;
    expect(cwd).toContain(WORKTREE_DIR);
    expect(fs.existsSync(path.join(cwd, "app.ts"))).toBe(true);
    // The checkout is a real worktree of this repository, not a stray copy.
    expect(fs.existsSync(path.join(cwd, ".git"))).toBe(true);
  });

  it("leaves a plain conversation in the folder the editor has open", async () => {
    const registry = new ConversationRegistry(fakeContext() as never);
    const host = registry.create();
    const surface = fakeTarget();
    host.attach(surface.target as never);
    surface.webview.route(() => host as never);

    surface.webview.deliver({ type: "prompt", text: "hello" });
    await settle();

    expect(spawned).toHaveLength(1);
    expect(spawned[0].cwd).toBe(repo.root);
  });

  it("keeps one checkout across turns rather than a tree per prompt", async () => {
    const registry = new ConversationRegistry(fakeContext() as never);
    const host = registry.create();
    const surface = fakeTarget();
    host.attach(surface.target as never, { isolate: true });
    surface.webview.route(() => host as never);

    surface.webview.deliver({ type: "prompt", text: "one" });
    await settle();
    surface.webview.deliver({ type: "prompt", text: "two" });
    await settle();

    expect(spawned).toHaveLength(2);
    expect(spawned[1].cwd).toBe(spawned[0].cwd);
  });

  it("gives the checkout back when the conversation closes", async () => {
    const registry = new ConversationRegistry(fakeContext() as never);
    const host = registry.create();
    const surface = fakeTarget();
    host.attach(surface.target as never, { isolate: true });
    surface.webview.route(() => host as never);

    surface.webview.deliver({ type: "prompt", text: "hello" });
    await settle();
    const cwd = spawned[0].cwd;
    expect(fs.existsSync(cwd)).toBe(true);

    registry.close(host);
    await settle();

    // Nothing was written in it, so nothing is lost by removing it.
    expect(fs.existsSync(cwd)).toBe(false);
  });

  it("keeps a checkout that still holds uncommitted work", async () => {
    const registry = new ConversationRegistry(fakeContext() as never);
    const host = registry.create();
    const surface = fakeTarget();
    host.attach(surface.target as never, { isolate: true });
    surface.webview.route(() => host as never);

    surface.webview.deliver({ type: "prompt", text: "hello" });
    await settle();
    const cwd = spawned[0].cwd;
    fs.writeFileSync(path.join(cwd, "app.ts"), "export const a = 99;\n");

    registry.close(host);
    await settle();

    // Closing a tab must not throw away what the agent did in it.
    expect(fs.existsSync(cwd)).toBe(true);
  });
});
