import { describe, it, expect, vi } from "vitest";

// index.ts imports `* as vscode` (and transitively oauth/client/storage).
vi.mock("vscode", () => ({}));

import {
  slugify,
  cliServerName,
  cliToolNamespace,
  deriveConnectorId,
  parseManagedId
} from "../../src/services/mcp/index.js";

describe("slugify (custom connector id prefix)", () => {
  it("lowercases and hyphenates non-alphanumerics", () => {
    expect(slugify("My Server!!")).toBe("my-server");
    expect(slugify("  Hello World  ")).toBe("hello-world");
  });
  it("falls back to 'connector' for an empty result", () => {
    expect(slugify("")).toBe("connector");
    expect(slugify("***")).toBe("connector");
  });
  it("caps the length at 24 chars", () => {
    expect(slugify("a".repeat(50)).length).toBe(24);
  });
});

describe("cliServerName (mcp__<name>__<tool> safety)", () => {
  it("passes through clean ids unchanged", () => {
    expect(cliServerName("linear")).toBe("linear");
    expect(cliServerName("my_server-1")).toBe("my_server-1");
  });
  it("replaces unsafe characters with underscores", () => {
    expect(cliServerName("a.b/c")).toBe("a_b_c");
  });
  it("caps the length at 48 chars", () => {
    expect(cliServerName("x".repeat(60)).length).toBe(48);
  });
});

// Fix for audit finding #3: imported (managed) server names must be pre-allowed
// under the SAME namespace the CLI derives for `mcp__<namespace>__<tool>`, i.e.
// every non [A-Za-z0-9_-] char replaced with "_" (no truncation). Otherwise a
// server whose config key has a dot/space stays gated.
describe("cliToolNamespace (CLI mcp__<namespace>__<tool> parity)", () => {
  it("replaces non [A-Za-z0-9_-] chars with underscores", () => {
    expect(cliToolNamespace("my.server")).toBe("my_server");
    expect(cliToolNamespace("team server")).toBe("team_server");
    expect(cliToolNamespace("a/b:c")).toBe("a_b_c");
  });
  it("passes clean names through unchanged and does not truncate", () => {
    expect(cliToolNamespace("figma")).toBe("figma");
    expect(cliToolNamespace("a_b-c")).toBe("a_b-c");
    expect(cliToolNamespace("x".repeat(60))).toHaveLength(60);
  });
});

describe("parseManagedId (managed:<scope>:<name>)", () => {
  it("splits scope and name", () => {
    expect(parseManagedId("managed:user:figma")).toEqual({ scope: "user", name: "figma" });
    expect(parseManagedId("managed:local:my-server")).toEqual({ scope: "local", name: "my-server" });
  });
  it("keeps a name that itself contains colons", () => {
    expect(parseManagedId("managed:project:plugin:figma:figma")).toEqual({
      scope: "project",
      name: "plugin:figma:figma"
    });
  });
  it("returns null for non-managed or unknown-scope ids", () => {
    expect(parseManagedId("linear")).toBeNull();
    expect(parseManagedId("managed:bogus:x")).toBeNull();
  });
});

// Fix for audit finding #6: the old id was `slugify(name)-<host>`, which
// ignored the URL path — so two servers with the same name + host but
// different paths (`/mcp` vs `/sse`) collapsed to one id and the second save
// silently overwrote the first. `deriveConnectorId` now folds the full
// discriminator (URL incl. path, or command+args) into a short hash.
describe("deriveConnectorId (fix #6 — no same-host path collision)", () => {
  // Mirrors how addCustom builds the remote discriminator.
  const remoteId = (name: string, url: string) => {
    const u = new URL(url);
    const transport = /sse$/i.test(u.pathname) ? "sse" : "streamable-http";
    return deriveConnectorId(name, `${transport}:${u.toString()}`);
  };

  it("produces DISTINCT ids for different paths on the same host", () => {
    const a = remoteId("My Server", "https://example.com/mcp");
    const b = remoteId("My Server", "https://example.com/sse");
    expect(a).not.toBe(b);
  });

  it("is stable for the same name + url", () => {
    expect(remoteId("My Server", "https://example.com/mcp")).toBe(
      remoteId("My Server", "https://example.com/mcp")
    );
  });

  it("prefixes the slugified name and appends an 8-char hex hash", () => {
    expect(deriveConnectorId("My Server", "x")).toMatch(/^my-server-[0-9a-f]{8}$/);
  });

  it("distinguishes stdio servers that differ only by args", () => {
    const a = deriveConnectorId("fs", "stdio:npx -y server /a");
    const b = deriveConnectorId("fs", "stdio:npx -y server /b");
    expect(a).not.toBe(b);
  });
});
