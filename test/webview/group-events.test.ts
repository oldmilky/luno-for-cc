import { describe, it, expect } from "vitest";
import { groupEvents } from "../../webview/src/features/chat/timeline/group-events.js";
import type { TimelineEvent } from "../../webview/src/lib/rpc.js";

// The fold from a flat event list into the turns the chat draws. It had no
// test while it lived inside `ChatScreen.tsx` — reaching it meant rendering a
// component — so this is new coverage, not moved coverage.

const T0 = 1_700_000_000_000;

function ev(
  id: string,
  dt: number,
  kind: TimelineEvent["kind"],
  title: string,
  body?: string,
  meta?: Record<string, unknown>
): TimelineEvent {
  return { id, ts: T0 + dt, kind, title, body, meta };
}

function call(
  id: string,
  dt: number,
  name: string,
  body = "{}"
): TimelineEvent {
  return ev(id, dt, "tool_call", name, body, { toolUseId: id, name });
}

function result(id: string, dt: number, name: string): TimelineEvent {
  return ev(`${id}r`, dt, "tool_result", name, "ok", { toolUseId: id });
}

/** The turn groups only, which is what every assertion below is about. */
function turns(events: TimelineEvent[]) {
  return groupEvents(events).groups.filter((g) => g.kind === "turn");
}

describe("groupEvents — turns", () => {
  it("opens one turn per user message", () => {
    const { groups } = groupEvents([
      ev("u1", 0, "user", "first"),
      ev("a1", 1000, "assistant", "", "answer one"),
      ev("u2", 2000, "user", "second"),
      ev("a2", 3000, "assistant", "", "answer two")
    ]);
    expect(groups.filter((g) => g.kind === "user")).toHaveLength(2);
    expect(groups.filter((g) => g.kind === "turn")).toHaveLength(2);
  });

  it("keeps the answer outside the collapsible when no tool ran", () => {
    const [turn] = turns([
      ev("u1", 0, "user", "hi"),
      ev("a1", 1000, "assistant", "", "just an answer")
    ]);
    expect(turn.kind === "turn" && turn.blocks).toHaveLength(0);
    expect(
      turn.kind === "turn" &&
        turn.responseBlocks.some(
          (b) => b.kind === "narrative" && b.text === "just an answer"
        )
    ).toBe(true);
  });
});

describe("groupEvents — tool bucketing", () => {
  it("merges consecutive calls of one bucket into a single group", () => {
    const [turn] = turns([
      ev("u1", 0, "user", "read them"),
      call("t1", 1000, "Read"),
      result("t1", 1100, "Read"),
      call("t2", 1200, "Read"),
      result("t2", 1300, "Read")
    ]);
    const groupsOfTools =
      turn.kind === "turn"
        ? turn.blocks.filter((b) => b.kind === "toolGroup")
        : [];
    expect(groupsOfTools).toHaveLength(1);
    expect(
      groupsOfTools[0].kind === "toolGroup" && groupsOfTools[0].items
    ).toHaveLength(2);
  });

  it("starts a new group when the bucket changes", () => {
    const [turn] = turns([
      ev("u1", 0, "user", "read then search"),
      call("t1", 1000, "Read"),
      result("t1", 1100, "Read"),
      call("t2", 1200, "Grep"),
      result("t2", 1300, "Grep")
    ]);
    const buckets =
      turn.kind === "turn"
        ? turn.blocks
            .filter((b) => b.kind === "toolGroup")
            .map((b) => (b.kind === "toolGroup" ? b.bucket : ""))
        : [];
    expect(buckets).toEqual(["read", "search"]);
  });
});

describe("groupEvents — timing", () => {
  it("measures thinking to the first tool and work to the last event", () => {
    const [turn] = turns([
      ev("u1", 0, "user", "go"),
      ev("a1", 1_000, "assistant", "", "thinking out loud"),
      call("t1", 13_000, "Read"),
      result("t1", 14_000, "Read"),
      ev("a2", 61_000, "assistant", "", "done")
    ]);
    // Both are measured from the turn's own start, not from the user message.
    expect(turn.kind === "turn" && turn.thoughtMs).toBe(12_000);
    expect(turn.kind === "turn" && turn.workedMs).toBe(60_000);
  });

  it("leaves an unfinished turn without a worked duration", () => {
    const [turn] = turns([ev("u1", 0, "user", "go")]);
    expect(turn).toBeUndefined();
  });
});

describe("groupEvents — pre-tool text is thought, post-tool text is not", () => {
  it("buffers assistant text before the first tool as the thought", () => {
    const [turn] = turns([
      ev("u1", 0, "user", "go"),
      ev("a1", 1000, "assistant", "", "before the tool"),
      call("t1", 2000, "Read"),
      result("t1", 2100, "Read"),
      ev("a2", 3000, "assistant", "", "after the tool")
    ]);
    expect(turn.kind === "turn" && turn.thought).toBe("before the tool");
    expect(
      turn.kind === "turn" &&
        turn.responseBlocks.some(
          (b) => b.kind === "narrative" && b.text === "after the tool"
        )
    ).toBe(true);
  });
});
