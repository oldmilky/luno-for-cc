import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

// history.ts only needs vscode for the ExtensionContext type; stub the module
// so the import resolves in vitest's node environment.
vi.mock("vscode", () => ({}));

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
