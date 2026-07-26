// ─────────────────────────────────────────────────────────────
// Import MCP servers the user already configured in Claude Code.
//
// Claude Code keeps MCP servers in three places, all of which the CLI
// loads automatically for a given working directory:
//
//   • ~/.claude.json  → top-level `mcpServers`         (scope: user/global)
//   • ~/.claude.json  → `projects[<cwd>].mcpServers`   (scope: local)
//   • <cwd>/.mcp.json → `mcpServers`                   (scope: project)
//
// Because Luno spawns the CLI *without* `--strict-mcp-config`, the CLI
// already merges these in on its own. So we don't re-emit them into our
// `--mcp-config` file (that would double-register them). We only:
//
//   1. surface them in the Connectors UI ("Managed by Claude Code") so the
//      user can see the full picture, and
//   2. hand their names to the pre-allow list (`mcp__<name>`) so their tools
//      don't trip a permission prompt in auto / default mode.
//
// The parsing half (`parseManagedServers`) is pure and unit-tested; the IO
// half (`loadManagedServers`) reads the files and delegates to it.
// ─────────────────────────────────────────────────────────────

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { McpTransport } from "./storage.js";

/** Where a managed server was configured — mirrors `claude mcp add --scope`. */
export type ManagedScope = "user" | "project" | "local";

/** A server Luno found in Claude Code's own config (read-only here). */
export interface ManagedServer {
  /** Config key — this is the `<name>` in the CLI's `mcp__<name>__<tool>`. */
  name: string;
  transport: McpTransport;
  /** Remote endpoint (http/sse). */
  url?: string;
  /** Remote auth/custom headers as stored by Claude Code (contains secrets —
   *  used to fetch the tool list, never surfaced to the webview). */
  headers?: Record<string, string>;
  /** stdio command. */
  command?: string;
  /** stdio args. */
  args?: string[];
  /** stdio env (contains secrets — used to spawn, never surfaced to webview). */
  env?: Record<string, string>;
  scope: ManagedScope;
}

/** The raw per-server spec as it appears in Claude Code's JSON. */
interface RawServerSpec {
  type?: string;
  transport?: string;
  url?: string;
  command?: string;
  args?: unknown;
  env?: unknown;
  headers?: unknown;
}

/**
 * Normalize Claude Code's three config sources into a deduped list. Higher
 * specificity wins on a name clash: local (project-local in ~/.claude.json)
 * > project (.mcp.json) > user (global). Pure — feed it parsed JSON.
 */
export function parseManagedServers(input: {
  /** Parsed contents of ~/.claude.json (or null/undefined if absent). */
  claudeJson?: unknown;
  /** Parsed contents of <cwd>/.mcp.json (or null/undefined if absent). */
  projectMcpJson?: unknown;
  /** Absolute workspace path, used to key into `projects` in ~/.claude.json. */
  cwd?: string;
}): ManagedServer[] {
  const { claudeJson, projectMcpJson, cwd } = input;
  // Keyed by `<scope>:<name>` so the SAME name at different scopes is kept as a
  // separate entry — Claude Code can hold e.g. a broken `figma` at user scope
  // and a working one at local scope, and the user needs to see/remove each
  // independently (each scope is removed via `claude mcp remove -s <scope>`).
  const byKey = new Map<string, ManagedServer>();

  const ingest = (servers: unknown, scope: ManagedScope) => {
    if (!servers || typeof servers !== "object") return;
    for (const [name, raw] of Object.entries(
      servers as Record<string, unknown>
    )) {
      const server = normalizeServer(name, raw as RawServerSpec, scope);
      if (server) byKey.set(`${scope}:${name}`, server);
    }
  };

  const cj = asObject(claudeJson);
  ingest(cj?.mcpServers, "user"); // global
  ingest(asObject(projectMcpJson)?.mcpServers, "project"); // .mcp.json
  if (cwd) {
    // local: this project's entry inside ~/.claude.json
    const entry = asObject(asObject(cj?.projects)?.[cwd]);
    ingest(entry?.mcpServers, "local");
  }

  return [...byKey.values()];
}

