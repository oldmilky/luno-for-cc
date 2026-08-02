import { describe, it, expect } from "vitest";
import {
  DEFAULT_NOTIFY,
  TURN_FINISHED_TOAST_MS,
  humanDuration,
  toastFor,
  type NotifySwitches,
  type NotifyTrigger
} from "../../src/core/notify.js";

const all: NotifySwitches = {
  approval: true,
  question: true,
  turnFinished: true
};

const ctx = (
  trigger: NotifyTrigger,
  over: Partial<{
    visible: boolean;
    switches: NotifySwitches;
    turnMs: number;
    title: string;
  }> = {}
) => ({
  trigger,
  visible: false,
  switches: all,
  ...over
});

describe("toastFor — when it stays quiet", () => {
  it("says nothing about a chat the user is looking at", () => {
    // A banner over a card already on screen interrupts and informs nobody.
    for (const trigger of [
      "approval",
      "question",
      "turnFinished"
    ] as NotifyTrigger[]) {
      expect(
        toastFor(ctx(trigger, { visible: true, turnMs: 10 * 60_000 }))
      ).toBeNull();
    }
  });

  it("obeys each switch on its own", () => {
    const off = { approval: false, question: false, turnFinished: false };
    expect(toastFor(ctx("approval", { switches: off }))).toBeNull();
    expect(toastFor(ctx("question", { switches: off }))).toBeNull();
    expect(
      toastFor(ctx("turnFinished", { switches: off, turnMs: 10 * 60_000 }))
    ).toBeNull();
  });

  it("lets one switch off without silencing the others", () => {
    const noQuestions = { ...all, question: false };
    expect(toastFor(ctx("question", { switches: noQuestions }))).toBeNull();
    expect(toastFor(ctx("approval", { switches: noQuestions }))).not.toBeNull();
  });
});

describe("toastFor — the measured threshold", () => {
  it("stays quiet about a turn too short to have been walked away from", () => {
    expect(toastFor(ctx("turnFinished", { turnMs: 8_000 }))).toBeNull();
    expect(
      toastFor(ctx("turnFinished", { turnMs: TURN_FINISHED_TOAST_MS - 1 }))
    ).toBeNull();
  });

  it("speaks at the threshold and past it", () => {
    expect(
      toastFor(ctx("turnFinished", { turnMs: TURN_FINISHED_TOAST_MS }))
    ).not.toBeNull();
    expect(
      toastFor(ctx("turnFinished", { turnMs: 5 * 60_000 }))
    ).not.toBeNull();
  });

  it("stays quiet when nobody timed the turn", () => {
    expect(toastFor(ctx("turnFinished", {}))).toBeNull();
    expect(toastFor(ctx("turnFinished", { turnMs: 0 }))).toBeNull();
  });

  it("sits past the 95th percentile of real turns", () => {
    // 33 226 turns off this machine's CLI transcripts: p90 32s, p95 50s. The
    // line has to be in the tail — at 30s it would fire on one turn in nine,
    // which is noise with a threshold's name on it.
    expect(TURN_FINISHED_TOAST_MS).toBeGreaterThan(50_000);
  });

  it("is off by default, unlike the other two", () => {
    expect(DEFAULT_NOTIFY.turnFinished).toBe(false);
    expect(DEFAULT_NOTIFY.approval).toBe(true);
    expect(DEFAULT_NOTIFY.question).toBe(true);
  });
});

describe("toastFor — what it says", () => {
  it("names the conversation, so a person with several knows which", () => {
    const said = toastFor(ctx("approval", { title: "Refactor the parser" }));
    expect(said).toContain("Refactor the parser");
    expect(said).toContain("approval");
  });

  it("manages without a title rather than saying “undefined”", () => {
    for (const title of [undefined, "", "   "]) {
      const said = toastFor(ctx("approval", { title }));
      expect(said).not.toContain("undefined");
      expect(said).not.toContain("“”");
    }
  });

  it("tells a question apart from an approval", () => {
    expect(toastFor(ctx("question"))).toContain("asking");
    expect(toastFor(ctx("approval"))).toContain("approval");
  });

  it("says how long a finished turn took", () => {
    expect(toastFor(ctx("turnFinished", { turnMs: 4 * 60_000 }))).toContain(
      "4 min"
    );
  });
});

describe("humanDuration", () => {
  it("counts seconds while a person would", () => {
    expect(humanDuration(61_000)).toBe("61s");
    expect(humanDuration(89_400)).toBe("89s");
  });

  it("switches to minutes once seconds stop being readable", () => {
    expect(humanDuration(90_000)).toBe("2 min");
    expect(humanDuration(5 * 60_000)).toBe("5 min");
  });

  it("rounds rather than reading out a decimal nobody wants", () => {
    expect(humanDuration(63_400)).toBe("63s");
    expect(humanDuration(4 * 60_000 + 20_000)).toBe("4 min");
  });
});
