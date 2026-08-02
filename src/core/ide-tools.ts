// ─────────────────────────────────────────────────────────────
// The `ide` MCP server — the table, the validation, the dispatch.
//
// The CLI drives this server over the control protocol rather than a socket:
// an `mcp_message` control request carries a JSON-RPC message, and the answer
// rides back inside the control response. There is no port, no lockfile and no
// WebSocket anywhere in this — see `docs/PARITY-PLAN.md` Wave 1.1, where the
// two socket designs were measured and refuted.
//
// This module imports zero VS Code APIs. Every operation that touches the
// editor arrives as an `IdeToolOps` function from `services/ide/`, which is
// what keeps the protocol testable without a mock editor.
// ─────────────────────────────────────────────────────────────

/**
 * The name the server is declared under in the CLI's `--mcp-config`, and the
 * namespace its tools appear in as `mcp__luno_ide__<tool>`.
 *
 * **Not `ide`** — that name is reserved, and the failure is silent. MEASURED
 * against 2.1.219: two identical `sdk` servers in one config, named `ide` and
 * `lunoide`, both answered `initialize` and `tools/list` and both came back
 * `status: "connected"` in `system/init` — but only `lunoide`'s tool reached
 * the model. `ide`'s was dropped from the tool list with no error anywhere, and
 * the model reported the tool as simply not existing.
 */
export const IDE_SERVER_NAME = "luno_ide";

/** Sent back from `initialize` when the CLI asks for a version we cannot read.
 *  The CLI on 2.1.219 asks for `2025-11-25`; a request that names a version is
 *  echoed instead, which is the negotiation MCP specifies. */
const FALLBACK_PROTOCOL_VERSION = "2025-11-25";

/** What a tool hands back. The MCP content shape, which the CLI turns into the
 *  tool result the model reads. */
export interface IdeToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * The arguments each tool takes, after {@link validateArguments} has passed
 * them. Declared as one map so the ops table below cannot drift from it: a
 * tool added here with no implementation is a compile error, not a
 * method-not-found at runtime.
 */
export interface IdeToolArgs {
  getWorkspaceFolders: Record<string, never>;
  getOpenEditors: Record<string, never>;
  getCurrentSelection: Record<string, never>;
  getLatestSelection: Record<string, never>;
  getDiagnostics: { uri?: string };
  checkDocumentDirty: { filePath: string };
  closeAllDiffTabs: Record<string, never>;
  openFile: {
    filePath: string;
    preview?: boolean;
    startText?: string;
    endText?: string;
    selectToEndOfLine?: boolean;
    makeFrontmost?: boolean;
  };
  saveDocument: { filePath: string };
  /** Every argument is optional, and each absent one has a defined meaning —
   *  see the descriptions in {@link IDE_TOOLS}. The reference declares all four
   *  required while its own descriptions say otherwise; we follow the
   *  descriptions, because a schema that lies costs a refused call. */
  openDiff: {
    old_file_path?: string;
    new_file_path?: string;
    new_file_contents?: string;
    tab_name?: string;
  };
}

/** The editor operations the table dispatches into. One entry per tool that
 *  ships; `services/ide/editor.ts` is the only implementation that touches
 *  VS Code. */
export type IdeToolOps = {
  [K in keyof IdeToolArgs]: (args: IdeToolArgs[K]) => Promise<IdeToolResult>;
};

/** A JSON Schema for one tool's arguments — the subset the reference's own
 *  tools use, which is objects of strings and booleans and nothing nested. */
export interface IdeToolSchema {
  type: "object";
  properties: Record<
    string,
    { type: "string" | "boolean" | "number"; description?: string }
  >;
  required?: string[];
}

export interface IdeToolDef {
  name: keyof IdeToolOps;
  description: string;
  inputSchema: IdeToolSchema;
  /** False for a tool that must reach `decidePermission` instead of being
   *  pre-allowed in argv. `ide` cannot go in as one block — the tools differ
   *  in weight, and that is the whole reason this flag exists. */
  preAllowed: boolean;
}

/**
 * The tools this server exposes.
 *
 * Names and descriptions are the reference extension's own, read out of
 * `anthropic.claude-code` 2.1.220 — the model has been trained against those
 * exact strings, so paraphrasing them is not a style choice.
 */
