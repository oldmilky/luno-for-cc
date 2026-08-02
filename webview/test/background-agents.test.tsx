import { describe, it, expect } from "vitest";
import { act } from "react";
import { Composer } from "../src/features/chat/Composer";
import { Header } from "../src/features/chat/Header";
import { BackgroundAgentsModal } from "../src/features/chat/BackgroundAgentsModal";
import { render } from "./render";
import type { AgentPanel } from "../src/features/chat/subagent-state";

// The surface that replaces `/workflows`. What is asserted here is what a
// screenshot cannot check on its own: that the button is absent before any
// work exists, that its count is the agent count rather than the launch count,
// and that the header's three numbers are the ones `agentPanel` computed.

const panel = (over: Partial<AgentPanel> = {}): AgentPanel => ({
  runs: [],
  running: 3,
  done: 1,
  total: 4,
  tokens: 19_210,
  elapsedMs: 5_593,
  ...over
});

const IDLE = panel({ running: 0, done: 4, etaMs: undefined });

function composer(agents: AgentPanel | undefined, onOpen = () => {}) {
  return render(
    <Composer
      value=""
      onChange={() => {}}
      onSubmit={() => {}}
      onCancel={() => {}}
      busy={false}
      model="claude-opus-5"
      permissionMode="default"
      models={[]}
      skills={[]}
      focusKey={0}
      pendingInsert={null}
      onInserted={() => {}}
      agents={agents}
      onOpenAgents={onOpen}
    />
  );
}

const button = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>(
    '[aria-label="Background agents"]'
  );

describe("the toolbar's background-agents button", () => {
  // A control for work that does not exist is noise in a panel this narrow.
  it("does not exist before anything has been dispatched", () => {
    const { container, unmount } = composer(
      panel({ running: 0, done: 0, total: 0 })
    );
    expect(button(container)).toBeNull();
    unmount();

    const none = composer(undefined);
    expect(button(none.container)).toBeNull();
    none.unmount();
  });

  it("counts running agents, not launches", () => {
    const { container, unmount } = composer(panel());
    expect(button(container)?.textContent).toContain("3");
    unmount();
  });

  it("stays after the work ends, without a count", () => {
    const { container, unmount } = composer(IDLE);
    const el = button(container);
    expect(el).not.toBeNull();
    expect(el?.textContent ?? "").not.toMatch(/\d/);
    unmount();
  });

  it("is lit only while something is running", () => {
    const live = composer(panel());
    expect(button(live.container)?.className).toMatch(/agentsBtnLive/);
    live.unmount();

    const idle = composer(IDLE);
    expect(idle.container.querySelector('[class*="agentsBtnLive"]')).toBeNull();
    idle.unmount();
  });

  it("opens the panel when clicked", () => {
    let opened = 0;
    const { container, unmount } = composer(panel(), () => {
      opened += 1;
    });
    act(() => {
      button(container)?.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      );
    });
    expect(opened).toBe(1);
    unmount();
  });
});

// The header already reported background work, less precisely and with no way
// to act on it. Two indicators for one thing is one too many unless both lead
// to the same place — so it leads there, and carries the same number.
describe("the header's agents chip", () => {
  const header = (over: Partial<Parameters<typeof Header>[0]> = {}) =>
    render(
      <Header
        title="review the branch"
        storedStatus={null}
        busy={false}
        awaitingApproval={false}
        errored={false}
        agentsRunning
        agentCount={3}
        onOpenAgents={() => {}}
        events={[{ id: "e1", ts: 1, kind: "user", title: "hi" }]}
        streaming=""
        onOpenHistory={() => {}}
        onOpenConnectors={() => {}}
        onOpenPermissions={() => {}}
        remoteControl={{ state: "off" }}
        {...over}
      />
    );

  const chip = (container: HTMLElement) =>
    container.querySelector<HTMLElement>(
      '[aria-label="Show background agents"]'
    );

  it("carries the count the toolbar button carries", () => {
    const { container, unmount } = header();
    expect(chip(container)?.textContent).toContain("3 agents");
    unmount();
  });

  it("says agent, not agents, for one", () => {
    const { container, unmount } = header({ agentCount: 1 });
    expect(chip(container)?.textContent).toContain("1 agent");
    expect(chip(container)?.textContent).not.toContain("agents");
    unmount();
  });

  it("opens the same panel the toolbar button opens", () => {
    let opened = 0;
    const { container, unmount } = header({
      onOpenAgents: () => {
        opened += 1;
      }
    });
    act(() => {
      chip(container)?.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      );
    });
    expect(opened).toBe(1);
    unmount();
  });

  // Every other status is a report, not a control. Making them all clickable
  // would promise an action none of them has.
  it("leaves the other statuses as plain reports", () => {
    const { container, unmount } = header({
      agentsRunning: false,
      busy: true
    });
    expect(chip(container)).toBeNull();
    expect(container.textContent ?? "").toContain("streaming");
    unmount();
  });
});

