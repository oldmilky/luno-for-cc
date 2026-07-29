import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { readFileSync } from "node:fs";

// Mock the child process so we can drive stream() end-to-end without a real
// `claude` binary. Kept in its own file so the module mock doesn't leak into
// the pure-unit tests in claude-cli.test.ts.
vi.mock("node:child_process", async (orig) => {
  const actual = await (orig() as Promise<typeof import("node:child_process")>);
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from "node:child_process";
import { ClaudeCliProvider } from "../../src/providers/claude-cli.js";
import type { StreamDelta } from "../../src/core/types.js";
import type { ProviderRequest } from "../../src/providers/base.js";

/** A minimal stand-in for the spawned `claude` process: real streams for
 *  stdout/stderr/stdin plus EventEmitter exit/error and a kill() that records
 *  the signal. We push CLI stream-json lines into `stdout` to simulate the
 *  agent, and simply never emit a tool_result to simulate a wedged tool. */
function makeFakeChild() {
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  // Kept, not discarded: what goes *into* the CLI is the whole of steering, and
  // a test that cannot read stdin can only assert that nothing crashed.
  child.written = [] as unknown[];
  child.stdin = new Writable({
    write: (chunk: Buffer, _e: unknown, cb: () => void) => {
      for (const line of String(chunk).split("\n").filter(Boolean)) {
        try {
          child.written.push(JSON.parse(line));
        } catch {
          child.written.push(line);
        }
      }
      cb();
    }
  });
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (sig?: string) => {
    child.killed = true;
    child.signalCode = sig ?? null;
    return true;
  };
  child.emitLine = (obj: unknown) =>
    child.stdout.write(JSON.stringify(obj) + "\n");
  return child;
}

function req(): ProviderRequest {
  return {
    model: "claude-sonnet-4-6",
    maxTokens: 1,
    messages: [{ role: "user", content: "fetch the docs" }],
    tools: []
  };
}

/** Start consuming the generator, then yield a macrotask so stream() finishes
 *  its synchronous setup (listeners + first await) before we feed events. */
async function drive(provider: ClaudeCliProvider) {
  const collected: StreamDelta[] = [];
  const finished = (async () => {
    for await (const d of provider.stream(req())) collected.push(d);
  })();
  await new Promise((r) => setTimeout(r, 5));
  return { collected, finished };
}

describe("ClaudeCliProvider.stream — tool stall watchdog (integration)", () => {
  let child: any;
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    child = makeFakeChild();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(child);
  });
  afterEach(() => vi.restoreAllMocks());

  it("stops the turn with an error result when WebFetch never returns", async () => {
    const provider = new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "default",
      toolStallMs: 40 // short budget so the test is fast
    });
    const { collected, finished } = await drive(provider);

    // Agent dispatches WebFetch (start+input+end) but the CLI never sends a
    // tool_result — the tool is wedged.
    child.emitLine({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "wf1",
            name: "WebFetch",
            input: { url: "https://developer-docs.amazon.com/sp-api" }
          }
        ]
      }
    });

    await finished; // resolves once the watchdog fires and ends the turn

    const result = collected.find((d) => d.type === "tool_result");
    expect(result).toBeDefined();
    expect(result!.toolUseId).toBe("wf1");
    expect(result!.resultIsError).toBe(true);
    expect(result!.resultContent).toMatch(
      /did not respond within 0?40?s|did not respond within/i
    );
    // The wedged CLI was stopped rather than left hanging for 10 minutes.
    expect(child.killed).toBe(true);
    expect(child.signalCode).toBe("SIGTERM");
  });

  it("does NOT inject an error when WebFetch returns a result in time", async () => {
    const provider = new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "default",
      toolStallMs: 200
    });
    const { collected, finished } = await drive(provider);

    child.emitLine({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "wf1",
            name: "WebFetch",
            input: { url: "https://x" }
          }
        ]
      }
    });
    // Real result arrives well within the 200ms budget.
    child.emitLine({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "wf1",
            content: "fetched ok",
            is_error: false
          }
        ]
      }
    });
    // End the turn normally.
    child.emitLine({ type: "result", subtype: "success", result: "done" });

    await finished;

    // Exactly the real result — the watchdog injected no error result.
    const results = collected.filter((d) => d.type === "tool_result");
    expect(results).toHaveLength(1);
    expect(results[0].resultIsError).toBe(false);
    expect(results[0].resultContent).toBe("fetched ok");
    // (child.killed is true here only because the generator's finally always
    //  reaps the process on completion — that's normal cleanup, not a stall.)
  });

  it("leaves a slow non-watched tool (Bash) alone past the budget", async () => {
    const provider = new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "default",
      toolStallMs: 30
    });
    const { collected, finished } = await drive(provider);

    child.emitLine({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "b1",
            name: "Bash",
            input: { command: "sleep 1" }
          }
        ]
      }
    });
    // Wait well past the watchdog budget — Bash is intentionally unwatched.
    await new Promise((r) => setTimeout(r, 80));
    expect(collected.find((d) => d.type === "tool_result")).toBeUndefined();
    expect(child.killed).toBe(false);

    // Now the Bash result lands and the turn ends cleanly — the only
    // tool_result is the real one, never a watchdog timeout.
    child.emitLine({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "b1",
            content: "ok",
            is_error: false
          }
        ]
      }
    });
    child.emitLine({ type: "result", subtype: "success", result: "done" });
    await finished;
    const results = collected.filter((d) => d.type === "tool_result");
    expect(results).toHaveLength(1);
    expect(results[0].resultIsError).toBe(false);
  });
});

