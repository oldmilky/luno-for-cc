import { describe, it, expect } from "vitest";
import { makeProcessor, contextSize } from "../../src/providers/claude-cli.js";
import type { CliEvent } from "../../src/providers/claude-cli.js";

// The numbers are from `test/fixtures/workflow-stream.jsonl`, a real capture.
// Two requests in one turn, then the result that sums them — which is the bug
// this file exists to hold shut: the panel divided that sum by the window and
// reported 173% of a million-token context.
const FIRST_REQUEST = {
  input_tokens: 9,
  cache_creation_input_tokens: 9_248,
  cache_read_input_tokens: 24_196,
  output_tokens: 4
};
const SECOND_REQUEST = {
  input_tokens: 8,
  cache_creation_input_tokens: 920,
  cache_read_input_tokens: 33_444,
  output_tokens: 2
};
const TURN_TOTAL = {
  input_tokens: 17,
  cache_creation_input_tokens: 10_168,
  cache_read_input_tokens: 57_640,
  output_tokens: 322
};

const assistantEvent = (usage: Record<string, number>): CliEvent =>
  ({
    type: "assistant",
    message: { content: [], usage }
  }) as unknown as CliEvent;

const resultEvent = (
  usage: Record<string, number>,
  contextWindow = 200_000
): CliEvent =>
  ({
    type: "result",
    usage,
    modelUsage: { "claude-haiku-4-5-20251001": { contextWindow } }
  }) as unknown as CliEvent;

// `StreamDelta` is one interface with a `type` field rather than a union, so
// there is nothing to narrow to — filtering is all this needs.
const usageDeltas = (deltas: ReturnType<ReturnType<typeof makeProcessor>>) =>
  deltas.filter((d) => d.type === "usage");

describe("how full the context was", () => {
  it("reports the last request, not the turn's running total", () => {
    const process = makeProcessor();
    process(assistantEvent(FIRST_REQUEST));
    process(assistantEvent(SECOND_REQUEST));
    const [end] = usageDeltas(process(resultEvent(TURN_TOTAL)));

    // 34,372 — what the second request put in front of the model.
    expect(end.usage?.contextTokens).toBe(contextSize(SECOND_REQUEST));
    // Not 67,825, which is the two requests added together and belongs to no
    // moment in the conversation.
    expect(end.usage?.contextTokens).not.toBe(contextSize(TURN_TOTAL));
    expect(end.usage?.contextWindow).toBe(200_000);
  });

  it("keeps a long turn under the window it ran in", () => {
    const process = makeProcessor();
    let summedCacheReads = 0;
    for (let i = 0; i < 20; i += 1) {
      const request = {
        input_tokens: 10,
        cache_creation_input_tokens: 1_000,
        cache_read_input_tokens: 40_000,
        output_tokens: 50
      };
      summedCacheReads += request.cache_read_input_tokens;
      process(assistantEvent(request));
    }
    const [end] = usageDeltas(
      process(
        resultEvent(
          {
            input_tokens: 200,
            cache_creation_input_tokens: 20_000,
            cache_read_input_tokens: summedCacheReads,
            output_tokens: 1_000
          },
          200_000
        )
      )
    );

    // Twenty requests re-read the same cached prefix; summing them is how the
    // meter passed 100% on a context that was never a third full.
    expect(end.usage?.contextTokens).toBe(41_060);
    expect(end.usage!.contextTokens!).toBeLessThan(end.usage!.contextWindow!);
  });

  it("says nothing rather than passing off a total as an occupancy", () => {
    // A CLI that ships no per-assistant usage leaves the question unanswerable.
    const process = makeProcessor();
    const [end] = usageDeltas(process(resultEvent(TURN_TOTAL)));

    expect(end.usage?.contextTokens).toBeUndefined();
  });

  it("follows the compaction down instead of holding the old figure", () => {
    const process = makeProcessor();
    process(assistantEvent(FIRST_REQUEST));
    process(resultEvent(TURN_TOTAL));

    const [afterCompact] = usageDeltas(
      process({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: {
          trigger: "auto",
          pre_tokens: 180_000,
          post_tokens: 24_500
        }
      } as unknown as CliEvent)
    );

    // The CLI says how much survived the fold. Reporting the pre-compaction
    // figure until the next request shows a full window at the one moment the
    // user is watching it empty.
    expect(afterCompact.usage?.contextTokens).toBe(24_500);
    expect(afterCompact.usage?.contextWindow).toBe(200_000);
  });

  it("takes the window of the model that ran the main loop", () => {
    const process = makeProcessor();
    // `system/init` names it; a side-call's larger window must not win.
    process({
      type: "system",
      subtype: "init",
      model: "claude-haiku-4-5-20251001"
    } as unknown as CliEvent);
    process(assistantEvent(FIRST_REQUEST));

    const [end] = usageDeltas(
      process({
        type: "result",
        usage: TURN_TOTAL,
        modelUsage: {
          "claude-haiku-4-5-20251001": { contextWindow: 200_000 },
          "claude-opus-5[1m]": { contextWindow: 1_000_000 }
        }
      } as unknown as CliEvent)
    );

    expect(end.usage?.contextWindow).toBe(200_000);
  });

  it("updates live once a result in this stream has named the window", () => {
    const process = makeProcessor();
    process(assistantEvent(FIRST_REQUEST));
    process(resultEvent(TURN_TOTAL));

    const [live] = usageDeltas(process(assistantEvent(SECOND_REQUEST)));
    expect(live.usage?.contextTokens).toBe(contextSize(SECOND_REQUEST));
    expect(live.usage?.contextWindow).toBe(200_000);
  });
});
