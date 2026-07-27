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
