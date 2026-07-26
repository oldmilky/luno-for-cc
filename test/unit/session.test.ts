import { describe, it, expect } from "vitest";
import { Session } from "../../src/core/session.js";
import { ContentBlock } from "../../src/core/types.js";

describe("Session basics", () => {
  it("records a user turn into messages + timeline and runs the onUserTurn hook", async () => {
    const session = new Session();
    const hookCalls: string[] = [];
    session.onUserTurn((id) => {
      hookCalls.push(id);
    });
    const ev = await session.addUser("hello");
    expect(session.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(session.timeline.map((e) => e.kind)).toEqual(["user"]);
    expect(hookCalls).toEqual([ev.id]);
  });

  it("emits tool_call and tool_result events and appends a tool_result message", () => {
    const session = new Session();
    session.emitToolCall("t1", "Edit", { path: "a.ts" });
    session.addToolResult("t1", "done", false);
    expect(session.timeline.map((e) => e.kind)).toEqual(["tool_call", "tool_result"]);
    const last = session.messages.at(-1)!;
    expect(Array.isArray(last.content)).toBe(true);
    const block = (last.content as ContentBlock[])[0];
    expect(block).toMatchObject({ type: "tool_result", tool_use_id: "t1", content: "done" });
  });

  it("summarizes a plan answer into a readable body", () => {
    const session = new Session();
    const ev = session.emitPlanAnswer({
      questionId: "q",
      answers: [{ choice: "Yes", note: "do it" }, { choice: "No" }]
    });
    expect(ev.body).toBe("Yes — do it · No");
  });
});

describe("Session.truncateAt", () => {
  it("truncates the timeline to just before the given user event", async () => {
    const session = new Session();
    const u1 = await session.addUser("first");
    session.emit({ kind: "assistant", title: "Assistant", body: "reply one" });
    const u2 = await session.addUser("second");
    session.emit({ kind: "assistant", title: "Assistant", body: "reply two" });

    const surviving = session.truncateAt(u2.id);
    expect(surviving.map((e) => e.kind)).toEqual(["user", "assistant"]);
    expect(surviving[0].id).toBe(u1.id);
  });

  it("returns the full timeline unchanged if the id is not found", async () => {
    const session = new Session();
    await session.addUser("a");
    const before = session.timeline.length;
    const surviving = session.truncateAt("does-not-exist");
    expect(surviving).toHaveLength(before);
  });

  // ───────────────────────────────────────────────────────────
  // KNOWN BUG: truncateAt rebuilds `messages` from the surviving timeline
  // but only reconstructs user(string) and assistant(text) entries —
  // tool_call and tool_result events are dropped, so the assistant's tool
  // context is lost from the in-memory message history after a rewind/edit.
  // See src/core/session.ts:131-145.
  // ───────────────────────────────────────────────────────────
  it("documents that tool events survive in the timeline but are dropped from messages", async () => {
    const session = new Session();
    await session.addUser("first");
    session.emitToolCall("t1", "Edit", { path: "a.ts" });
    session.addToolResult("t1", "edited a.ts");
    session.emit({ kind: "assistant", title: "Assistant", body: "I edited a.ts" });
    const u2 = await session.addUser("second");

    session.truncateAt(u2.id);

    // The timeline still has the tool_call + tool_result events:
    expect(session.timeline.some((e) => e.kind === "tool_call")).toBe(true);
    expect(session.timeline.some((e) => e.kind === "tool_result")).toBe(true);

    // But the rebuilt messages contain NO tool_use / tool_result blocks:
    const hasToolBlocks = session.messages.some(
      (m) =>
        Array.isArray(m.content) &&
        (m.content as ContentBlock[]).some(
          (b) => b.type === "tool_use" || b.type === "tool_result"
        )
    );
    expect(hasToolBlocks).toBe(false);
  });

  it.fails("messages should preserve tool context after truncateAt", async () => {
    const session = new Session();
    await session.addUser("first");
    session.emitToolCall("t1", "Edit", { path: "a.ts" });
    session.addToolResult("t1", "edited a.ts");
    const u2 = await session.addUser("second");
    session.truncateAt(u2.id);
    const hasToolBlocks = session.messages.some(
      (m) =>
        Array.isArray(m.content) &&
        (m.content as ContentBlock[]).some(
          (b) => b.type === "tool_use" || b.type === "tool_result"
        )
    );
    expect(hasToolBlocks).toBe(true);
  });
});
