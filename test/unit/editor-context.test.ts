import { describe, it, expect } from "vitest";
import {
  formatEditorContext,
  truncateSelection,
  MAX_SELECTION_CHARS,
  type EditorSnapshot
} from "../../src/core/editor-context.js";

function snapshot(over: Partial<EditorSnapshot> = {}): EditorSnapshot {
  return { file: "src/gate.ts", language: "typescript", ...over };
}

describe("formatEditorContext", () => {
  it("says nothing when no editor is focused", () => {
    expect(formatEditorContext(null)).toBeNull();
  });

  it("names the file the user is in", () => {
    const out = formatEditorContext(snapshot()) ?? "";

    expect(out).toContain("Active file: src/gate.ts (typescript)");
    expect(out).toContain("No selection.");
  });

  it("carries the selected text and where it came from", () => {
    const out =
      formatEditorContext(
        snapshot({
          selection: {
            startLine: 12,
            endLine: 14,
            text: "if (!ok) throw new Error()",
            truncated: false
          }
        })
      ) ?? "";

    expect(out).toContain("Selected lines 12-14:");
    expect(out).toContain("if (!ok) throw new Error()");
    // Fenced with the language so the model reads it as code, not prose.
    expect(out).toContain("```typescript");
  });

  it("says line, not lines, for a one-line selection", () => {
    const out =
      formatEditorContext(
        snapshot({
          selection: { startLine: 7, endLine: 7, text: "x", truncated: false }
        })
      ) ?? "";

    expect(out).toContain("Selected line 7:");
  });

  // This rides on every turn. An agent that reads "file open" as "change this
  // file" starts editing things nobody asked about.
  it("frames the state as context rather than an instruction", () => {
    const out = formatEditorContext(snapshot()) ?? "";

    expect(out).toMatch(/context, not/i);
    expect(out).toMatch(/only when the message refers to it/i);
  });

  it("admits when the selection was cut", () => {
    const out =
      formatEditorContext(
        snapshot({
          selection: {
            startLine: 1,
            endLine: 900,
            text: "x".repeat(10),
            truncated: true
          }
        })
      ) ?? "";

    expect(out).toContain("(truncated)");
  });
});

describe("truncateSelection", () => {
  it("passes a normal selection through untouched", () => {
    const { text, truncated } = truncateSelection("const a = 1;");

    expect(text).toBe("const a = 1;");
    expect(truncated).toBe(false);
  });

  // Ctrl+A in a large file would otherwise re-send the whole thing with every
  // message for the rest of the conversation.
  it("caps a selection that would be re-sent on every turn", () => {
    const { text, truncated } = truncateSelection(
      "y".repeat(MAX_SELECTION_CHARS + 500)
    );

    expect(text).toHaveLength(MAX_SELECTION_CHARS);
    expect(truncated).toBe(true);
  });
});
