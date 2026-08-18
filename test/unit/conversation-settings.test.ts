import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Model, permission mode and effort used to be workspace settings, so every
// chat shared one posture and changing it retargeted turns that were already
// running. These assert the opposite: a conversation carries its own, and the
// turn it spawns uses it.
const disposable = { dispose: () => {} };
const folder = vi.hoisted(() => ({ root: "" }));
/**
 * What the CLI knew when each turn opened, one entry per turn.
 *
 * Not what it was spawned with: one process now serves the whole conversation,
 * so the posture a turn runs under arrives through `updateOptions` on a process
 * that already exists. Spawn options and every update since are merged here,
 * which is the only view that answers "what was this turn sent under".
 */
const spawned = vi.hoisted(
  () =>
    [] as {
      permissionMode: string;
      effort: string;
      model?: string;
      ultracode?: boolean;
    }[]
);

/**
 * What the fake CLI does for the next turn. Empty deltas and `hang: false` is
 * a turn that runs and ends, which is what most of these want.
 *
 * `hang` matters for the approval state: the real CLI blocks on a permission
 * request until someone answers, and a turn that returns instead clears
 * `awaitingApproval` in its own `finally` before anything can observe it.
 */
const stream = vi.hoisted(() => ({ deltas: [] as unknown[], hang: false }));

/**
 * What `hasLiveWork()` answered at each turn's spawn decision, one entry per
 * turn.
 *
 * The real provider asks exactly there, and a `true` means "keep the process
 * you have" — so an option that only exists in argv (effort, ultracode,
 * thinking, disabled skills, and the permission mode) does not reach the CLI
 * on that turn.
 */
const liveWorkAtSpawn = vi.hoisted(() => [] as boolean[]);

/** Every `setContext` the registry published, in order. */
const contexts = vi.hoisted(() => [] as { key: string; value: unknown }[]);

vi.mock("../../src/providers/factory.js", () => ({
  createProvider: (opts: {
    permissionMode: string;
    effort: string;
    hasLiveWork?: () => boolean;
  }) => {
    let live = { ...opts };
    return {
      id: "fake",
      /** What the host answers when the real provider asks whether it may
       *  replace the process. Recorded at the moment a turn reaches the spawn
       *  decision, which is the only moment the answer is acted on. */
      askedHasLiveWork: () => opts.hasLiveWork?.() ?? false,
      updateOptions(patch: Record<string, unknown>) {
        live = { ...live, ...patch };
      },
      // Pushed at pick time rather than at the next turn, so the mock has to
      // move `live` too — otherwise a turn would look as if it never heard.
      async setLivePermissionMode(mode: string) {
        live = { ...live, permissionMode: mode };
      },
      // The model is a `buildArgs` parameter rather than a spawn option, so the
      // real one moves the session and not `this.opts`. Nothing to mirror.
      async setLiveModel() {},
      disposeSession() {},
      async *stream() {
        spawned.push(live);
        liveWorkAtSpawn.push(opts.hasLiveWork?.() ?? false);
        for (const d of stream.deltas) yield d;
        if (stream.hang) await new Promise(() => {});
      }
    };
  },
  resolveClaudeBinary: () => "claude"
}));

vi.mock("vscode", () => ({
  workspace: {
    get workspaceFolders() {
      return folder.root
        ? [{ uri: { fsPath: folder.root }, name: "ws" }]
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
    }),
    registerWebviewPanelSerializer: () => disposable
  },
  commands: {
    executeCommand: async (cmd: string, key: string, value: unknown) => {
      if (cmd === "setContext") contexts.push({ key, value });
    }
  },
  ViewColumn: { Active: -1 },
  RelativePattern: class {
    constructor(
      public base: unknown,
      public pattern: string
    ) {}
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

const { ConversationRegistry } =
  await import("../../src/ui/conversation-registry.js");

let storage: string;

let claudeHome = "";
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  spawned.length = 0;
  liveWorkAtSpawn.length = 0;
  stream.deltas.length = 0;
  stream.hang = false;
  contexts.length = 0;
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "luno-settings-"));
  // A turn refuses to start without an open folder, and these tests are about
  // what it starts *with*. Deliberately not a git repository: isolation is a
  // separate concern with its own file.
  folder.root = fs.mkdtempSync(path.join(os.tmpdir(), "luno-settings-ws-"));
  // A conversation is now born with Claude's own preferences where LUNO has
  // no explicit one, so without this the answer depends on whatever
  // `~/.claude/settings.json` says on the machine running the suite — which is
  // how these three started failing on a laptop with `defaultMode: auto`.
  claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "luno-settings-home-"));
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
  fs.rmSync(storage, { recursive: true, force: true });
  fs.rmSync(claudeHome, { recursive: true, force: true });
  fs.rmSync(folder.root, { recursive: true, force: true });
  folder.root = "";
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

