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
import {
  IDE_SERVER_NAME,
  IDE_TOOLS,
  type IdeToolOps
} from "../../src/core/ide-tools.js";

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

  // Effort has no live command — the CLI takes exactly five, and this is not
  // one of them — so applying it means replacing the process. With agents
  // inside that process, the change waits instead: measured, an `interrupt`
  // ends a background agent 10ms after the request, and a replacement is worse
  // than an interrupt because it also takes the session with it.
  it("holds a settings change while agents are running, and says which", async () => {
    let live = true;
    const pending: string[][] = [];
    const provider = new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "default",
      sessionMode: true,
      effort: "high",
      hasLiveWork: () => live,
      onSettingsPending: (p) => pending.push(p)
    });
    await turn(provider);

    provider.updateOptions({ effort: "max" });
    await turn(provider);

    // Same process, and the panel was told the chip is ahead of the session.
    expect(children).toHaveLength(1);
    expect(pending.at(-1)).toEqual(["effort"]);

    // Once the work drains the very next turn picks the change up — nothing
    // was stored for it, `buildArgs` simply finds the difference again.
    live = false;
    await turn(provider);
    expect(children).toHaveLength(2);
    expect(pending.at(-1)).toEqual([]);
  });

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

  // Measured 2026-07-29 in the running extension: the bridge was switched on
  // mid-turn, the log said `replacing the CLI process: ---model -default`, and
  // the CLI was SIGTERMed halfway through an assistant message. The toggle has
  // no turn behind it, so it has no model to rebuild argv from — and argv
  // rebuilt without one does not match what the process is running.
  it("does not replace it when the bridge is switched on mid-conversation", async () => {
    const provider = new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "default",
      sessionMode: true
    });
    await turn(provider);
    expect(children).toHaveLength(1);

    // Not awaited: the CLI's answer to the control request never comes here,
    // and the spawn decision is made before that request is even sent.
    void provider.enableRemoteControl().catch(() => {});
    await new Promise((r) => setTimeout(r, 20));

    expect(children).toHaveLength(1);
    expect(children[0].killed).toBe(false);
  });

  it("tells a turn still reading when the process is taken away", async () => {
    // The exit handler routes `done`, but `route` delivers through
    // `session.sink`, which `disposeSession` clears on its way out — so the
    // turn was left waiting on a generator nothing would ever push to again.
    const provider = new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "default",
      sessionMode: true
    });
    const collected: StreamDelta[] = [];
    const finished = (async () => {
      for await (const d of provider.stream(req())) collected.push(d);
    })();
    await new Promise((r) => setTimeout(r, 5));

    provider.disposeSession();
    await finished;

    expect(collected.at(-1)).toMatchObject({ type: "done" });
    expect(collected.find((d) => d.type === "error")?.error).toMatch(
      /session ended before this turn finished/i
    );
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
    //
    // Asserted on the subtype rather than on "no control_request at all": a
    // session legitimately sends others of its own accord — `initialize` at
    // spawn, `remote_control` on the toggle — and none of them are the send
    // path. The rule being kept here is about interrupting, not about the
    // channel being quiet.
    expect(
      (
        child.written as { type?: string; request?: { subtype?: string } }[]
      ).filter(
        (m) =>
          m.type === "control_request" && m.request?.subtype === "interrupt"
      )
    ).toHaveLength(0);
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

  it("stays quiet when the turn it landed in belongs to another surface", async () => {
    // `session.sink` is null for the whole of a phone-driven turn — only
    // `streamInSession` ever installs one — so the sink alone cannot tell "no
    // turn" from "somebody else's turn". Announcing it here opens a second turn
    // that closes the queue receiving the phone's answer mid-sentence, sealing
    // the half written so far as a finished reply with no interrupted marker.
    const provider = sessionProvider();
    const { finished } = await drive(provider);
    child.emitLine({ type: "result", subtype: "success" });
    await finished;

    // A prompt typed on the phone: replayed under a uuid that is not ours.
    child.emitLine({
      type: "user",
      uuid: "phone-1",
      isReplay: true,
      message: { role: "user", content: "what changed today?" }
    });
    await new Promise((r) => setTimeout(r, 20));

    provider.steer("and check the tests");
    child.emitLine(echo(written()[1] as never));
    await new Promise((r) => setTimeout(r, 20));

    expect(outOfTurn).toEqual([
      { type: "remote_prompt", prompt: "what changed today?" }
    ]);
  });

  it("refuses when there is no session, so the caller opens an ordinary turn", () => {
    expect(sessionProvider().steer("nothing to write to")).toBe(false);
  });
});

