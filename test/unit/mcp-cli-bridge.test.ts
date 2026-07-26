import { describe, it, expect, vi } from "vitest";

// index.ts imports `* as vscode` (and transitively oauth/client/storage).
vi.mock("vscode", () => ({}));

import { toCliServerEntry } from "../../src/services/mcp/index.js";

// Verifies the connector → `--mcp-config` entry mapping that Claude Code's
// CLI consumes. The CLI's format is `{type:"http"|"sse", url, headers}` for
// remote and `{type:"stdio", command, args?, env?}` for local servers.
describe("toCliServerEntry", () => {
  it("maps a streamable-http server with a bearer token", () => {
    expect(
      toCliServerEntry({ transport: "streamable-http", url: "https://h/mcp" }, "tok")
    ).toEqual({
      type: "http",
      url: "https://h/mcp",
      headers: { Authorization: "Bearer tok" }
    });
  });

  it("maps an sse server", () => {
    expect(toCliServerEntry({ transport: "sse", url: "https://h/sse" }, "t")).toMatchObject({
      type: "sse",
      url: "https://h/sse"
    });
  });

  it("maps a stdio server with args and env", () => {
    expect(
      toCliServerEntry({
        transport: "stdio",
        command: "npx",
        args: ["-y", "@scope/server"],
        env: { API_KEY: "V" }
      })
    ).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@scope/server"],
      env: { API_KEY: "V" }
    });
  });

  it("omits empty args/env on stdio entries", () => {
    expect(toCliServerEntry({ transport: "stdio", command: "x", args: [], env: {} })).toEqual({
      type: "stdio",
      command: "x"
    });
  });

  it("returns null for remote without a url and stdio without a command", () => {
    expect(toCliServerEntry({ transport: "streamable-http" })).toBeNull();
    expect(toCliServerEntry({ transport: "stdio" })).toBeNull();
  });
});
