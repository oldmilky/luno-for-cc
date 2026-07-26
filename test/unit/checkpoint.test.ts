import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { CheckpointService } from "../../src/services/checkpoint.js";

const pexec = promisify(exec);

describe("CheckpointService", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "iri-cp-"));
    await pexec("git init", { cwd: tmp });
    await pexec('git config user.email "t@t.com"', { cwd: tmp });
    await pexec('git config user.name "t"', { cwd: tmp });
    await fs.writeFile(path.join(tmp, "a.txt"), "original-a");
    await fs.writeFile(path.join(tmp, "b.txt"), "original-b");
    await pexec("git add -A && git commit -m init", { cwd: tmp });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("captures and restores modified files", async () => {
    const svc = new CheckpointService(tmp, "sess-1");
    await fs.writeFile(path.join(tmp, "a.txt"), "changed-a");
    await svc.captureBefore("turn-1");

    await fs.writeFile(path.join(tmp, "a.txt"), "changed-again");
    const { restored } = await svc.restore("turn-1");
    expect(restored).toBeGreaterThanOrEqual(1);
    const after = await fs.readFile(path.join(tmp, "a.txt"), "utf8");
    expect(after).toBe("changed-a");
  });

  it("captures untracked files and restores their content", async () => {
    const svc = new CheckpointService(tmp, "sess-2");
    await fs.writeFile(path.join(tmp, "new.txt"), "exists-before");
    await svc.captureBefore("turn-1");

    await fs.writeFile(path.join(tmp, "new.txt"), "modified-after");
    const { restored } = await svc.restore("turn-1");
    expect(restored).toBeGreaterThanOrEqual(1);
    const after = await fs.readFile(path.join(tmp, "new.txt"), "utf8");
    expect(after).toBe("exists-before");
  });

  it("addFileToLatest deletes files that did not exist at capture time", async () => {
    const svc = new CheckpointService(tmp, "sess-2b");
    await svc.captureBefore("turn-1");
    // Agent later creates a file. Simulate: mark it in the checkpoint BEFORE it exists.
    await svc.addFileToLatest("brand-new.txt");
    // Now agent actually writes it.
    await fs.writeFile(path.join(tmp, "brand-new.txt"), "agent-created");

    const { deleted } = await svc.restore("turn-1");
    expect(deleted).toBeGreaterThanOrEqual(1);
    await expect(fs.access(path.join(tmp, "brand-new.txt"))).rejects.toThrow();
  });

  it("drops forward history on rewind", async () => {
    const svc = new CheckpointService(tmp, "sess-3");
    await fs.writeFile(path.join(tmp, "a.txt"), "v1");
    await svc.captureBefore("t1");
    await fs.writeFile(path.join(tmp, "a.txt"), "v2");
    await svc.captureBefore("t2");

    expect(svc.hasCheckpoint("t1")).toBe(true);
    expect(svc.hasCheckpoint("t2")).toBe(true);

    await svc.restore("t1");
    expect(svc.hasCheckpoint("t1")).toBe(true);
    expect(svc.hasCheckpoint("t2")).toBe(false);
  });

  it("restoreFile rewrites the file from its most recent snapshot", async () => {
    const svc = new CheckpointService(tmp, "sess-rf");
    await fs.writeFile(path.join(tmp, "a.txt"), "before-write");
    await svc.captureBefore("t1");
    await fs.writeFile(path.join(tmp, "a.txt"), "after-write");
    const result = await svc.restoreFile("a.txt");
    expect(result).toEqual({ deleted: false });
    const after = await fs.readFile(path.join(tmp, "a.txt"), "utf8");
    expect(after).toBe("before-write");
  });

  it("restoreFile normalizes absolute paths inside the workspace", async () => {
    const svc = new CheckpointService(tmp, "sess-rf-abs");
    await fs.writeFile(path.join(tmp, "a.txt"), "before-write");
    await svc.captureBefore("t1");
    await fs.writeFile(path.join(tmp, "a.txt"), "after-write");
    // Caller passes the agent's absolute path — service must still find it.
    const abs = path.join(tmp, "a.txt");
    const result = await svc.restoreFile(abs);
    expect(result).toEqual({ deleted: false });
    const after = await fs.readFile(path.join(tmp, "a.txt"), "utf8");
    expect(after).toBe("before-write");
  });

  it("addFileToLatest captures git HEAD content for tracked files (pre-edit state)", async () => {
    // This is the critical regression test: in Claude CLI mode the
    // tool_call event arrives AFTER the CLI executed the tool, so reading
    // the file from disk gives us the *post-edit* content. addFileToLatest
    // must instead pull from git HEAD so revert restores the original.
    const svc = new CheckpointService(tmp, "sess-head");
    await svc.captureBefore("turn-1");
    // Simulate the race: the agent has already mutated a tracked file
    // on disk by the time we're asked to snapshot it.
    await fs.writeFile(path.join(tmp, "a.txt"), "agent-overwrote-it");
    await svc.addFileToLatest("a.txt");
    // Now restore — should get the HEAD content "original-a", NOT
    // "agent-overwrote-it".
    const result = await svc.restoreFile("a.txt");
    expect(result).toEqual({ deleted: false });
    const after = await fs.readFile(path.join(tmp, "a.txt"), "utf8");
    expect(after).toBe("original-a");
  });

  it("addFileToLatest treats untracked existing files as 'did-not-exist'", async () => {
    // For files git doesn't know about, we can't recover their pre-edit
    // state (no HEAD entry, and disk has post-edit content). Storing
    // existed:false means revert will delete the file, which is the
    // safest outcome for "the agent created this file".
    const svc = new CheckpointService(tmp, "sess-untracked");
    await svc.captureBefore("turn-1");
    await fs.writeFile(path.join(tmp, "agent-only.txt"), "agent-wrote-this");
    await svc.addFileToLatest("agent-only.txt");
    const result = await svc.restoreFile("agent-only.txt");
    expect(result).toEqual({ deleted: true });
    await expect(fs.access(path.join(tmp, "agent-only.txt"))).rejects.toThrow();
  });

  it("addFileToLatest stores workspace-relative paths even when given absolute", async () => {
    const svc = new CheckpointService(tmp, "sess-add-abs");
    await svc.captureBefore("t1");
    // Agent emits an absolute path in its tool input.
    await svc.addFileToLatest(path.join(tmp, "fresh.txt"));
    await fs.writeFile(path.join(tmp, "fresh.txt"), "agent-created");

    // Either form must hit the same snapshot.
    expect(svc.hasSnapshotFor("fresh.txt")).toBe(true);
    expect(svc.hasSnapshotFor(path.join(tmp, "fresh.txt"))).toBe(true);

    const result = await svc.restoreFile(path.join(tmp, "fresh.txt"));
    expect(result).toEqual({ deleted: true });
    await expect(fs.access(path.join(tmp, "fresh.txt"))).rejects.toThrow();
  });

  it("restoreFile returns null when no snapshot exists", async () => {
    const svc = new CheckpointService(tmp, "sess-miss");
    await svc.captureBefore("t1");
    const result = await svc.restoreFile("never-snapshotted.txt");
    expect(result).toBeNull();
  });

  it("addFileToLatest ignores absolute paths outside the workspace", async () => {
    const svc = new CheckpointService(tmp, "sess-outside");
    await svc.captureBefore("t1");
    await svc.addFileToLatest("/tmp/somewhere-else.txt");
    expect(svc.hasSnapshotFor("/tmp/somewhere-else.txt")).toBe(false);
  });

  it("gc keeps last 20 per session", async () => {
    const svc = new CheckpointService(tmp, "sess-4");
    for (let i = 0; i < 25; i++) {
      await svc.captureBefore(`t-${i}`);
    }
    expect(svc.list().length).toBe(20);
    expect(svc.hasCheckpoint("t-0")).toBe(false);
    expect(svc.hasCheckpoint("t-24")).toBe(true);
  });
});
