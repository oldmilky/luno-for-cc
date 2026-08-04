import { describe, expect, it } from "vitest";

import {
  toggleRemoteControl,
  type RemoteControlProvider,
  type RemoteControlTarget
} from "../../src/ui/domains/remote-control.js";
import type { RemoteControlStatus } from "../../src/core/types.js";

/** Records every state the toggle publishes, in order — the sequence is the
 *  behaviour, not just the final value. */
function harness(provider?: Partial<RemoteControlProvider>) {
  const published: RemoteControlStatus[] = [];
  const spawned: string[] = [];
  const stub: RemoteControlProvider = {
    enableRemoteControl: async (name) => {
      spawned.push(`enable:${name ?? ""}`);
      return { state: "ready", url: "https://example.invalid/s" };
    },
    disableRemoteControl: async () => {
      spawned.push("disable");
    },
    ...provider
  };
  return {
    published,
    spawned,
    stub,
    target: (over: Partial<RemoteControlTarget> = {}): RemoteControlTarget => ({
      liveProvider: () => stub,
      ensureProvider: async () => {
        spawned.push("ensure");
        return stub;
      },
      publish: (status) => published.push(status),
      ...over
    })
  };
}

describe("turning Remote Control on", () => {
  it("says `connecting` before the round-trip, then what came back", async () => {
    const h = harness();
    await toggleRemoteControl(true, h.target({ title: "a chat" }));
    // Not `ready` first: that state offers a link which does not exist yet.
    expect(h.published.map((s) => s.state)).toEqual(["connecting", "ready"]);
  });

  it("names the session on the far side", async () => {
    const h = harness();
    await toggleRemoteControl(true, h.target({ title: "a chat" }));
    expect(h.spawned).toEqual(["ensure", "enable:a chat"]);
  });

  it("passes an unnamed session as absent rather than empty", async () => {
    const h = harness();
    await toggleRemoteControl(true, h.target({ title: "" }));
    expect(h.spawned).toEqual(["ensure", "enable:"]);
  });

  it("starts a process when the conversation has none", async () => {
    const h = harness();
    await toggleRemoteControl(
      true,
      h.target({ liveProvider: () => undefined })
    );
    expect(h.spawned).toContain("ensure");
    expect(h.published.at(-1)?.state).toBe("ready");
  });

  it("reports a refusal as an error state, not a throw", async () => {
    const h = harness({
      enableRemoteControl: () => Promise.reject(new Error("needs session mode"))
    });
    await expect(
      toggleRemoteControl(true, h.target())
    ).resolves.toBeUndefined();
    expect(h.published.at(-1)).toEqual({
      state: "error",
      error: "needs session mode"
    });
  });

  it("still reports an error when what was thrown was not one", async () => {
    const h = harness({
      enableRemoteControl: () => Promise.reject("bridge said no")
    });
    await toggleRemoteControl(true, h.target());
    expect(h.published.at(-1)).toEqual({
      state: "error",
      error: "bridge said no"
    });
  });
});

describe("turning Remote Control off", () => {
  it("takes the running bridge down and says so", async () => {
    const h = harness();
    await toggleRemoteControl(false, h.target());
    expect(h.spawned).toEqual(["disable"]);
    expect(h.published).toEqual([{ state: "off" }]);
  });

  // Spawning a process in order to tell it to stop bridging is work with
  // nothing on the other end of it.
  it("starts no process when there is nothing to disable", async () => {
    const h = harness();
    await toggleRemoteControl(
      false,
      h.target({ liveProvider: () => undefined })
    );
    expect(h.spawned).toEqual([]);
    expect(h.published).toEqual([{ state: "off" }]);
  });
});