function normalizeServer(
  name: string,
  raw: RawServerSpec,
  scope: ManagedScope
): ManagedServer | null {
  if (!name || !raw || typeof raw !== "object") return null;

  // stdio: identified by a `command`.
  if (typeof raw.command === "string" && raw.command) {
    return {
      name,
      transport: "stdio",
      command: raw.command,
      args: Array.isArray(raw.args) ? raw.args.map(String) : undefined,
      env: isStringRecord(raw.env)
        ? (raw.env as Record<string, string>)
        : undefined,
      scope
    };
  }

  // remote: needs a url AND an explicit transport. The Claude Code CLI's config
  // schema requires `type` on every remote entry (only stdio infers it from
  // `command`), so a url-only entry is one the CLI itself would reject — we
  // skip it rather than surface a phantom "connected" card the CLI won't load.
  if (typeof raw.url === "string" && raw.url) {
    const declared = (raw.type ?? raw.transport ?? "").toLowerCase();
    const headers = isStringRecord(raw.headers)
      ? (raw.headers as Record<string, string>)
      : undefined;
    if (declared === "sse") {
      return { name, transport: "sse", url: raw.url, headers, scope };
    }
    if (
      declared === "http" ||
      declared === "streamable-http" ||
      declared === "streamablehttp"
    ) {
      return {
        name,
        transport: "streamable-http",
        url: raw.url,
        headers,
        scope
      };
    }
    return null; // no recognized type — CLI wouldn't load it
  }

  return null; // unrecognized shape — skip rather than guess
}

/** True for a plain object whose values are all strings (headers / env maps). */
function isStringRecord(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every(
    (x) => typeof x === "string"
  );
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * Read Claude Code's config files and return the managed servers for `cwd`.
 * Never throws — a missing/garbage file yields an empty list.
 */
export function loadManagedServers(cwd?: string): ManagedServer[] {
  const claudeJson = readJsonSafe(path.join(os.homedir(), ".claude.json"));
  const projectMcpJson = cwd
    ? readJsonSafe(path.join(cwd, ".mcp.json"))
    : undefined;
  return parseManagedServers({ claudeJson, projectMcpJson, cwd });
}

function readJsonSafe(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

// ── `claude mcp list` status (the only place claude.ai connectors live) ──────
//
// claude.ai's first-party connectors (Figma, Notion, …) and plugin servers
// aren't written to ~/.claude.json — they're synced to the user's account and
// only surfaced via `claude mcp list`. We never read Claude Code's token store
// (that's its job); instead we parse the supported list command's output to
// learn which servers are connected, so a connector the user authorized through
// Claude Code's `/mcp` flow can flip to "connected" in Luno.

export type CliServerStatus = "connected" | "needs-auth" | "pending" | "failed";

export interface CliMcpServer {
  /** Display name as printed by the CLI (e.g. "claude.ai Figma"). */
  name: string;
  /** URL or command string. */
  endpoint: string;
  status: CliServerStatus;
}

/**
 * Parse `claude mcp list` output. Each server prints as
 *   `<name>: <endpoint> - <status>`
 * where status begins with a glyph (✓ Connected, ! Needs authentication, …).
 * Header/diagnostic lines have no recognizable status and are skipped. Pure.
 */
export function parseClaudeMcpList(stdout: string): CliMcpServer[] {
  const out: CliMcpServer[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(.+?):\s+(.+?)\s+-\s+(.+)$/.exec(line);
    if (!m) continue;
    const st = m[3].toLowerCase();
    let status: CliServerStatus;
    if (st.includes("✓") || /\bconnected\b/.test(st)) status = "connected";
    else if (st.includes("needs") && st.includes("auth")) status = "needs-auth";
    else if (st.includes("pending")) status = "pending";
    else if (st.includes("✗") || st.includes("fail") || st.includes("error"))
      status = "failed";
    else continue; // unrecognized → not a server line
    out.push({ name: m[1].trim(), endpoint: m[2].trim(), status });
  }
  return out;
}

/** Does a `claude mcp list` endpoint refer to the same server as `url`? */
export function endpointMatchesUrl(endpoint: string, url: string): boolean {
  const clean = endpoint.replace(/\s*\((?:HTTP|SSE|stdio)\)\s*$/i, "").trim();
  try {
    const a = new URL(clean);
    const b = new URL(url);
    return (
      a.host === b.host &&
      a.pathname.replace(/\/+$/, "") === b.pathname.replace(/\/+$/, "")
    );
  } catch {
    return clean === url;
  }
}
