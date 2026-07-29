// ─────────────────────────────────────────────────────────────
// DeltaQueue — a push source read as an async iterable.
//
// The provider hands turn output to a consumer by *being* an async
// generator, which works when the consumer asked for the turn. A turn
// started on another device arrives the other way round: the session
// reader pushes deltas at whoever is listening, with nothing to await.
// This is the adapter between the two, so a remote turn can be fed to
// the same Orchestrator loop as a local one.
// ─────────────────────────────────────────────────────────────

import { StreamDelta } from "./types.js";

export class DeltaQueue implements AsyncIterable<StreamDelta> {
  private readonly buffer: StreamDelta[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  private endedWithSession = false;

  /**
   * Whether the `done` that closed this queue meant the CLI process is gone,
   * rather than merely that a turn finished.
   *
   * The consumer only sees the queue end; the reason arrives on the delta and
   * would otherwise be lost. It decides whether the caller may close cards for
   * agents still running — see `sweepLiveTasks`.
   */
  get sessionEnded(): boolean {
    return this.endedWithSession;
  }

  /** Feed one delta. `done` closes the queue, matching the provider's own
   *  contract — the consumer stops there rather than waiting for a source that
   *  has nothing left to say. */
  push(d: StreamDelta): void {
    if (this.closed) return;
    if (d.type === "done") {
      this.endedWithSession = d.sessionEnded === true;
      this.close();
      return;
    }
    this.buffer.push(d);
    this.wake?.();
    this.wake = null;
  }

  /** End the stream without waiting for a `done` that may never come — the
   *  turn was cancelled, or the process it belonged to is gone. Whatever is
   *  already buffered is still delivered. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.wake?.();
    this.wake = null;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamDelta> {
    while (true) {
      while (this.buffer.length > 0) yield this.buffer.shift()!;
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}
