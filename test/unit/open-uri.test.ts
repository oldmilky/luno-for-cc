import { describe, expect, it } from "vitest";

import { promptFromUri } from "../../src/core/open-uri.js";

// A URI handler is reachable from any web page, so what it refuses matters
// more than what it accepts. The extension spawns processes and holds a
// subscription credential; everything below is the boundary in front of that.
describe("vscode:// open links", () => {
  it("reads the prompt off /open", () => {
    expect(promptFromUri("/open", "prompt=fix%20the%20build")).toBe(
      "fix the build"
    );
  });

  it("ignores a path it does not know", () => {
    expect(promptFromUri("/run", "prompt=rm%20-rf")).toBeNull();
  });

  it("answers nothing when there is no prompt", () => {
    expect(promptFromUri("/open", "session=abc")).toBeNull();
  });

  it("treats whitespace as no prompt at all", () => {
    expect(promptFromUri("/open", "prompt=%20%20")).toBeNull();
  });

  // The composer renders what it is handed, and a link can carry anything.
  it("strips control characters, keeping newline and tab", () => {
    const esc = encodeURIComponent(String.fromCharCode(27));
    const nul = encodeURIComponent(String.fromCharCode(0));
    const out = promptFromUri("/open", `prompt=a${esc}b${nul}c%0Ad%09e`);
    expect(out).toBe("ab" + "c\nd\te");
  });

  it("keeps non-ASCII text intact", () => {
    expect(
      promptFromUri("/open", "prompt=%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82")
    ).toBe("привет");
  });

  it("caps a prompt long enough to be a payload", () => {
    const long = "x".repeat(10_000);
    expect(promptFromUri("/open", `prompt=${long}`)?.length).toBe(4_000);
  });
});
