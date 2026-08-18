import { describe, it, expect } from "vitest";
import {
  fileTouchedByTool,
  filesTouchedByTool,
  filesWrittenByShell
} from "../../src/ui/domains/checkpoint-triggers.js";

// A miss here does not throw — the file simply never enters the checkpoint,
// and the user discovers it when rewind fails to bring the file back. This was
// a private method on a class no test imported, so neither the tool-name list
// nor the path extraction had ever been exercised.

const call = (name: string, input: unknown) => ({
  kind: "tool_call",
  body: JSON.stringify(input),
  meta: { name }
});

describe("fileTouchedByTool", () => {
  it("recognises the tools Claude Code actually writes with", () => {
    for (const name of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
      expect(fileTouchedByTool(call(name, { file_path: "a.ts" })), name).toBe(
        "a.ts"
      );
    }
  });

  it("matches case-insensitively", () => {
    // The CLI's casing is not a contract; the gate lowercases before matching.
    expect(fileTouchedByTool(call("WRITE", { path: "a.ts" }))).toBe("a.ts");
    expect(fileTouchedByTool(call("wRiTe", { path: "a.ts" }))).toBe("a.ts");
  });

  it("keeps the legacy names a restored session can still replay", () => {
    // An old history file replays the tool names of its own era.
    for (const name of ["update", "create", "str_replace_editor"]) {
      expect(fileTouchedByTool(call(name, { path: "a.ts" })), name).toBe(
        "a.ts"
      );
    }
  });

  it("ignores tools that do not write", () => {
    for (const name of ["Read", "Grep", "Glob", "Bash", "WebFetch", "Task"]) {
      expect(fileTouchedByTool(call(name, { path: "a.ts" })), name).toBeNull();
    }
  });

  it("accepts all three spellings of the path key, in precedence order", () => {
    expect(fileTouchedByTool(call("Write", { path: "p" }))).toBe("p");
    expect(fileTouchedByTool(call("Write", { file_path: "fp" }))).toBe("fp");
    expect(fileTouchedByTool(call("Write", { filePath: "fP" }))).toBe("fP");
    // `path` wins when more than one is present.
    expect(
      fileTouchedByTool(call("Write", { path: "p", file_path: "fp" }))
    ).toBe("p");
  });

  it("returns null for a write with no usable path", () => {
    expect(fileTouchedByTool(call("Write", {}))).toBeNull();
    expect(fileTouchedByTool(call("Write", { path: "" }))).toBeNull();
    // A non-string path is not coerced — `String(42)` would snapshot a file
    // called "42" and hide the real problem.
    expect(fileTouchedByTool(call("Write", { path: 42 }))).toBeNull();
  });

  it("survives a malformed body instead of throwing", () => {
    // The body is JSON from a subprocess. Throwing here would take down the
    // listener the whole timeline flows through.
    expect(
      fileTouchedByTool({
        kind: "tool_call",
        body: "{not json",
        meta: { name: "Write" }
      })
    ).toBeNull();
    expect(
      fileTouchedByTool({ kind: "tool_call", meta: { name: "Write" } })
    ).toBeNull();
    expect(
      fileTouchedByTool({
        kind: "tool_call",
        body: "null",
        meta: { name: "Write" }
      })
    ).toBeNull();
  });

  it("ignores events that are not tool calls at all", () => {
    for (const kind of ["user", "assistant", "tool_result", "plan_revision"]) {
      expect(
        fileTouchedByTool({
          kind,
          body: JSON.stringify({ path: "a.ts" }),
          meta: { name: "Write" }
        }),
        kind
      ).toBeNull();
    }
  });

  it("returns null when the tool name is missing", () => {
    expect(
      fileTouchedByTool({
        kind: "tool_call",
        body: JSON.stringify({ path: "a" })
      })
    ).toBeNull();
  });
});

