import { describe, it, expect, vi } from "vitest";
import {
  IDE_SERVER_NAME,
  IDE_TOOLS,
  MCP_NOTIFICATION_ACK,
  handleIdeMcpMessage,
  ideAllowedToolPatterns,
  validateArguments,
  type IdeToolOps,
  type IdeToolSchema
} from "../../src/core/ide-tools.js";

/** A stand-in for the editor half. The real one is the only thing in Wave 1
 *  that needs a running VS Code, which is exactly why it is not in here.
 *
 *  Built off `IDE_TOOLS` rather than written out, so a tool added to the table
 *  is exercised by every test in this file without one of them being edited. */
function fakeOps(): IdeToolOps & {
  calls: string[];
  args: Record<string, unknown>[];
} {
  const calls: string[] = [];
  const args: Record<string, unknown>[] = [];
  const ops = { calls, args } as IdeToolOps & {
    calls: string[];
    args: Record<string, unknown>[];
  };
  for (const tool of IDE_TOOLS) {
    (ops as Record<string, unknown>)[tool.name] = async (
      given: Record<string, unknown>
    ) => {
      calls.push(tool.name);
      args.push(given);
      return { content: [{ type: "text" as const, text: '{"success":true}' }] };
    };
  }
  return ops;
}

describe("ide-tools — the JSON-RPC surface", () => {
  it("answers initialize with the protocol version the CLI asked for", async () => {
    const res = await handleIdeMcpMessage(
      IDE_SERVER_NAME,
      {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { protocolVersion: "2025-11-25" }
      },
      fakeOps()
    );
    expect(res.id).toBe(0);
    expect(res.error).toBeUndefined();
    const result = res.result as {
      protocolVersion: string;
      capabilities: { tools: unknown };
      serverInfo: { name: string };
    };
    expect(result.protocolVersion).toBe("2025-11-25");
    expect(result.capabilities.tools).toBeDefined();
    expect(result.serverInfo.name).toBe(IDE_SERVER_NAME);
  });

  it("still names a version when the client sends none", async () => {
    const res = await handleIdeMcpMessage(
      IDE_SERVER_NAME,
      { id: 1, method: "initialize", params: {} },
      fakeOps()
    );
    const { protocolVersion } = res.result as { protocolVersion: string };
    expect(protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("lists every tool in the table, with its schema", async () => {
    const res = await handleIdeMcpMessage(
      IDE_SERVER_NAME,
      { id: 2, method: "tools/list" },
      fakeOps()
    );
    const { tools } = res.result as {
      tools: Array<{ name: string; description: string; inputSchema: unknown }>;
    };
    expect(tools.map((t) => t.name)).toEqual(IDE_TOOLS.map((t) => t.name));
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema).toBeDefined();
    }
  });

  it("dispatches tools/call into the editor half and returns its result", async () => {
    const ops = fakeOps();
    const res = await handleIdeMcpMessage(
      IDE_SERVER_NAME,
      { id: 3, method: "tools/call", params: { name: "getWorkspaceFolders" } },
      ops
    );
    expect(ops.calls).toEqual(["getWorkspaceFolders"]);
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({
      content: [{ type: "text", text: '{"success":true}' }]
    });
  });

  it("answers a notification with the bare ack and calls nothing", async () => {
    const ops = fakeOps();
    const res = await handleIdeMcpMessage(
      IDE_SERVER_NAME,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      ops
    );
    expect(res).toEqual(MCP_NOTIFICATION_ACK);
    expect(ops.calls).toEqual([]);
  });

  it("treats an explicit null id as a notification, not as id 0", async () => {
    const res = await handleIdeMcpMessage(
      IDE_SERVER_NAME,
      { jsonrpc: "2.0", id: null, method: "notifications/cancelled" },
      fakeOps()
    );
    expect(res).toEqual(MCP_NOTIFICATION_ACK);
  });
});

describe("ide-tools — the four ways it says no", () => {
  it("errors on a server name we never declared, rather than throwing", async () => {
    const res = await handleIdeMcpMessage(
      "chrome",
      { id: 7, method: "tools/list" },
      fakeOps()
    );
    expect(res.error?.code).toBe(-32601);
    expect(res.error?.message).toContain("chrome");
    expect(res.id).toBe(7);
  });

  it("errors on an unknown method", async () => {
    const res = await handleIdeMcpMessage(
      IDE_SERVER_NAME,
      { id: 8, method: "resources/list" },
      fakeOps()
    );
    expect(res.error?.code).toBe(-32601);
    expect(res.error?.message).toContain("resources/list");
  });

  it("errors on an unknown tool", async () => {
    const res = await handleIdeMcpMessage(
      IDE_SERVER_NAME,
      { id: 9, method: "tools/call", params: { name: "executeCode" } },
      fakeOps()
    );
    expect(res.error?.code).toBe(-32601);
    expect(res.error?.message).toContain("executeCode");
  });

  it("errors on a message carrying no method", async () => {
    const res = await handleIdeMcpMessage(
      IDE_SERVER_NAME,
      { id: 10 },
      fakeOps()
    );
    expect(res.error?.code).toBe(-32600);
  });

  it("turns a throwing editor operation into an error, not a rejection", async () => {
    const ops: IdeToolOps = {
      ...fakeOps(),
      getWorkspaceFolders: vi.fn().mockRejectedValue(new Error("no window"))
    };
    const res = await handleIdeMcpMessage(
      IDE_SERVER_NAME,
      { id: 11, method: "tools/call", params: { name: "getWorkspaceFolders" } },
      ops
    );
    expect(res.error?.code).toBe(-32603);
    expect(res.error?.message).toBe("no window");
  });

  it("errors rather than crashing when the host wired in no ops at all", async () => {
    const res = await handleIdeMcpMessage(
      IDE_SERVER_NAME,
      { id: 12, method: "tools/call", params: { name: "getWorkspaceFolders" } },
      undefined
    );
    expect(res.error?.code).toBe(-32603);
  });
});

describe("ide-tools — argument validation", () => {
  const schema: IdeToolSchema = {
    type: "object",
    properties: {
      filePath: { type: "string" },
      preview: { type: "boolean" }
    },
    required: ["filePath"]
  };

  it("passes a call that supplies every required argument", () => {
    expect(validateArguments(schema, { filePath: "a.ts" })).toBeNull();
  });

  it("names the missing required argument", () => {
    expect(validateArguments(schema, { preview: true })).toContain("filePath");
  });

  it("rejects a supplied argument of the wrong type", () => {
    expect(validateArguments(schema, { filePath: 42 })).toContain("string");
    expect(
      validateArguments(schema, { filePath: "a.ts", preview: "yes" })
    ).toContain("boolean");
  });

  it("lets an absent optional argument through", () => {
    expect(validateArguments(schema, { filePath: "a.ts" })).toBeNull();
  });

  it("accepts a no-argument tool called with nothing at all", () => {
    const empty: IdeToolSchema = { type: "object", properties: {} };
    expect(validateArguments(empty, undefined)).toBeNull();
    expect(validateArguments(empty, {})).toBeNull();
  });

  it("rejects arguments that are not an object", () => {
    expect(validateArguments(schema, "filePath=a.ts")).toContain("object");
  });

  it("refuses a tools/call whose arguments fail the schema", async () => {
    const res = await handleIdeMcpMessage(
      IDE_SERVER_NAME,
      {
        id: 13,
        method: "tools/call",
        params: { name: "getWorkspaceFolders", arguments: "nope" }
      },
      fakeOps()
    );
    expect(res.error?.code).toBe(-32602);
  });
});

describe("ide-tools — the server name", () => {
  it("is not `ide`, which the CLI silently strips from the tool list", () => {
    // MEASURED against 2.1.219 — see the constant's own note. Pinned here
    // because the failure mode is a tool the model simply cannot see, with no
    // error anywhere to trace it back from.
    expect(IDE_SERVER_NAME).not.toBe("ide");
  });

  it("survives the CLI's own name sanitizer unchanged", () => {
    // The CLI derives tool ids by replacing everything outside [A-Za-z0-9_-]
    // with `_`. A name that does not round-trip would be pre-allowed under one
    // spelling and exposed under another.
    expect(IDE_SERVER_NAME.replace(/[^a-zA-Z0-9_-]/g, "_")).toBe(
      IDE_SERVER_NAME
    );
  });
});

describe("ide-tools — permission weight", () => {
  it("pre-allows per tool, never as one whole-server block", () => {
    const patterns = ideAllowedToolPatterns();
    expect(patterns).not.toContain("mcp__luno_ide");
    for (const p of patterns) {
      expect(p.startsWith("mcp__luno_ide__")).toBe(true);
    }
  });

  it("offers a pattern for exactly the tools marked pre-allowed", () => {
    const expected = IDE_TOOLS.filter((t) => t.preAllowed).map(
      (t) => `mcp__luno_ide__${t.name}`
    );
    expect(ideAllowedToolPatterns()).toEqual([...expected].sort());
  });

  it("keeps the order stable, because argv order replaces a live process", () => {
    expect(ideAllowedToolPatterns()).toEqual(ideAllowedToolPatterns());
    expect(ideAllowedToolPatterns()).toEqual(
      [...ideAllowedToolPatterns()].sort()
    );
  });
});

describe("ide-tools — the read-only six", () => {
  const NAMES = [
    "getWorkspaceFolders",
    "getOpenEditors",
    "getCurrentSelection",
    "getLatestSelection",
    "getDiagnostics",
    "checkDocumentDirty"
  ];

  it("ships all six of them", () => {
    const shipped = IDE_TOOLS.map((t) => t.name);
    for (const name of NAMES) expect(shipped).toContain(name);
  });

  it("words every description as the reference words it", () => {
    // Not a style choice: the model has been trained against these strings.
    const byName = Object.fromEntries(
      IDE_TOOLS.map((t) => [t.name, t.description])
    );
    expect(byName.getWorkspaceFolders).toBe(
      "Get all workspace folders currently open in the IDE"
    );
    expect(byName.getOpenEditors).toBe(
      "Get information about currently open editors"
    );
    expect(byName.getCurrentSelection).toBe(
      "Get the current text selection in the active editor"
    );
    expect(byName.getLatestSelection).toBe(
      "Get the most recent text selection (even if not in the active editor)"
    );
    expect(byName.getDiagnostics).toBe("Get language diagnostics from VS Code");
    expect(byName.checkDocumentDirty).toBe(
      "Check if a document has unsaved changes (is dirty)"
    );
  });

  it("pre-allows all six — none of them reaches decidePermission", () => {
    for (const name of NAMES) {
      expect(IDE_TOOLS.find((t) => t.name === name)!.preAllowed).toBe(true);
      expect(ideAllowedToolPatterns()).toContain(`mcp__luno_ide__${name}`);
    }
  });

  it("hands the call's arguments to the operation", async () => {
    const ops = fakeOps();
    await handleIdeMcpMessage(
      IDE_SERVER_NAME,
      {
        id: 20,
        method: "tools/call",
        params: {
          name: "checkDocumentDirty",
          arguments: { filePath: "src/a.ts" }
        }
      },
      ops
    );
    expect(ops.calls).toEqual(["checkDocumentDirty"]);
    expect(ops.args).toEqual([{ filePath: "src/a.ts" }]);
  });

  it("hands an operation with no arguments an empty object, never undefined", async () => {
    const ops = fakeOps();
    await handleIdeMcpMessage(
      IDE_SERVER_NAME,
      { id: 21, method: "tools/call", params: { name: "getOpenEditors" } },
      ops
    );
    expect(ops.args).toEqual([{}]);
  });

  it("refuses checkDocumentDirty with no filePath, before the editor is touched", async () => {
    const ops = fakeOps();
    const res = await handleIdeMcpMessage(
      IDE_SERVER_NAME,
      {
        id: 22,
        method: "tools/call",
        params: { name: "checkDocumentDirty", arguments: {} }
      },
      ops
    );
    expect(res.error?.code).toBe(-32602);
    expect(res.error?.message).toContain("filePath");
    expect(ops.calls).toEqual([]);
  });

  it("lets getDiagnostics through with no uri — it is the one optional argument", async () => {
    const ops = fakeOps();
    const res = await handleIdeMcpMessage(
      IDE_SERVER_NAME,
      { id: 23, method: "tools/call", params: { name: "getDiagnostics" } },
      ops
    );
    expect(res.error).toBeUndefined();
    expect(ops.calls).toEqual(["getDiagnostics"]);
  });

  it("still refuses a uri of the wrong type", async () => {
    const res = await handleIdeMcpMessage(
      IDE_SERVER_NAME,
      {
        id: 24,
        method: "tools/call",
        params: { name: "getDiagnostics", arguments: { uri: 7 } }
      },
      fakeOps()
    );
    expect(res.error?.code).toBe(-32602);
  });

  it("advertises the argument schema, so the model does not guess", async () => {
    const res = await handleIdeMcpMessage(
      IDE_SERVER_NAME,
      { id: 25, method: "tools/list" },
      fakeOps()
    );
    const { tools } = res.result as {
      tools: Array<{ name: string; inputSchema: Record<string, any> }>;
    };
    const dirty = tools.find((t) => t.name === "checkDocumentDirty")!;
    expect(dirty.inputSchema.required).toEqual(["filePath"]);
    expect(dirty.inputSchema.properties.filePath.type).toBe("string");
    const diag = tools.find((t) => t.name === "getDiagnostics")!;
    expect(diag.inputSchema.required).toBeUndefined();
    expect(diag.inputSchema.properties.uri.description).toContain(
      "If not provided"
    );
  });
});

describe("ide-tools — the ones that write or wait", () => {
  it("never pre-allows saveDocument — it writes to disk, so it meets the gate", () => {
    // The whole reason `preAllowed` exists per tool rather than per server. A
    // pattern here would take saveDocument out of `decidePermission` entirely,
    // and the CLI would stop asking us at all.
    expect(ideAllowedToolPatterns()).not.toContain(
      "mcp__luno_ide__saveDocument"
    );
    const def = IDE_TOOLS.find((t) => t.name === "saveDocument")!;
    expect(def.preAllowed).toBe(false);
  });

  it("pre-allows openDiff, because that call *is* the question", () => {
    expect(ideAllowedToolPatterns()).toContain("mcp__luno_ide__openDiff");
  });

  it("pre-allows openFile — no card, and the timeline shows it stealing focus", () => {
    expect(ideAllowedToolPatterns()).toContain("mcp__luno_ide__openFile");
  });

  it("declares every openDiff argument optional, as its own descriptions read", () => {
    const def = IDE_TOOLS.find((t) => t.name === "openDiff")!;
    expect(def.inputSchema.required).toBeUndefined();
    expect(Object.keys(def.inputSchema.properties).sort()).toEqual([
      "new_file_contents",
      "new_file_path",
      "old_file_path",
      "tab_name"
    ]);
  });

  it("requires the one argument openFile cannot do without", () => {
    const def = IDE_TOOLS.find((t) => t.name === "openFile")!;
    expect(def.inputSchema.required).toEqual(["filePath"]);
    expect(def.inputSchema.properties.makeFrontmost.type).toBe("boolean");
  });

  it("words the writing tools as the reference words them", () => {
    const byName = Object.fromEntries(
      IDE_TOOLS.map((t) => [t.name, t.description])
    );
    expect(byName.openFile).toBe(
      "Open a file in the editor and optionally select a range of text"
    );
    expect(byName.openDiff).toBe("Open a git diff for the file");
    expect(byName.saveDocument).toBe("Save a document with unsaved changes");
    expect(byName.closeAllDiffTabs).toBe("Close all diff tabs in the editor");
  });
});
