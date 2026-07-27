import { describe, expect, it } from "vitest";

import { Orchestrator } from "../../src/core/orchestrator.js";
import { Session } from "../../src/core/session.js";
import type { ChatProvider } from "../../src/providers/base.js";
import type { StreamDelta } from "../../src/core/types.js";

/**
 * A provider that hands out `deltas` one at a time and calls `between` after
 * each. `between` is assigned after construction so a test can cancel the very
 * orchestrator that consumes this provider — which is where the cancel has to
 * land to reproduce the real case: Stop, rewind, edit or a session switch
 * arriving mid-stream.
 */
function providerOf(deltas: StreamDelta[]) {
  const provider = {
    id: "fake",
    between: undefined as ((index: number) => void) | undefined,
    async *stream() {
      for (let i = 0; i < deltas.length; i++) {
        yield deltas[i];
        provider.between?.(i);
      }
    }
  };
  return provider;
}

function orchestratorFor(
  session: Session,
  provider: ChatProvider
): Orchestrator {
  return new Orchestrator(session, {
    provider,
    model: "opus",
    maxTokens: 1000,
    systemPrompt: ""
  });
}

describe("cancelling a turn", () => {
  it("keeps the text the model had already streamed", async () => {
    const session = new Session();
    const provider = providerOf([
      { type: "text", text: "Partial " },
      { type: "text", text: "answer." },
      { type: "text", text: "never seen" }
    ]);
    const orch = orchestratorFor(session, provider);
    provider.between = (i) => {
      if (i === 1) orch.cancel();
    };
    await orch.turn("go");

    const assistant = session.timeline.filter((e) => e.kind === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0].body).toBe("Partial answer.");
  });

  it("leaves messages untouched, so a half-finished turn is not sent back as context", async () => {
    const session = new Session();
    // Two deltas, not one: with a single delta the stream ends before the
    // cancel check runs again, so the turn would complete normally and the
    // assertion would be about the happy path instead of the cancelled one.
    const provider = providerOf([
      { type: "text", text: "Partial" },
      { type: "text", text: "unreachable" }
    ]);
    const orch = orchestratorFor(session, provider);
    provider.between = () => orch.cancel();
    await orch.turn("go");

    expect(session.messages).toEqual([{ role: "user", content: "go" }]);
  });

  it("emits nothing when cancelled before any text arrived", async () => {
    const session = new Session();
    const provider = providerOf([
      { type: "text", text: "" },
      { type: "text", text: "unreachable" }
    ]);
    const orch = orchestratorFor(session, provider);
    provider.between = () => orch.cancel();
    await orch.turn("go");

    expect(session.timeline.filter((e) => e.kind === "assistant")).toEqual([]);
  });
});