describe("ClaudeCliProvider — a grant that must not outlive its turn", () => {
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

  const canUseTool = (id: string) => ({
    type: "control_request",
    request_id: id,
    request: {
      subtype: "can_use_tool",
      tool_name: "Write",
      input: { file_path: `/tmp/${id}.ts`, content: "x" }
    }
  });

  /** Every permission the host answered by itself, as `id:behavior`. */
  const answers = () =>
    (
      child.written as {
        type?: string;
        response?: {
          request_id?: string;
          response?: { behavior?: string };
        };
      }[]
    )
      .filter((m) => m.type === "control_response" && m.response?.response)
      .map(
        (m) => `${m.response!.request_id}:${m.response!.response!.behavior}`
      );

  it("stops auto-allowing edits once the turn that granted it ends", async () => {
    // "Allow this turn" is cleared at the top of `stream()`, and a turn the
    // phone or a steered message opened never enters it. Cleared at the
    // `result` instead, which is where a turn ends in session mode, both
    // surfaces are covered.
    const provider = sessionProvider();
    const { finished } = await drive(provider);

    child.emitLine(canUseTool("perm-1"));
    await new Promise((r) => setTimeout(r, 20));
    provider.respondToPermission("perm-1", "allow", { restOfTurn: true });

    child.emitLine({ type: "result", subtype: "success" });
    await finished;

    // The next turn is not this one, whoever opened it.
    child.emitLine(canUseTool("perm-2"));
    await new Promise((r) => setTimeout(r, 20));

    expect(answers()).toEqual(["perm-1:allow"]);
    expect(
      outOfTurn.filter((d) => d.type === "permission_request")
    ).toHaveLength(1);
  });

  it("keeps a prompt raised out of turn answerable past an unrelated turn", async () => {
    // A background agent's prompt has no turn to end. The turn-end sweep used
    // to clear the whole map, destroying its request id — from that moment the
    // card could not be answered at all and the CLI stayed blocked for the
    // life of the process.
    const provider = sessionProvider();
    const first = await drive(provider);
    child.emitLine({ type: "result", subtype: "success" });
    await first.finished;

    // The agent asks with nothing reading.
    child.emitLine(canUseTool("agent-1"));
    await new Promise((r) => setTimeout(r, 20));
    expect(
      outOfTurn.filter((d) => d.type === "permission_request")
    ).toHaveLength(1);

    // A whole unrelated turn comes and goes in the meantime.
    const second = await drive(provider);
    child.emitLine({ type: "result", subtype: "success" });
    await second.finished;

    provider.respondToPermission("agent-1", "deny");
    expect(answers()).toEqual(["agent-1:deny"]);
  });

  it("still retires the prompts that did belong to the turn", async () => {
    // The other half: an id raised inside a turn and never answered must not
    // outlive it, or a stale card could be answered against a request the CLI
    // has forgotten.
    const provider = sessionProvider();
    const { finished } = await drive(provider);
    child.emitLine(canUseTool("perm-1"));
    await new Promise((r) => setTimeout(r, 20));
    child.emitLine({ type: "result", subtype: "success" });
    await finished;

    provider.respondToPermission("perm-1", "deny");
    expect(answers()).toEqual([]);
  });

  it("still honours the grant for the rest of the turn that gave it", async () => {
    // The guard against fixing the leak by clearing the flag too early.
    const provider = sessionProvider();
    const { finished } = await drive(provider);

    child.emitLine(canUseTool("perm-1"));
    await new Promise((r) => setTimeout(r, 20));
    provider.respondToPermission("perm-1", "allow", { restOfTurn: true });

    child.emitLine(canUseTool("perm-2"));
    await new Promise((r) => setTimeout(r, 20));

    expect(answers()).toEqual(["perm-1:allow", "perm-2:allow"]);

    child.emitLine({ type: "result", subtype: "success" });
    await finished;
  });
});

