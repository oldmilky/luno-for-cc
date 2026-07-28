import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

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
  child.stdin = new Writable({ write: (_c, _e, cb) => cb() });
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

  // The wait has to be bounded, or an agent that never reports holds the turn
  // until the 10-minute hard kill.
  it("gives up on an agent that goes quiet", async () => {
    const p = new ClaudeCliProvider({
      binary: "claude",
      cwd: "/tmp",
      permissionMode: "default",
      backgroundGraceMs: 30
    });
    const { collected, finished } = await drive(p);
    child.emitLine(started);
    child.emitLine({ type: "result", subtype: "success" });
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