// A `run_in_background` subagent keeps working past the turn's `result`.
// Closing stdin there — which is what ends the turn — exits the child and kills
// the agent mid-step, so its card could only ever read "interrupted". Timed
// against 2.1.220: one agent reported `completed` with its full answer 5.6s
// after `result` arrived.
describe("ClaudeCliProvider.stream — backgrounded subagents", () => {
  let child: any;
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    child = makeFakeChild();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(child);
  });
  afterEach(() => vi.restoreAllMocks());

  const provider = () =>
    new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "default",
      // Both long enough that only an explicit end fires.
      backgroundGraceMs: 10_000,
      taskReportGraceMs: 10_000
    });

  const started = {
    type: "system",
    subtype: "task_started",
    task_id: "t1",
    tool_use_id: "toolu_a",
    subagent_type: "Explore",
    description: "Find makeProcessor"
  };

  it("holds the turn open while a launched agent is still running", async () => {
    const { collected, finished } = await drive(provider());
    child.emitLine(started);
    child.emitLine({ type: "result", subtype: "success" });
    await new Promise((r) => setTimeout(r, 30));

    // The turn has NOT ended: no `done`, and stdin is still open for the agent.
    expect(collected.some((d) => d.type === "done")).toBe(false);
    expect(child.stdin.writableEnded).toBe(false);

    child.emitLine({
      type: "system",
      subtype: "task_notification",
      task_id: "t1",
      status: "completed",
      summary: "src/providers/claude-cli.ts"
    });
    // The launching turn's own `result`. The model has still said nothing about
    // what came back, so this is not the end of anything.
    child.emitLine({ type: "result", subtype: "success" });
    child.emitLine({
      type: "assistant",
      message: { content: [{ type: "text", text: "It is in claude-cli.ts." }] }
    });
    child.emitLine({ type: "result", subtype: "success" });
    await finished;

    const answer = collected.filter((d) => d.type === "task").pop();
    expect(answer!.task).toMatchObject({
      status: "completed",
      summary: "src/providers/claude-cli.ts"
    });
  });

  // The shape a short workflow always produces: it finishes *before* the turn
  // that launched it reports, so `result` arrives with nothing open. Ending
  // there discarded the follow-up turn the CLI opens to answer its own
  // `<task-notification>` — the only place the run's result is ever stated.
  it("waits for the report on a task that finished before the result", async () => {
    const { collected, finished } = await drive(provider());
    child.emitLine({
      type: "system",
      subtype: "task_started",
      task_id: "w1",
      tool_use_id: "toolu_w",
      task_type: "local_workflow",
      workflow_name: "probe",
      description: "probe run"
    });
    child.emitLine({
      type: "system",
      subtype: "task_notification",
      task_id: "w1",
      status: "completed",
      summary: 'Dynamic workflow "probe run" completed'
    });
    child.emitLine({ type: "result", subtype: "success" });
    await new Promise((r) => setTimeout(r, 30));

    expect(collected.some((d) => d.type === "done")).toBe(false);

    // The follow-up turn, verbatim in shape from 2.1.219.
    child.emitLine({ type: "system", subtype: "init" });
    child.emitLine({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: 'Workflow completed. Result: {"a":"OK"}' }
        ]
      }
    });
    child.emitLine({ type: "result", subtype: "success" });
    await finished;

    const text = collected.filter((d) => d.type === "text").pop();
    expect(text!.text).toBe('Workflow completed. Result: {"a":"OK"}');
  });

  // The agent answering is not the end of the turn — the model picks the
  // conversation back up and reports what came back. Ending on the last agent
  // instead of on the `result` that follows it cut the answer mid-sentence,
  // which is what shipped in 0.22.4.
  it("lets the model report on an agent before ending the turn", async () => {
    const { collected, finished } = await drive(provider());
    child.emitLine(started);
    child.emitLine({ type: "result", subtype: "success" });
    child.emitLine({
      type: "system",
      subtype: "task_notification",
      task_id: "t1",
      status: "completed",
      summary: "found it"
    });
    await new Promise((r) => setTimeout(r, 30));

    // Nothing is running any more, but the turn is not over: the model has not
    // said what the agent found.
    expect(collected.some((d) => d.type === "done")).toBe(false);

    child.emitLine({
      type: "assistant",
      message: { content: [{ type: "text", text: "The first one came back:" }] }
    });
    child.emitLine({ type: "result", subtype: "success" });
    await finished;

    const text = collected.filter((d) => d.type === "text").pop();
    expect(text!.text).toBe("The first one came back:");
  });

  it("ends the turn at `result` when nothing was backgrounded", async () => {
    const { collected, finished } = await drive(provider());
    child.emitLine({ type: "result", subtype: "success" });
    await finished;

    expect(collected.some((d) => d.type === "done")).toBe(true);
  });

  // Quiet is not evidence that an agent stopped. Measured against 2.1.219: the
  // parent's stdout says nothing for the *whole* of a nested tool call — 47.1s
  // across one `sleep 50` — so a run doing something slow is indistinguishable
  // from a run doing nothing. Ending the turn on quiet closed stdin and killed
  // the work; while the CLI reports a task open, the turn is held instead.
  it("holds the turn for an agent that goes quiet", async () => {
    const p = new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "default",
      backgroundGraceMs: 20,
      taskReportGraceMs: 20
    });
    const { collected, finished } = await drive(p);
    child.emitLine(started);
    child.emitLine({ type: "result", subtype: "success" });
    // Several budgets' worth of silence, with the agent saying nothing at all.
    await new Promise((r) => setTimeout(r, 150));

    expect(collected.some((d) => d.type === "done")).toBe(false);

    // It ends when the CLI says the work is done, not when the clock says so.
    child.emitLine({
      type: "system",
      subtype: "task_notification",
      task_id: "t1",
      status: "completed",
      summary: "found it"
    });
    await finished;

    expect(collected.some((d) => d.type === "done")).toBe(true);
  });

  // Progress is a sign of life: the budget is measured from the last one, so a
  // long agent that keeps reporting is not cut off at a flat deadline.
  it("re-arms the wait each time the agent reports progress", async () => {
    const p = new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "default",
      backgroundGraceMs: 60,
      // The agent answering leaves the model's report outstanding; this test is
      // about the budget before that, so let the tail expire immediately.
      taskReportGraceMs: 30
    });
    const { collected, finished } = await drive(p);
    child.emitLine(started);
    child.emitLine({ type: "result", subtype: "success" });

    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 40));
      expect(collected.some((d) => d.type === "done")).toBe(false);
      child.emitLine({
        type: "system",
        subtype: "task_progress",
        task_id: "t1",
        description: `step ${i}`,
        last_tool_name: "Grep"
      });
    }

    child.emitLine({
      type: "system",
      subtype: "task_notification",
      task_id: "t1",
      status: "completed",
      summary: "done"
    });
    await finished;
    expect(collected.some((d) => d.type === "done")).toBe(true);
  });
});

