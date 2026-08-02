import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs/promises";

// The config writer reaches for the workspace folders and, through storage.ts,
// for the extension context. Neither exists under `node`, and neither is what
// this file is about — the `ide` entry is written whatever they say.
vi.mock("vscode", () => ({
  workspace: { workspaceFolders: undefined }
}));
vi.mock("../../src/services/mcp/cli-config.js", async (orig) => ({
  ...(await (orig() as Promise<Record<string, unknown>>)),
  loadManagedServers: () => []
}));

import { writeCliMcpConfig } from "../../src/services/mcp/index.js";
import { IDE_SERVER_NAME } from "../../src/core/ide-tools.js";

/** An extension context with nothing stored — the shape a user who has never
 *  opened the Connectors page actually has. */
const emptyCtx = {
  globalState: { get: (_k: string, fallback: unknown) => fallback }
} as never;

describe("writeCliMcpConfig — the editor server", () => {
  const written: string[] = [];
  afterEach(async () => {
    for (const f of written.splice(0)) {
      await fs.unlink(f).catch(() => undefined);
    }
  });

  it("declares it even when the user has no connectors at all", async () => {
    const config = await writeCliMcpConfig(emptyCtx);
    expect(config?.path).toBeDefined();
    written.push(config!.path!);

    const file = JSON.parse(await fs.readFile(config!.path!, "utf8"));
    expect(file.mcpServers[IDE_SERVER_NAME]).toEqual({
      type: "sdk",
      name: IDE_SERVER_NAME
    });

    await config!.cleanup();
    written.splice(0);
  });

  it("keeps it out of serverNames, so no blanket mcp__<name> is pre-allowed", async () => {
    // The names in here become one `mcp__<name>` each. The editor server earns
    // its pre-allow per tool instead, because saveDocument and
    // getWorkspaceFolders do not weigh the same.
    const config = await writeCliMcpConfig(emptyCtx);
    if (config?.path) written.push(config.path);
    expect(config?.serverNames ?? []).not.toContain(IDE_SERVER_NAME);
  });
});
