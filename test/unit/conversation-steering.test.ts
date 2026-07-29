import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// What this file guards: sending never queues. A message typed while a turn is
// running is written into that turn's stdin, and the CLI picks it up at its
// next tool boundary — so a correction lands while the work it corrects is
// still happening. There is no local queue any more, on either side.
//
// The rule has a second half, and it is the one worth tests: a steered message
// belongs to nobody's `addUser`. `Orchestrator.turn` records the message that
// opened a turn, and this one opens none — left alone it renders, gets
// answered, and is gone on the next reload.
//
// And, since the two are the same question asked twice: when the conversation's
// CLI process may die. It outlives the turn now, which turns every teardown
// path into a decision rather than a consequence.
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

/** What was written into a turn already running, in order — the whole of
 *  steering, as far as the host is concerned. */
const steers = vi.hoisted(() => [] as string[]);

/** Out-of-turn sinks handed to every provider built, newest last: what the
 *  session pushes when nothing here asked for it. */
const outOfTurn = vi.hoisted(() => [] as ((d: unknown) => void)[]);

/** Whether the fake session will take a write. `false` is a process that is
 *  gone, which is the host's signal to open an ordinary turn instead. */
const stdin = vi.hoisted(() => ({ accepts: true }));

/** What the CLI hands back when Stop interrupts it: whatever it had been
 *  written and had not read yet. `[]` for a turn that accepted everything. */
const stillQueued = vi.hoisted(() => ({ text: "" }));

/** Every time the host ended the conversation's CLI process. The process now
 *  outlives the turn, so *when* it is released is behaviour worth asserting. */
const disposals = vi.hoisted(() => [] as string[]);

/** How many processes the conversation has asked for. One per conversation is
 *  the claim; one per turn is what it replaced. */
const spawns = vi.hoisted(() => ({ count: 0 }));

vi.mock("../../src/providers/factory.js", () => ({
  createProvider: (opts: {
    onStillQueued?: (text: string) => void;
    onOutOfTurn?: (d: unknown) => void;
  }) => {
    if (opts.onOutOfTurn) outOfTurn.push(opts.onOutOfTurn);
    return {
      id: `fake-${++spawns.count}`,
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
      // A write into the turn already in flight. Deliberately not a turn of its
      // own and deliberately not an interrupt: the real one is a line on stdin
      // and nothing else, which is what leaves background agents alone.
      steer(text: string) {
        if (!stdin.accepts) return false;
        steers.push(text);
        return true;
      },
      cancel() {
        // Stop is an interrupt, and the CLI answers one with `still_queued`.
        if (stillQueued.text) opts.onStillQueued?.(stillQueued.text);
        turns[turns.length - 1]?.release();
      },
      // One process per conversation: the host reuses the provider and pushes
      // what changed since the last turn through here, then ends the process
      // itself when the conversation is over. Both are called on every turn now,
      // so a fake without them fails before the stream opens.
      updateOptions() {},
      disposeSession() {
        disposals.push("session");
      }
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
  event?: { kind?: string; body?: string };
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
  steers.length = 0;
  outOfTurn.length = 0;
  disposals.length = 0;
  spawns.count = 0;
  stdin.accepts = true;
  stillQueued.text = "";
  for (const key of Object.keys(settings)) delete settings[key];
  settings.worktree = "off";
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "luno-steer-storage-"));
  root.path = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "luno-steer-root-"))
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
      // Slow on purpose. The credential lookup is a real await on the way to
      // the spawn, and without a wait here two sends fired in one tick finish
      // the first spawn before the second asks for one — which would make the
      // race the lock exists for untestable rather than absent.
      get: () =>
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 25)),
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
/** Past the session store's 400ms save debounce: what is on disk here is what
 *  a reload would read back. */
const saved = () => new Promise((r) => setTimeout(r, 700));

/** The user messages in the session file on disk — the reload's view. */
function storedPrompts(): string[] {
  const dir = path.join(storage, "sessions");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => {
      const stored = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as {
        messages?: { role: string; content: unknown }[];
      };
      return (stored.messages ?? [])
        .filter((m) => m.role === "user" && typeof m.content === "string")
        .map((m) => m.content as string);
    });
}

