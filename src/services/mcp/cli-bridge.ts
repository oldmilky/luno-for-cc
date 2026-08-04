// The CLI bridge, split out of `index.ts`: it shares nothing with the
// connector registry above it but `resolveConfig`, and it is the one part of
// this module the CLI itself consumes rather than the panel.
// ─────────────────────────────────────────────────────────────
// CLI bridge — write Luno's own connected servers into a temp file
// the Claude Code CLI consumes via `--mcp-config <path>`.
//
// The CLI's MCP config format (identical to ~/.claude.json / .mcp.json):
//
//   { "mcpServers": {
//       "<name>": { "type":"http"|"sse", "url":"…", "headers":{…} }   // remote
//       "<name>": { "type":"stdio", "command":"…", "args":[…], "env":{…} } // local
//   } }
//
// We materialize ONLY Luno's own connected connectors here. Servers the
// user already configured in Claude Code (~/.claude.json + .mcp.json) are
// NOT re-emitted — the CLI loads them itself (we don't pass
// `--strict-mcp-config`) and re-listing would double-register them. We do,
// however, return their names in `serverNames` so their tools get pre-allowed
// alongside ours. The file is written to OS temp with mode 0600 because it
// holds bearer tokens; the caller calls `cleanup()` after the CLI exits.
// ─────────────────────────────────────────────────────────────


import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { IDE_SERVER_NAME } from "../../core/ide-tools.js";
import { loadManagedServers } from "./cli-config.js";
import {
  McpTransport,
  loadConnections,
  loadStdioEnv,
  loadTokens
} from "./storage.js";
import { resolveConfig } from "./config-resolve.js";
import { cliConnectedServerNames } from "./index.js";

