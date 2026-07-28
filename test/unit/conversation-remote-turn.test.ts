import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// What this file guards: a turn typed on a phone is a turn here.
//
// With Remote Control on, both surfaces drive one long-lived CLI process, and
// everything that turn produces arrives on the out-of-turn seam — the panel
// never asked for it. Before this, only the bridge's own state was read there
// and the rest was dropped: the answer to a question the panel never saw.
//
// The three things that make it a real turn and not a transcript: it lands on
// the timeline, an approval it raises can be answered here, and Stop stops it.
const disposable = { dispose: () => {} };
const root = vi.hoisted(() => ({ path: "" }));
const settings = vi.hoisted(() => ({}) as Record<string, unknown>);

/** The out-of-turn sink the host handed the provider — the phone's end of the
 *  wire, as far as this test is concerned. */
const remote = vi.hoisted(
  () => ({}) as { push?: (d: Record<string, unknown>) => void }
);
/** Prompts the host asked the provider to send, in order. */
const sentPrompts = vi.hoisted(() => [] as string[]);
/** Permission answers routed back to the provider. */
const answered = vi.hoisted(() => [] as string[]);
const cancels = vi.hoisted(() => ({ count: 0 }));

vi.mock("../../src/providers/factory.js", () => ({
  createProvider: (ctx: { onOutOfTurn?: (d: unknown) => void }) => {
    remote.push = ctx.onOutOfTurn as (d: Record<string, unknown>) => void;
    return {
      id: "fake",
      // eslint-disable-next-line require-yield
      async *stream(req: { messages: { role: string; content: unknown }[] }) {
        const last = req.messages[req.messages.length - 1];
        if (last?.role === "user" && typeof last.content === "string") {
          sentPrompts.push(last.content);
        }
      },
      cancel() {
        cancels.count += 1;
      },
      respondToPermission(requestId: string, behavior: string) {
        answered.push(`${requestId}:${behavior}`);
      },
      updateOptions() {},
      enableRemoteControl: async () => ({
        state: "ready",
        sessionUrl: "https://claude.ai/code/session_test"
      }),
      disableRemoteControl: async () => {},
      remoteControlStatus: () => ({ state: "ready" })
    };
  },
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
    // The modal one is the Bypass confirmation, and it says yes: otherwise the
    // Bypass test would pass on that refusal and never reach the rule it is
    // supposed to be checking.
    showWarningMessage: async (_message: string, opts?: { modal?: boolean }) =>
      opts?.modal ? "Enable Bypass" : undefined,
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
  },
  env: { openExternal: async () => true }
}));

interface Posted {
  type?: string;
  event?: { kind?: string; body?: string };
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
  for (const key of Object.keys(settings)) delete settings[key];
  settings.worktree = "off";
  sentPrompts.length = 0;
  answered.length = 0;
  cancels.count = 0;
  remote.push = undefined;
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "luno-remote-storage-"));
  root.path = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "luno-remote-root-"))
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

const settle = () => new Promise((r) => setTimeout(r, 300));

/** A conversation with the bridge up and the out-of-turn sink captured. */
async function openWithBridge() {
  const registry = new ConversationRegistry(fakeContext() as never);
  const host = registry.create();
  const webview = makeWebview();
  host.attach({ webview, reveal: () => {} } as never, {});
  webview.route(() => host as never);
  webview.deliver({ type: "toggleRemoteControl", enabled: true });
  await settle();
  return { registry, host, webview };
}

const timeline = (webview: FakeWebview) =>
  webview.sent
    .filter((m) => m.type === "timeline")
    .map((m) => [m.event?.kind, m.event?.body]);

/** The posture the composer would be rendering from right now. */
const publishedMode = (webview: FakeWebview) =>
  webview.sent.filter((m) => m.type === "auth").at(-1)?.permissionMode;

const publishedBridge = (webview: FakeWebview) =>
  webview.sent.filter((m) => m.type === "remoteControl").at(-1)?.status as
    { state?: string } | undefined;