describe("sending while a turn is running", () => {
  it("writes into the running turn instead of opening a second one", async () => {
    const { webview } = open();
    webview.deliver({ type: "prompt", text: "first" });
    await settle();
    expect(turns).toHaveLength(1);

    webview.deliver({ type: "prompt", text: "and check the tests" });
    await settle();

    // Still the one turn: the running one was neither queued behind nor
    // doubled, and nothing was interrupted to make room.
    expect(turns).toHaveLength(1);
    expect(steers).toEqual(["and check the tests"]);
    expect(webview.sent.some((m) => m.type === "queued")).toBe(false);
  });

  it("sends each Enter as its own message, not one merged blob", async () => {
    // The local queue concatenated everything typed during a turn into a single
    // `\n\n`-joined string. One Enter is one user message now, as upstream.
    const { webview } = open();
    webview.deliver({ type: "prompt", text: "first" });
    await settle();

    webview.deliver({ type: "prompt", text: "and check the tests" });
    await settle();
    webview.deliver({ type: "prompt", text: "no new dependencies" });
    await settle();

    expect(steers).toEqual(["and check the tests", "no new dependencies"]);
    expect(turns).toHaveLength(1);
  });

  it("records it, so a reload still has it and the next turn is answered from it", async () => {
    // Nothing else would: `addUser` lives inside `Orchestrator.turn`, and a
    // steered message opens no turn. Left out, the bubble renders, the model
    // answers — and the message is absent from the stored session and from
    // every later turn's context.
    const { host, webview } = open();
    webview.deliver({ type: "prompt", text: "first" });
    await settle();
    webview.deliver({ type: "prompt", text: "and check the tests" });
    await saved();

    const bodies = host.timeline
      .filter((e) => e.kind === "user")
      .map((e) => e.body);
    expect(bodies).toEqual(["first", "and check the tests"]);
    expect(storedPrompts()).toEqual(["first", "and check the tests"]);
    // And it reached the surface as an ordinary user bubble, appended when it
    // was sent rather than when the CLI got around to it.
    const posted = webview.sent.filter(
      (m) => m.type === "timeline" && m.event?.kind === "user"
    );
    expect(posted.map((m) => m.event?.body)).toEqual([
      "first",
      "and check the tests"
    ]);
  });

  it("opens an ordinary turn when the process will not take the write", async () => {
    const { webview } = open();
    webview.deliver({ type: "prompt", text: "first" });
    await settle();

    // The process died under the turn. `steer` says so rather than throwing,
    // and the send falls back to the path that spawns and records for itself.
    stdin.accepts = false;
    webview.deliver({ type: "prompt", text: "and check the tests" });
    await settle();

    expect(steers).toEqual([]);
    expect(turns).toHaveLength(2);
  });

  it("takes the answer as a full turn when the message missed the boundary", async () => {
    // Run 1 of the probes: pure text generation has no tool boundary, so the
    // message waited and the CLI opened a turn of its own for it. That answer
    // has to arrive into a turn here — the out-of-turn path keeps only `text`,
    // so it would land as one bare paragraph with every tool call dropped.
    const { host, webview } = open();
    webview.deliver({ type: "prompt", text: "first" });
    await settle();
    webview.deliver({ type: "prompt", text: "actually, use 2FA" });
    await settle();
    turns[0].release();
    await settle();

    const before = webview.sent.filter((m) => m.type === "turnStart").length;
    const sink = outOfTurn[outOfTurn.length - 1];
    sink({ type: "steer_turn", prompt: "actually, use 2FA" });
    await settle();
    sink({ type: "text", text: "Using 2FA." });
    sink({ type: "done" });
    await settle();

    expect(webview.sent.filter((m) => m.type === "turnStart").length).toBe(
      before + 1
    );
    // Recorded once, at the send. `steer_turn` passes `null` so the turn it
    // opens adds no second copy of a message that is already on the timeline.
    expect(
      host.timeline.filter((e) => e.kind === "user").map((e) => e.body)
    ).toEqual(["first", "actually, use 2FA"]);
    expect(
      host.timeline.filter((e) => e.kind === "assistant").map((e) => e.body)
    ).toContain("Using 2FA.");
  });

  it("spawns one CLI for two sends that arrive together", async () => {
    // The gate this phase deleted was also serialising the spawn: with no
    // process yet, both sends reach `ensureSessionProvider` before either has
    // one. `session.busy` is set after the spawn and cannot cover the gap.
    const { webview } = open();
    webview.deliver({ type: "prompt", text: "first" });
    webview.deliver({ type: "prompt", text: "and check the tests" });
    await settle();

    expect(spawns.count).toBe(1);
  });
});