export const IDE_TOOLS: readonly IdeToolDef[] = [
  {
    name: "getWorkspaceFolders",
    description: "Get all workspace folders currently open in the IDE",
    inputSchema: { type: "object", properties: {} },
    preAllowed: true
  },
  {
    name: "getOpenEditors",
    description: "Get information about currently open editors",
    inputSchema: { type: "object", properties: {} },
    preAllowed: true
  },
  {
    name: "getCurrentSelection",
    description: "Get the current text selection in the active editor",
    inputSchema: { type: "object", properties: {} },
    preAllowed: true
  },
  {
    name: "getLatestSelection",
    description:
      "Get the most recent text selection (even if not in the active editor)",
    inputSchema: { type: "object", properties: {} },
    preAllowed: true
  },
  {
    name: "getDiagnostics",
    description: "Get language diagnostics from VS Code",
    inputSchema: {
      type: "object",
      properties: {
        uri: {
          type: "string",
          description:
            "Optional file URI to get diagnostics for. If not provided, gets diagnostics for all files."
        }
      }
    },
    preAllowed: true
  },
  {
    name: "checkDocumentDirty",
    description: "Check if a document has unsaved changes (is dirty)",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path to the file to check" }
      },
      required: ["filePath"]
    },
    preAllowed: true
  },
  {
    name: "openFile",
    description:
      "Open a file in the editor and optionally select a range of text",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path to the file to open" },
        preview: {
          type: "boolean",
          description: "Whether to open the file in preview mode"
        },
        startText: {
          type: "string",
          description:
            "Text pattern to find the start of the selection range. Selects from the beginning of this match."
        },
        endText: {
          type: "string",
          description:
            "Text pattern to find the end of the selection range. Selects up to the end of this match. If not provided, only the startText match will be selected."
        },
        selectToEndOfLine: {
          type: "boolean",
          description:
            "If true, selection will extend to the end of the line containing the endText match."
        },
        makeFrontmost: {
          type: "boolean",
          description:
            "Whether to make the file the active editor tab. If false, the file will be opened in the background without changing focus."
        }
      },
      required: ["filePath"]
    },
    // No approval card — but it steals focus, so the timeline has to show it,
    // which the tool card already does.
    preAllowed: true
  },
  {
    name: "openDiff",
    description: "Open a git diff for the file",
    inputSchema: {
      type: "object",
      properties: {
        old_file_path: {
          type: "string",
          description:
            "Path to the file to show diff for. If not provided, uses active editor."
        },
        new_file_path: {
          type: "string",
          description:
            "Path to the file to show diff for. If not provided, uses active editor."
        },
        new_file_contents: {
          type: "string",
          description:
            "Contents of the new file. If not provided then the current file contents of new_file_path will be used."
        },
        tab_name: {
          type: "string",
          description:
            "Path to the file to show diff for. If not provided, uses active editor."
        }
      }
    },
    // Allowlisted deliberately: this call *is* the question. An approval card
    // over it would ask the user to approve being asked.
    preAllowed: true
  },
  {
    name: "closeAllDiffTabs",
    description: "Close all diff tabs in the editor",
    inputSchema: { type: "object", properties: {} },
    // Closes only the diff tabs this server opened — see `diff-tabs.ts`. The
    // reference matches on a label containing "[Claude Code]", which closes a
    // tab it merely recognises rather than one it owns.
    preAllowed: true
  },
  {
    name: "saveDocument",
    description: "Save a document with unsaved changes",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path to the file to save" }
      },
      required: ["filePath"]
    },
    // The one tool here that writes to disk, so it goes through
    // `decidePermission` like any other write — never pre-allowed in argv.
    preAllowed: false
  }
];

/** `--allowedTools` patterns for the tools that carry no permission weight.
 *  Sorted, because argv order decides whether a session-mode process survives
 *  the turn — same reason `mcpToolPatterns` sorts. */
export function ideAllowedToolPatterns(): string[] {
  return IDE_TOOLS.filter((t) => t.preAllowed)
    .map((t) => `mcp__${IDE_SERVER_NAME}__${t.name}`)
    .sort();
}

