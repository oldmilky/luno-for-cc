import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

// `list()` scopes to the open folder, so the stub has to carry one. A hoisted
// holder lets a test move the workspace between cases.
const workspace = vi.hoisted(() => ({ root: undefined as string | undefined }));
vi.mock("vscode", () => ({
  workspace: {
    get workspaceFolders() {
      return workspace.root ? [{ uri: { fsPath: workspace.root } }] : undefined;
    }
  }
}));

import {
  deriveLastUserAt,
  deriveStatus,
  HistoryService,
  StoredSession
} from "../../src/services/history.js";
import { TimelineEvent } from "../../src/core/types.js";

function userEvent(text: string): TimelineEvent {
  return { id: "u1", ts: 1, kind: "user", title: "User", body: text };
}

function makeSession(timeline: TimelineEvent[]): StoredSession {
  return {
    id: "sess-1",
    title: "t",
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    timeline
  };
}

// What state a chat was left in has to survive the extension host: the list is
// mostly chats nobody has open, and before this every one of them looked alike.
describe("deriveStatus", () => {
  const ev = (
    kind: TimelineEvent["kind"],
    meta?: Record<string, unknown>
  ): TimelineEvent => ({ id: `${kind}-1`, ts: 1, kind, title: kind, meta });

  it("calls a chat done when the agent had the last word", () => {
    expect(deriveStatus([ev("user"), ev("assistant")])).toBe("done");
  });

  it("does not call a cancelled turn done", () => {
    // Stop, rewind, edit and switching chats all flush a partial answer as an
    // ordinary assistant event. Without the marker every one of them reads as
    // a finished turn, which is the whole reason the marker exists.
    expect(
      deriveStatus([ev("user"), ev("assistant", { interrupted: true })])
    ).toBe("interrupted");
  });

  it("reports a turn that died mid-tool", () => {
    expect(deriveStatus([ev("user"), ev("tool_call")])).toBe("interrupted");
    expect(deriveStatus([ev("user"), ev("tool_result")])).toBe("interrupted");
  });

  it("reports a prompt that never got an answer", () => {
    expect(deriveStatus([ev("assistant"), ev("user")])).toBe("no-reply");
  });

  it("reports a failed turn", () => {
    expect(deriveStatus([ev("user"), ev("error")])).toBe("failed");
  });

  it("reports an unanswered question as needing the user", () => {
    // Unlike a tool approval, this one outlives the process that asked: reopen
    // the chat and the card is still there.
    expect(deriveStatus([ev("user"), ev("plan_question")])).toBe("needs-you");
  });

  it("looks past checkpoints to the conversation underneath", () => {
    // Checkpoints are rewind bookkeeping. A chat whose last write happened to
    // be one is not in whatever state "checkpoint" would map to.
    expect(deriveStatus([ev("user"), ev("assistant"), ev("checkpoint")])).toBe(
      "done"
    );
  });

  it("does not guess for a timeline with nothing in it", () => {
    expect(deriveStatus([])).toBe("no-reply");
    expect(deriveStatus([ev("checkpoint")])).toBe("no-reply");
  });
});

// The list answers "what was I working on", so it is ordered on the user's own
// last message rather than on the last thing that happened in the chat.
describe("deriveLastUserAt", () => {
  const ev = (kind: TimelineEvent["kind"], ts: number): TimelineEvent => ({
    id: `${kind}-${ts}`,
    ts,
    kind,
    title: kind
  });

  it("reads the last user event, not the last event", () => {
    expect(
      deriveLastUserAt([
        ev("user", 10),
        ev("assistant", 20),
        ev("tool_call", 30)
      ])
    ).toBe(10);
  });

  it("moves when the user speaks again", () => {
    expect(
      deriveLastUserAt([ev("user", 10), ev("assistant", 20), ev("user", 40)])
    ).toBe(40);
  });

  it("says nothing for a timeline the user is not in", () => {
    expect(deriveLastUserAt([])).toBeUndefined();
    expect(deriveLastUserAt([ev("assistant", 5)])).toBeUndefined();
  });
});

