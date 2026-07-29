import { describe, it, expect } from "vitest";
import {
  headerStatus,
  STATUS_LABEL,
  HEADER_LABEL
} from "../../webview/src/features/chat/chat-status";

// What this file guards: the header's one word, and the order the states beat
// each other in. The set grew a seventh member when the CLI process started
// outliving its turn — the model finishes, twenty agents keep working, and
// neither `working` (nothing is streaming) nor the stored `done` is true.

const base = {
  busy: false,
  awaitingApproval: false,
  errored: false,
  agentsRunning: false,
  stored: "done" as const
};

describe("headerStatus", () => {
  it("puts an unanswered approval above everything", () => {
    expect(
      headerStatus({
        ...base,
        awaitingApproval: true,
        busy: true,
        errored: true,
        agentsRunning: true
      })
    ).toBe("needs-you");
  });

  it("says working while text is arriving, agents or no agents", () => {
    expect(headerStatus({ ...base, busy: true, agentsRunning: true })).toBe(
      "working"
    );
  });

  it("keeps a failure visible even with agents still running", () => {
    // How the turn ended is what the user has to act on; agents outliving it
    // do not change that.
    expect(headerStatus({ ...base, errored: true, agentsRunning: true })).toBe(
      "failed"
    );
  });

  it("says agents once the turn is over and the work is not", () => {
    // The case the whole state exists for: `busy` is off, the timeline reads
    // `done`, and a workflow is still running in the conversation.
    expect(headerStatus({ ...base, agentsRunning: true })).toBe("agents");
  });

  it("falls back to what the host read off the timeline", () => {
    expect(headerStatus({ ...base, stored: "interrupted" })).toBe(
      "interrupted"
    );
    expect(headerStatus({ ...base, stored: null })).toBeNull();
  });
});

describe("the vocabulary", () => {
  it("renames only `working` for the header", () => {
    // `working` means two different things on the two surfaces — "mid-turn
    // while you look at another chat" in the list, "text is arriving in front
    // of you" here. `agents` means the same thing on both.
    expect(HEADER_LABEL.working).toBe("streaming");
    expect(HEADER_LABEL.agents).toBe(STATUS_LABEL.agents);
    for (const key of Object.keys(
      STATUS_LABEL
    ) as (keyof typeof STATUS_LABEL)[])
      if (key !== "working") expect(HEADER_LABEL[key]).toBe(STATUS_LABEL[key]);
  });
});