describe("ClaudeCliProvider — the bridge toggle spawning a process", () => {
  let child: any;
  let children: any[];
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    children = [];
    (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      child = makeFakeChild();
      children.push(child);
      return child;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const turn = async (provider: ClaudeCliProvider, model: string) => {
    const collected: StreamDelta[] = [];
    const finished = (async () => {
      for await (const d of provider.stream({
        model,
        maxTokens: 1,
        messages: [{ role: "user", content: "go" }],
        tools: []
      })) {
        collected.push(d);
      }
    })();
    await new Promise((r) => setTimeout(r, 10));
    child.emitLine({ type: "result", subtype: "success" });
    await finished;
  };

  it("does not replace the process on the first turn after /rc, in plan mode", async () => {
    // The `/rc` spawn used to record `taskType: undefined`, and
    // `streamInSession`'s `session.taskType ?? opts.taskType` then reached past
    // it to the freshly classified one — so the very next turn built argv with
    // a task-type `--append-system-prompt` the live process did not have, and
    // replaced it. Under Remote Control that hands the phone a session URL
    // nobody is holding.
    // The order that bites: `/rc` on a fresh chat, so nothing has been
    // classified yet, and the first turn is what sets a task type.
    const provider = new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "plan",
      sessionMode: true,
      model: "claude-sonnet-4-6"
    });

    void provider.enableRemoteControl();
    await new Promise((r) => setTimeout(r, 20));
    expect(children).toHaveLength(1);

    // What `runPromptTurn` does before every turn.
    provider.updateOptions({ taskType: "backend" });
    await turn(provider, "claude-sonnet-4-6");

    expect(children).toHaveLength(1);
  });

  it("still picks the current playbook up on the next process", async () => {
    // The other half: keeping a live session's "none" must not mean a task type
    // never reaches the CLI again. A replacement builds argv from `opts`.
    const provider = new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "plan",
      sessionMode: true,
      model: "claude-sonnet-4-6"
    });
    // Nothing answers the control request here, and `disposeSession` below
    // rejects everything still pending — which is the real path, and the one
    // `conversation-host` handles. Swallow it so it does not surface as an
    // unhandled rejection and fail the run.
    void provider.enableRemoteControl().catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    provider.updateOptions({ taskType: "backend" });
    await turn(provider, "claude-sonnet-4-6");

    provider.disposeSession();
    await turn(provider, "claude-sonnet-4-6");

    const argv = (spawn as unknown as ReturnType<typeof vi.fn>).mock
      .calls[1][1] as string[];
    // Assert the playbook itself, not how many appends ride with it — the
    // count also moves when an unrelated append is added or dropped.
    expect(argv.some((a) => a.includes("# Backend work"))).toBe(true);
  });

  it("does not replace it over an effort level the pinned model refuses", async () => {
    // `--effort` is decided against the model's own ladder. Spawned with no
    // model there is no ladder, so the flag always went on — and the first turn
    // named a model whose ladder drops it, which is a differing flag and a
    // replacement.
    const provider = new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "default",
      sessionMode: true,
      effort: "xhigh",
      model: "claude-sonnet-4-6"
    });

    void provider.enableRemoteControl();
    await new Promise((r) => setTimeout(r, 20));
    expect(children).toHaveLength(1);

    await turn(provider, "claude-sonnet-4-6");

    expect(children).toHaveLength(1);
  });
});

