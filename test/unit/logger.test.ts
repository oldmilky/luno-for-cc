import { describe, it, expect, vi, afterEach } from "vitest";
import { log, warn, error, setLogSink } from "../../src/services/logger.js";

afterEach(() => {
  setLogSink(undefined);
  vi.restoreAllMocks();
});

function captured(): { lines: string[] } {
  const lines: string[] = [];
  setLogSink((l) => lines.push(l));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  return { lines };
}

describe("logger", () => {
  it("stamps the level and the time onto every line", () => {
    const { lines } = captured();

    log("spawned the CLI");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^\d{2}:\d{2}:\d{2}\.\d{3} \[info] spawned the CLI$/
    );
  });

  it("keeps writing to the console as well", () => {
    captured();

    warn("something odd");

    expect(console.warn).toHaveBeenCalledOnce();
  });

  // A message with an Error attached is the common case in this codebase, and
  // `[object Object]` in a log a user pastes into a bug report is worthless.
  it("renders an Error as its stack, not as an object", () => {
    const { lines } = captured();

    error("restore failed:", new Error("EACCES"));

    expect(lines[0]).toContain("Error: EACCES");
  });

  it("survives a value that cannot be serialised", () => {
    const { lines } = captured();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    log("state:", cyclic);

    expect(lines).toHaveLength(1);
  });

  // The provider and core layers call this with no editor around; until
  // activation attaches the output channel there is simply nowhere to send it.
  it("logs happily with no sink attached", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(() => log("before activation")).not.toThrow();
  });

  it("does not let a failing sink take down the caller", () => {
    setLogSink(() => {
      throw new Error("channel disposed");
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(() => log("after dispose")).not.toThrow();
  });
});