function fakeTarget() {
  const webview = makeWebview();
  return { webview, target: { webview, reveal: () => {} } };
}

/** The posture the webview was last told to render. */
function lastAuth(sent: { type?: string }[]): Record<string, unknown> {
  const auth = sent.filter((m) => m.type === "auth");
  return auth[auth.length - 1] as Record<string, unknown>;
}

/** A turn reaches the spawn only after conventions and the MCP config are
 *  resolved, so give the async chain room rather than racing it. */
const settle = () => new Promise((r) => setTimeout(r, 350));

describe("per-conversation settings", () => {
  it("keeps one conversation's mode out of another's", async () => {
    const registry = new ConversationRegistry(fakeContext() as never);
    const first = fakeTarget();
    const second = fakeTarget();
    {
      const h = registry.create();
      h.attach(first.target as never);
      first.webview.route(() => h as never);
    }
    {
      const h = registry.create();
      h.attach(second.target as never);
      second.webview.route(() => h as never);
    }

    first.webview.deliver({ type: "setPermissionMode", mode: "plan" });
    second.webview.deliver({ type: "setEffort", effort: "max" });
    await settle();

    expect(lastAuth(first.webview.sent).permissionMode).toBe("plan");
    expect(lastAuth(second.webview.sent).permissionMode).toBe("default");
    expect(lastAuth(second.webview.sent).effort).toBe("max");
    expect(lastAuth(first.webview.sent).effort).toBe("high");
  });

  it("spawns each turn with its own conversation's posture", async () => {
    const registry = new ConversationRegistry(fakeContext() as never);
    const planning = fakeTarget();
    const working = fakeTarget();
    {
      const h = registry.create();
      h.attach(planning.target as never);
      planning.webview.route(() => h as never);
    }
    {
      const h = registry.create();
      h.attach(working.target as never);
      working.webview.route(() => h as never);
    }

    planning.webview.deliver({ type: "setPermissionMode", mode: "plan" });
    working.webview.deliver({ type: "setPermissionMode", mode: "auto" });
    await settle();

    planning.webview.deliver({ type: "prompt", text: "think" });
    await settle();
    working.webview.deliver({ type: "prompt", text: "do" });
    await settle();

    // The failure this guards is silent: one shared setting would have sent
    // both turns out under whichever mode was written last.
    expect(spawned.map((s) => s.permissionMode)).toEqual(["plan", "auto"]);
  });

  it("carries ultracode down to the spawn", async () => {
    const registry = new ConversationRegistry(fakeContext() as never);
    const surface = fakeTarget();
    const host = registry.create();
    host.attach(surface.target as never);
    surface.webview.route(() => host as never);

    surface.webview.deliver({
      type: "setEffort",
      effort: "xhigh",
      ultracode: true
    });
    surface.webview.deliver({ type: "prompt", text: "hello" });
    await settle();

    expect(spawned[0].ultracode).toBe(true);
    expect(lastAuth(surface.webview.sent).ultracode).toBe(true);
  });

  it("drops ultracode the moment a plain level is picked", async () => {
    const registry = new ConversationRegistry(fakeContext() as never);
    const surface = fakeTarget();
    const host = registry.create();
    host.attach(surface.target as never);
    surface.webview.route(() => host as never);

    surface.webview.deliver({
      type: "setEffort",
      effort: "xhigh",
      ultracode: true
    });
    await settle();
    // The picker is one radiogroup: choosing a rung on the ramp *is* choosing
    // not to be in ultracode, and nothing else says so.
    surface.webview.deliver({ type: "setEffort", effort: "high" });
    surface.webview.deliver({ type: "prompt", text: "hello" });
    await settle();

    expect(lastAuth(surface.webview.sent).ultracode).toBe(false);
    expect(spawned[0].ultracode).toBe(false);
    expect(spawned[0].effort).toBe("high");
  });

  it("brings ultracode back with the conversation", async () => {
    const registry = new ConversationRegistry(fakeContext() as never);
    const first = fakeTarget();
    const host = registry.create();
    host.attach(first.target as never);
    first.webview.route(() => host as never);

    first.webview.deliver({ type: "prompt", text: "hello" });
    await settle();
    first.webview.deliver({
      type: "setEffort",
      effort: "xhigh",
      ultracode: true
    });
    await settle();
    const sessionId = host.sessionId;
    await new Promise((r) => setTimeout(r, 700));

    const reopened = registry.openInTab(sessionId);
    await settle();

    const panelSent = (
      reopened as unknown as { target: { webview: FakeWebview } }
    ).target.webview.sent;
    expect(lastAuth(panelSent).ultracode).toBe(true);
    expect(lastAuth(panelSent).effort).toBe("xhigh");
  });

  it("brings a conversation back in the posture it ran in", async () => {
    const registry = new ConversationRegistry(fakeContext() as never);
    const first = fakeTarget();
    const host = registry.create();
    host.attach(first.target as never);
    first.webview.route(() => host as never);

    first.webview.deliver({ type: "prompt", text: "hello" });
    await settle();
    first.webview.deliver({ type: "setEffort", effort: "low" });
    await settle();
    const sessionId = host.sessionId;
    // Let the debounced write land.
    await new Promise((r) => setTimeout(r, 700));

    const reopened = registry.openInTab(sessionId);
    await settle();

    expect(reopened.sessionId).toBe(sessionId);
    const panelSent = (
      reopened as unknown as { target: { webview: FakeWebview } }
    ).target.webview.sent;
    expect(lastAuth(panelSent).effort).toBe("low");
  });

  it("falls back to the defaults for a chat stored before postures existed", async () => {
    const dir = path.join(storage, "sessions");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "old.json"),
      JSON.stringify({
        id: "old",
        title: "Old chat",
        createdAt: 1,
        updatedAt: 2,
        messages: [],
        timeline: [{ id: "u", ts: 1, kind: "user", title: "u", body: "hi" }]
      })
    );
    const registry = new ConversationRegistry(fakeContext() as never);
    const surface = fakeTarget();
    const host = registry.create();
    host.attach(surface.target as never, { adoptSessionId: "old" });
    surface.webview.route(() => host as never);
    await settle();

    // No `effort` in the file, and reading `undefined` back would have left the
    // composer with an empty picker.
    expect(host.sessionId).toBe("old");
    expect(lastAuth(surface.webview.sent).effort).toBe("high");
    expect(lastAuth(surface.webview.sent).permissionMode).toBe("default");
  });

  it("cycles the mode of the conversation last worked in", async () => {
    const registry = new ConversationRegistry(fakeContext() as never);
    const first = fakeTarget();
    const second = fakeTarget();
    {
      const h = registry.create();
      h.attach(first.target as never);
      first.webview.route(() => h as never);
    }
    {
      const h = registry.create();
      h.attach(second.target as never);
      second.webview.route(() => h as never);
    }

    // Interacting with the second one makes it the target of a keybinding.
    second.webview.deliver({ type: "refreshAuth" });
    await settle();
    await registry.activeConversation()?.cycleMode();
    await settle();

    expect(lastAuth(second.webview.sent).permissionMode).toBe("acceptEdits");
    expect(lastAuth(first.webview.sent).permissionMode).toBe("default");
  });
});

