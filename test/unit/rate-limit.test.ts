import { describe, it, expect } from "vitest";
import {
  RateLimitTracker,
  type RateLimitStore
} from "../../src/services/rate-limit.js";
import type { RateLimitStatus } from "../../src/core/types.js";

const NOW = new Date("2026-05-27T18:00:00").getTime();
const HOUR = 3_600_000;

function verdict(over: Partial<RateLimitStatus> = {}): RateLimitStatus {
  return {
    bucket: "five_hour",
    resetsAt: NOW + 4 * HOUR,
    status: "allowed",
    observedAt: NOW,
    ...over
  };
}

function memoryStore(): RateLimitStore & { value?: RateLimitStatus[] } {
  const store: RateLimitStore & { value?: RateLimitStatus[] } = {
    get: () => store.value,
    set: (v) => {
      store.value = v;
    }
  };
  return store;
}

describe("RateLimitTracker", () => {
  it("hands back the 5-hour window start the CLI implied", () => {
    const t = new RateLimitTracker();
    t.record(verdict());
    expect(t.sessionWindowStart(NOW)).toBe(NOW - HOUR);
  });

  // The CLI reports whichever window is binding. A weekly verdict says nothing
  // about the 5-hour one, and letting it overwrite would leave the session row
  // anchored to a boundary seven days out.
  it("keeps each window separate", () => {
    const t = new RateLimitTracker();
    t.record(verdict());
    t.record(verdict({ bucket: "seven_day", resetsAt: NOW + 72 * HOUR }));

    expect(t.sessionWindowStart(NOW)).toBe(NOW - HOUR);
    expect(t.forBucket("seven_day", NOW)?.resetsAt).toBe(NOW + 72 * HOUR);
  });

  // A window that has already reset says nothing about the one that replaced
  // it. Reporting it anyway is how a meter counts down to a moment in the past.
  it("drops a verdict once its window has elapsed", () => {
    const t = new RateLimitTracker();
    t.record(verdict({ resetsAt: NOW - 60_000 }));

    expect(t.forBucket("five_hour", NOW)).toBeUndefined();
    expect(t.sessionWindowStart(NOW)).toBeUndefined();
    expect(t.live(NOW)).toEqual([]);
  });

  // Turns finish out of order — a slow one can land after a fast one started
  // later. Taking the last message to arrive would drag the countdown backwards.
  it("ignores news older than what it already knows", () => {
    const t = new RateLimitTracker();
    t.record(verdict({ resetsAt: NOW + 4 * HOUR, observedAt: NOW }));
    t.record(verdict({ resetsAt: NOW + HOUR, observedAt: NOW - 10 * 60_000 }));

    expect(t.forBucket("five_hour", NOW)?.resetsAt).toBe(NOW + 4 * HOUR);
  });

  it("survives a reload through the store", () => {
    const store = memoryStore();
    new RateLimitTracker(store).record(verdict());

    // What the next window gets: a fresh tracker over the same storage.
    const revived = new RateLimitTracker(store);
    expect(revived.sessionWindowStart(NOW)).toBe(NOW - HOUR);
  });

  it("starts empty rather than throwing on junk in the store", () => {
    const store = memoryStore();
    store.value = [{ bucket: "" }, null] as unknown as RateLimitStatus[];

    expect(new RateLimitTracker(store).live(NOW)).toEqual([]);
  });
});