// The wedge watchdog measures SILENCE, not elapsed time. As a deadline from
// spawn it killed turns that were working perfectly — a long build, a long test
// run or a fleet of background agents all look identical to a wall clock, and
// the SIGKILL landed mid-message with no error and nothing in the transcript to
// say why.
describe("ClaudeCliProvider.stream — silence watchdog", () => {
  let child: any;
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    child = makeFakeChild();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(child);
  });
  afterEach(() => vi.restoreAllMocks());

  it("does not kill a turn that keeps emitting past the budget", async () => {
    const provider = new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "default",
      silenceTimeoutMs: 60
    });
    const { collected, finished } = await drive(provider);

    // Six steps at 25ms — 150ms total, well past the 60ms budget, but never
    // 60ms quiet. This is the shape of a turn driving background agents.
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 25));
      child.emitLine({
        type: "system",
        subtype: "task_progress",
        task_id: "t1",
        description: `step ${i}`,
        last_tool_name: "Grep"
      });
      expect(child.killed).toBe(false);
    }

    child.emitLine({ type: "result", subtype: "success", result: "done" });
    await finished;
    expect(collected.some((d) => d.type === "error")).toBe(false);
  });

  it("kills a CLI that has gone completely silent", async () => {
    const provider = new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "default",
      silenceTimeoutMs: 40
    });
    await drive(provider);

    expect(child.killed).toBe(false);
    await new Promise((r) => setTimeout(r, 90));
    expect(child.killed).toBe(true);
    expect(child.signalCode).toBe("SIGKILL");
  });

  it("counts stderr output as a sign of life", async () => {
    const provider = new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "default",
      silenceTimeoutMs: 60
    });
    await drive(provider);

    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 25));
      child.stderr.write("compiling…\n");
    }
    expect(child.killed).toBe(false);
  });
});