describe("ClaudeCliProvider — the process going away", () => {
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

  const die = () => {
    child.exitCode = 1;
    child.emit("exit");
  };

  it("settles an in-flight control request instead of leaving it to time out", async () => {
    // `sendControl` sits on a 30s timer with no idea the pipe it was written to
    // has closed. Left alone, a replacement joining `remoteControlInFlight`
    // attaches itself to a promise bound to a dead process and sends nothing.
    const provider = sessionProvider();
    await drive(provider);
    const enabling = provider.enableRemoteControl();
    await new Promise((r) => setTimeout(r, 20));

    die();

    await expect(enabling).rejects.toThrow(/ended before it answered/);
  });

  it("stops the pill describing a session that no longer exists", async () => {
    // The bridge is still wanted, so a replacement will bring one back — which
    // is `connecting`, not `off` and certainly not a live-looking URL.
    const provider = sessionProvider();
    const { finished } = await drive(provider);
    const enabling = provider.enableRemoteControl();
    await new Promise((r) => setTimeout(r, 20));
    const req = (
      child.written as {
        type?: string;
        request_id?: string;
        request?: { subtype?: string };
      }[]
    ).find((m) => m.request?.subtype === "remote_control");
    child.emitLine({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: req!.request_id,
        response: { session_url: "https://claude.ai/code/gone" }
      }
    });
    await enabling;
    expect(provider.remoteControlStatus().sessionUrl).toBe(
      "https://claude.ai/code/gone"
    );

    // The turn ends first, so the panel is between turns — which is where a
    // process dying unwatched actually leaves it, and it puts the delta on the
    // out-of-turn seam rather than into a turn's sink.
    child.emitLine({ type: "result", subtype: "success" });
    await finished;
    die();

    expect(provider.remoteControlStatus()).toEqual({ state: "connecting" });
    expect(outOfTurn.filter((d) => d.type === "remote_control").at(-1)).toEqual(
      {
        type: "remote_control",
        remoteControl: { state: "connecting" }
      }
    );
  });

  it("does not send a prompt the user cancelled while it waited for the CLI", async () => {
    // A turn submitted while the session is busy parks in `waitUntilIdle`.
    // Stop pressed there queues this turn's `done` — and the drain used to
    // write the prompt anyway the moment the previous turn reported.
    const provider = sessionProvider();
    const first = await drive(provider);

    const second: StreamDelta[] = [];
    const running = (async () => {
      for await (const d of provider.stream({
        model: "claude-sonnet-4-6",
        maxTokens: 1,
        messages: [{ role: "user", content: "the cancelled one" }],
        tools: []
      })) {
        second.push(d);
      }
    })();
    await new Promise((r) => setTimeout(r, 20));

    provider.cancel();
    child.emitLine({ type: "result", subtype: "success" });
    await first.finished;
    await running;

    const sent = (
      child.written as { type?: string; message?: { content?: string } }[]
    ).filter((m) => m.type === "user");
    expect(sent.map((m) => m.message?.content)).not.toContain(
      "the cancelled one"
    );
  });
});