describe("a turn started on another device", () => {
  it("puts the phone's prompt and the answer on the timeline", async () => {
    const { webview } = await openWithBridge();
    expect(remote.push).toBeDefined();

    remote.push!({ type: "remote_prompt", prompt: "what changed today?" });
    remote.push!({ type: "text", text: "Two files." });
    remote.push!({ type: "done" });
    await settle();

    expect(timeline(webview)).toEqual([
      ["user", "what changed today?"],
      ["assistant", "Two files."]
    ]);
  });

  it("shows the panel as busy for the length of that turn", async () => {
    // Without this the composer looks idle while the CLI is working for
    // someone else, and anything typed here would race the phone's turn.
    const { webview } = await openWithBridge();
    remote.push!({ type: "remote_prompt", prompt: "hello" });
    await settle();
    expect(webview.sent.some((m) => m.type === "turnStart")).toBe(true);
    expect(webview.sent.some((m) => m.type === "turnEnd")).toBe(false);

    remote.push!({ type: "done" });
    await settle();
    expect(webview.sent.some((m) => m.type === "turnEnd")).toBe(true);
  });

  it("lets an approval it raised be answered from here", async () => {
    // Both surfaces get the prompt and either may answer it. The panel could
    // not answer at all while `activeProvider` was empty between turns.
    const { webview } = await openWithBridge();
    remote.push!({ type: "remote_prompt", prompt: "delete the temp dir" });
    remote.push!({
      type: "permission_request",
      permission: { requestId: "req-1", toolName: "Bash", input: {} }
    });
    await settle();
    expect(webview.sent.some((m) => m.type === "permissionRequest")).toBe(true);

    webview.deliver({
      type: "permissionResponse",
      requestId: "req-1",
      behavior: "deny"
    });
    expect(answered).toEqual(["req-1:deny"]);
    remote.push!({ type: "done" });
    await settle();
  });

  it("stops when the user presses Stop, without waiting for a result", async () => {
    // Stop interrupts the CLI, but a session that never reports the `result`
    // would otherwise leave the panel busy for good: there is no generator to
    // return from, only a source that went quiet.
    const { webview } = await openWithBridge();
    remote.push!({ type: "remote_prompt", prompt: "long job" });
    remote.push!({ type: "text", text: "Working" });
    await settle();

    webview.deliver({ type: "cancel" });
    await settle();
    expect(cancels.count).toBeGreaterThan(0);
    expect(webview.sent.some((m) => m.type === "turnEnd")).toBe(true);
  });

  it("sends what was typed here while the phone held the session", async () => {
    // The composer stays live during a remote turn, so what it accepts is
    // queued. Nothing else drains that queue — the local path only flushes
    // behind a turn it started itself.
    const { webview } = await openWithBridge();
    remote.push!({ type: "remote_prompt", prompt: "from the phone" });
    await settle();

    webview.deliver({ type: "prompt", text: "and from the panel" });
    await settle();
    expect(sentPrompts).toEqual([]);

    remote.push!({ type: "done" });
    await settle();
    expect(sentPrompts).toEqual(["and from the panel"]);
  });

  it("survives a second prompt arriving while the first is still open", async () => {
    // Two messages typed on the phone in a row. The CLI takes both and replays
    // the second with the first turn still running here; before this, the new
    // turn awaited an old one whose `done` was being delivered to a queue
    // nobody read any more, and the panel stayed busy for good.
    const { webview } = await openWithBridge();
    remote.push!({ type: "remote_prompt", prompt: "first" });
    remote.push!({ type: "text", text: "half an answer" });
    await settle();

    remote.push!({ type: "remote_prompt", prompt: "second" });
    remote.push!({ type: "text", text: "the second answer" });
    remote.push!({ type: "done" });
    await settle();

    expect(timeline(webview)).toEqual([
      ["user", "first"],
      ["assistant", "half an answer"],
      ["user", "second"],
      ["assistant", "the second answer"]
    ]);
    // And the panel is free again rather than parked on a turn that cannot end.
    expect(webview.sent.filter((m) => m.type === "turnEnd")).toHaveLength(2);
  });

  it("drops turn traffic that belongs to no turn", async () => {
    // A `result` tail from a turn that was already cancelled, arriving with
    // nothing on the timeline to attach it to.
    const { webview } = await openWithBridge();
    remote.push!({ type: "text", text: "orphan" });
    remote.push!({ type: "done" });
    await settle();
    expect(timeline(webview)).toEqual([]);
  });
});

