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

import { HistoryService, StoredSession } from "../../src/services/history.js";
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
