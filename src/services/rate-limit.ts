// ─────────────────────────────────────────────────────────────
// rate-limit — the account's quota verdicts as the CLI reports them.
//
// The CLI emits a `rate_limit_event` mid-turn saying which window is binding
// and when it resets. That reset time is the only authoritative anchor
// available on the subscription path, and the usage aggregation needs it:
// without it the 5-hour window has to be inferred from message timestamps,
// which silently folds the previous window's tokens into the current one.
//
// Quota is per account, not per conversation, so one tracker is shared by all
// of them. It survives a reload through the store, because a window that
// resets at 22:10 still resets at 22:10 after the panel is rebuilt.
// ─────────────────────────────────────────────────────────────

import type { RateLimitStatus } from "../core/types.js";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

/** Where verdicts survive a window reload. A `Memento` satisfies this. */
export interface RateLimitStore {
  get(): RateLimitStatus[] | undefined;
  set(value: RateLimitStatus[]): void;
}

export class RateLimitTracker {
  /** Keyed by bucket: the CLI reports whichever window is binding right now,
   *  so a `seven_day` verdict must not overwrite what we know about the
   *  5-hour one. */
  private readonly byBucket = new Map<string, RateLimitStatus>();

  constructor(private readonly store?: RateLimitStore) {
    for (const s of store?.get() ?? []) {
      if (s?.bucket && typeof s.resetsAt === "number") {
        this.byBucket.set(s.bucket, s);
      }
    }
  }

  /** Record a verdict. Older news about a bucket is ignored: turns can finish
   *  out of order, and a stale event would drag the countdown backwards. */
  record(status: RateLimitStatus): void {
    const known = this.byBucket.get(status.bucket);
    if (known && known.observedAt > status.observedAt) return;
    this.byBucket.set(status.bucket, status);
    this.store?.set([...this.byBucket.values()]);
  }

  /**
   * The verdict for one bucket, or undefined once its window has elapsed.
   *
   * A reset time in the past says nothing about the window that replaced it —
   * reporting it anyway is how a meter ends up counting down to a moment that
   * has already been and gone.
   */
  forBucket(
    bucket: string,
    now: number = Date.now()
  ): RateLimitStatus | undefined {
    const s = this.byBucket.get(bucket);
    return s && s.resetsAt > now ? s : undefined;
  }

  /**
   * Start of the 5-hour window in flight, when the CLI has told us where it
   * ends. Undefined means fall back to inference — the answer is unknown, not
   * zero.
   */
  sessionWindowStart(now: number = Date.now()): number | undefined {
    const s = this.forBucket("five_hour", now);
    return s ? s.resetsAt - FIVE_HOURS_MS : undefined;
  }

  /** Every live verdict, for surfacing in the UI. */
  live(now: number = Date.now()): RateLimitStatus[] {
    return [...this.byBucket.values()].filter((s) => s.resetsAt > now);
  }
}
