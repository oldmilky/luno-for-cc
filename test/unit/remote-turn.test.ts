import { describe, expect, it } from "vitest";

import { Orchestrator } from "../../src/core/orchestrator.js";
import { Session } from "../../src/core/session.js";
import { DeltaQueue } from "../../src/core/delta-queue.js";
import {
  replayedPrompt,
  isCliControlMarker,
  takeEcho,
  type CliEvent
} from "../../src/providers/claude-cli.js";
import type { ChatProvider } from "../../src/providers/base.js";

/** A provider that would fail the test if a remote turn ever wrote to it: the
 *  prompt has already been sent, from somewhere else. */
const silentProvider = {
  id: "fake",
  stream(): AsyncIterable<never> {
    throw new Error("a remote turn must not send a prompt of its own");
  }
} as unknown as ChatProvider;

describe("replayedPrompt", () => {
  it("reads the bare-string form the CLI actually sends", () => {
    // Measured against 2.1.219: the replay carries the prompt as a string,
    // where every other message on this stream is a list of blocks.
    const ev: CliEvent = {
      type: "user",
      isReplay: true,
      parent_tool_use_id: null,
      message: { content: "Reply with exactly: pong" }
    } as CliEvent;
    expect(replayedPrompt(ev)).toBe("Reply with exactly: pong");
  });

  it("reads the block form too", () => {
    const ev = {
      type: "user",
      isReplay: true,
      message: { content: [{ type: "text", text: "from the phone" }] }
    } as CliEvent;
    expect(replayedPrompt(ev)).toBe("from the phone");
  });

  // The flag is what `--replay-user-messages` puts on what it replays, and it
  // is the only thing separating a prompt someone typed from a `user` record
  // the CLI wrote for its own bookkeeping.
  it("ignores a user record the CLI did not replay", () => {
    const ev = {
      type: "user",
      message: { content: "[Request interrupted by user]" }
    } as CliEvent;
    expect(replayedPrompt(ev)).toBeNull();
  });

  // Observed with Remote Control on: Stop put this on the timeline as the
  // user's own message three times in one session, each opening a turn against
  // the CLI — so the model answered a control marker as if it were a prompt.
  it("knows the CLI's own control markers are not prompts", () => {
    expect(isCliControlMarker("[Request interrupted by user]")).toBe(true);
    expect(isCliControlMarker("  [Request interrupted by user]  ")).toBe(true);
    expect(isCliControlMarker("please interrupt the build")).toBe(false);
    expect(isCliControlMarker("")).toBe(false);
  });

  it("is not fooled by the tool_result envelope, which is also a user event", () => {
    // Every tool the model runs comes back as `type: "user"`. Treating one as a
    // prompt would put a raw tool result on the timeline as something the user
    // supposedly typed, and start a turn on top of the one already running.
    const ev = {
      type: "user",
      isReplay: true,
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "ok" },
          { type: "text", text: "trailing note" }
        ]
      }
    } as CliEvent;
    expect(replayedPrompt(ev)).toBeNull();
  });

  it("ignores what a subagent said", () => {
    const ev = {
      type: "user",
      parent_tool_use_id: "toolu_agent",
      message: { content: "find the callers" }
    } as CliEvent;
    expect(replayedPrompt(ev)).toBeNull();
  });

  it("ignores every other event type", () => {
    const ev = {
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] }
    } as CliEvent;
    expect(replayedPrompt(ev)).toBeNull();
  });
});

describe("takeEcho", () => {
  it("drops the replay carrying an id we sent", () => {
    const pending = new Set(["u-1"]);
    expect(takeEcho(pending, "u-1")).toBe(true);
    expect(pending.size).toBe(0);
  });

  it("keeps a prompt whose id we never sent, even with identical text", () => {
    // The measured shape: the CLI marks our echo and the phone's prompt the
    // same way, and the words may be the same too. Only the id we minted
    // before sending separates them — matching on text would swallow a phone
    // repeating what the panel had just asked.
    const pending = new Set(["u-ours"]);
    expect(takeEcho(pending, "u-theirs")).toBe(false);
    expect(pending.has("u-ours")).toBe(true);
  });

  it("consumes the match, so a resent id is not swallowed twice", () => {
    const pending = new Set(["u-1"]);
    expect(takeEcho(pending, "u-1")).toBe(true);
    expect(takeEcho(pending, "u-1")).toBe(false);
  });

  it("treats a replay with no id as somebody else's", () => {
    // Ours always carries one. Dropping an unidentified prompt would lose a
    // message; showing it twice would only be untidy.
    const pending = new Set(["u-1"]);
    expect(takeEcho(pending, undefined)).toBe(false);
  });
});