// `package.json` binds Shift+Tab to `luno.cycleMode` under
// `when: "luno.chatFocused"`. Nothing ever set that key, so the binding could
// not match under any condition and the shortcut the hints overlay advertises
// did nothing. These pin the key to the focus the webview reports.
// Rewinding truncated the timeline, rewrote the session file and dropped the
// CLI resume id. Between them that left no route back to the conversation as it
// stood — the messages were gone from disk and the CLI session behind them was
// unreachable. These pin the safety copy that makes it recoverable.
// Rewinding used to copy the whole conversation into a second history row
// before truncating. Stop → Rewind is a normal working rhythm, not an
// exceptional event, so one chat became five or ten rows of itself and the
// list stopped being usable. The copy is gone: a rewind rewrites one chat.
describe("rewind leaves no second copy of the chat", () => {
  /** Every stored conversation on disk, newest content first read fresh. */
  function storedSessions(): Array<Record<string, unknown>> {
    const dir = path.join(storage, "sessions");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map(
        (f) =>
          JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Record<
            string,
            unknown
          >
      );
  }

  function userEventIds(sent: { type?: string }[]): string[] {
    return sent
      .filter(
        (m): m is { type: string; event: { kind: string; id: string } } =>
          m.type === "timeline" &&
          (m as { event?: { kind?: string } }).event?.kind === "user"
      )
      .map((m) => m.event.id);
  }

  /**
   * Three exchanges, then rewind to the second.
   *
   * `truncateAt` slices `[0, idx)` — the target message goes too — so rewinding
   * to the middle turn leaves exactly the first and discards the other two.
   */
  async function threeTurnsThenRewind() {
    const registry = new ConversationRegistry(fakeContext() as never);
    const surface = fakeTarget();
    const host = registry.create();
    host.attach(surface.target as never);
    surface.webview.route(() => host as never);

    for (const text of ["first", "second", "third"]) {
      surface.webview.deliver({ type: "prompt", text });
      await settle();
    }

    const ids = userEventIds(surface.webview.sent);
    surface.webview.deliver({ type: "rewindTo", turnId: ids[1] });
    // Longer than the save debounce, so the truncated original has landed.
    await new Promise((r) => setTimeout(r, 800));
    return { host, ids };
  }

  it("writes one chat, not the rewound one plus a copy", async () => {
    const { host } = await threeTurnsThenRewind();

    expect(storedSessions().map((s) => s.id)).toEqual([host.sessionId]);
  });

  it("truncates the conversation the user is still in", async () => {
    const { host } = await threeTurnsThenRewind();

    const live = storedSessions().find((s) => s.id === host.sessionId);
    const timeline = live!.timeline as Array<{ kind: string }>;
    expect(timeline.filter((e) => e.kind === "user")).toHaveLength(1);
  });

  // A rewind to the newest turn discards nothing at all. It had its own branch
  // in the copying code, so it keeps its own case here.
  it("writes no extra chat when nothing would be lost", async () => {
    const registry = new ConversationRegistry(fakeContext() as never);
    const surface = fakeTarget();
    const host = registry.create();
    host.attach(surface.target as never);
    surface.webview.route(() => host as never);

    surface.webview.deliver({ type: "prompt", text: "only question" });
    await settle();
    const ids = userEventIds(surface.webview.sent);

    surface.webview.deliver({ type: "rewindTo", turnId: ids[ids.length - 1] });
    await new Promise((r) => setTimeout(r, 800));

    expect(
      storedSessions().filter((s) => s.id !== host.sessionId)
    ).toHaveLength(0);
  });

  // Editing a sent message truncates exactly the same way and copied the chat
  // through the same helper, so removing it from one path and not the other
  // would leave half the duplicates in place.
  it("writes one chat when a sent message is edited", async () => {
    const registry = new ConversationRegistry(fakeContext() as never);
    const surface = fakeTarget();
    const host = registry.create();
    host.attach(surface.target as never);
    surface.webview.route(() => host as never);

    for (const text of ["first", "second"]) {
      surface.webview.deliver({ type: "prompt", text });
      await settle();
    }
    const ids = userEventIds(surface.webview.sent);

    surface.webview.deliver({
      type: "editAt",
      turnId: ids[0],
      text: "first, but different",
      revertFiles: false
    });
    await new Promise((r) => setTimeout(r, 800));

    expect(storedSessions().map((s) => s.id)).toEqual([host.sessionId]);
  });
});