describe("ClaudeCliProvider — the editor context on the wire", () => {
  let child: any;
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    child = makeFakeChild();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(child);
  });
  afterEach(() => vi.restoreAllMocks());

  const CONTEXT_A = "# What the user is looking at\n\nActive file: a.ts";
  const CONTEXT_B = "# What the user is looking at\n\nActive file: b.ts";

  const contextProvider = (editorContext?: string) =>
    new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "default",
      sessionMode: true,
      ...(editorContext && { editorContext })
    });

  /** What each `user` record actually carried to the CLI, in order. */
  const contents = () =>
    (
      child.written as {
        type?: string;
        message?: { content?: string };
      }[]
    )
      .filter((m) => m.type === "user")
      .map((m) => m.message?.content ?? "");

  it("carries it on the first message of a session", async () => {
    const provider = contextProvider(CONTEXT_A);
    const { finished } = await drive(provider);

    expect(contents()[0]).toBe(CONTEXT_A + "\n\nfetch the docs");

    child.emitLine({ type: "result", subtype: "success" });
    await finished;
  });

  it("does not repeat it while the user is looking at the same thing", async () => {
    // It rides on the message text, so every surface sharing this session
    // renders it as part of what the user typed. Repeated, the transcript on
    // claude.ai is a wall of context blocks — measured 2026-07-30.
    const provider = contextProvider(CONTEXT_A);
    const { finished } = await drive(provider);
    provider.steer("and check the tests");

    expect(contents()[1]).toBe("and check the tests");

    child.emitLine({ type: "result", subtype: "success" });
    await finished;
  });

  it("carries it again the moment it moves", async () => {
    const provider = contextProvider(CONTEXT_A);
    const { finished } = await drive(provider);
    provider.updateOptions({ editorContext: CONTEXT_B });
    provider.steer("what about this one");

    expect(contents()[1]).toBe(CONTEXT_B + "\n\nwhat about this one");

    child.emitLine({ type: "result", subtype: "success" });
    await finished;
  });

  it("does not count a write the CLI never took", async () => {
    // The context went nowhere, so the next message has to carry it. Recording
    // it on a failed write would lose it for the life of the session.
    const provider = contextProvider(CONTEXT_A);
    const { finished } = await drive(provider);
    // The first message carried CONTEXT_A; move it, then refuse the write.
    provider.updateOptions({ editorContext: CONTEXT_B });
    const live = child.stdin;
    const dead = new Writable({
      write: (_c: unknown, _e: unknown, cb: () => void) => cb()
    });
    dead.destroy();
    child.stdin = dead;
    expect(provider.steer("into a closed pipe")).toBe(false);

    child.stdin = live;
    provider.steer("second try");
    expect(contents()[1]).toBe(CONTEXT_B + "\n\nsecond try");

    child.emitLine({ type: "result", subtype: "success" });
    await finished;
  });
});

