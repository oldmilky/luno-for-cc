import { describe, it, expect } from "vitest";
import { buildArgs } from "../../src/providers/cli/args.js";

// Ultracode is a settings key, not a sixth `--effort` level, and the CLI is
// perfectly happy to accept a settings blob it does not understand — it ignores
// unknown keys in silence. So the only thing standing between "the user picked
// it" and "the turn ran without it" is what this file asserts about argv.

const base = { binary: "claude", cwd: "/tmp" } as const;

/** The `--settings` blob as an object, or `{}` when the flag is absent. */
function settingsBlob(args: string[]): Record<string, unknown> {
  const i = args.indexOf("--settings");
  if (i === -1) return {};
  return JSON.parse(args[i + 1]) as Record<string, unknown>;
}

function effortArg(args: string[]): string | undefined {
  const i = args.indexOf("--effort");
  return i === -1 ? undefined : args[i + 1];
}

describe("buildArgs ultracode", () => {
  it("sends the key only when the conversation asked for it", () => {
    const on = buildArgs("hi", "opus", { ...base, ultracode: true });
    expect(settingsBlob(on).ultracode).toBe(true);

    const off = buildArgs("hi", "opus", { ...base, ultracode: false });
    // Absent, not `false`: the key's absence is its off state, and writing
    // `false` would override a settings file that turned it on deliberately.
    expect("ultracode" in settingsBlob(off)).toBe(false);
  });

  it("runs at xhigh whatever level came with it", () => {
    // A stored posture can pair ultracode with any level — the picker sends
    // them together, but a session file written by hand need not.
    const args = buildArgs("hi", "opus", {
      ...base,
      effort: "max",
      ultracode: true
    });
    expect(effortArg(args)).toBe("xhigh");
  });

  it("leaves the chosen level alone when it is off", () => {
    const args = buildArgs("hi", "opus", {
      ...base,
      effort: "max",
      ultracode: false
    });
    expect(effortArg(args)).toBe("max");
    expect(settingsBlob(args).ultracode).toBeUndefined();
  });

  it("keeps the rest of the settings blob intact", () => {
    const args = buildArgs("hi", "opus", {
      ...base,
      permissionMode: "default",
      thinking: true,
      ultracode: true
    });
    const blob = settingsBlob(args);
    expect(blob.ultracode).toBe(true);
    expect(blob.alwaysThinkingEnabled).toBe(true);
    // The git→classifier routing is what makes the approval card fire at all.
    expect(blob.permissions).toBeDefined();
  });
});
