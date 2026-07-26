import { describe, it, expect, vi } from "vitest";

// stdio-client imports types from storage/client (erased at runtime), but stub
// vscode defensively in case the bundler keeps the import.
vi.mock("vscode", () => ({}));

import { StdioMcpClient } from "../../src/services/mcp/stdio-client.js";

// A minimal MCP server that speaks JSON-RPC over stdio (newline-framed),
// run via `node -e`. The only escaped sequence is the trailing "\n" the
// server writes after each response (so node parses it as a newline).
const SERVER = `
const rl = require("readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg; try { msg = JSON.parse(t); } catch { return; }
  if (msg.id === undefined) return; // notifications carry no id
  let result;
  if (msg.method === "initialize")
    result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "test-stdio", version: "1" } };
  else if (msg.method === "tools/list")
    result = { tools: [{ name: "echo", description: "echo tool" }] };
  else if (msg.method === "tools/call")
    result = { content: [{ type: "text", text: "called " + msg.params.name }] };
  else return;
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
});
`;

function client() {
  return new StdioMcpClient({
    command: process.execPath, // the node binary running vitest
    args: ["-e", SERVER],
    timeoutMs: 5000
  });
}

describe("StdioMcpClient", () => {
  it("initializes and lists tools", async () => {
    const { info, tools } = await client().connectAndList();
    expect(info.serverInfo?.name).toBe("test-stdio");
    expect(tools.map((t) => t.name)).toEqual(["echo"]);
  });

  it("calls a tool and returns its content", async () => {
    const res = await client().callTool("echo", { hi: true });
    expect(res.content[0]).toMatchObject({ type: "text", text: "called echo" });
  });

  it("rejects when the command cannot be spawned", async () => {
    const bad = new StdioMcpClient({
      command: "luno-nonexistent-binary-zzz",
      timeoutMs: 2000
    });
    await expect(bad.connectAndList()).rejects.toThrow();
  });
});
