import { describe, it, expect } from "vitest";
import { extractFileEdits } from "../../webview/src/features/chat/extract-file-edits.js";

// extract-file-edits.ts only uses `import type` for its imports, so it runs
// in the node vitest environment with no React/DOM dependency.

interface Item {
  id: string;
  name: string;
  input: string;
  result?: string;
  isError?: boolean;
}
const item = (o: Item): any => o;

describe("extractFileEdits", () => {
  it("turns a single Edit into one entry with one change", () => {
    const out = extractFileEdits([
      item({
        id: "1",
        name: "Edit",
        input: JSON.stringify({ path: "a.ts", old_string: "x", new_string: "y" }),
        result: "ok"
      })
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe("a.ts");
    expect(out[0].action).toBe("Edited");
    expect(out[0].changes).toEqual([{ kind: "edit", oldText: "x", newText: "y" }]);
    expect(out[0].pending).toBe(false);
  });

  it("expands a MultiEdit edits[] array into multiple changes", () => {
    const out = extractFileEdits([
      item({
        id: "1",
        name: "MultiEdit",
        input: JSON.stringify({
          file_path: "b.ts",
          edits: [
            { old_string: "a", new_string: "b" },
            { old_string: "c", new_string: "d" }
          ]
        })
      })
    ]);
    expect(out[0].changes).toHaveLength(2);
  });

  it("aggregates multiple tool calls to the same path into one entry", () => {
    const out = extractFileEdits([
      item({ id: "1", name: "Edit", input: JSON.stringify({ path: "a.ts", old_string: "x", new_string: "y" }) }),
      item({ id: "2", name: "Edit", input: JSON.stringify({ path: "a.ts", old_string: "y", new_string: "z" }) })
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].changes).toHaveLength(2);
  });

  it("recognizes the various write tool name aliases", () => {
    const out = extractFileEdits([
      item({ id: "1", name: "Write", input: JSON.stringify({ path: "a.ts", content: "hi" }) })
    ]);
    expect(out[0].action).toBe("Wrote");
    expect(out[0].changes).toEqual([{ kind: "write", newText: "hi" }]);
  });

  it("reads alternate field names (file_path / filePath / target_file)", () => {
    const out = extractFileEdits([
      item({ id: "1", name: "Write", input: JSON.stringify({ target_file: "t.ts", text: "z" }) })
    ]);
    expect(out[0].path).toBe("t.ts");
  });

  it("skips tool calls whose JSON cannot be parsed", () => {
    const out = extractFileEdits([item({ id: "1", name: "Edit", input: "{not json" })]);
    expect(out).toHaveLength(0);
  });

  it("skips tool calls with no recognizable path", () => {
    const out = extractFileEdits([
      item({ id: "1", name: "Edit", input: JSON.stringify({ old_string: "x", new_string: "y" }) })
    ]);
    expect(out).toHaveLength(0);
  });

  it("ignores non-file tools entirely", () => {
    const out = extractFileEdits([item({ id: "1", name: "Grep", input: JSON.stringify({ pattern: "x" }) })]);
    expect(out).toHaveLength(0);
  });

  it("marks an item pending when it has no result and no error", () => {
    const out = extractFileEdits([
      item({ id: "1", name: "Write", input: JSON.stringify({ path: "a.ts", content: "x" }) })
    ]);
    expect(out[0].pending).toBe(true);
  });

  it("propagates the errored flag", () => {
    const out = extractFileEdits([
      item({ id: "1", name: "Edit", input: JSON.stringify({ path: "a.ts", old_string: "x", new_string: "y" }), isError: true })
    ]);
    expect(out[0].errored).toBe(true);
  });

  // Documents the current behavior flagged in the audit (B6): when a Write
  // follows Edits to the same path, the action flips to "Wrote" but the
  // earlier edit changes are *retained* rather than superseded.
  it("documents that a Write after Edits keeps prior edit hunks (action upgrades to Wrote)", () => {
    const out = extractFileEdits([
      item({ id: "1", name: "Edit", input: JSON.stringify({ path: "a.ts", old_string: "x", new_string: "y" }) }),
      item({ id: "2", name: "Write", input: JSON.stringify({ path: "a.ts", content: "FULL" }) })
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].action).toBe("Wrote");
    // Both the edit hunk and the full write survive in `changes`.
    expect(out[0].changes).toHaveLength(2);
    expect(out[0].changes[0].kind).toBe("edit");
    expect(out[0].changes[1].kind).toBe("write");
  });
});
