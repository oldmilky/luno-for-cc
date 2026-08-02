import { describe, it, expect } from "vitest";
import {
  AUDIO_SLOTS,
  BORROWED_CANDIDATES,
  CAPTURE_COMMANDS,
  audioSlotFor,
  chooseCapture,
  noBackendMessage,
  recorderFileName
} from "../../src/core/voice/backends.js";

describe("the borrowed recorders", () => {
  it("asks both for the one shape the endpoint accepts", () => {
    // linear16, 16 kHz, mono, raw — the same stream the socket is opened for.
    expect(CAPTURE_COMMANDS.rec).toEqual(
      expect.arrayContaining([
        "-r",
        "16000",
        "-c",
        "1",
        "-b",
        "16",
        "-t",
        "raw"
      ])
    );
    expect(CAPTURE_COMMANDS.arecord).toEqual(
      expect.arrayContaining(["-f", "S16_LE", "-r", "16000", "-c", "1"])
    );
  });

  it("asks sox first, since it is the one that exists off Linux", () => {
    expect(BORROWED_CANDIDATES[0]).toBe("rec");
  });
});

describe("choosing a backend", () => {
  it("prefers the recorder we shipped over anything found on the machine", () => {
    // Ours produces the target format directly; a borrowed one is a fallback
    // whose presence we do not control.
    expect(chooseCapture({ bundled: true, borrowed: ["rec"] })).toBe("bundled");
  });

  it("falls back in order when nothing shipped", () => {
    expect(
      chooseCapture({ bundled: false, borrowed: ["arecord", "rec"] })
    ).toBe("rec");
    expect(chooseCapture({ bundled: false, borrowed: ["arecord"] })).toBe(
      "arecord"
    );
  });

  it("answers null rather than guessing when there is nothing", () => {
    expect(chooseCapture({ bundled: false, borrowed: [] })).toBeNull();
  });
});

describe("where a shipped recorder lives", () => {
  it("names a slot for every target the package carries", () => {
    expect(audioSlotFor("win32", "x64")).toBe("win32-x64");
    expect(audioSlotFor("darwin", "arm64")).toBe("darwin-arm64");
    expect(audioSlotFor("linux", "x64")).toBe("linux-x64");
  });

  it("has no slot for a target nothing was built for", () => {
    // 32-bit Windows and Linux armv7 are real installs; answering with a path
    // that cannot exist would turn "not built" into "file missing".
    expect(audioSlotFor("win32", "ia32")).toBeNull();
    expect(audioSlotFor("linux", "arm")).toBeNull();
    expect(audioSlotFor("freebsd", "x64")).toBeNull();
  });

  it("carries six targets, and every one of them is built by CI", () => {
    expect(AUDIO_SLOTS).toHaveLength(6);
  });

  it("only Windows wants the extension", () => {
    expect(recorderFileName("win32")).toBe("luno-audio.exe");
    expect(recorderFileName("darwin")).toBe("luno-audio");
  });
});

describe("what the panel says when it cannot hear", () => {
  it("separates a target we never built from a file that went missing", () => {
    // The two need different actions: one is ours to fix, the other is the
    // user's install to repair.
    expect(noBackendMessage("linux", "arm")).toContain("no recorder built for");
    expect(noBackendMessage("win32", "x64")).toContain(
      "missing from this install"
    );
  });

  it("names the install command for the platform in front of the user", () => {
    expect(noBackendMessage("win32", "x64")).toContain("winget");
    expect(noBackendMessage("darwin", "arm64")).toContain("brew");
    expect(noBackendMessage("linux", "x64")).toContain("apt");
  });
});