/** A single server entry in the CLI's `mcpServers` map. */
export type CliServerEntry =
  | { type: "http" | "sse"; url: string; headers: Record<string, string> }
  | {
      type: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  /** In-process: no transport at all. The CLI drives it by sending
   *  `mcp_message` control requests down the stdin it already holds. */
  | { type: "sdk"; name: string };

export interface CliMcpConfig {
  /** Absolute path to the JSON config; pass via `--mcp-config`. Undefined when
   *  Luno has no own connectors to write (managed servers still pre-allowed). */
  path?: string;
  /** Server names to pre-allow as `mcp__<name>` — Luno's own + Claude Code's. */
  serverNames: string[];
  /** Best-effort cleanup helper. */
  cleanup: () => Promise<void>;
}

/**
 * Map a resolved connector config + (for remote) its access token into the
 * CLI's server-entry shape. Pure — returns null for shapes we can't emit
 * (remote with no url, stdio with no command). Exported for unit tests.
 */
export function toCliServerEntry(
  config: {
    transport: McpTransport;
    url?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
  },
  accessToken?: string
): CliServerEntry | null {
  if (config.transport === "stdio") {
    if (!config.command) return null;
    const entry: CliServerEntry = { type: "stdio", command: config.command };
    if (config.args && config.args.length) entry.args = config.args;
    if (config.env && Object.keys(config.env).length) entry.env = config.env;
    return entry;
  }
  if (!config.url) return null;
  return {
    type: config.transport === "sse" ? "sse" : "http",
    url: config.url,
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {}
  };
}

/**
 * Materialize a Claude-CLI-compatible `--mcp-config` file for Luno's own
 * connected connectors, and gather the full pre-allow name list (own +
 * Claude-Code-managed). Returns `null` only when there's nothing at all —
 * no own connectors AND no managed servers.
 */
export async function writeCliMcpConfig(
  ctx: vscode.ExtensionContext
): Promise<CliMcpConfig | null> {
  const conns = loadConnections(ctx);
  const cwd = vscode.workspace?.workspaceFolders?.[0]?.uri?.fsPath;

  // Luno's own connected connectors → file entries.
  const own: Array<{ name: string; entry: CliServerEntry }> = [];
  for (const rec of Object.values(conns)) {
    if (rec.status !== "connected") continue;
    const config = resolveConfig(ctx, rec.id);
    if (!config) continue;
    let accessToken: string | undefined;
    let env: Record<string, string> | undefined;
    if (config.transport === "stdio") {
      env = await loadStdioEnv(ctx, rec.id); // secrets, not globalState
    } else {
      const tokens = await loadTokens(ctx, rec.id);
      if (!tokens.accessToken) continue; // remote without a token — skip
      accessToken = tokens.accessToken;
    }
    const entry = toCliServerEntry({ ...config, env }, accessToken);
    if (entry) own.push({ name: cliServerName(rec.id), entry });
  }

  // Servers Claude Code already manages → names only (CLI loads them itself).
  // Sanitize through the same transform the CLI applies when it builds tool
  // ids (`mcp__<namespace>__<tool>`); otherwise a managed server whose config
  // key has a dot/space/etc. would be pre-allowed under the wrong name and its
  // tools would stay gated.
  const ownNames = new Set(own.map((o) => o.name));
  const managedNames = loadManagedServers(cwd)
    .map((s) => cliToolNamespace(s.name))
    .filter((n) => !ownNames.has(n));

  // claude.ai / plugin connectors the user authorized through Claude Code's
  // `/mcp` (from the cached `claude mcp list`). The CLI loads them itself; we
  // only pre-allow their tools so they don't trip a permission prompt.
  const cliConnectedNames = cliConnectedServerNames().map(cliToolNamespace);

  // dedupe: the same name can appear at multiple scopes (e.g. figma at user +
  // local) but the CLI exposes one `mcp__<name>` namespace either way.
  const serverNames = [
    ...new Set([
      ...own.map((o) => o.name),
      ...managedNames,
      ...cliConnectedNames
    ])
  ];

  const mcpServers: Record<string, CliServerEntry> = {};
  for (const o of own) mcpServers[o.name] = o.entry;
  // The editor server is always declared, whether or not the user has a single
  // connector: these tools are ours, not something they connected. It is
  // deliberately absent from `serverNames` — those become one blanket
  // `mcp__<name>` pre-allow, and this one goes in per tool instead. See
  // `ideAllowedToolPatterns()`.
  //
  // Written last so that a user connector sanitizing to the same name loses.
  // The other order fails worse than it looks: `ideAllowedToolPatterns()` names
  // this namespace literally, so a foreign server holding it would inherit an
  // allowlist entry meant for us — a permission bug, not a missing feature.
  mcpServers[IDE_SERVER_NAME] = { type: "sdk", name: IDE_SERVER_NAME };

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "luno-mcp-"));
  const file = path.join(dir, "mcp.json");
  // Mode 0600 so the file with bearer tokens is readable only by us.
  await fs.writeFile(file, JSON.stringify({ mcpServers }, null, 2), {
    mode: 0o600
  });

  return {
    path: file,
    serverNames,
    cleanup: async () => {
      try {
        await fs.unlink(file);
        await fs.rmdir(dir);
      } catch {
        // best-effort: tmpdir cleanup will handle stragglers
      }
    }
  };
}

/**
 * Sanitize a connector id into a CLI-safe server name. The Claude CLI
 * exposes tools as `mcp__<name>__<tool>`, so the name needs to round-trip
 * through that pattern cleanly.
 */
export function cliServerName(id: string): string {
  // Keep alphanum + underscore + hyphen; collapse everything else.
  const cleaned = cliToolNamespace(id).slice(0, 48);
  return cleaned || `connector_${crypto.randomBytes(3).toString("hex")}`;
}

/**
 * The exact transform the Claude Code CLI applies to a server name when it
 * derives tool ids `mcp__<namespace>__<tool>` (it replaces every char outside
 * `[A-Za-z0-9_-]` with `_`, with no truncation). We use this to sanitize the
 * names of *imported* servers so our `mcp__<name>` pre-allow patterns line up
 * with the ids the CLI actually generates. `cliServerName` adds a length cap
 * and random fallback on top, for names we materialize into the config file.
 */
export function cliToolNamespace(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}