// JSON-RPC 2.0 error codes, the four this server can produce.
const PARSE_INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
};

/** The acknowledgement a notification gets: it carries no id, so there is
 *  nothing to correlate and the CLI wants only to know we took it. Shape is the
 *  reference's own, `id: 0` included. */
export const MCP_NOTIFICATION_ACK: JsonRpcResponse = {
  jsonrpc: "2.0",
  result: {},
  id: 0
};

function ok(id: number | string, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function fail(
  id: number | string,
  code: number,
  message: string
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Check `arguments` against a tool's schema.
 *
 * @returns the reason it is invalid, or `null` when it passes. Absent optional
 * fields pass; a present field of the wrong type does not, because a tool that
 * receives `filePath: 42` fails somewhere less legible than here.
 */
export function validateArguments(
  schema: IdeToolSchema,
  args: unknown
): string | null {
  if (args !== undefined && (typeof args !== "object" || args === null)) {
    return "arguments must be an object";
  }
  const given = (args ?? {}) as Record<string, unknown>;
  for (const name of schema.required ?? []) {
    if (given[name] === undefined) return `missing required argument: ${name}`;
  }
  for (const [name, spec] of Object.entries(schema.properties)) {
    const value = given[name];
    if (value === undefined) continue;
    if (typeof value !== spec.type) {
      return `argument ${name} must be a ${spec.type}`;
    }
  }
  return null;
}

/**
 * Answer one JSON-RPC message addressed to the `ide` server.
 *
 * Never throws. A control channel that throws on an unexpected name is a turn
 * that dies for a reason the user cannot act on — the reference throws here and
 * we deliberately do not.
 *
 * @param serverName the `server_name` off the control request. Anything but
 *   `ide` is a server we never declared, and gets an error rather than silence.
 * @returns the response to put inside `mcp_response`.
 */
export async function handleIdeMcpMessage(
  serverName: string | undefined,
  message: JsonRpcMessage | undefined,
  ops: IdeToolOps | undefined
): Promise<JsonRpcResponse> {
  const id = message?.id;
  // A notification: no id to answer, so the ack is all there is to send.
  if (id === undefined || id === null) return MCP_NOTIFICATION_ACK;

  if (serverName !== IDE_SERVER_NAME) {
    return fail(id, METHOD_NOT_FOUND, `Unknown MCP server: ${serverName}`);
  }
  const method = message?.method;
  if (typeof method !== "string") {
    return fail(id, PARSE_INVALID_REQUEST, "Missing method");
  }

  if (method === "initialize") {
    const asked = (message?.params as { protocolVersion?: unknown } | undefined)
      ?.protocolVersion;
    return ok(id, {
      protocolVersion:
        typeof asked === "string" ? asked : FALLBACK_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: IDE_SERVER_NAME, version: "1.0.0" }
    });
  }

  if (method === "tools/list") {
    return ok(id, {
      tools: IDE_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema
      }))
    });
  }

  if (method === "tools/call") {
    const params = (message?.params ?? {}) as {
      name?: unknown;
      arguments?: unknown;
    };
    const def = IDE_TOOLS.find((t) => t.name === params.name);
    if (!def) {
      return fail(id, METHOD_NOT_FOUND, `Unknown tool: ${String(params.name)}`);
    }
    const invalid = validateArguments(def.inputSchema, params.arguments);
    if (invalid) return fail(id, INVALID_PARAMS, invalid);
    // The ops map is a union of differently-shaped signatures, so it cannot be
    // called through its own type. The cast is safe by construction: the
    // schema that just passed is the same one `IdeToolArgs` mirrors.
    const op = ops?.[def.name] as
      ((args: Record<string, unknown>) => Promise<IdeToolResult>) | undefined;
    if (!op) {
      return fail(
        id,
        INTERNAL_ERROR,
        `Tool ${def.name} has no implementation in this host`
      );
    }
    try {
      return ok(
        id,
        await op((params.arguments ?? {}) as Record<string, unknown>)
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(id, INTERNAL_ERROR, msg);
    }
  }

  return fail(id, METHOD_NOT_FOUND, `Unknown method: ${method}`);
}