describe("what Stop hands back", () => {
  it("returns what the CLI still held, without a local queue to read", async () => {
    // The queue lives inside the CLI now. `interrupt` answers with
    // `still_queued` — what was written and never looked at — and LUNO hands
    // that to the composer. The official extension asks for the same field and
    // drops it; the TUI consumes it, and so do we.
    stillQueued.text = "and check the tests";
    const { webview } = open();
    webview.deliver({ type: "prompt", text: "first" });
    await settle();

    webview.deliver({ type: "cancel" });
    await settle();

    const returned = webview.sent.find((m) => m.type === "returnToComposer");
    expect(returned?.text).toBe("and check the tests");
    // Nothing was sent on the user's behalf: still just the stopped turn.
    expect(turns).toHaveLength(1);
  });

  it("says nothing when the CLI had read everything", async () => {
    // Measured against 2.1.219: a message the turn had already *accepted* comes
    // back as `[]`. Handing the composer an empty string would look like a
    // message being returned.
    const { webview } = open();
    webview.deliver({ type: "prompt", text: "first" });
    await settle();
    webview.deliver({ type: "prompt", text: "and check the tests" });
    await settle();

    webview.deliver({ type: "cancel" });
    await settle();

    expect(webview.sent.some((m) => m.type === "returnToComposer")).toBe(false);
  });
});

describe("two conversations", () => {
  it("steer into their own turns and nobody else's", async () => {
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

    expect(steers).toEqual(["only for one"]);
    expect(
      one.timeline.filter((e) => e.kind === "user").map((e) => e.body)
    ).toEqual(["first", "only for one"]);
    expect(
      two.timeline.filter((e) => e.kind === "user").map((e) => e.body)
    ).toEqual(["first"]);
  });
});

/**
 * One CLI process serves the whole conversation instead of one per turn.
 *
 * The thing that makes this worth its own block: the process now outlives the
 * turn on purpose, so every rule about when it *may* die is load-bearing. Too
 * eager and Stop ends the conversation; too shy and a closed tab leaves a
 * `claude` running with nobody reading it.
 */
describe("one process per conversation", () => {
  it("does not spawn a second one for the second turn", async () => {
    const { webview } = open();
    webview.deliver({ type: "prompt", text: "first" });
    await settle();
    turns[0].release();
    await settle();

    webview.deliver({ type: "prompt", text: "second" });
    await settle();

    expect(turns).toHaveLength(2);
    expect(spawns.count).toBe(1);
  });

  it("survives Stop — the turn ends, the conversation does not", async () => {
    const { webview } = open();
    webview.deliver({ type: "prompt", text: "first" });
    await settle();

    webview.deliver({ type: "cancel" });
    await settle();

    // Killing the process here would end the conversation and drop any Remote
    // Control bridge, when all the user asked for was to stop this turn.
    expect(disposals).toHaveLength(0);
    webview.deliver({ type: "prompt", text: "again" });
    await settle();
    expect(turns).toHaveLength(2);
    expect(spawns.count).toBe(1);
  });

  it("survives a turn that failed", async () => {
    const { webview } = open();
    webview.deliver({ type: "prompt", text: "first" });
    await settle();

    turns[0].fail("the model refused");
    await settle();

    // "This turn failed" and "the session died" stopped being the same event
    // the moment the process outlived the turn. Only the second may tear
    // anything down.
    expect(disposals).toHaveLength(0);
  });

  it("ends it when the user starts a new chat", async () => {
    const { webview } = open();
    webview.deliver({ type: "prompt", text: "first" });
    await settle();
    turns[0].release();
    await settle();

    webview.deliver({ type: "newSession" });
    await settle();

    // `--resume` is applied at spawn and nowhere else, so a process kept here
    // would answer the new chat out of the old one's history.
    expect(disposals).toEqual(["session"]);
  });

  // The same button while something is actually running means something else
  // entirely. A conversation with a live turn or an unfinished background agent
  // is not cleared: clearing calls `newSession`, which aborts the turn and
  // releases the CLI process, and a `run_in_background` workflow dies with it —
  // measured, a 19m52s audit lost both its agents to one blank chat.
  it("leaves a running conversation alone, and gives the blank chat elsewhere", async () => {
    const { webview } = open();
    webview.deliver({ type: "prompt", text: "first" });
    await settle();

    webview.deliver({ type: "newSession" });
    await settle();

    expect(disposals).toHaveLength(0);
    expect(turns).toHaveLength(1);
  });

  it("ends it when the conversation is closed", async () => {
    const { registry, host, webview } = open();
    webview.deliver({ type: "prompt", text: "first" });
    await settle();
    turns[0].release();
    await settle();

    registry.close(host);
    await settle();

    expect(disposals).toEqual(["session"]);
  });

  it("ends it for a tab closed between turns, with no turn to abort", async () => {
    const { registry, host, webview } = open();
    webview.deliver({ type: "prompt", text: "first" });
    await settle();
    turns[0].release();
    await settle();
    expect(spawns.count).toBe(1);

    // The leak this closes: `abortTurn` reaches the provider through
    // `activeProvider`, which is undefined once the turn is over — so between
    // turns there was nothing holding a reference to the process at all.
    registry.close(host);
    await settle();

    expect(disposals).toEqual(["session"]);
  });
});
