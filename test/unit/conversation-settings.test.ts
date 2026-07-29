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

/** Every `setContext` the registry published, in order. */
const contexts = vi.hoisted(() => [] as { key: string; value: unknown }[]);

vi.mock("../../src/providers/factory.js", () => ({
  createProvider: (opts: { permissionMode: string; effort: string }) => {
    let live = { ...opts };
    return {
      id: "fake",
      updateOptions(patch: Record<string, unknown>) {
        live = { ...live, ...patch };
      },
      disposeSession() {},
      async *stream() {
        spawned.push(live);
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

beforeEach(() => {
  spawned.length = 0;
  stream.deltas.length = 0;
  stream.hang = false;
  contexts.length = 0;
  storage = fs.mkdtempSync(path.join(os.tmpdir(), "luno-settings-"));
  // A turn refuses to start without an open folder, and these tests are about
  // what it starts *with*. Deliberately not a git repository: isolation is a
  // separate concern with its own file.
  folder.root = fs.mkdtempSync(path.join(os.tmpdir(), "luno-settings-ws-"));
});

afterEach(() => {
  fs.rmSync(storage, { recursive: true, force: true });
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

    expect(lastAuth(second.webview.sent).permissionMode).toBe("plan");
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
describe("rewind keeps the branch it leaves", () => {
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
    // Longer than the save debounce: both the fork and the truncated original
    // land through it.
    await new Promise((r) => setTimeout(r, 800));
    return { host, ids };
  }

  it("leaves the discarded branch on disk as its own chat", async () => {
    const { host } = await threeTurnsThenRewind();

    const fork = storedSessions().find((s) => s.id !== host.sessionId);
    expect(fork).toBeDefined();
    // The whole conversation, not the part that survived the rewind.
    const timeline = fork!.timeline as Array<{ kind: string }>;
    expect(timeline.filter((e) => e.kind === "user")).toHaveLength(3);
  });

  it("names the fork so the list does not show two identical rows", async () => {
    const { host } = await threeTurnsThenRewind();

    const fork = storedSessions().find((s) => s.id !== host.sessionId);
    expect(String(fork!.name)).toContain("before rewind");
  });

  it("truncates the conversation the user is still in", async () => {
    const { host } = await threeTurnsThenRewind();

    const live = storedSessions().find((s) => s.id === host.sessionId);
    const timeline = live!.timeline as Array<{ kind: string }>;
    expect(timeline.filter((e) => e.kind === "user")).toHaveLength(1);
  });

  // A rewind to the newest turn discards nothing, and a history row per no-op
  // buries the forks that matter.
  it("does not fork when nothing would be lost", async () => {
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
