import { describe, it, expect, vi } from "vitest";

// storage.ts imports `* as vscode` only for the ExtensionContext type; stub it
// so the module resolves in vitest's node environment (same pattern as
// history.test.ts).
vi.mock("vscode", () => ({}));

import {
  loadCustomConnectors,
  saveCustomConnector,
  removeCustomConnector,
  loadConnections,
  setConnectionRecord,
  clearConnectionRecord,
  saveTokens,
  loadTokens,
  deleteTokens,
  saveStdioEnv,
  loadStdioEnv,
  deleteStdioEnv,
  resolveConnector,
  CustomConnector,
  ConnectionRecord
} from "../../src/services/mcp/storage.js";
import { addCustom, removeCustom } from "../../src/services/mcp/index.js";

/** Minimal in-memory ExtensionContext double (globalState + secrets). */
function makeCtx(): any {
  const gs = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  return {
    globalState: {
      get: (k: string, d?: unknown) => (gs.has(k) ? gs.get(k) : d),
      update: async (k: string, v: unknown) => {
        gs.set(k, v);
      }
    },
    secrets: {
      get: async (k: string) => secrets.get(k),
      store: async (k: string, v: string) => {
        secrets.set(k, v);
      },
      delete: async (k: string) => {
        secrets.delete(k);
      }
    }
  };
}

const conn = (id: string, url = "https://example.com/mcp"): CustomConnector => ({
  id,
  name: id,
  url,
  transport: "streamable-http",
  description: ""
});

describe("custom connector storage", () => {
  it("round-trips a saved connector", async () => {
    const ctx = makeCtx();
    expect(loadCustomConnectors(ctx)).toEqual([]);
    await saveCustomConnector(ctx, conn("a"));
    expect(loadCustomConnectors(ctx).map((c) => c.id)).toEqual(["a"]);
  });

  it("replaces (dedupes) an existing connector with the same id", async () => {
    const ctx = makeCtx();
    await saveCustomConnector(ctx, conn("a", "https://one.com/mcp"));
    await saveCustomConnector(ctx, conn("a", "https://two.com/mcp"));
    const list = loadCustomConnectors(ctx);
    expect(list).toHaveLength(1);
    expect(list[0].url).toBe("https://two.com/mcp");
  });

  it("removes a connector by id", async () => {
    const ctx = makeCtx();
    await saveCustomConnector(ctx, conn("a"));
    await saveCustomConnector(ctx, conn("b"));
    await removeCustomConnector(ctx, "a");
    expect(loadCustomConnectors(ctx).map((c) => c.id)).toEqual(["b"]);
  });
});

describe("connection records", () => {
  it("stores, reads, and clears a connection record by id", async () => {
    const ctx = makeCtx();
    const rec: ConnectionRecord = { id: "linear", connectedAt: 1 } as ConnectionRecord;
    await setConnectionRecord(ctx, rec);
    expect(loadConnections(ctx).linear).toMatchObject({ id: "linear" });
    await clearConnectionRecord(ctx, "linear");
    expect(loadConnections(ctx).linear).toBeUndefined();
  });
});

describe("token keychain", () => {
  it("round-trips access / refresh / client secrets and deletes them", async () => {
    const ctx = makeCtx();
    await saveTokens(ctx, "linear", {
      accessToken: "at",
      refreshToken: "rt",
      clientSecret: "cs"
    });
    expect(await loadTokens(ctx, "linear")).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      clientSecret: "cs"
    });
    await deleteTokens(ctx, "linear");
    expect(await loadTokens(ctx, "linear")).toEqual({
      accessToken: undefined,
      refreshToken: undefined,
      clientSecret: undefined
    });
  });

  it("only writes the fields that are provided (partial save)", async () => {
    const ctx = makeCtx();
    await saveTokens(ctx, "x", { accessToken: "at" });
    const t = await loadTokens(ctx, "x");
    expect(t.accessToken).toBe("at");
    expect(t.refreshToken).toBeUndefined();
  });
});

describe("stdio env keychain (security #5 — secrets, not plaintext globalState)", () => {
  it("round-trips and deletes a stdio env blob via ctx.secrets", async () => {
    const ctx = makeCtx();
    await saveStdioEnv(ctx, "srv", { API_KEY: "sk-123", OTHER: "v" });
    expect(await loadStdioEnv(ctx, "srv")).toEqual({ API_KEY: "sk-123", OTHER: "v" });
    await deleteStdioEnv(ctx, "srv");
    expect(await loadStdioEnv(ctx, "srv")).toBeUndefined();
  });

  it("returns undefined when nothing is stored", async () => {
    expect(await loadStdioEnv(makeCtx(), "nope")).toBeUndefined();
  });

  it("addCustom(stdio) stores env values in secrets, NOT in the globalState record", async () => {
    const ctx = makeCtx();
    const view = await addCustom(ctx, {
      name: "Local FS",
      kind: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      env: { API_KEY: "sk-secret" }
    });
    // The persisted connector record must not carry the secret value.
    const saved = loadCustomConnectors(ctx).find((c) => c.id === view.id)!;
    expect(JSON.stringify(saved)).not.toContain("sk-secret");
    expect((saved as Record<string, unknown>).env).toBeUndefined();
    // …but it must be retrievable from the keychain.
    expect(await loadStdioEnv(ctx, view.id)).toEqual({ API_KEY: "sk-secret" });
  });

  it("removeCustom wipes the stdio env secret", async () => {
    const ctx = makeCtx();
    const view = await addCustom(ctx, {
      name: "Local FS",
      kind: "stdio",
      command: "npx",
      env: { API_KEY: "sk-secret" }
    });
    expect(await loadStdioEnv(ctx, view.id)).toBeDefined();
    await removeCustom(ctx, view.id);
    expect(await loadStdioEnv(ctx, view.id)).toBeUndefined();
    expect(loadCustomConnectors(ctx).find((c) => c.id === view.id)).toBeUndefined();
  });
});

describe("resolveConnector", () => {
  const catalog = [
    { id: "linear", name: "Linear", url: "https://mcp.linear.app/mcp" }
  ] as any;

  it("resolves a built-in catalog id", () => {
    const r = resolveConnector(makeCtx(), "linear", catalog);
    expect(r?.id).toBe("linear");
  });

  it("resolves a custom connector id", async () => {
    const ctx = makeCtx();
    await saveCustomConnector(ctx, conn("custom-1"));
    const r = resolveConnector(ctx, "custom-1", catalog) as any;
    expect(r?.id).toBe("custom-1");
    expect(r?.builtIn).toBe(false);
  });

  it("returns null for an unknown id", () => {
    expect(resolveConnector(makeCtx(), "nope", catalog)).toBeNull();
  });
});
