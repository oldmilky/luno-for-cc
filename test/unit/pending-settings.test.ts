import { describe, it, expect } from "vitest";
import {
  pendingSettings,
  respawnFingerprint,
  buildArgs
} from "../../src/providers/claude-cli.js";

// Which of the user's choices a running process cannot be given. Measured
// against 2.1.219: the CLI takes exactly five settings live — set_cwd,
// set_model, set_permission_mode, set_max_thinking_tokens and
// set_mcp_permission_mode_override. Everything else is argv, and argv is fixed
// at spawn, so applying it means replacing the process — which kills every
// background agent inside it.
describe("pendingSettings", () => {
  const base = { binary: "claude", cwd: "/tmp" };

  it("is empty when the process already matches", () => {
    expect(pendingSettings(base, base)).toEqual([]);
  });

  it("names effort, which has no live equivalent at all", () => {
    expect(
      pendingSettings({ ...base, effort: "high" }, { ...base, effort: "max" })
    ).toEqual(["effort"]);
  });

  // Ultracode pins `--effort xhigh` and rides in `--settings`; both are argv.
  it("treats ultracode as part of the same choice", () => {
    expect(
      pendingSettings(
        { ...base, ultracode: false },
        { ...base, ultracode: true }
      )
    ).toEqual(["effort"]);
  });

  // `set_permission_mode` exists and is sent, but the mode also carries an
  // `--append-system-prompt` block — enforcement lands now, posture does not.
  it("names the mode, because its prompt rides on argv", () => {
    expect(
      pendingSettings(
        { ...base, permissionMode: "default" },
        { ...base, permissionMode: "plan" }
      )
    ).toEqual(["mode"]);
  });

  it("names skills regardless of the order they were toggled in", () => {
    expect(
      pendingSettings(
        { ...base, disabledSkills: ["a", "b"] },
        { ...base, disabledSkills: ["b", "a"] }
      )
    ).toEqual([]);
    expect(
      pendingSettings(
        { ...base, disabledSkills: ["a"] },
        { ...base, disabledSkills: ["a", "b"] }
      )
    ).toEqual(["skills"]);
  });

  it("names every outstanding one at once", () => {
    expect(
      pendingSettings(
        { ...base, effort: "high", thinking: true },
        { ...base, effort: "low", thinking: false, permissionMode: "plan" }
      )
    ).toEqual(["mode", "effort", "thinking"]);
  });
});

// The model has `set_model`, and `applyLiveOptions` sends it. Leaving it in the
// fingerprint made a fresh `/rc` spawn — which goes through
// `buildArgs("", undefined, …)` and so carries no `--model` — replace its own
// process on the user's very next message, taking the phone's bridge with it.
describe("respawnFingerprint", () => {
  const base = { binary: "claude", cwd: "/tmp", sessionMode: true } as const;

  it("does not change when only the model does", () => {
    const before = buildArgs("", undefined, base);
    const after = buildArgs("hi", "claude-opus-5", base);
    expect(respawnFingerprint(before)).toBe(respawnFingerprint(after));
  });

  it("still changes when effort does", () => {
    const before = buildArgs("hi", "claude-opus-5", { ...base, effort: "low" });
    const after = buildArgs("hi", "claude-opus-5", { ...base, effort: "max" });
    expect(respawnFingerprint(before)).not.toBe(respawnFingerprint(after));
  });
});