describe("ClaudeCliProvider — a permission mode picked between turns", () => {
  let child: any;
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    child = makeFakeChild();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(child);
  });
  afterEach(() => vi.restoreAllMocks());

  const modeRequests = () =>
    (
      child.written as {
        type?: string;
        request_id?: string;
        request?: { subtype?: string; mode?: string };
      }[]
    ).filter(
      (m) =>
        m.type === "control_request" &&
        m.request?.subtype === "set_permission_mode"
    );

  const modelRequests = () =>
    (
      child.written as {
        type?: string;
        request_id?: string;
        request?: { subtype?: string; model?: string };
      }[]
    ).filter(
      (m) => m.type === "control_request" && m.request?.subtype === "set_model"
    );

  const bypassProvider = () =>
    new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "bypass",
      sessionMode: true
    });

  it("tells the live process, with no turn behind the change", async () => {
    // The whole point: a turn started on the phone never rebuilds argv, so the
    // only way out of the mode the process was spawned with is to say so.
    const provider = bypassProvider();
    const { finished } = await drive(provider);

    const pushing = provider.setLivePermissionMode("default");
    await new Promise((r) => setTimeout(r, 20));
    const sent = modeRequests()[0];
    expect(sent?.request?.mode).toBe("default");

    child.emitLine({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: sent!.request_id,
        response: {}
      }
    });
    await pushing;

    // Recorded against the session, so picking the same mode again says
    // nothing — the CLI is already in it.
    await provider.setLivePermissionMode("default");
    expect(modeRequests()).toHaveLength(1);

    child.emitLine({ type: "result", subtype: "success" });
    await finished;
  });

  it("sends a model change the same way", async () => {
    const provider = new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "default",
      sessionMode: true,
      effort: "high"
    });
    const { finished } = await drive(provider);

    // `drive` opens the turn under claude-sonnet-4-6; both ladders carry
    // "high", so the effort flag is unchanged and the model can travel alone.
    const pushing = provider.setLiveModel("claude-opus-4-8");
    await new Promise((r) => setTimeout(r, 20));
    const sent = modelRequests()[0];
    expect(sent?.request?.model).toBe("claude-opus-4-8");

    child.emitLine({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: sent!.request_id,
        response: {}
      }
    });
    await pushing;

    await provider.setLiveModel("claude-opus-4-8");
    expect(modelRequests()).toHaveLength(1);

    child.emitLine({ type: "result", subtype: "success" });
    await finished;
  });

  it("holds back a model whose effort ladder disagrees with the running one", async () => {
    // `--effort` reaches the CLI in argv and argv cannot be rebuilt under a
    // live process. claude-sonnet-4-6 has no `xhigh`, so the running argv
    // carries no `--effort` at all; pushing opus alone would leave it at the
    // model's default while the picker claims xhigh. The next panel turn
    // replaces the process and carries both.
    const provider = new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "default",
      sessionMode: true,
      effort: "xhigh"
    });
    const { finished } = await drive(provider);

    await provider.setLiveModel("claude-opus-4-8");
    expect(modelRequests()).toEqual([]);

    child.emitLine({ type: "result", subtype: "success" });
    await finished;
  });

  it("leaves a refusal standing rather than replacing the process", async () => {
    // The CLI refuses Bypass on a session not launched for it. Respawning to
    // force it would take every background agent and the bridge with it, for a
    // change that only loosens and that the next panel turn delivers anyway.
    const provider = new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "default",
      sessionMode: true
    });
    const { finished } = await drive(provider);
    const spawnsBefore = (spawn as unknown as ReturnType<typeof vi.fn>).mock
      .calls.length;

    const pushing = provider.setLivePermissionMode("bypass");
    await new Promise((r) => setTimeout(r, 20));
    child.emitLine({
      type: "control_response",
      response: {
        subtype: "error",
        request_id: modeRequests()[0]!.request_id,
        error:
          "Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions"
      }
    });
    await pushing;

    expect(
      (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    ).toBe(spawnsBefore);
    expect(child.killed).toBe(false);

    child.emitLine({ type: "result", subtype: "success" });
    await finished;
  });
});

describe("ClaudeCliProvider — switching the bridge off mid-request", () => {
  let child: any;
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    child = makeFakeChild();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(child);
  });
  afterEach(() => vi.restoreAllMocks());

  /** The control requests the host sent, in order. */
  const controls = () =>
    (
      child.written as {
        type?: string;
        request_id?: string;
        request?: { subtype?: string; enabled?: boolean };
      }[]
    ).filter((m) => m.type === "control_request");

  const answer = (requestId: string, payload: Record<string, unknown>) =>
    child.emitLine({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response: payload }
    });

  it("does not light the pill back up for a bridge already told to go", async () => {
    const provider = new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "default",
      sessionMode: true
    });
    const { collected, finished } = await drive(provider);

    const enabling = provider.enableRemoteControl();
    await new Promise((r) => setTimeout(r, 20));
    const enable = controls().find(
      (m) => m.request?.subtype === "remote_control"
    );
    expect(enable?.request_id).toBeDefined();

    // Switched off before the CLI got round to answering.
    const disabling = provider.disableRemoteControl();
    await new Promise((r) => setTimeout(r, 20));
    expect(provider.remoteControlStatus()).toEqual({ state: "off" });

    // The reply lands anyway, carrying a URL for a bridge being torn down.
    answer(enable!.request_id!, {
      session_url: "https://claude.ai/code/session_stale",
      connect_url: "https://claude.ai/connect/stale"
    });
    await enabling;

    expect(provider.remoteControlStatus()).toEqual({ state: "off" });

    const off = controls().find((m) => m.request?.enabled === false);
    answer(off!.request_id!, {});
    await disabling;

    child.emitLine({ type: "result", subtype: "success" });
    await finished;
    expect(collected.some((d) => d.type === "error")).toBe(false);
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

