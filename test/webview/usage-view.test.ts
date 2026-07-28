import { describe, it, expect } from "vitest";
import {
  serverRows,
  chipView,
  labelForLimit,
  toneForLimit,
  toneForPct,
  pctOf
} from "../../webview/src/features/chat/usage-view";
import type { UtilizationLimit } from "../../webview/src/lib/rpc";

const limit = (over: Partial<UtilizationLimit>): UtilizationLimit => ({
  kind: "session",
  group: "session",
  percent: 0,
  severity: "normal",
  resetsAt: 0,
  isActive: false,
  ...over
});

// The account this was taken from: 22% of the 5-hour window, 4% of the week.
// The old meter showed "over" and 58% for the same moment, because both
// numbers were counted against a cap it made up.
const LIVE = [
  limit({ kind: "session", group: "session", percent: 22, isActive: true }),
  limit({ kind: "weekly_all", group: "weekly", percent: 4 }),
  limit({
    kind: "weekly_scoped",
    group: "weekly",
    percent: 0,
    scopeLabel: "Fable"
  })
];

describe("choosing between the account's figures and our own count", () => {
  it("says nothing at all when the account has not reported", () => {
    expect(serverRows(undefined)).toBeNull();
    expect(serverRows([])).toBeNull();
  });

  it("sorts the account's rows into the slots the panel renders", () => {
    const rows = serverRows(LIVE);
    expect(rows?.session?.percent).toBe(22);
    expect(rows?.weekly?.percent).toBe(4);
    expect(rows?.scoped?.scopeLabel).toBe("Fable");
  });

  it("puts the window under most pressure on the chip", () => {
    expect(serverRows(LIVE)?.worst.kind).toBe("session");

    const weeklyBinding = [
      limit({ kind: "session", percent: 10 }),
      limit({ kind: "weekly_all", group: "weekly", percent: 88 })
    ];
    expect(serverRows(weeklyBinding)?.worst.kind).toBe("weekly_all");
  });

  it("counts tokens on the chip when there is no account figure", () => {
    const chip = chipView(null, 7_710_860);
    expect(chip).toEqual({
      kind: "tokens",
      label: "Current session",
      short: "5H",
      tokens: 7_710_860,
      tone: "accent"
    });
  });

  it("shows a percentage only when the account gave one", () => {
    const chip = chipView(serverRows(LIVE), 7_710_860);
    // The same moment the fallback would have called "over".
    expect(chip).toEqual({
      kind: "percent",
      label: "5-hour limit",
      short: "5H",
      percent: 22,
      tone: "ok"
    });
  });
});

describe("naming and colouring the account's rows", () => {
  it("names a scoped row after the model the account named", () => {
    expect(labelForLimit(LIVE[2])).toBe("Fable only");
    expect(labelForLimit(limit({ kind: "weekly_scoped" }))).toBe(
      "Model-scoped"
    );
    expect(labelForLimit(LIVE[0])).toBe("5-hour limit");
    expect(labelForLimit(LIVE[1])).toBe("Weekly (all models)");
  });

  it("takes the account's severity, and never softens it", () => {
    // A row the server calls critical stays red however small the number.
    expect(toneForLimit(limit({ percent: 3, severity: "critical" }))).toBe(
      "err"
    );
    expect(toneForLimit(limit({ percent: 3, severity: "warning" }))).toBe(
      "warn"
    );
    // And a number high enough is not talked down by a calm severity.
    expect(toneForLimit(limit({ percent: 95, severity: "normal" }))).toBe(
      "err"
    );
    expect(toneForLimit(limit({ percent: 22, severity: "normal" }))).toBe("ok");
  });
});

describe("the one fraction we compute ourselves", () => {
  it("is the context window, where the CLI reports both halves", () => {
    expect(pctOf(763_146, 1_000_000)).toBeCloseTo(76.3, 1);
    expect(toneForPct(76.3)).toBe("warn");
    expect(toneForPct(20)).toBe("ok");
    expect(toneForPct(95)).toBe("err");
  });

  it("answers zero rather than infinity for an unknown window", () => {
    expect(pctOf(1000, 0)).toBe(0);
  });
});