describe("an approval answered on the other device", () => {
  it("takes the card off this surface", async () => {
    // Whoever answers first wins, and the CLI withdraws the request from the
    // loser. A card left standing would be answered into an id the CLI has
    // already forgotten.
    const { webview } = await openWithBridge();
    remote.push!({ type: "remote_prompt", prompt: "clean the branch" });
    remote.push!({
      type: "permission_request",
      permission: { requestId: "req-9", toolName: "Bash", input: {} }
    });
    await settle();

    remote.push!({
      type: "permission_resolved",
      requestId: "req-9",
      permission: { requestId: "req-9", toolName: "Bash", input: {} }
    });
    await settle();

    const resolved = webview.sent.filter(
      (m) => m.type === "permissionResolved"
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0].requestId).toBe("req-9");
    remote.push!({ type: "done" });
    await settle();
  });

  it("says on the timeline that a tool ran without being approved here", async () => {
    const { webview } = await openWithBridge();
    remote.push!({ type: "remote_prompt", prompt: "clean the branch" });
    remote.push!({
      type: "permission_resolved",
      requestId: "req-9",
      permission: { requestId: "req-9", toolName: "Bash", input: {} }
    });
    remote.push!({ type: "done" });
    await settle();

    expect(timeline(webview)).toContainEqual(["approval", "Bash"]);
  });

  it("does not restore the card when the panel is reopened", async () => {
    // The host replays a pending approval onto a surface that was showing
    // another chat. A withdrawn one must not come back with it.
    const { host, webview } = await openWithBridge();
    remote.push!({ type: "remote_prompt", prompt: "clean the branch" });
    remote.push!({
      type: "permission_request",
      permission: { requestId: "req-9", toolName: "Bash", input: {} }
    });
    await settle();
    remote.push!({ type: "permission_resolved", requestId: "req-9" });
    await settle();

    host.hide();
    const second = makeWebview();
    host.show({ webview: second, reveal: () => {} } as never);
    await settle();
    expect(second.sent.some((m) => m.type === "permissionRequest")).toBe(false);
    remote.push!({ type: "done" });
    await settle();
    void webview;
  });
});

describe("the ungated modes and the bridge are kept apart", () => {
  it("refuses Agent mode while a phone is connected", async () => {
    // `auto` auto-allows edits with no card on either surface: a device that is
    // not in the room could make the agent write files unapproved.
    const { webview } = await openWithBridge();
    const before = webview.sent.filter((m) => m.type === "auth").length;
    webview.deliver({ type: "setPermissionMode", mode: "auto" });
    await settle();

    expect(publishedMode(webview)).toBe("default");
    // Republished, not merely unchanged: the picker had already moved to the
    // mode it could not have and has to be put back.
    expect(
      webview.sent.filter((m) => m.type === "auth").length
    ).toBeGreaterThan(before);
    // And the refusal costs nothing else — the bridge is still up.
    expect(publishedBridge(webview)?.state).toBe("ready");
  });

  it("refuses Bypass even once its own confirmation said yes", async () => {
    const { webview } = await openWithBridge();
    webview.deliver({ type: "setPermissionMode", mode: "bypass" });
    await settle();

    expect(publishedMode(webview)).toBe("default");
  });

  it("still allows Plan, which gates harder rather than less", async () => {
    const { webview } = await openWithBridge();
    webview.deliver({ type: "setPermissionMode", mode: "plan" });
    await settle();

    expect(publishedMode(webview)).toBe("plan");
  });

  it("refuses to start the bridge from Agent mode, without flashing ready", async () => {
    settings.permissionMode = "auto";
    const registry = new ConversationRegistry(fakeContext() as never);
    const host = registry.create();
    const webview = makeWebview();
    host.attach({ webview, reveal: () => {} } as never, {});
    webview.route(() => host as never);
    webview.deliver({ type: "toggleRemoteControl", enabled: true });
    await settle();

    const states = webview.sent
      .filter((m) => m.type === "remoteControl")
      .map((m) => (m.status as { state?: string }).state);
    expect(states).toEqual(["off"]);
    void registry;
  });
});