// How full the context is belongs to one conversation, and the meter showing it
// sits in a tree the sidebar swap does not remount. Published rather than left
// on screen, `null` included — that is the half that takes the previous
// occupant's number off.
describe("the context figure follows the conversation", () => {
  const USAGE_DELTA = {
    type: "usage",
    usage: {
      inputTokens: 12_000,
      outputTokens: 400,
      contextTokens: 41_060,
      contextWindow: 200_000
    }
  };

  /** What the surface was last told about the context, or undefined if never. */
  function lastContext(
    sent: { type?: string }[]
  ): { used: number; window: number } | null | undefined {
    const posts = sent.filter((m) => m.type === "contextUsage") as {
      context: { used: number; window: number } | null;
    }[];
    return posts.at(-1)?.context;
  }

  function writeStoredSession(
    id: string,
    extra: Record<string, unknown> = {}
  ): void {
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
        timeline: [
          { id: "e1", ts: 1, kind: "user", title: "user", body: "hi" }
        ],
        ...extra
      })
    );
  }

  /**
   * The session file once the debounced write has landed.
   *
   * Polled rather than slept past: a fixed wait for a 400 ms debounce is the
   * shape that goes red on a loaded machine and green on a quiet one, and this
   * suite runs two projects at once.
   */
  async function storedFile(id: string): Promise<Record<string, unknown>> {
    const file = path.join(storage, "sessions", `${id}.json`);
    for (let i = 0; i < 40; i++) {
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
          string,
          unknown
        >;
        if (parsed.context) return parsed;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no context was written for ${id}`);
  }

  /** A sidebar conversation that has run one turn reporting its context. */
  async function chatWithAContextFigure() {
    stream.deltas = [USAGE_DELTA];
    const registry = new ConversationRegistry(fakeContext() as never);
    const surface = fakeTarget();
    const host = registry.create();
    registry.useSidebar(surface.target as never, host);
    host.attach(surface.target as never);
    surface.webview.route(() => registry.sidebarConversation() as never);
    surface.webview.deliver({ type: "prompt", text: "hello" });
    await settle();
    return { registry, surface, host };
  }

  it("publishes what the CLI reported for the chat that ran the turn", async () => {
    const { surface } = await chatWithAContextFigure();

    expect(lastContext(surface.webview.sent)).toEqual({
      used: 41_060,
      window: 200_000
    });
  });

  it("clears it when the surface takes a different conversation", async () => {
    // The reported bug: switching chats left the previous one's context on the
    // meter, so the number read as belonging to the chat now on screen.
    const { registry, surface } = await chatWithAContextFigure();
    writeStoredSession("stored-elsewhere");

    await registry.showInSidebar("stored-elsewhere");
    await settle();

    expect(lastContext(surface.webview.sent)).toBeNull();
  });

  it("clears it on New Chat", async () => {
    const { registry, surface } = await chatWithAContextFigure();

    registry.startNewSidebarConversation();
    await settle();

    expect(lastContext(surface.webview.sent)).toBeNull();
  });

  it("clears it when a stored chat is loaded into this conversation", async () => {
    const { surface } = await chatWithAContextFigure();
    writeStoredSession("stored-elsewhere");

    surface.webview.deliver({ type: "loadSession", id: "stored-elsewhere" });
    await settle();

    expect(lastContext(surface.webview.sent)).toBeNull();
  });

  it("saves the figure with the conversation", async () => {
    const { host } = await chatWithAContextFigure();

    expect((await storedFile(host.sessionId)).context).toEqual({
      used: 41_060,
      window: 200_000
    });
  });

  it("restores it for a chat that will be resumed", async () => {
    // `--resume` carries the conversation into the next process, so the figure
    // still describes what the model is holding — the meter can open on it
    // rather than on nothing until the next turn reports.
    writeStoredSession("resumable", {
      resumeId: "cli-session-1",
      context: { used: 128_000, window: 200_000 }
    });
    const registry = new ConversationRegistry(fakeContext() as never);
    const surface = fakeTarget();
    const host = registry.create();
    host.attach(surface.target as never, { adoptSessionId: "resumable" });
    surface.webview.route(() => host as never);
    await settle();

    expect(lastContext(surface.webview.sent)).toEqual({
      used: 128_000,
      window: 200_000
    });
  });

  it("does not restore it for a chat with no resume id", async () => {
    // Nothing will pick this conversation back up inside the CLI, so its next
    // turn opens a fresh session and the stored figure describes a context the
    // model is not holding. Showing it would be the same wrong number the swap
    // used to leave behind, only older.
    writeStoredSession("not-resumable", {
      context: { used: 128_000, window: 200_000 }
    });
    const registry = new ConversationRegistry(fakeContext() as never);
    const surface = fakeTarget();
    const host = registry.create();
    host.attach(surface.target as never, { adoptSessionId: "not-resumable" });
    surface.webview.route(() => host as never);
    await settle();

    expect(lastContext(surface.webview.sent)).toBeNull();
  });
});

// A question card is a permission prompt, and the host replays the prompts a
// conversation still has open onto whichever surface takes it back. Which makes
// "still open" the load-bearing word: an answered one replayed is a quiz the
// user has already done, asked again.
describe("an answered prompt is not raised a second time", () => {
  const QUESTION = {
    type: "permission_request",
    permission: {
      requestId: "req-1",
      toolName: "AskUserQuestion",
      toolUseId: "tu-1",
      input: {
        questions: [
          {
            question: "Which library?",
            header: "Library",
            options: [{ label: "date-fns" }, { label: "dayjs" }]
          }
        ]
      },
      suggestions: []
    }
  };

  function prompts(sent: { type?: string }[]): { type?: string }[] {
    return sent.filter((m) => m.type === "permissionRequest");
  }

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

  /** A sidebar conversation parked on a question, the way a real one is: the
   *  turn is still open, because the CLI is blocked on the answer. */
  async function chatParkedOnAQuestion() {
    stream.deltas = [QUESTION];
    stream.hang = true;
    const registry = new ConversationRegistry(fakeContext() as never);
    const surface = fakeTarget();
    const host = registry.create();
    registry.useSidebar(surface.target as never, host);
    host.attach(surface.target as never);
    surface.webview.route(() => registry.sidebarConversation() as never);
    surface.webview.deliver({ type: "prompt", text: "brainstorm this" });
    await settle();
    return { registry, surface, host };
  }

  /** Away to another chat and back — the swap that replays the live state. */
  async function switchAwayAndBack(
    registry: InstanceType<typeof ConversationRegistry>,
    sessionId: string
  ) {
    writeStoredSession("somewhere-else");
    await registry.showInSidebar("somewhere-else");
    await settle();
    await registry.showInSidebar(sessionId);
    await settle();
  }

  it("raises the question once while it waits", async () => {
    const { surface } = await chatParkedOnAQuestion();

    expect(prompts(surface.webview.sent)).toHaveLength(1);
  });

  it("puts an unanswered question back when the chat returns", async () => {
    // The other half of the same mechanism, and the reason it cannot simply be
    // deleted: the CLI is still blocked on this one, so a surface that does not
    // get it back is a turn nobody can unblock.
    const { registry, surface, host } = await chatParkedOnAQuestion();

    await switchAwayAndBack(registry, host.sessionId);

    expect(prompts(surface.webview.sent)).toHaveLength(2);
  });

  it("does not put back one the user has already answered", async () => {
    const { registry, surface, host } = await chatParkedOnAQuestion();
    surface.webview.deliver({
      type: "permissionResponse",
      requestId: "req-1",
      behavior: "allow",
      updatedInput: {
        questions: QUESTION.permission.input.questions,
        answers: { "Which library?": "date-fns" }
      }
    });
    await settle();

    await switchAwayAndBack(registry, host.sessionId);

    expect(prompts(surface.webview.sent)).toHaveLength(1);
  });
});

// `ensureSession` will not replace a running CLI process while the host says
// there is live work in it, because a replacement takes every background agent
// with it. Everything that only exists in argv — effort, ultracode, thinking,
// disabled skills, and the permission mode — therefore waits for a turn that
// finds the process idle. Which turn is that?
describe("what the host says about live work when a turn asks for a process", () => {
  async function twoTurns() {
    const registry = new ConversationRegistry(fakeContext() as never);
    const surface = fakeTarget();
    const host = registry.create();
    host.attach(surface.target as never);
    surface.webview.route(() => host as never);

    surface.webview.deliver({ type: "prompt", text: "first" });
    await settle();
    surface.webview.deliver({ type: "prompt", text: "second" });
    await settle();
    return { host, surface };
  }

  it("says no live work on an ordinary turn, so an argv change can land", async () => {
    await twoTurns();

    // Both turns. If either says `true`, a permission mode the user picked mid
    // conversation never reaches the CLI on that turn — the process keeps the
    // mode it was spawned with and goes on prompting.
    expect(liveWorkAtSpawn).toEqual([false, false]);
  });

  it("still says yes while a background agent is inside the process", async () => {
    // The other half, and the reason this cannot simply be `false`: an agent
    // launched by an earlier turn lives in the process and dies with it, 10 ms
    // after a replacement. That one is worth deferring an argv change for.
    stream.deltas = [
      {
        type: "task",
        task: {
          phase: "started",
          taskId: "task-1",
          toolUseId: "toolu_1",
          subagentType: "Explore",
          description: "Find the callers",
          prompt: "Search src for callers."
        }
      }
    ];
    const registry = new ConversationRegistry(fakeContext() as never);
    const surface = fakeTarget();
    const host = registry.create();
    host.attach(surface.target as never);
    surface.webview.route(() => host as never);

    surface.webview.deliver({ type: "prompt", text: "launch an agent" });
    await settle();
    stream.deltas = [];
    surface.webview.deliver({ type: "prompt", text: "and now change effort" });
    await settle();

    expect(liveWorkAtSpawn.at(-1)).toBe(true);
  });
});

describe("chat focus context key", () => {
  /** What VS Code was last told `luno.chatFocused` is. */
  function chatFocused(): unknown {
    return contexts.filter((c) => c.key === "luno.chatFocused").at(-1)?.value;
  }

  function focusableChat(registry: InstanceType<typeof ConversationRegistry>) {
    const surface = fakeTarget();
    const host = registry.create();
    host.attach(surface.target as never);
    surface.webview.route(() => host as never);
    return { surface, host };
  }

  it("raises the key while a chat holds the keyboard", async () => {
    const registry = new ConversationRegistry(fakeContext() as never);
    const { surface } = focusableChat(registry);

    surface.webview.deliver({ type: "chatFocus", focused: true });
    await settle();
    expect(chatFocused()).toBe(true);

    surface.webview.deliver({ type: "chatFocus", focused: false });
    await settle();
    expect(chatFocused()).toBe(false);
  });

  // Clicking from one chat straight into another delivers the second one's
  // focus and the first one's blur in whichever order they arrive. A single
  // boolean ends up false with a chat plainly focused, and Shift+Tab dies
  // exactly when two chats are open — the case this project exists for.
  it("stays raised when focus moves between two chats", async () => {
    const registry = new ConversationRegistry(fakeContext() as never);
    const first = focusableChat(registry);
    const second = focusableChat(registry);

    first.surface.webview.deliver({ type: "chatFocus", focused: true });
    await settle();
    second.surface.webview.deliver({ type: "chatFocus", focused: true });
    first.surface.webview.deliver({ type: "chatFocus", focused: false });
    await settle();

    expect(chatFocused()).toBe(true);
  });

  it("lowers the key when the focused chat is closed", async () => {
    const registry = new ConversationRegistry(fakeContext() as never);
    const { surface, host } = focusableChat(registry);

    surface.webview.deliver({ type: "chatFocus", focused: true });
    await settle();
    registry.close(host);

    // A disposed surface sends no blur of its own.
    expect(chatFocused()).toBe(false);
  });
});

describe("conversation status", () => {
  /** A surface that records what it was named, the way a tab does. */
  function titledTarget() {
    const webview = makeWebview();
    const titles: string[] = [];
    return {
      webview,
      titles,
      target: {
        webview,
        reveal: () => {},
        setTitle: (t: string) => {
          titles.push(t);
        }
      }
    };
  }

  it("names a tab after the conversation rather than a number", async () => {
    const registry = new ConversationRegistry(fakeContext() as never);
    const surface = titledTarget();
    const host = registry.create();
    host.attach(surface.target as never);
    surface.webview.route(() => host as never);

    surface.webview.deliver({
      type: "prompt",
      text: "Refactor the permission gate"
    });
    await settle();

    expect(surface.titles.at(-1)).toContain("Refactor the permission gate");
  });

  it("tells the panel the same name it gave the tab", async () => {
    const registry = new ConversationRegistry(fakeContext() as never);
    const surface = titledTarget();
    const host = registry.create();
    host.attach(surface.target as never);
    surface.webview.route(() => host as never);

    surface.webview.deliver({
      type: "prompt",
      text: "Refactor the permission gate"
    });
    await settle();

    // The header renders this. A tab that says one thing while the panel above
    // the chat says another is the drift the shared call site exists to stop.
    const meta = surface.webview.sent.filter(
      (m): m is { type: string; title?: string; status?: string } =>
        m.type === "sessionMeta"
    );
    expect(meta.at(-1)?.title).toBe("Refactor the permission gate");
    // The fake CLI answers with nothing, so the last word in the timeline is
    // the user's. `no-reply` rather than `done` is the point: the status is
    // read off the timeline, not off the fact that a turn finished.
    expect(meta.at(-1)?.status).toBe("no-reply");
  });

  it("marks a conversation that finished while the user was elsewhere", async () => {
    const registry = new ConversationRegistry(fakeContext() as never);
    const surface = titledTarget();
    const host = registry.create();
    host.attach(surface.target as never);
    surface.webview.route(() => host as never);
    host.setVisible(false);

    surface.webview.deliver({ type: "prompt", text: "do the thing" });
    await settle();

    expect(host.attention).toBe("finished");
    expect(surface.titles.at(-1)?.startsWith("●")).toBe(true);
    expect(registry.attentionCount()).toBe(1);
  });

  it("clears the mark once the conversation is looked at", async () => {
    const registry = new ConversationRegistry(fakeContext() as never);
    const surface = titledTarget();
    const host = registry.create();
    host.attach(surface.target as never);
    surface.webview.route(() => host as never);
    host.setVisible(false);
    surface.webview.deliver({ type: "prompt", text: "do the thing" });
    await settle();

    host.setVisible(true);

    expect(host.attention).toBe("none");
    expect(registry.attentionCount()).toBe(0);
  });

  it("leaves a visible conversation unmarked when its turn ends", async () => {
    const registry = new ConversationRegistry(fakeContext() as never);
    const surface = titledTarget();
    const host = registry.create();
    host.attach(surface.target as never);
    surface.webview.route(() => host as never);

    surface.webview.deliver({ type: "prompt", text: "do the thing" });
    await settle();

    // The user watched it happen; there is nothing to come back to.
    expect(host.attention).toBe("none");
  });

  it("counts every conversation waiting on the user", async () => {
    const registry = new ConversationRegistry(fakeContext() as never);
    const one = titledTarget();
    const two = titledTarget();
    const first = registry.create();
    const second = registry.create();
    first.attach(one.target as never);
    one.webview.route(() => first as never);
    second.attach(two.target as never);
    two.webview.route(() => second as never);
    first.setVisible(false);
    second.setVisible(false);

    one.webview.deliver({ type: "prompt", text: "a" });
    await settle();
    two.webview.deliver({ type: "prompt", text: "b" });
    await settle();

    // The sidebar badge is the only thing a user with five hidden tabs sees.
    expect(registry.attentionCount()).toBe(2);
  });

  // The badge says *how many* chats want the user; the history list is the only
  // place that can say which. Without it, running several conversations means
  // opening each one to find out what it is doing.
  it("reports a conversation parked on an approval as waiting", async () => {
    stream.deltas.push({
      type: "permission_request",
      permission: { id: "p1", tool: "Edit", input: {} }
    });
    stream.hang = true;
    const registry = new ConversationRegistry(fakeContext() as never);
    const surface = titledTarget();
    const host = registry.create();
    host.attach(surface.target as never);
    surface.webview.route(() => host as never);

    surface.webview.deliver({ type: "prompt", text: "edit the gate" });
    await settle();

    // Waiting outranks running: this turn cannot continue until it is answered.
    expect(host.live).toEqual({ status: "needs-you" });
  });

  it("reports a conversation mid-turn as running", async () => {
    stream.hang = true;
    const registry = new ConversationRegistry(fakeContext() as never);
    const surface = titledTarget();
    const host = registry.create();
    host.attach(surface.target as never);
    surface.webview.route(() => host as never);

    surface.webview.deliver({ type: "prompt", text: "refactor the gate" });
    await settle();

    expect(host.live).toEqual({ status: "working" });
  });

  it("claims no live state for an idle conversation", async () => {
    const registry = new ConversationRegistry(fakeContext() as never);
    const surface = titledTarget();
    const host = registry.create();
    host.attach(surface.target as never);
    surface.webview.route(() => host as never);

    surface.webview.deliver({ type: "prompt", text: "hello" });
    await settle();

    // Sitting there is not a state the conversation is *in* — the status the
    // list shows then comes off its timeline, and being open is carried
    // separately. Claiming one here is what made the two compete.
    expect(host.live).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────
// A mode the user's own Claude Code settings forbid.
//
// The picker hides these, but hiding is not enforcement: a stale webview, a
// command, or a keybinding all reach the same handler. The one that matters is
// `bypass` — the mode whose whole effect is that no approval card appears.
// ─────────────────────────────────────────────────────────────
describe("permission modes the settings forbid", () => {
  let cfgDir: string;
  let previous: string | undefined;

  beforeEach(() => {
    cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "luno-modes-"));
    previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cfgDir;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    fs.rmSync(cfgDir, { recursive: true, force: true });
  });

  const forbidBypass = () =>
    fs.writeFileSync(
      path.join(cfgDir, "settings.json"),
      JSON.stringify({
        permissions: { disableBypassPermissionsMode: "disable" }
      })
    );

  it("refuses to apply one, and republishes so the picker snaps back", async () => {
    forbidBypass();
    const registry = new ConversationRegistry(fakeContext() as never);
    const t = fakeTarget();
    const h = registry.create();
    h.attach(t.target as never);
    t.webview.route(() => h as never);

    t.webview.deliver({ type: "setPermissionMode", mode: "bypass" });
    await settle();

    expect(lastAuth(t.webview.sent).permissionMode).toBe("default");
    expect(lastAuth(t.webview.sent).disabledModes).toEqual(["bypass"]);
  });

  it("still applies a mode the settings say nothing about", async () => {
    forbidBypass();
    const registry = new ConversationRegistry(fakeContext() as never);
    const t = fakeTarget();
    const h = registry.create();
    h.attach(t.target as never);
    t.webview.route(() => h as never);

    t.webview.deliver({ type: "setPermissionMode", mode: "plan" });
    await settle();

    expect(lastAuth(t.webview.sent).permissionMode).toBe("plan");
  });

  it("forbids nothing when no policy is set", async () => {
    const registry = new ConversationRegistry(fakeContext() as never);
    const t = fakeTarget();
    const h = registry.create();
    h.attach(t.target as never);
    t.webview.route(() => h as never);

    t.webview.deliver({ type: "setEffort", effort: "max" });
    await settle();

    expect(lastAuth(t.webview.sent).disabledModes).toEqual([]);
  });
});
