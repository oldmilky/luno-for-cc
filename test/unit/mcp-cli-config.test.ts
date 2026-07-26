import { describe, it, expect, vi } from "vitest";

// cli-config imports a type from storage.ts which imports `* as vscode`.
vi.mock("vscode", () => ({}));

import {
  parseManagedServers,
  parseClaudeMcpList,
  endpointMatchesUrl
} from "../../src/services/mcp/cli-config.js";

describe("parseManagedServers (import Claude Code's own MCP servers)", () => {
  it("reads user (global), project (.mcp.json), and local (per-project) scopes", () => {
    const claudeJson = {
      mcpServers: {
        figma: {
          type: "http",
          url: "https://mcp.figma.com/mcp",
          headers: { Authorization: "Bearer secret" }
        }
      },
      projects: {
        "/work/app": {
          mcpServers: { localdb: { command: "node", args: ["db.js"] } }
        }
      }
    };
    const projectMcpJson = {
      mcpServers: { team: { type: "sse", url: "https://team.example.com/sse" } }
    };

    const servers = parseManagedServers({ claudeJson, projectMcpJson, cwd: "/work/app" });
    const byName = Object.fromEntries(servers.map((s) => [s.name, s]));

    expect(byName.figma).toMatchObject({
      transport: "streamable-http",
      scope: "user",
      url: "https://mcp.figma.com/mcp"
    });
    expect(byName.team).toMatchObject({ transport: "sse", scope: "project" });
    expect(byName.localdb).toMatchObject({
      transport: "stdio",
      scope: "local",
      command: "node",
      args: ["db.js"]
    });
  });

  it("maps explicit http / streamable-http / sse types", () => {
    const servers = parseManagedServers({
      claudeJson: {
        mcpServers: {
          a: { type: "http", url: "https://h.com/mcp" },
          b: { type: "streamable-http", url: "https://h.com/x" },
          c: { type: "sse", url: "https://h.com/s" }
        }
      }
    });
    const byName = Object.fromEntries(servers.map((s) => [s.name, s.transport]));
    expect(byName).toEqual({ a: "streamable-http", b: "streamable-http", c: "sse" });
  });

  it("captures remote headers and stdio env (used to fetch the tool list)", () => {
    const servers = parseManagedServers({
      claudeJson: {
        mcpServers: {
          fig: { type: "http", url: "https://h/mcp", headers: { Authorization: "Bearer x" } },
          loc: { command: "node", env: { API_KEY: "k" } }
        }
      }
    });
    const byName = Object.fromEntries(servers.map((s) => [s.name, s]));
    expect(byName.fig.headers).toEqual({ Authorization: "Bearer x" });
    expect(byName.loc.env).toEqual({ API_KEY: "k" });
  });

  it("ignores headers/env whose values aren't all strings", () => {
    const servers = parseManagedServers({
      claudeJson: {
        mcpServers: { x: { type: "http", url: "https://h/mcp", headers: { A: 1 } } }
      }
    });
    expect(servers[0].headers).toBeUndefined();
  });

  it("drops a remote entry with no explicit type (the CLI would reject it)", () => {
    // Url-only, no type — mirrors what `claude` v2.1.150 refuses to load, so we
    // don't surface a phantom 'connected' card for a server that won't run.
    expect(
      parseManagedServers({ claudeJson: { mcpServers: { x: { url: "https://h.com/sse" } } } })
    ).toEqual([]);
  });

  it("keeps the same name at different scopes as separate entries", () => {
    // The user can have a broken `figma` at user scope and a working one at
    // local scope — both must surface so each can be managed independently.
    const servers = parseManagedServers({
      claudeJson: {
        mcpServers: { figma: { type: "http", url: "https://global.example.com/mcp" } },
        projects: { "/p": { mcpServers: { figma: { command: "local-cmd" } } } }
      },
      cwd: "/p"
    });
    expect(servers).toHaveLength(2);
    expect(servers.map((s) => s.scope).sort()).toEqual(["local", "user"]);
    expect(servers.find((s) => s.scope === "local")).toMatchObject({
      transport: "stdio",
      command: "local-cmd"
    });
    expect(servers.find((s) => s.scope === "user")).toMatchObject({
      transport: "streamable-http"
    });
  });

  it("ignores unrecognized shapes and non-object input", () => {
    expect(parseManagedServers({})).toEqual([]);
    expect(parseManagedServers({ claudeJson: { mcpServers: { bad: {} } } })).toEqual([]);
    expect(parseManagedServers({ claudeJson: "garbage" as unknown })).toEqual([]);
    expect(parseManagedServers({ claudeJson: { mcpServers: null } })).toEqual([]);
  });
});

describe("parseClaudeMcpList (status from `claude mcp list`)", () => {
  const SAMPLE = [
    "Checking MCP server health…",
    "",
    "claude.ai Figma: https://mcp.figma.com/mcp - ✓ Connected",
    "claude.ai Slack: https://mcp.slack.com/mcp - ! Needs authentication",
    "plugin:figma:figma: https://mcp.figma.com/mcp (HTTP) - ! Needs authentication",
    "figma: npx -y figma-developer-mcp --stdio - ✓ Connected",
    "",
    "MCP Config Diagnostics",
    "Some diagnostic note without a status"
  ].join("\n");

  it("parses names (with spaces/colons), endpoints, and statuses", () => {
    const servers = parseClaudeMcpList(SAMPLE);
    const byName = Object.fromEntries(servers.map((s) => [s.name, s]));
    expect(byName["claude.ai Figma"]).toMatchObject({
      endpoint: "https://mcp.figma.com/mcp",
      status: "connected"
    });
    expect(byName["claude.ai Slack"].status).toBe("needs-auth");
    expect(byName["plugin:figma:figma"]).toMatchObject({
      endpoint: "https://mcp.figma.com/mcp (HTTP)",
      status: "needs-auth"
    });
    expect(byName["figma"]).toMatchObject({
      endpoint: "npx -y figma-developer-mcp --stdio",
      status: "connected"
    });
  });

  it("skips header and diagnostic lines (no recognizable status)", () => {
    const servers = parseClaudeMcpList(SAMPLE);
    expect(servers.map((s) => s.name)).not.toContain("Checking MCP server health…");
    expect(servers).toHaveLength(4);
  });

  it("returns empty for empty / unparseable output", () => {
    expect(parseClaudeMcpList("")).toEqual([]);
    expect(parseClaudeMcpList("no servers configured")).toEqual([]);
  });
});

describe("endpointMatchesUrl", () => {
  it("matches identical and (HTTP)-suffixed endpoints, ignoring trailing slash", () => {
    expect(endpointMatchesUrl("https://mcp.figma.com/mcp", "https://mcp.figma.com/mcp")).toBe(true);
    expect(endpointMatchesUrl("https://mcp.figma.com/mcp (HTTP)", "https://mcp.figma.com/mcp")).toBe(true);
    expect(endpointMatchesUrl("https://mcp.figma.com/mcp/", "https://mcp.figma.com/mcp")).toBe(true);
  });
  it("rejects different hosts/paths", () => {
    expect(endpointMatchesUrl("https://mcp.canva.com/mcp", "https://mcp.figma.com/mcp")).toBe(false);
    expect(endpointMatchesUrl("https://mcp.figma.com/other", "https://mcp.figma.com/mcp")).toBe(false);
  });
});
