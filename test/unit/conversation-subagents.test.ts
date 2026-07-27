import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// What this file guards: which half of a subagent's life is worth keeping.
//
// The CLI reports four `task_*` events per agent, and persisting all of them
// would grow the timeline by a row per nested tool call — hundreds for a fleet,
// none of which mean anything once the run is over. So the dispatch and the
// answer go on the timeline and the middle does not, and the turn-end sweep
// exists because the CLI process dies with the turn: a card still spinning
// after that is claiming work that nothing is doing.
const disposable = { dispose: () => {} };
const root = vi.hoisted(() => ({ path: "" }));
const settings = vi.hoisted(() => ({}) as Record<string, unknown>);

/** Deltas the fake provider yields for the next turn, in order. */
const script = vi.hoisted(() => [] as unknown[]);

vi.mock("../../src/providers/factory.js", () => ({
  createProvider: () => ({
    id: "fake",
    async *stream() {
      for (const delta of script) yield delta as never;
    },
    cancel() {}
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
  event?: { kind?: string; title?: string; body?: string; meta?: Posted };
  task?: Record<string, unknown>;
  [k: string]: unknown;
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
  script.length = 0;
  for (const key of Object.keys(settings)) delete settings[key];
  settings.worktree = "off";
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "luno-agent-storage-"));
  root.path = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "luno-agent-root-"))
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

const settle = () => new Promise((r) => setTimeout(r, 300));

const TASK = "ad0748687a4aac2a8";
const PARENT = "toolu_01VHk67cxKJ2HnTpAptXs4Xk";

const started = {
  type: "task",
  task: {
    phase: "started",
    taskId: TASK,
    toolUseId: PARENT,
    subagentType: "Explore",
    description: "Find makeProcessor definition",
    prompt: "Search the codebase under src for makeProcessor."
  }
};

const progress = {
  type: "task",
  task: {
    phase: "progress",
    taskId: TASK,
    activity: "Searching for makeProcessor",
    lastToolName: "Grep",
    toolUses: 1,
    durationMs: 4_956
  }
};

// Verbatim in shape from 2.1.220: the terminal status arrives on `task_updated`
// with no tool_use_id at all, one event before the summary does.
const updated = {
  type: "task",
  task: { phase: "updated", taskId: TASK, status: "completed" }
};

const notification = {
  type: "task",
  task: {
    phase: "notification",
    taskId: TASK,
    toolUseId: PARENT,
    status: "completed",
    summary: "src/providers/claude-cli.ts",
    toolUses: 1,
    durationMs: 13_400
  }
};

/** Every `subagent` row the surface was told to put on the timeline. */
const cards = (w: FakeWebview) =>
  w.sent
    .filter((m) => m.type === "timeline" && m.event?.kind === "subagent")
    .map((m) => m.event!);

const progressPosts = (w: FakeWebview) =>
  w.sent.filter((m) => m.type === "subagentProgress");

describe("subagents on the timeline", () => {
  it("opens a card when the agent is dispatched", async () => {
    script.push(started);
    const { webview } = open();
    webview.deliver({ type: "prompt", text: "find it" });
    await settle();

    const opened = cards(webview)[0];
    expect(opened.title).toBe("Agent: Explore");
    expect(opened.body).toBe("Find makeProcessor definition");
    expect(opened.meta).toMatchObject({
      phase: "start",
      taskId: TASK,
      toolUseId: PARENT,
      status: "running",
      prompt: "Search the codebase under src for makeProcessor."
    });
  });

  // Progress is the half that stops meaning anything the moment the run ends.
  // It reaches the surface, but never the stored timeline.
  it("sends live progress without writing it down", async () => {
    script.push(started, progress);
    const { webview } = open();
    webview.deliver({ type: "prompt", text: "find it" });
    await settle();

    // One row for the dispatch and one for the sweep closing it — never one
    // for the progress in between, which is the whole point.
    const phases = cards(webview).map((r) => r.meta?.phase);
    expect(phases).toEqual(["start", "end"]);
    expect(progressPosts(webview)[0].task).toMatchObject({
      taskId: TASK,
      activity: "Searching for makeProcessor",
      lastToolName: "Grep",
      // Carried over from the dispatch: `task_progress` names neither the agent
      // nor the task, so an unmerged update would blank both on the card.
      subagentType: "Explore",
      description: "Find makeProcessor definition"
    });
  });

  // `task_updated` reports "completed" first, but only `task_notification`
  // carries the answer — closing on the earlier one would file an empty card.
  it("closes the card on the answer, not on the status that precedes it", async () => {
    script.push(started, progress, updated, notification);
    const { webview } = open();
    webview.deliver({ type: "prompt", text: "find it" });
    await settle();

    const rows = cards(webview);
    expect(rows).toHaveLength(2);
    expect(rows[1].body).toBe("src/providers/claude-cli.ts");
    expect(rows[1].meta).toMatchObject({
      phase: "end",
      status: "completed",
      summary: "src/providers/claude-cli.ts",
      toolUses: 1,
      durationMs: 13_400,
      // Still the label it was dispatched with, not what it was doing a moment
      // before it stopped.
      description: "Find makeProcessor definition"
    });
  });

  // The CLI process does not outlive the turn, so an agent that never reported
  // a terminal status did not keep running — it died with the turn.
  it("closes an agent the turn ended under rather than leaving it spinning", async () => {
    script.push(started, progress);
    const { webview } = open();
    webview.deliver({ type: "prompt", text: "find it" });
    await settle();

    const rows = cards(webview);
    expect(rows).toHaveLength(2);
    expect(rows[1].meta).toMatchObject({
      phase: "end",
      status: "interrupted",
      taskId: TASK
    });
  });

  it("leaves a finished agent alone at turn end", async () => {
    script.push(started, updated, notification);
    const { webview } = open();
    webview.deliver({ type: "prompt", text: "find it" });
    await settle();

    const rows = cards(webview);
    expect(rows).toHaveLength(2);
    expect(rows[1].meta).toMatchObject({ status: "completed" });
  });

  it("keeps two agents apart", async () => {
    const second = "bb1859798b5bbd3b9";
    script.push(
      started,
      {
        type: "task",
        task: {
          phase: "started",
          taskId: second,
          toolUseId: "toolu_second",
          subagentType: "general-purpose",
          description: "Check the tests"
        }
      },
      notification,
      {
        type: "task",
        task: {
          phase: "notification",
          taskId: second,
          status: "failed",
          summary: "could not run the suite"
        }
      }
    );
    const { webview } = open();
    webview.deliver({ type: "prompt", text: "do both" });
    await settle();

    const rows = cards(webview);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.meta?.taskId)).toEqual([
      TASK,
      second,
      TASK,
      second
    ]);
    expect(rows[3].meta).toMatchObject({
      status: "failed",
      subagentType: "general-purpose",
      description: "Check the tests"
    });
  });
});