// What this guards: a session-mode process must survive an ordinary turn.
//
// Every replacement hands Remote Control a new session URL, so a phone driving
// the conversation is left on a dead one — it sees the history it connected to
// and then nothing, however long the panel keeps working. Both causes were
// per-turn values that no live process can be told about: the MCP config's
// `mkdtemp` path, and the plan-mode playbook the classifier re-derives from
// each prompt.
describe("ClaudeCliProvider — a session process outlives its turns", () => {
  let children: any[];
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    children = [];
    (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const child = makeFakeChild();
      children.push(child);
      return child;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  /** One turn, answered, so the next can start. */
  async function turn(provider: ClaudeCliProvider) {
    const collected: StreamDelta[] = [];
    const finished = (async () => {
      for await (const d of provider.stream(req())) collected.push(d);
    })();
    await new Promise((r) => setTimeout(r, 5));
    children[children.length - 1].emitLine({
      type: "result",
      subtype: "success",
      result: "done"
    });
    await finished;
  }

  it("keeps the same process when only the MCP config path changed", async () => {
    const provider = new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "default",
      sessionMode: true,
      mcpServerNames: ["figma"],
      mcpConfigPath: "/tmp/luno-mcp-aaa/mcp.json"
    });
    await turn(provider);
    provider.updateOptions({ mcpConfigPath: "/tmp/luno-mcp-bbb/mcp.json" });
    await turn(provider);

    expect(children).toHaveLength(1);
  });

  it("keeps the same process when the prompt classifies differently", async () => {
    const provider = new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "plan",
      sessionMode: true,
      taskType: "frontend"
    });
    await turn(provider);
    provider.updateOptions({ taskType: "refactor" });
    await turn(provider);

    expect(children).toHaveLength(1);
  });

  it("still replaces it for something a live session cannot be told", async () => {
    // The guard must not have turned into "never respawn": there is no
    // set_effort in the control protocol, so that one has to replace it.
    const provider = new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "default",
      sessionMode: true,
      effort: "high"
    });
    await turn(provider);
    provider.updateOptions({ effort: "max" });
    await turn(provider);

    expect(children).toHaveLength(2);
  });
});