// The CLI's own system prompt steers the model to `sed`, heredocs and short
// scripts instead of the edit tools. A file written that way is named by no
// tool, so it lands in no checkpoint and Rewind cannot put it back — silently,
// which is the whole reason this net exists. `prompts/common.md` countermands
// the steer; this holds when the model does it anyway.
describe("filesWrittenByShell", () => {
  it("reads a redirect, both kinds", () => {
    expect(filesWrittenByShell("cat > src/a.ts")).toEqual(["src/a.ts"]);
    expect(filesWrittenByShell("echo hi >> notes.md")).toEqual(["notes.md"]);
  });

  it("resolves against a `cd` in the same command line", () => {
    // The shape the report came in as. Without this the bare basename names a
    // file at the workspace root that probably does not exist — and
    // `addFileToLatest` records an unknown path as "did not exist before", so
    // a later revert would *delete* whatever is actually there.
    expect(
      filesWrittenByShell("cd src/features/cases && cat >> next-cases.tsx")
    ).toEqual(["src/features/cases/next-cases.tsx"]);
  });

  it("leaves an absolute target alone", () => {
    expect(
      filesWrittenByShell("cd /repo/src && cat > /tmp/out.txt")
    ).toEqual(["/tmp/out.txt"]);
  });

  it("resolves a Windows `cd` target", () => {
    // Backslashes survive to `normalizeRel`, which folds them before it
    // compares against the workspace root — so a mixed separator is fine and
    // an absolute Windows path must stay whole.
    const b = String.fromCharCode(92);
    expect(filesWrittenByShell(`cd C:${b}repo${b}src && cat > a.ts`)).toEqual([
      `C:${b}repo${b}src/a.ts`
    ]);
    expect(filesWrittenByShell(`cat > C:${b}repo${b}out.ts`)).toEqual([
      `C:${b}repo${b}out.ts`
    ]);
  });

  it("reads sed -i, and only its file operands", () => {
    expect(filesWrittenByShell("sed -i 's/a/b/' src/x.ts")).toEqual([
      "src/x.ts"
    ]);
    expect(filesWrittenByShell("sed -i.bak 's/a/b/' a.ts b.ts")).toEqual([
      "a.ts",
      "b.ts"
    ]);
  });

  it("does not read a sed that only prints", () => {
    // `sed -n` is a read. Recording it would put a file in the checkpoint that
    // nothing is going to change.
    expect(filesWrittenByShell("sed -n '1,20p' src/x.ts")).toEqual([]);
  });

  it("reads tee", () => {
    expect(filesWrittenByShell("echo x | tee -a build.log")).toEqual([
      "build.log"
    ]);
  });

  it("is not fooled by a descriptor duplication", () => {
    // `2>&1` opens nothing. Reading `&1` as a filename would have put a file
    // called `&1` in the checkpoint.
    expect(filesWrittenByShell("bun run test 2>&1 | head -20")).toEqual([]);
  });

  it("does not read a redirect out of a quoted string", () => {
    // The first version scanned the raw line and answered `b'` for a plain
    // `grep` — a phantom path, out of a command that writes nothing. A path
    // that is wrong is worse than one that is missing: `addFileToLatest`
    // records an unknown path as "did not exist before", and a revert acts on
    // that by deleting whatever is at it.
    expect(filesWrittenByShell("grep -n 'a > b' src/x.ts")).toEqual([]);
    expect(filesWrittenByShell("awk '{ if ($1 > 2) print }' data.txt")).toEqual(
      []
    );
    expect(filesWrittenByShell('echo "value > 10" >> log.txt')).toEqual([
      "log.txt"
    ]);
  });

  it("reads a target attached to the operator, and a quoted one", () => {
    expect(filesWrittenByShell("cat >src/b.ts")).toEqual(["src/b.ts"]);
    expect(filesWrittenByShell('cat > "my file.txt"')).toEqual([
      "my file.txt"
    ]);
  });

  it("ignores sinks", () => {
    expect(filesWrittenByShell("noisy > /dev/null 2>&1")).toEqual([]);
  });

  it("collects every file one line writes", () => {
    expect(
      filesWrittenByShell("cat > a.ts && sed -i 's/x/y/' b.ts; echo z >> c.md")
    ).toEqual(["a.ts", "b.ts", "c.md"]);
  });

  it("says nothing about a command whose target it cannot read", () => {
    // `perl -i` and a script that computes its own path are not modelled, and
    // guessing one would be worse than missing it.
    expect(filesWrittenByShell("perl -i -pe 's/a/b/' x.ts")).toEqual([]);
    expect(filesWrittenByShell("node scripts/codegen.mjs")).toEqual([]);
  });

  it("reads nothing out of an ordinary read-only line", () => {
    expect(filesWrittenByShell("grep -rn TODO src | head -20")).toEqual([]);
    expect(filesWrittenByShell("git status --short")).toEqual([]);
  });
});

describe("filesTouchedByTool", () => {
  const bash = (command: string) => ({
    kind: "tool_call",
    body: JSON.stringify({ command }),
    meta: { name: "Bash" }
  });

  it("still answers with the edit tool's own path", () => {
    expect(
      filesTouchedByTool({
        kind: "tool_call",
        body: JSON.stringify({ file_path: "a.ts" }),
        meta: { name: "Edit" }
      })
    ).toEqual(["a.ts"]);
  });

  it("answers for a shell write", () => {
    expect(filesTouchedByTool(bash("cat > src/a.ts"))).toEqual(["src/a.ts"]);
  });

  it("ignores a tool that is neither", () => {
    expect(
      filesTouchedByTool({
        kind: "tool_call",
        body: JSON.stringify({ command: "cat > a.ts" }),
        meta: { name: "Grep" }
      })
    ).toEqual([]);
  });
});