describe("ClaudeCliProvider — the ide MCP server over the control channel", () => {
  let child: any;
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    child = makeFakeChild();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(child);
  });
  afterEach(() => vi.restoreAllMocks());

  const mcpMessage = (
    id: string,
    message: unknown,
    server: string = IDE_SERVER_NAME
  ) => ({
    type: "control_request",
    request_id: id,
    request: { subtype: "mcp_message", server_name: server, message }
  });

  /** Every `mcp_response` the host wrote back, by control-request id. */
  const responses = () =>
    (
      child.written as {
        type?: string;
        response?: {
          request_id?: string;
          response?: { mcp_response?: Record<string, any> };
        };
      }[]
    )
      .filter((m) => m.type === "control_response" && m.response?.response)
      .map((m) => ({
        requestId: m.response!.request_id,
        mcp: m.response!.response!.mcp_response
      }))
      .filter((r) => r.mcp !== undefined);

  const withIde = () =>
    new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "default",
      // Built off the table so a tool added to it needs no edit here.
      ideOps: Object.fromEntries(
        IDE_TOOLS.map((t) => [
          t.name,
          async () => ({
            content: [{ type: "text" as const, text: '{"folders":[]}' }]
          })
        ])
      ) as unknown as IdeToolOps
    });

  it("answers a tools/call inside an mcp_response envelope", async () => {
    await drive(withIde());
    child.emitLine(
      mcpMessage("c-1", {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "getWorkspaceFolders" }
      })
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(responses()).toEqual([
      {
        requestId: "c-1",
        mcp: {
          jsonrpc: "2.0",
          id: 4,
          result: { content: [{ type: "text", text: '{"folders":[]}' }] }
        }
      }
    ]);
  });

  it("answers a server we never declared, rather than leaving the CLI waiting", async () => {
    await drive(withIde());
    child.emitLine(
      mcpMessage(
        "c-2",
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        "chrome"
      )
    );
    await new Promise((r) => setTimeout(r, 20));

    const [only] = responses();
    expect(only.requestId).toBe("c-2");
    expect(only.mcp!.error.code).toBe(-32601);
  });

  it("acknowledges a notification without inventing a result", async () => {
    await drive(withIde());
    child.emitLine(
      mcpMessage("c-3", { jsonrpc: "2.0", method: "notifications/initialized" })
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(responses()[0].mcp).toEqual({ jsonrpc: "2.0", result: {}, id: 0 });
  });

  it("does not route an mcp_message through the unhandled-request ack", async () => {
    // The empty `{}` that path sends claims we did something. For an
    // `mcp_message` it is a JSON-RPC message with no jsonrpc, no id and no
    // result — the CLI has nothing to correlate it with.
    await drive(withIde());
    child.emitLine(
      mcpMessage("c-4", {
        jsonrpc: "2.0",
        id: 9,
        method: "initialize",
        params: {}
      })
    );
    await new Promise((r) => setTimeout(r, 20));

    const [only] = responses();
    expect(only.mcp!.jsonrpc).toBe("2.0");
    expect(only.mcp!.id).toBe(9);
    expect(only.mcp!.result.serverInfo.name).toBe(IDE_SERVER_NAME);
  });
});

