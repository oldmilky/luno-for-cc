import { describe, expect, it } from "vitest";

import {
  cleanTerminalOutput,
  expandTerminalMentions,
  formatRun,
  tailOf,
  type TerminalRun
} from "../../src/core/terminal-output.js";

// By char code rather than as a literal: an unescaped ESC is invisible in an
// editor, and a fixture nobody can see is one nobody can correct.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

const run = (over: Partial<TerminalRun> = {}): TerminalRun => ({
  terminalName: "bash",
  commandLine: "bun run lint",
  exitCode: 2,
  output: "error TS2345",
  ...over
});

describe("cleaning what a terminal wrote", () => {
  it("drops colour and cursor sequences", () => {
    const raw = `${ESC}[31merror${ESC}[0m: nope${ESC}[2K`;
    expect(cleanTerminalOutput(raw)).toBe("error: nope");
  });

  // Shell integration writes these around every command; left in, they are
  // most of the payload by weight and mean nothing to the model.
  it("drops OSC sequences closed by BEL or ST", () => {
    expect(cleanTerminalOutput(`${ESC}]0;title${BEL}out`)).toBe("out");
    expect(cleanTerminalOutput(`${ESC}]633;A${ESC}\\out`)).toBe("out");
  });

  it("normalises CRLF without eating the newline", () => {
    expect(cleanTerminalOutput("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("keeps tabs and newlines, which carry the layout", () => {
    expect(cleanTerminalOutput("a\tb\nc")).toBe("a\tb\nc");
  });

  it("leaves ordinary text alone", () => {
    expect(cleanTerminalOutput("plain output")).toBe("plain output");
  });
});

describe("bounding the output", () => {
  it("returns short output untouched", () => {
    expect(tailOf("short", 100)).toBe("short");
  });

  it("keeps the end, which is where a failure says why", () => {
    const text = "aaaa\nbbbb\nthe actual error";
    expect(tailOf(text, 20)).toContain("the actual error");
  });

  // A silent truncation reads as the whole output, and a model asked "why did
  // this fail" would answer from a log it cannot tell is partial.
  it("says that it truncated", () => {
    expect(tailOf("a".repeat(50) + "\nend", 20)).toContain(
      "[earlier output trimmed]"
    );
  });
});

describe("a run in a prompt", () => {
  it("carries the command, the exit code and the output", () => {
    const text = formatRun(run());
    expect(text).toContain("bun run lint");
    expect(text).toContain("exit 2");
    expect(text).toContain("error TS2345");
  });

  it("says the exit code is unknown rather than inventing a zero", () => {
    expect(formatRun(run({ exitCode: undefined }))).toContain(
      "exit code unknown"
    );
  });

  it("marks an empty run as empty", () => {
    expect(formatRun(run({ output: "   " }))).toContain("(no output)");
  });
});

describe("expanding @terminal: mentions", () => {
  const pwsh = run({
    terminalName: "pwsh",
    commandLine: "git push",
    exitCode: 0,
    output: "done"
  });
  const lookup = (name: string) =>
    name === "bash" ? run() : name === "pwsh" ? pwsh : undefined;

  it("replaces the token with the run", () => {
    const out = expandTerminalMentions("why did @terminal:bash fail?", lookup);
    expect(out).toContain("bun run lint");
    expect(out).not.toContain("@terminal:bash");
  });

  it("expands every mention in one message", () => {
    const out = expandTerminalMentions("@terminal:bash @terminal:pwsh", lookup);
    expect(out).toContain("bun run lint");
    expect(out).toContain("git push");
  });

  // Blanking it would leave a prompt reading as if the output had never been
  // asked for, and the model would answer the question with nothing in hand.
  it("leaves an unknown terminal's token in place", () => {
    const out = expandTerminalMentions("@terminal:fish please", lookup);
    expect(out).toContain("@terminal:fish");
  });

  it("does not take the sentence's punctuation for part of the name", () => {
    const out = expandTerminalMentions("look at @terminal:bash.", lookup);
    expect(out).toContain("bun run lint");
  });

  it("leaves a message with no mention untouched", () => {
    expect(expandTerminalMentions("just a question", lookup)).toBe(
      "just a question"
    );
  });
});