describe("the background-agents panel", () => {
  const open = (p: AgentPanel, onClose = () => {}, onStopAll = () => {}) =>
    render(
      <BackgroundAgentsModal
        panel={p}
        onClose={onClose}
        onStopAll={onStopAll}
      />
    );

  const stopButton = (container: HTMLElement) =>
    [...container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("Stop all")
    );

  it("reports the numbers agentPanel computed", () => {
    const { container, unmount } = open(
      panel({ etaMs: 120_000, etaSample: 3 })
    );
    const text = container.textContent ?? "";

    expect(text).toContain("3 still working");
    expect(text).toContain("1 / 4 done");
    // 19210 tokens, and the CLI's own 5593ms — not a sum and not a clock read.
    expect(text).toContain("19.2k");
    expect(text).toContain("6s");
    expect(text).toContain("≈2m");
    unmount();
  });

  // The estimate is the one number nobody measured. It is absent, not zeroed,
  // whenever there is no sample behind it.
  it("shows no estimate when there is none", () => {
    const { container, unmount } = open(panel({ etaMs: undefined }));
    expect(container.textContent ?? "").not.toContain("≈");
    unmount();
  });

  it("says so plainly once everything has finished", () => {
    const { container, unmount } = open(IDLE);
    expect(container.textContent ?? "").toContain("4 agents · all finished");
    unmount();
  });

  it("reports progress to a screen reader as agents, not percent", () => {
    const { container, unmount } = open(panel());
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute("aria-valuenow")).toBe("1");
    expect(bar?.getAttribute("aria-valuemax")).toBe("4");
    unmount();
  });

  it("lists a workflow's agents under the phases the CLI named", () => {
    const { container, unmount } = open(
      panel({
        runs: [
          {
            taskId: "wf",
            kind: "workflow",
            name: "review-changes",
            description: "Review changed files",
            outcome: "running",
            detailsUnavailable: false,
            running: 1,
            done: 2,
            total: 3,
            tokens: 40_000,
            toolCalls: 12,
            durationMs: 64_000,
            phases: [
              {
                index: 1,
                title: "Review",
                agents: [
                  {
                    type: "workflow_agent",
                    agentId: "a1",
                    label: "review:bugs",
                    state: "done",
                    tokens: 12_000,
                    toolCalls: 8,
                    durationMs: 31_000
                  },
                  {
                    type: "workflow_agent",
                    agentId: "a2",
                    label: "review:perf",
                    state: "done",
                    tokens: 9_000,
                    toolCalls: 1,
                    durationMs: 22_000
                  }
                ]
              },
              {
                index: 2,
                title: "Verify",
                agents: [
                  {
                    type: "workflow_agent",
                    agentId: "a3",
                    label: "verify:auth.ts",
                    state: "start"
                  }
                ]
              }
            ]
          }
        ]
      })
    );
    const text = container.textContent ?? "";

    expect(text).toContain("Review");
    expect(text).toContain("Verify");
    expect(text).toContain("review:bugs");
    expect(text).toContain("verify:auth.ts");
    // The workflow's own row counts its agents; the rows carry their own spend.
    expect(text).toContain("1 running · 2 done");
    expect(text).toContain("12.0k");
    // Singular and plural both, because "1 tools" is the kind of thing nobody
    // notices until it ships.
    expect(text).toContain("8 tools");
    expect(text).toContain("1 tool");
    unmount();
  });

  // A live workflow between phases has answered agents and none running. The
  // arithmetic is right and the sentence was not: a spinner beside "0 running"
  // reads as a defect in the panel rather than a moment in the run.
  it("does not say zero are running while the workflow is still going", () => {
    const { container, unmount } = open(
      panel({
        running: 1,
        done: 3,
        total: 4,
        runs: [
          {
            taskId: "wf",
            kind: "workflow",
            name: "review-changes",
            outcome: "running",
            detailsUnavailable: false,
            running: 0,
            done: 3,
            total: 3,
            tokens: 12_000,
            toolCalls: 4,
            durationMs: 60_000,
            phases: []
          }
        ]
      })
    );
    const text = container.textContent ?? "";

    expect(text).not.toContain("0 running");
    expect(text).toContain("3 done · starting more");
    unmount();
  });

  // An empty phase list would read as "this workflow dispatched nobody", which
  // is a different claim from "nobody told us".
  it("says the breakdown is missing rather than showing none", () => {
    const { container, unmount } = open(
      panel({
        running: 0,
        done: 1,
        total: 1,
        runs: [
          {
            taskId: "wf",
            kind: "workflow",
            name: "review-changes",
            outcome: "done",
            detailsUnavailable: true,
            running: 0,
            done: 1,
            total: 1,
            tokens: 19_210,
            toolCalls: 0,
            durationMs: 5_593,
            phases: []
          }
        ]
      })
    );

    expect(container.textContent ?? "").toContain(
      "no agent breakdown reported"
    );
    unmount();
  });

  // There is no way to stop one agent — the CLI's only handle is `interrupt`,
  // and it takes every agent at once. One collective control is the honest one.
  it("offers Stop all only while something is running", () => {
    const live = open(panel());
    expect(stopButton(live.container)).toBeDefined();
    live.unmount();

    const idle = open(IDLE);
    expect(stopButton(idle.container)).toBeUndefined();
    idle.unmount();
  });

  // It hands over to the existing confirmation rather than interrupting: the
  // dialog that names what is about to be lost is the whole safety here.
  it("asks rather than stopping", () => {
    let asked = 0;
    const { container, unmount } = open(
      panel(),
      () => {},
      () => {
        asked += 1;
      }
    );
    act(() => {
      stopButton(container)?.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      );
    });
    expect(asked).toBe(1);
    unmount();
  });

  // The toolbar button is already called "Background agents". A second element
  // with the same accessible name makes the two indistinguishable by name, so
  // the dialog takes its name from the heading it already draws.
  it("is named by its own heading, not by a duplicate label", () => {
    const { container, unmount } = open(panel());
    const dialog = container.querySelector('[role="dialog"]');
    const heading = container.querySelector("h2");

    expect(dialog?.getAttribute("aria-label")).toBeNull();
    expect(dialog?.getAttribute("aria-labelledby")).toBe(heading?.id);
    expect(heading?.textContent).toBe("Background agents");
    unmount();
  });

  it("closes on Escape", () => {
    let closed = 0;
    const { unmount } = open(panel(), () => {
      closed += 1;
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(closed).toBe(1);
    unmount();
  });
});