// A real workflow launch, replayed byte for byte.
//
// `test/fixtures/workflow-stream.jsonl` is the stdout of `claude` 2.1.219
// driven through stream-json, captured while it ran a one-agent workflow. It
// exists because every workflow defect this project has shipped came from
// guessing the wire: a gate on `task_type` (sent once, on the dispatch), and a
// guard on `parent_tool_use_id` (never present on a task event at all). Reading
// the bytes settles those in seconds; reasoning about them cost days.
describe("ClaudeCliProvider.stream — a recorded workflow", () => {
  let child: any;
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    child = makeFakeChild();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(child);
  });
  afterEach(() => vi.restoreAllMocks());

  const recorded = () =>
    readFileSync(
      new URL("../fixtures/workflow-stream.jsonl", import.meta.url),
      "utf8"
    )
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

  it("carries the dispatch, the phases and the answer off the wire", async () => {
    const { collected, finished } = await drive(
      new ClaudeCliProvider({
        binary: "claude",
        cwd: "/tmp",
        permissionMode: "default",
        backgroundGraceMs: 200,
        taskReportGraceMs: 60
      })
    );
    for (const ev of recorded()) child.emitLine(ev);
    await finished;

    const tasks = collected
      .filter((d) => d.type === "task")
      .map((d) => d.task!);
    const started = tasks.find((t) => t.phase === "started")!;
    expect(started).toMatchObject({
      taskType: "local_workflow",
      workflowName: "probe"
    });

    // The phase breakdown reaches us at all. Gated on `task_type`, which the
    // CLI puts on the dispatch and on nothing after it, this was empty.
    const withPhases = tasks.filter((t) => t.workflowProgress?.length);
    expect(withPhases.length).toBeGreaterThan(0);
    expect(withPhases[0].workflowProgress![0]).toMatchObject({
      type: "workflow_phase"
    });

    expect(tasks.at(-1)).toMatchObject({
      phase: "notification",
      status: "completed"
    });
  });

  // The turn must stay open for a workflow that has not reported yet — that is
  // the whole reason `openTasks` exists. If the dispatch never lands in it the
  // budget silently drops to the short one, and a workflow whose agents pause
  // longer than that is killed mid-run with its results lost.
  it("holds the long budget while a launched workflow is unfinished", async () => {
    const { collected } = await drive(
      new ClaudeCliProvider({
        binary: "claude",
        cwd: "/tmp",
        permissionMode: "default",
        backgroundGraceMs: 5_000,
        taskReportGraceMs: 40
      })
    );
    const events = recorded();
    for (const ev of events) {
      if (
        ev.type === "system" &&
        /task_updated|task_notification/.test(ev.subtype ?? "")
      )
        break;
      child.emitLine(ev);
    }
    child.emitLine({ type: "result", subtype: "success" });

    // Well past the short budget, nowhere near the long one.
    await new Promise((r) => setTimeout(r, 250));

    expect(collected.some((d) => d.type === "done")).toBe(false);
    expect(child.stdin.writableEnded).toBe(false);
  });
});

// Session mode: one CLI process serves every turn, so a `result` is not
// self-evidently the answer to the turn currently being read.
describe("ClaudeCliProvider.stream — session mode result correlation", () => {
  let child: any;
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    child = makeFakeChild();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(child);
  });
  afterEach(() => vi.restoreAllMocks());

  const sessionProvider = () =>
    new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "default",
      sessionMode: true
    });

  // The CLI opens a turn of its own to answer a `<task-notification>` and
  // stamps its result `origin: {kind: "task-notification"}`. That turn raises
  // neither of the two flags that mark a turn as ours, so a panel turn
  // submitted while it runs used to be ended by a stranger's `result` before it
  // had said anything.
  it("does not end our turn on the CLI's own task-notification turn", async () => {
    const { collected } = await drive(sessionProvider());

    child.emitLine({
      type: "result",
      subtype: "success",
      origin: { kind: "task-notification" }
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(collected.some((d) => d.type === "done")).toBe(false);
  });

  it("ends our turn on a result that carries no foreign origin", async () => {
    const { collected, finished } = await drive(sessionProvider());

    child.emitLine({ type: "result", subtype: "success" });
    await finished;

    expect(collected.some((d) => d.type === "done")).toBe(true);
  });
});

