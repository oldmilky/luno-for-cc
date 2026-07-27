import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  utimesSync
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { aggregateClaudeCodeUsage } from "../../src/services/claude-code-usage.js";

// Deterministic clock — well clear of any local day/week boundary.
// 2026-05-27 is a Wednesday; 18:00 local leaves >5h since local midnight.
const NOW = new Date("2026-05-27T18:00:00");
const HOUR = 3_600_000;
const DAY = 86_400_000;

function line(
  tsMs: number,
  model: string,
  input: number,
  output: number
): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: new Date(tsMs).toISOString(),
    message: { model, usage: { input_tokens: input, output_tokens: output } }
  });
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "luno-usage-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("aggregateClaudeCodeUsage windowing", () => {
  it("aggregates today / week / weekSonnet / total / session windows", async () => {
    const proj = path.join(root, "proj-1");
    mkdirSync(proj, { recursive: true });
    const nowMs = NOW.getTime();
    writeFileSync(
      path.join(proj, "fresh.jsonl"),
      [
        line(nowMs - HOUR, "claude-sonnet-4-6", 100, 50), // 17:00, sonnet
        line(nowMs - 2 * HOUR, "claude-opus-4-8", 200, 80) // 16:00, opus
      ].join("\n")
    );

    const out = await aggregateClaudeCodeUsage("/unused", NOW, {
      scope: "all",
      projectsRoot: root
    });

    expect(out.available).toBe(true);
    expect(out.total.inputTokens).toBe(300);
    expect(out.today.inputTokens).toBe(300);
    expect(out.week.inputTokens).toBe(300);
    expect(out.weekSonnet.inputTokens).toBe(100); // only the sonnet line
    expect(out.session.usage.inputTokens).toBe(300);
    // Session starts at the EARLIEST message in the 5h window (the 16:00 line).
    expect(out.session.startedAt).toBe(nowMs - 2 * HOUR);
    expect(out.session.resetsAt).toBe(nowMs - 2 * HOUR + 5 * HOUR);
  });

  it("reports unavailable when the projects root does not exist", async () => {
    const out = await aggregateClaudeCodeUsage("/unused", NOW, {
      scope: "all",
      projectsRoot: path.join(root, "missing")
    });
    expect(out.available).toBe(false);
  });

  it("excludes a message older than the 5h window from the session bucket", async () => {
    const proj = path.join(root, "proj-1");
    mkdirSync(proj, { recursive: true });
    const nowMs = NOW.getTime();
    writeFileSync(
      path.join(proj, "fresh.jsonl"),
      [
        line(nowMs - HOUR, "claude-sonnet-4-6", 100, 50), // in window
        line(nowMs - 6 * HOUR, "claude-sonnet-4-6", 999, 999) // outside 5h window
      ].join("\n")
    );
    const out = await aggregateClaudeCodeUsage("/unused", NOW, {
      scope: "all",
      projectsRoot: root
    });
    expect(out.session.usage.inputTokens).toBe(100);
  });

  // ───────────────────────────────────────────────────────────
  // KNOWN BUG: `total` is documented as "cumulative since file storage began",
  // but files whose mtime is older than ~2 weeks are skipped entirely (a perf
  // shortcut at claude-code-usage.ts:217-221), so old usage never reaches the
  // total. We write an old file (mtime 20 days ago) and show its tokens are
  // dropped from `total`.
  // ───────────────────────────────────────────────────────────
  it("documents that old files are skipped, so `total` is NOT truly cumulative", async () => {
    const proj = path.join(root, "proj-1");
    mkdirSync(proj, { recursive: true });
    const nowMs = NOW.getTime();
    writeFileSync(
      path.join(proj, "fresh.jsonl"),
      line(nowMs - HOUR, "claude-sonnet-4-6", 100, 50)
    );

    const oldFile = path.join(proj, "old.jsonl");
    writeFileSync(oldFile, line(nowMs - 20 * DAY, "claude-opus-4-8", 999, 999));
    const oldTime = new Date(nowMs - 20 * DAY);
    utimesSync(oldFile, oldTime, oldTime); // backdate the file mtime

    const out = await aggregateClaudeCodeUsage("/unused", NOW, {
      scope: "all",
      projectsRoot: root
    });
    // The 999 from the backdated file is excluded:
    expect(out.total.inputTokens).toBe(100);
  });
});

// The inferred 5-hour window takes the oldest message inside [now-5h, now] as
// the window start. When a window boundary falls inside that range, the tail of
// the *previous* window is the oldest message — so the reset time is reported
// hours early and the previous window's tokens are counted against the current
// one. Measured against a live account the countdown was 2.5 hours out.
describe("aggregateClaudeCodeUsage session anchoring", () => {
  /** 17:10 — a window that runs to 22:10, with the one before it still inside
   *  the five hours the inference scans. */
  const windowStart = NOW.getTime() - 50 * 60 * 1000;

  function twoWindows(): string {
    const nowMs = NOW.getTime();
    return [
      // Previous window: 14:39, three hours before now but before the boundary.
      line(nowMs - 3 * HOUR - 21 * 60_000, "claude-opus-4-8", 900, 100),
      // Current window: after 17:10.
      line(windowStart + 5 * 60_000, "claude-opus-4-8", 40, 10),
      line(nowMs - 5 * 60_000, "claude-opus-4-8", 30, 20)
    ].join("\n");
  }

  it("counts only the anchored window, and resets when the CLI says", async () => {
    const proj = path.join(root, "proj-1");
    mkdirSync(proj, { recursive: true });
    writeFileSync(path.join(proj, "fresh.jsonl"), twoWindows());

    const out = await aggregateClaudeCodeUsage("/unused", NOW, {
      scope: "all",
      projectsRoot: root,
      sessionWindowStart: windowStart
    });

    expect(out.session.startedAt).toBe(windowStart);
    expect(out.session.resetsAt).toBe(windowStart + 5 * HOUR);
    expect(out.session.authoritative).toBe(true);
    // 40+10+30+20 — the 900 from the previous window stays out of it.
    expect(out.session.usage.inputTokens + out.session.usage.outputTokens).toBe(
      100
    );
  });

  it("without an anchor, folds the previous window in and resets early", async () => {
    const proj = path.join(root, "proj-1");
    mkdirSync(proj, { recursive: true });
    writeFileSync(path.join(proj, "fresh.jsonl"), twoWindows());

    const out = await aggregateClaudeCodeUsage("/unused", NOW, {
      scope: "all",
      projectsRoot: root
    });

    // This is the defect the anchor exists to remove, pinned so a future
    // change to the fallback is a deliberate one.
    expect(out.session.authoritative).toBeUndefined();
    expect(out.session.resetsAt).toBeLessThan(windowStart + 5 * HOUR);
    expect(out.session.usage.inputTokens + out.session.usage.outputTokens).toBe(
      1100
    );
  });
});
