import { describe, it, expect } from "vitest";
import { CURATED_CATALOG, findCatalog } from "../../src/services/mcp/catalog.js";

describe("mcp catalog", () => {
  it("findCatalog returns the entry for a known id", () => {
    const first = CURATED_CATALOG[0];
    expect(findCatalog(first.id)).toBe(first);
  });

  it("findCatalog returns undefined for an unknown id", () => {
    expect(findCatalog("__definitely-not-a-connector__")).toBeUndefined();
  });

  it("has no duplicate connector ids", () => {
    const ids = CURATED_CATALOG.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses https endpoints for every remote connector", () => {
    for (const c of CURATED_CATALOG) {
      if (c.transport === "stdio") continue; // local presets have no url
      expect(c.url?.startsWith("https://"), `${c.id} url should be https`).toBe(true);
    }
  });

  it("every entry has the required display fields", () => {
    for (const c of CURATED_CATALOG) {
      expect(c.id, "id").toBeTruthy();
      expect(c.name, `${c.id} name`).toBeTruthy();
      expect(
        ["streamable-http", "sse", "stdio"].includes(c.transport),
        `${c.id} transport`
      ).toBe(true);
      expect(Array.isArray(c.categories)).toBe(true);
    }
  });

  it("stdio presets carry a command (and apiKeyEnv if they need a token)", () => {
    for (const c of CURATED_CATALOG) {
      if (c.transport !== "stdio") continue;
      expect(c.command, `${c.id} command`).toBeTruthy();
    }
  });

  it("derives transport consistently with the URL path (sse endpoints)", () => {
    for (const c of CURATED_CATALOG) {
      if (c.url && /\/sse$/i.test(new URL(c.url).pathname)) {
        expect(c.transport, `${c.id} ends in /sse`).toBe("sse");
      }
    }
  });

  it("Figma authenticates through Claude Code (vendor blocks third-party OAuth)", () => {
    const figma = findCatalog("figma");
    expect(figma, "figma should be in the catalog").toBeTruthy();
    expect(figma?.requiresClaudeCodeAuth).toBe(true);
    expect(figma?.url).toBe("https://mcp.figma.com/mcp");
  });

  it("Canva and monday remain DCR-capable remote connectors", () => {
    expect(findCatalog("canva")?.transport).toBe("streamable-http");
    expect(findCatalog("monday")?.requiresClaudeCodeAuth).toBeFalsy();
  });
});