// Steering: a second `user` message written into a turn that is already
// running. The CLI takes it at the next tool boundary and continues the *same*
// turn — measured on 2.1.219, written at 7.78s and echoed at 8.24s with no
// second `system/init` and one `result`.
//
// The two cases below are the same write with the reader in two states, and
// they are the whole of the attribution rule: the echo says which happened.
describe("ClaudeCliProvider — steering a running turn", () => {
  let child: any;
  let outOfTurn: StreamDelta[];
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    child = makeFakeChild();
    outOfTurn = [];
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(child);
  });
  afterEach(() => vi.restoreAllMocks());

  const sessionProvider = () =>
    new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "default",
      sessionMode: true,
      onOutOfTurn: (d) => outOfTurn.push(d)
    });

  /** The `user` records the host wrote to the child, in order. */
  const written = () =>
    (
      child.written as { type?: string; message?: { content?: string } }[]
    ).filter((m) => m.type === "user");

  /** The CLI's replay of a message it accepted, stamped with the same uuid. */
  const echo = (sent: { uuid?: string; message?: { content?: string } }) => ({
    type: "user",
    uuid: sent.uuid,
    isReplay: true,
    message: { role: "user", content: sent.message?.content }
  });

  it("writes a plain user message, with no interrupt anywhere near it", async () => {
    const provider = sessionProvider();
    await drive(provider);

    expect(provider.steer("and check the tests")).toBe(true);

    const messages = written();
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      type: "user",
      // Says a person typed it, here — the same stamp the official extension
      // puts on everything its composer sends.
      origin: { kind: "human" },
      message: { role: "user", content: "and check the tests" }
    });
    // An interrupt would have taken every background agent with it (measured:
    // `status: "stopped"` 10ms later), which is why no send path may use one.
    expect(
      (child.written as { type?: string }[]).some(
        (m) => m.type === "control_request"
      )
    ).toBe(false);
  });

  it("keeps it in the running turn: one turn, one result, no announcement", async () => {
    const provider = sessionProvider();
    const { collected, finished } = await drive(provider);

    provider.steer("and check the tests");
    child.emitLine(echo(written()[1] as never));
    await new Promise((r) => setTimeout(r, 20));

    // The echo of our own message is not a prompt anybody typed elsewhere, and
    // with a turn reading it is not news either — that turn is already
    // answering it.
    expect(outOfTurn).toHaveLength(0);
    expect(collected.some((d) => d.type === "done")).toBe(false);

    child.emitLine({ type: "result", subtype: "success" });
    await finished;
    expect(collected.filter((d) => d.type === "done")).toHaveLength(1);
  });

  it("opens a turn of its own when the echo lands with nothing reading", async () => {
    // Run 1 of the probes: no tool boundary existed, so the message waited and
    // the CLI opened a second turn for it by itself. Out-of-turn *text* would
    // arrive as one bare paragraph with every tool call dropped, so this asks
    // for a full turn instead.
    const provider = sessionProvider();
    const { finished } = await drive(provider);
    child.emitLine({ type: "result", subtype: "success" });
    await finished;

    provider.steer("actually, use 2FA");
    child.emitLine(echo(written()[1] as never));
    await new Promise((r) => setTimeout(r, 20));

    expect(outOfTurn).toEqual([
      { type: "steer_turn", prompt: "actually, use 2FA" }
    ]);
  });

  it("refuses when there is no session, so the caller opens an ordinary turn", () => {
    expect(sessionProvider().steer("nothing to write to")).toBe(false);
  });
});