describe("DeltaQueue", () => {
  it("holds what arrived before anyone was reading", async () => {
    // The reader pushes on its own thread; the consumer starts one await later.
    // Anything dropped in that window is the beginning of the answer.
    const q = new DeltaQueue();
    q.push({ type: "text", text: "early" });
    q.push({ type: "done" });
    const seen = [];
    for await (const d of q) seen.push(d);
    expect(seen).toEqual([{ type: "text", text: "early" }]);
  });

  it("ends on `done` without yielding it", async () => {
    const q = new DeltaQueue();
    const seen: string[] = [];
    const reading = (async () => {
      for await (const d of q) seen.push(d.type);
    })();
    q.push({ type: "text", text: "a" });
    q.push({ type: "done" });
    q.push({ type: "text", text: "after the end" });
    await reading;
    expect(seen).toEqual(["text"]);
  });

  it("close() ends a turn whose `done` will never come", async () => {
    // Stop, with a CLI that answers no further. Without this the panel would
    // stay busy for the rest of the session.
    const q = new DeltaQueue();
    const seen: string[] = [];
    const reading = (async () => {
      for await (const d of q) seen.push(d.type);
    })();
    q.push({ type: "text", text: "half an answer" });
    q.close();
    await reading;
    expect(seen).toEqual(["text"]);
  });
});

describe("observing a turn started on another device", () => {
  it("puts the prompt and the answer on the timeline", async () => {
    const session = new Session();
    const orch = new Orchestrator(session, {
      provider: silentProvider,
      model: "opus",
      maxTokens: 1000
    });
    const q = new DeltaQueue();
    const turn = orch.observe("what does this repo do?", q);
    q.push({ type: "text", text: "It is a chat panel." });
    q.push({ type: "done" });
    await turn;

    expect(session.timeline.map((e) => [e.kind, e.body])).toEqual([
      ["user", "what does this repo do?"],
      ["assistant", "It is a chat panel."]
    ]);
  });

  it("keeps the history a follow-up from either surface is answered against", async () => {
    const session = new Session();
    const orch = new Orchestrator(session, {
      provider: silentProvider,
      model: "opus",
      maxTokens: 1000
    });
    const q = new DeltaQueue();
    const turn = orch.observe("hi", q);
    q.push({ type: "text", text: "hello" });
    q.push({ type: "done" });
    await turn;

    expect(session.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] }
    ]);
  });

  it("runs tool calls through the same interception as a local turn", async () => {
    const session = new Session();
    const orch = new Orchestrator(session, {
      provider: silentProvider,
      model: "opus",
      maxTokens: 1000
    });
    const q = new DeltaQueue();
    const turn = orch.observe("read it", q);
    q.push({ type: "tool_use_start", tool: { id: "t1", name: "Read" } });
    q.push({ type: "tool_use_input", partialInput: '{"file_path":"a.ts"}' });
    q.push({ type: "tool_use_end" });
    q.push({ type: "tool_result", toolUseId: "t1", resultContent: "ok" });
    q.push({ type: "done" });
    await turn;

    const kinds = session.timeline.map((e) => e.kind);
    expect(kinds).toEqual(["user", "tool_call", "tool_result"]);
  });

  it("captures a checkpoint, so a rewind across it restores files too", async () => {
    // The remote turn edits the same working tree as a local one. Skipping the
    // snapshot would leave a rewind that moves the timeline but not the files.
    const session = new Session();
    const captured: string[] = [];
    session.onUserTurn((eventId) => {
      captured.push(eventId);
    });
    const orch = new Orchestrator(session, {
      provider: silentProvider,
      model: "opus",
      maxTokens: 1000
    });
    const q = new DeltaQueue();
    const turn = orch.observe("edit the file", q);
    q.push({ type: "done" });
    await turn;

    expect(captured).toEqual([session.timeline[0].id]);
  });
});
