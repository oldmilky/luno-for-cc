// ─────────────────────────────────────────────────────────────
// Which connector a stored id actually is.
//
// A connected server is remembered by id alone, and that id resolves two
// different ways: against the curated catalog for a built-in, or against the
// user's own custom entries. Both the connect paths and the CLI bridge need
// the answer, and neither should know which of the two it got — which is why
// a custom connector is presented as a `CatalogEntry` rather than as its own
// shape.
// ─────────────────────────────────────────────────────────────

import * as vscode from "vscode";
import { CURATED_CATALOG, CatalogEntry } from "./catalog.js";
import { CustomConnector, loadCustomConnectors } from "./storage.js";

export function customAsCatalog(c: CustomConnector): CatalogEntry {
  if (c.transport === "stdio") {
    return {
      id: c.id,
      name: c.name,
      vendor: "local",
      description:
        c.description ?? `Local MCP server: ${commandLine(c.command, c.args)}`,
      transport: "stdio",
      categories: ["custom", "local"],
      icon: "terminal",
      command: c.command,
      args: c.args,
      builtIn: false
    };
  }
  return {
    id: c.id,
    name: c.name,
    vendor: c.url ? new URL(c.url).host : "custom",
    description: c.description ?? `Custom MCP server at ${c.url ?? "?"}`,
    url: c.url,
    transport: c.transport,
    categories: ["custom"],
    icon: "cloud",
    builtIn: false
  };
}

/** Render a stdio command + args into a single display string. */
export function commandLine(command?: string, args?: string[]): string {
  return [command ?? "", ...(args ?? [])].join(" ").trim();
}



export function findCatalog(id: string): CatalogEntry | undefined {
  return CURATED_CATALOG.find((c) => c.id === id);
}

export function resolveConfig(
  ctx: vscode.ExtensionContext,
  id: string
): CatalogEntry | null {
  const builtin = findCatalog(id);
  if (builtin) return builtin;
  const custom = loadCustomConnectors(ctx).find((c) => c.id === id);
  if (!custom) return null;
  return customAsCatalog(custom);
}

