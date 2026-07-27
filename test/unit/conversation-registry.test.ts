import { describe, it, expect, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

// The extension host imports `vscode` at module load, which does not exist off
// a real editor. Only what the registry and a host touch while being built and
// attached is stubbed — anything missing surfaces as an import error rather
// than a silent pass, which is the point of keeping the stub this small.
const disposable = { dispose: () => {} };
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
    showWarningMessage: async () => undefined
  },
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

function fakeContext() {
  const storage = path.join(os.tmpdir(), "luno-registry-test");
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

/** A surface that records what a conversation posted to it. */
function fakeTarget() {
  const sent: { type?: string }[] = [];
  return {
    sent,
    target: {
      webview: {
        options: {},
        html: "",
        cspSource: "vscode-webview:",
        asWebviewUri: (u: unknown) => u,
        postMessage: (m: { type?: string }) => {
          sent.push(m);
          return Promise.resolve(true);
        },
        onDidReceiveMessage: () => disposable
      },
      reveal: () => {}
    }
  };
}

function typesOf(sent: { type?: string }[]): string[] {
  return sent.map((m) => m.type ?? "");
}

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

    expect(typesOf(first.sent)).toContain("models");
    expect(typesOf(second.sent)).toContain("models");
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
    kept.sent.length = 0;
    closed.sent.length = 0;
    registry.broadcast({ type: "models", models: [] });

    expect(typesOf(kept.sent)).toContain("models");
    expect(closed.sent).toEqual([]);
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
    const hellos = first.sent.filter((m) => m.type === "hello");
    expect(hellos).toHaveLength(1);
    expect((hellos[0] as { sessionId?: string }).sessionId).not.toBe(
      secondHost.sessionId
    );
  });
});