// The watchdog exists for a wedged CLI. A workflow is not wedged — it is silent
// by construction, because its agents report on state change rather than on a
// clock. Measured: a 4-agent phase reading a 265 MB binary produced nothing for
// ten minutes and was SIGKILLed, all four sidechains recording
// `[Request interrupted by user]` within 10ms of each other.
describe("ClaudeCliProvider.stream — silence with background work", () => {
  let child: any;
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    child = makeFakeChild();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(child);
  });
  afterEach(() => vi.restoreAllMocks());

  const started = {
    type: "system",
    subtype: "task_started",
    task_id: "w1",
    tool_use_id: "toolu_w",
    task_type: "local_workflow",
    workflow_name: "audit",
    description: "a long one"
  };

  it("does not kill a quiet turn that still has a task open", async () => {
    const { collected } = await drive(
      new ClaudeCliProvider({
        binary: "claude",
        cwd: "/tmp",
        permissionMode: "default",
        silenceTimeoutMs: 40,
        backgroundGraceMs: 5_000,
        taskReportGraceMs: 5_000
      })
    );
    child.emitLine(started);

    // Well past the silence budget, with nothing on the wire at all.
    await new Promise((r) => setTimeout(r, 200));

    expect(child.killed).toBe(false);
    expect(collected.some((d) => d.type === "error")).toBe(false);
  });

  // With nothing outstanding the watchdog still does its job — and now says so,
  // where before it killed the process without a log line, an error or any
  // trace in the transcript.
  it("kills a genuinely wedged turn, and says why", async () => {
    const { collected, finished } = await drive(
      new ClaudeCliProvider({
        binary: "claude",
        cwd: "/tmp",
        permissionMode: "default",
        silenceTimeoutMs: 40
      })
    );

    await finished;

    expect(child.killed).toBe(true);
    const err = collected.find((d) => d.type === "error");
    expect(err?.error).toMatch(/stopped responding/i);
  });
});

// The CLI's own roster of registered background work, read straight off
// `background_tasks_changed`. It exists because our `task_*` bookkeeping has
// twice read empty while a workflow was demonstrably alive — the grace timer
// then ended the turn and killed it at ten minutes, twice, with the log line
// reporting "0 background agent(s)". Either source saying busy holds the turn.
describe("ClaudeCliProvider.stream — the CLI's background-task roster", () => {
  let child: any;
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    child = makeFakeChild();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(child);
  });
  afterEach(() => vi.restoreAllMocks());

  const roster = (n: number) => ({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: Array.from({ length: n }, (_, i) => ({
      task_id: `w${i}`,
      task_type: "local_workflow"
    }))
  });

  it("holds the turn on the roster alone, with no task event ever seen", async () => {
    const { collected } = await drive(
      new ClaudeCliProvider({
        binary: "claude",
        cwd: "/tmp",
        permissionMode: "default",
        backgroundGraceMs: 5_000,
        taskReportGraceMs: 30,
        silenceTimeoutMs: 60
      })
    );
    child.emitLine(roster(1));
    child.emitLine({ type: "result", subtype: "success" });

    // Far past both the short grace and the silence budget.
    await new Promise((r) => setTimeout(r, 250));

    expect(collected.some((d) => d.type === "done")).toBe(false);
    expect(child.killed).toBe(false);
  });

  it("lets the turn end once the roster empties", async () => {
    const { collected, finished } = await drive(
      new ClaudeCliProvider({
        binary: "claude",
        cwd: "/tmp",
        permissionMode: "default",
        backgroundGraceMs: 5_000,
        taskReportGraceMs: 30
      })
    );
    child.emitLine(roster(1));
    child.emitLine({ type: "result", subtype: "success" });
    await new Promise((r) => setTimeout(r, 60));
    expect(collected.some((d) => d.type === "done")).toBe(false);

    child.emitLine(roster(0));
    child.emitLine({ type: "result", subtype: "success" });
    await finished;

    expect(collected.some((d) => d.type === "done")).toBe(true);
  });
});