// What this guards: an attachment survives the trip to stdin.
//
// A message carrying an image or a PDF is an array of content blocks, and the
// provider used to flatten the newest user message to a string before writing
// it — `map(b => b.type === "text" ? b.text : "")` — so every block that was
// not text was dropped on the floor. Nothing downstream could tell: the write
// succeeded, the turn ran, and the model simply never saw the file. The
// paperclip is built on this, so it is pinned here rather than assumed.
describe("ClaudeCliProvider — content blocks reach the CLI", () => {
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

  const IMAGE = {
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: "image/png",
      data: "iVBORw0KGgo="
    }
  };
  const PDF = {
    type: "document" as const,
    source: {
      type: "base64" as const,
      media_type: "application/pdf",
      data: "JVBERi0="
    },
    title: "spec.pdf"
  };

  /** The user message this turn put on stdin. */
  function written(child: any): Record<string, any> | undefined {
    return (child.written as Record<string, any>[]).find(
      (m) => m.type === "user"
    );
  }

  async function runTurn(
    provider: ClaudeCliProvider,
    content: unknown
  ): Promise<Record<string, any> | undefined> {
    const finished = (async () => {
      for await (const _ of provider.stream({
        model: "claude-sonnet-4-6",
        maxTokens: 1,
        messages: [{ role: "user", content: content as never }],
        tools: []
      })) {
        /* drained */
      }
    })();
    await new Promise((r) => setTimeout(r, 5));
    children[children.length - 1].emitLine({
      type: "result",
      subtype: "success",
      result: "done"
    });
    await finished;
    return written(children[children.length - 1]);
  }

  it("writes an image block beside the prompt, in order", async () => {
    const provider = new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "default",
      sessionMode: true
    });

    const msg = await runTurn(provider, [
      IMAGE,
      { type: "text", text: "what is wrong here?" }
    ]);

    expect(msg?.message.content).toEqual([
      IMAGE,
      { type: "text", text: "what is wrong here?" }
    ]);
  });

  it("writes a PDF as a document block with its title", async () => {
    const provider = new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "default",
      sessionMode: true
    });

    const msg = await runTurn(provider, [PDF, { type: "text", text: "read it" }]);

    expect(msg?.message.content[0]).toEqual(PDF);
  });

  it("still writes a plain string as a plain string", async () => {
    // The shape every existing turn uses. Wrapping it in a block array would be
    // a change of contract for every caller that never attaches anything.
    const provider = new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "default",
      sessionMode: true
    });

    const msg = await runTurn(provider, "just words");

    expect(msg?.message.content).toBe("just words");
  });

  it("puts the turn preamble in front as its own block", async () => {
    // `preamble + content` would have stringified the array into
    // `[object Object]` and sent that as the prompt.
    const provider = new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "default",
      sessionMode: true,
      editorContext: "The user is looking at src/app.ts"
    });

    const msg = await runTurn(provider, [
      IMAGE,
      { type: "text", text: "and this?" }
    ]);

    const blocks = msg?.message.content as Array<Record<string, unknown>>;
    expect(blocks[0].type).toBe("text");
    expect(String(blocks[0].text)).toContain("src/app.ts");
    expect(blocks[1]).toEqual(IMAGE);
    expect(blocks[2]).toEqual({ type: "text", text: "and this?" });
  });

  it("sends a turn that is only an attachment", async () => {
    // A screenshot with nothing typed. The old emptiness check read the words
    // and refused the turn as "No user message to send."
    const provider = new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "default",
      sessionMode: true
    });

    const msg = await runTurn(provider, [IMAGE]);

    expect(msg?.message.content).toEqual([IMAGE]);
  });

  it("carries blocks on the per-turn path too", async () => {
    // Session mode is what the panel uses; this one is the fallback that is
    // still reachable, and it writes the message through a different line.
    const provider = new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "default"
    });

    const msg = await runTurn(provider, [
      IMAGE,
      { type: "text", text: "per-turn" }
    ]);

    expect(msg?.message.content).toEqual([
      IMAGE,
      { type: "text", text: "per-turn" }
    ]);
  });
});
