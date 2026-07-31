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
/** Messages written into a turn already running — the panel talking over the
 *  phone's shoulder, into the same session. */
const steered = vi.hoisted(() => [] as string[]);
/** Permission answers routed back to the provider. */
const answered = vi.hoisted(() => [] as string[]);
const answeredOpts = vi.hoisted(() => [] as unknown[]);
const cancels = vi.hoisted(() => ({ count: 0 }));
/** Deltas the fake provider yields on the next panel turn — the other seam,
 *  reached only while a turn holds the sink. `remote.push` is its opposite. */
const turnDeltas = vi.hoisted(() => [] as Record<string, unknown>[]);
/** Permission modes pushed onto the live process at pick time, in order. */
const livePushes = vi.hoisted(() => [] as string[]);
/** Models pushed the same way. */
const liveModels = vi.hoisted(() => [] as string[]);

vi.mock("../../src/providers/factory.js", () => ({
  createProvider: (ctx: { onOutOfTurn?: (d: unknown) => void }) => {
    remote.push = ctx.onOutOfTurn as (d: Record<string, unknown>) => void;
    return {
      id: "fake",
      async *stream(req: { messages: { role: string; content: unknown }[] }) {
        const last = req.messages[req.messages.length - 1];
        if (last?.role === "user" && typeof last.content === "string") {
          sentPrompts.push(last.content);
        }
        for (const delta of turnDeltas.splice(0)) yield delta as never;
      },
      steer(text: string) {
        steered.push(text);
        return true;
      },
      cancel() {
        cancels.count += 1;
      },
      respondToPermission(requestId: string, behavior: string, opts?: unknown) {
        answered.push(`${requestId}:${behavior}`);
        answeredOpts.push(opts);
      },
      updateOptions() {},
      setLivePermissionMode: async (mode: string) => {
        livePushes.push(mode);
      },
      setLiveModel: async (model: string) => {
        liveModels.push(model);
      },
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
  steered.length = 0;
  answered.length = 0;
  answeredOpts.length = 0;
  cancels.count = 0;
  remote.push = undefined;
  turnDeltas.length = 0;
  livePushes.length = 0;
  liveModels.length = 0;
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
    { state?: string; sessionUrl?: string } | undefined;

describe("a permission mode picked while the phone is driving", () => {
  it("reaches the live process at pick time, not at the next panel turn", async () => {
    // `beginRemoteTurn` goes straight to `Orchestrator.observe` — no argv, no
    // `ensureSession`, no fingerprint. Left to the next panel turn, the CLI
    // keeps running under the mode it was spawned with while the composer
    // shows the new one.
    const { webview } = await openWithBridge();
    webview.deliver({ type: "setPermissionMode", mode: "auto" });
    await settle();

    expect(livePushes).toEqual(["auto"]);
    expect(publishedMode(webview)).toBe("auto");
  });

  it("sends a model picked while the phone drives to the live process", async () => {
    // Of everything a turn carries, the model is the only other thing the CLI
    // will take live — `set_model` and `set_permission_mode` are the whole of
    // its live-setter vocabulary. The rest travels in argv.
    const { webview } = await openWithBridge();
    webview.deliver({ type: "setModel", model: "claude-opus-4-8" });
    await settle();

    expect(liveModels).toEqual(["claude-opus-4-8"]);
  });

  it("delivers the direction that matters — leaving Bypass", async () => {
    // In `bypassPermissions` the CLI emits no `can_use_tool` at all, so a
    // change that never arrives means destructive calls running with no card
    // on either surface while the panel reads Default.
    const { webview } = await openWithBridge();
    webview.deliver({ type: "setPermissionMode", mode: "bypass" });
    await settle();
    webview.deliver({ type: "setPermissionMode", mode: "default" });
    await settle();

    expect(livePushes).toEqual(["bypass", "default"]);
  });
});

describe("the pill and the surface it is drawn on", () => {
  it("clears when another conversation takes the surface", async () => {
    // `swapSidebar` hands one webview to a different host through `show()`, and
    // `ChatScreen` is not remounted by that — the pill's state, and the session
    // URL under it, stayed with whoever held the surface last. A live-looking
    // link to somebody else's conversation is worse than no link.
    const { registry, webview } = await openWithBridge();
    expect(publishedBridge(webview)?.state).toBe("ready");

    const next = registry.create();
    next.show({ webview, reveal: () => {} } as never, {});
    await settle();

    expect(publishedBridge(webview)?.state).toBe("off");
  });

  it("says connecting before ready, so no link is offered that does not exist", async () => {
    // The optimistic publish used to be `ready`, which renders identically to a
    // bridge that is actually up — for as long as the round-trip takes, up to
    // 30s. The pill invited a click on a session URL nobody had minted.
    const { webview } = await openWithBridge();
    const published = webview.sent
      .filter((m) => m.type === "remoteControl")
      .map((m) => m.status as { state?: string; sessionUrl?: string });

    expect(published[0]).toEqual({ state: "connecting" });
    expect(published[0].sessionUrl).toBeUndefined();
    expect(published.at(-1)?.state).toBe("ready");
  });

  it("still shows a bridge that was up when the surface arrived", async () => {
    // The other direction, and the reason `show()` cannot simply post nothing:
    // swapping *back* to the bridged conversation has to light the pill again.
    const { registry, host, webview } = await openWithBridge();
    const next = registry.create();
    next.show({ webview, reveal: () => {} } as never, {});
    await settle();
    expect(publishedBridge(webview)?.state).toBe("off");

    host.show({ webview, reveal: () => {} } as never, {});
    await settle();

    expect(publishedBridge(webview)?.state).toBe("ready");
  });
});

describe("an approval raised with no turn open", () => {
  it("puts the card on the panel instead of dropping it", async () => {
    // A `run_in_background` agent outlives the turn that launched it, and the
    // CLI blocks on the answer for the life of the process. Dropped here, the
    // only trace was one line in the extension log.
    const { webview } = await openWithBridge();
    remote.push!({
      type: "permission_request",
      permission: { requestId: "bg-1", toolName: "Edit", input: {} }
    });
    await settle();

    expect(
      webview.sent.filter((m) => m.type === "permissionRequest")
    ).toHaveLength(1);
  });

  it("answers it through the session provider, which is the same process", async () => {
    // `activeProvider` is empty between turns, which is exactly when a
    // background agent asks. Without the fallback the card renders and cannot
    // be answered — worse than not rendering at all.
    const { webview } = await openWithBridge();
    remote.push!({
      type: "permission_request",
      permission: { requestId: "bg-1", toolName: "Edit", input: {} }
    });
    await settle();

    webview.deliver({
      type: "permissionResponse",
      requestId: "bg-1",
      behavior: "deny"
    });
    expect(answered).toEqual(["bg-1:deny"]);
  });

  it("takes the card away when the other device answers first", async () => {
    const { webview } = await openWithBridge();
    remote.push!({
      type: "permission_request",
      permission: { requestId: "bg-1", toolName: "Edit", input: {} }
    });
    remote.push!({ type: "permission_resolved", requestId: "bg-1" });
    await settle();

    expect(
      webview.sent.filter((m) => m.type === "permissionResolved")
    ).toHaveLength(1);
  });
});

describe("the bridge reporting while a turn is running", () => {
  it("publishes a bridge that changed mid-turn", async () => {
    // The enable reply is asynchronous I/O that always lands after the turn
    // installed its sink, so this delta never reaches the out-of-turn seam —
    // switching the bridge on during an answer is the ordinary case, not a
    // race. Dropped, the pill goes on offering a session URL nobody holds.
    const { webview } = await openWithBridge();
    turnDeltas.push({
      type: "remote_control",
      remoteControl: {
        state: "connected",
        sessionUrl: "https://claude.ai/code/session_second"
      }
    });
    webview.deliver({ type: "prompt", text: "carry on" });
    await settle();

    expect(publishedBridge(webview)).toEqual({
      state: "connected",
      sessionUrl: "https://claude.ai/code/session_second"
    });
  });

  it("does not leave it to the raw delta forward, which cannot carry it", async () => {
    // `Delta` in the webview has no `remote_control` member, so a fall-through
    // to `{type:"delta"}` is a message with no reader — green on both sides
    // and silent at runtime, which is how this went unnoticed.
    const { webview } = await openWithBridge();
    turnDeltas.push({
      type: "remote_control",
      remoteControl: { state: "error", error: "bridge lost" }
    });
    webview.deliver({ type: "prompt", text: "carry on" });
    await settle();

    const forwarded = webview.sent.filter(
      (m) =>
        m.type === "delta" &&
        (m.delta as { type?: string } | undefined)?.type === "remote_control"
    );
    expect(forwarded).toEqual([]);
    expect(publishedBridge(webview)?.state).toBe("error");
  });
});

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

  it("forwards updatedInput to the provider without reshaping it", async () => {
    // The answers to an AskUserQuestion ride here. The shape is the CLI's
    // schema, so the host has to hand it over exactly as the panel built it.
    const { webview } = await openWithBridge();
    remote.push!({ type: "remote_prompt", prompt: "which one?" });
    remote.push!({
      type: "permission_request",
      permission: {
        requestId: "q-1",
        toolName: "AskUserQuestion",
        input: { questions: [{ question: "Which library?" }] }
      }
    });
    await settle();

    const updatedInput = {
      questions: [{ question: "Which library?" }],
      answers: { "Which library?": "date-fns" },
      response: "actually, neither"
    };
    webview.deliver({
      type: "permissionResponse",
      requestId: "q-1",
      behavior: "allow",
      updatedInput
    });
    expect(answered).toEqual(["q-1:allow"]);
    expect(answeredOpts[0]).toMatchObject({ updatedInput });

    remote.push!({ type: "done" });
    await settle();
  });

  it("forwards what the user typed to do instead", async () => {
    const { webview } = await openWithBridge();
    remote.push!({ type: "remote_prompt", prompt: "delete the temp dir" });
    remote.push!({
      type: "permission_request",
      permission: { requestId: "d-1", toolName: "Bash", input: {} }
    });
    await settle();

    webview.deliver({
      type: "permissionResponse",
      requestId: "d-1",
      behavior: "deny",
      reason: "use git clean instead"
    });
    expect(answeredOpts[0]).toMatchObject({ reason: "use git clean instead" });

    remote.push!({ type: "done" });
    await settle();
  });

  it("omits updatedInput entirely when the panel sent none", async () => {
    const { webview } = await openWithBridge();
    remote.push!({ type: "remote_prompt", prompt: "run it" });
    remote.push!({
      type: "permission_request",
      permission: { requestId: "b-1", toolName: "Bash", input: {} }
    });
    await settle();

    webview.deliver({
      type: "permissionResponse",
      requestId: "b-1",
      behavior: "allow"
    });
    expect(answeredOpts[0]).not.toHaveProperty("updatedInput");

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

  it("steers into the turn the phone started, rather than waiting for it", async () => {
    // The two surfaces drive one session, so a turn started on the phone is a
    // turn here — and typing into it is the same stdin write as typing into one
    // started in the panel. Waiting for the phone's `done` would put the
    // correction after the work it corrects.
    const { webview } = await openWithBridge();
    remote.push!({ type: "remote_prompt", prompt: "from the phone" });
    await settle();

    webview.deliver({ type: "prompt", text: "and from the panel" });
    await settle();

    expect(steered).toEqual(["and from the panel"]);
    // Not a turn of its own: that would wait on a `result` the running turn is
    // going to spend.
    expect(sentPrompts).toEqual([]);

    remote.push!({ type: "done" });
    await settle();
    expect(sentPrompts).toEqual([]);
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

  it("drops orphan tool traffic, which has nothing to attach to", async () => {
    // A tool call from a turn that was already cancelled, arriving with no card
    // and no turn to hang it on. Text is the deliberate exception — the CLI
    // opens a whole extra turn to report a finished background task, and the
    // host keeps that.
    const { webview } = await openWithBridge();
    remote.push!({
      type: "tool_use_start",
      tool: { id: "t-orphan", name: "Read" }
    });
    remote.push!({ type: "tool_use_end" });
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

describe("the bridge puts no restriction on the permission mode", () => {
  // Deliberate, and reversed on purpose: an earlier build refused the ungated
  // modes while a device was connected. Whose files these are, and what may run
  // against them unattended, is the user's call on their own machine — the
  // second surface is theirs too. These tests exist so nobody reinstates the
  // refusal on the grounds that it looks like an oversight.
  it("takes Agent mode with a phone connected", async () => {
    const { webview } = await openWithBridge();
    webview.deliver({ type: "setPermissionMode", mode: "auto" });
    await settle();

    expect(publishedMode(webview)).toBe("auto");
    expect(publishedBridge(webview)?.state).toBe("ready");
  });

  it("takes Bypass too, behind its own confirmation and nothing else", async () => {
    const { webview } = await openWithBridge();
    webview.deliver({ type: "setPermissionMode", mode: "bypass" });
    await settle();

    expect(publishedMode(webview)).toBe("bypass");
    expect(publishedBridge(webview)?.state).toBe("ready");
  });

  it("starts the bridge from Agent mode", async () => {
    settings.permissionMode = "auto";
    const registry = new ConversationRegistry(fakeContext() as never);
    const host = registry.create();
    const webview = makeWebview();
    host.attach({ webview, reveal: () => {} } as never, {});
    webview.route(() => host as never);
    webview.deliver({ type: "toggleRemoteControl", enabled: true });
    await settle();

    expect(publishedBridge(webview)?.state).toBe("ready");
    expect(publishedBridge(webview)?.sessionUrl).toBeTruthy();
    void registry;
  });
});