describe("HistoryService save/delete on empty timeline", () => {
  let dir: string;
  let history: HistoryService;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "luno-hist-"));
    const ctx = { globalStorageUri: { fsPath: dir } } as never;
    history = new HistoryService(ctx);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists a session that has user content", async () => {
    await history.save(makeSession([userEvent("hello")]));
    const list = await history.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("sess-1");
  });

  it("orders on the user's last message, not on the last activity", async () => {
    // `busy` was written most recently — its agents are still going — but the
    // user last spoke in it long before they typed into `typed`. Ordering on
    // `updatedAt` put it on top, which is the report this fixes.
    await history.save({
      ...makeSession([
        { id: "u", ts: 1_000, kind: "user", title: "User", body: "go" },
        { id: "a", ts: 9_000, kind: "assistant", title: "Assistant" }
      ]),
      id: "busy",
      updatedAt: 9_000
    });
    await history.save({
      ...makeSession([
        {
          id: "u",
          ts: 3_000,
          kind: "user",
          title: "User",
          body: "fix the header"
        }
      ]),
      id: "typed",
      updatedAt: 3_000
    });

    const list = await history.list();
    expect(list.map((e) => e.id)).toEqual(["typed", "busy"]);
    expect(list[0].lastUserAt).toBe(3_000);
  });

  it("does not create a file for a brand-new empty session", async () => {
    await history.save(makeSession([]));
    expect(await history.list()).toHaveLength(0);
    expect(await history.load("sess-1")).toBeNull();
  });

  it("DELETES an existing session when it loses all user content (rewind-to-empty)", async () => {
    await history.save(makeSession([userEvent("hello")]));
    expect(await history.list()).toHaveLength(1);

    // Rewinding the only message empties the timeline. Saving that empty
    // state must remove the stale file, not silently skip it — otherwise a
    // reload resurrects the cleared chat.
    await history.save(makeSession([]));

    expect(await history.list()).toHaveLength(0);
    expect(await history.load("sess-1")).toBeNull();
  });
});

describe("HistoryService project scoping", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "luno-history-scope-"));
  });

  afterEach(() => {
    workspace.root = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  function serviceFor(root: string | undefined): HistoryService {
    workspace.root = root;
    return new HistoryService({
      globalStorageUri: { fsPath: dir }
    } as never);
  }

  function sessionNamed(id: string): StoredSession {
    return { ...makeSession([userEvent("hello")]), id };
  }

  it("lists only the chats belonging to the open project", async () => {
    const alpha = serviceFor("/repo/alpha");
    await alpha.save(sessionNamed("in-alpha"));
    const beta = serviceFor("/repo/beta");
    await beta.save(sessionNamed("in-beta"));

    expect((await beta.list()).map((e) => e.id)).toEqual(["in-beta"]);
    expect((await serviceFor("/repo/alpha").list()).map((e) => e.id)).toEqual([
      "in-alpha"
    ]);
  });

  it("stamps the project on the way to disk, not at read time", async () => {
    const alpha = serviceFor("/repo/alpha");
    await alpha.save(sessionNamed("in-alpha"));

    const stored = await alpha.load("in-alpha");
    expect(stored?.workspaceRoot).toBe("/repo/alpha");
  });

  it("keeps a session in the project that created it", async () => {
    const alpha = serviceFor("/repo/alpha");
    await alpha.save(sessionNamed("in-alpha"));

    // Re-saving from elsewhere must not re-home the conversation: the stamp is
    // written once and then left alone.
    const beta = serviceFor("/repo/beta");
    const stored = (await beta.load("in-alpha")) as StoredSession;
    await beta.save(stored);

    expect((await beta.list()).map((e) => e.id)).toEqual([]);
    expect((await serviceFor("/repo/alpha").list()).map((e) => e.id)).toEqual([
      "in-alpha"
    ]);
  });

  it("hides chats written before the field existed", async () => {
    // Written by an older build: no `workspaceRoot` at all. Treated as
    // belonging to no project rather than to every one of them.
    const legacy = serviceFor(undefined);
    await legacy.save(sessionNamed("legacy"));

    expect((await serviceFor("/repo/alpha").list()).map((e) => e.id)).toEqual(
      []
    );
  });

  it("filters nothing when no folder is open", async () => {
    const alpha = serviceFor("/repo/alpha");
    await alpha.save(sessionNamed("in-alpha"));

    // Nothing to scope to, and an empty list would just look broken.
    expect((await serviceFor(undefined).list()).map((e) => e.id)).toEqual([
      "in-alpha"
    ]);
  });
});
