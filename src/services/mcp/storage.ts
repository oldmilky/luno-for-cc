// ─────────────────────────────────────────────────────────────
// MCP connector storage.
//
// Three buckets, each backed by a different VS Code persistence
// mechanism:
//
//  • Custom connectors  → ctx.globalState  (durable JSON, visible)
//      User-added entries that aren't in the curated catalog.
//      Contains URL + display name only — no secrets.
//
//  • Connection records → ctx.globalState  (durable JSON, visible)
//      Per-connector status (connected? when? which tools?).
//
//  • Auth material      → ctx.secrets      (OS keychain, opaque)
//      OAuth access/refresh tokens + per-server registered
//      client_id / client_secret. Never logged, never written
//      anywhere except SecretStorage.
// ─────────────────────────────────────────────────────────────

import * as vscode from "vscode";
import { CatalogEntry } from "./catalog.js";

const CUSTOM_KEY = "luno.mcp.customConnectors.v1";
const CONNECTIONS_KEY = "luno.mcp.connections.v1";

/** Transport kinds Luno understands — matches Claude Code's own set. */
export type McpTransport = "streamable-http" | "sse" | "stdio";

/**
 * A user-added connector that lives outside the curated catalog.
 *
 * Two flavors, discriminated by `transport`:
 *   • remote (streamable-http | sse) → `url` (+ optional pre-registered
 *     OAuth `clientId`). Authenticated via the OAuth flow in oauth.ts.
 *   • stdio                          → `command` + `args` + `env`. Spawned
 *     locally; no auth. Mirrors `claude mcp add <name> -- <command> …`.
 */
export interface CustomConnector {
  id: string;
  name: string;
  transport: McpTransport;
  /** Remote (http/sse) endpoint. Present for remote transports, absent for stdio. */
  url?: string;
  description?: string;
  /** Pre-registered OAuth client id (remote only; skip DCR if set). */
  clientId?: string;
  /** stdio: executable to spawn (e.g. "npx"). */
  command?: string;
  /** stdio: arguments passed to the command (e.g. ["-y", "@scope/server"]). */
  args?: string[];
  // NOTE: stdio `env` is intentionally NOT stored here — env values are often
  // secrets (API keys), so they live in ctx.secrets via saveStdioEnv/loadStdioEnv.
}

/** Saved connection metadata — see ConnectionRecord shape below. */
export interface ConnectionRecord {
  /** Catalog id or custom-connector id. */
  id: string;
  /** Last-known auth state. */
  status: "connected" | "disconnected" | "error";
  /** ISO timestamp of the most recent successful initialize. */
  connectedAt?: number;
  /** Tools discovered on the last successful tools/list. */
  tools?: ConnectorTool[];
  /** Last error message, when status==="error". */
  lastError?: string;
  /** Issuer URL of the auth server (cached from OIDC discovery). */
  issuer?: string;
  /** Token endpoint URL (cached from OIDC discovery, for refresh). */
  tokenEndpoint?: string;
  /** Authorization-server-registered client id. */
  registeredClientId?: string;
  /** When the access token expires (epoch ms). */
  expiresAt?: number;
}

/** A tool advertised by an MCP server. */
export interface ConnectorTool {
  name: string;
  title?: string;
  description?: string;
  /** JSON-schema-ish input shape — opaque to us, passed through to the model. */
  inputSchema?: Record<string, unknown>;
}

// ── Custom connectors ───────────────────────────────────────

export function loadCustomConnectors(
  ctx: vscode.ExtensionContext
): CustomConnector[] {
  return ctx.globalState.get<CustomConnector[]>(CUSTOM_KEY, []);
}

export async function saveCustomConnector(
  ctx: vscode.ExtensionContext,
  entry: CustomConnector
): Promise<void> {
  const list = loadCustomConnectors(ctx);
  const filtered = list.filter((c) => c.id !== entry.id);
  filtered.push(entry);
  await ctx.globalState.update(CUSTOM_KEY, filtered);
}

export async function removeCustomConnector(
  ctx: vscode.ExtensionContext,
  id: string
): Promise<void> {
  const list = loadCustomConnectors(ctx);
  await ctx.globalState.update(
    CUSTOM_KEY,
    list.filter((c) => c.id !== id)
  );
}

// ── Connection records ──────────────────────────────────────

export function loadConnections(
  ctx: vscode.ExtensionContext
): Record<string, ConnectionRecord> {
  return ctx.globalState.get<Record<string, ConnectionRecord>>(
    CONNECTIONS_KEY,
    {}
  );
}

export async function setConnectionRecord(
  ctx: vscode.ExtensionContext,
  rec: ConnectionRecord
): Promise<void> {
  const all = loadConnections(ctx);
  all[rec.id] = rec;
  await ctx.globalState.update(CONNECTIONS_KEY, all);
}

export async function clearConnectionRecord(
  ctx: vscode.ExtensionContext,
  id: string
): Promise<void> {
  const all = loadConnections(ctx);
  delete all[id];
  await ctx.globalState.update(CONNECTIONS_KEY, all);
}

// ── Token + client-credential keychain ──────────────────────

/** Secret keys are namespaced so they don't collide with other Luno secrets. */
function secretKey(connectorId: string, kind: "access" | "refresh" | "client"): string {
  return `luno.mcp.${connectorId}.${kind}.v1`;
}

export interface StoredTokens {
  accessToken?: string;
  refreshToken?: string;
  clientSecret?: string;
}

export async function loadTokens(
  ctx: vscode.ExtensionContext,
  connectorId: string
): Promise<StoredTokens> {
  const [accessToken, refreshToken, clientSecret] = await Promise.all([
    ctx.secrets.get(secretKey(connectorId, "access")),
    ctx.secrets.get(secretKey(connectorId, "refresh")),
    ctx.secrets.get(secretKey(connectorId, "client"))
  ]);
  return { accessToken, refreshToken, clientSecret };
}

export async function saveTokens(
  ctx: vscode.ExtensionContext,
  connectorId: string,
  toks: StoredTokens
): Promise<void> {
  if (toks.accessToken !== undefined) {
    await ctx.secrets.store(secretKey(connectorId, "access"), toks.accessToken);
  }
  if (toks.refreshToken !== undefined) {
    await ctx.secrets.store(secretKey(connectorId, "refresh"), toks.refreshToken);
  }
  if (toks.clientSecret !== undefined) {
    await ctx.secrets.store(secretKey(connectorId, "client"), toks.clientSecret);
  }
}

export async function deleteTokens(
  ctx: vscode.ExtensionContext,
  connectorId: string
): Promise<void> {
  await ctx.secrets.delete(secretKey(connectorId, "access"));
  await ctx.secrets.delete(secretKey(connectorId, "refresh"));
  await ctx.secrets.delete(secretKey(connectorId, "client"));
}

// ── stdio env (secret) ──────────────────────────────────────
//
// Env vars for a stdio server frequently carry credentials (API keys), so we
// keep them out of the plaintext globalState connector record and stash them
// in the OS keychain instead — same treatment as OAuth tokens above. Stored as
// a single JSON blob keyed by connector id.

function envSecretKey(connectorId: string): string {
  return `luno.mcp.${connectorId}.env.v1`;
}

export async function saveStdioEnv(
  ctx: vscode.ExtensionContext,
  connectorId: string,
  env: Record<string, string>
): Promise<void> {
  await ctx.secrets.store(envSecretKey(connectorId), JSON.stringify(env));
}

export async function loadStdioEnv(
  ctx: vscode.ExtensionContext,
  connectorId: string
): Promise<Record<string, string> | undefined> {
  const raw = await ctx.secrets.get(envSecretKey(connectorId));
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : undefined;
  } catch {
    return undefined;
  }
}

export async function deleteStdioEnv(
  ctx: vscode.ExtensionContext,
  connectorId: string
): Promise<void> {
  await ctx.secrets.delete(envSecretKey(connectorId));
}

// ── Lookup helpers ──────────────────────────────────────────

/**
 * Resolve a connector id to its effective config — checks the curated
 * catalog first, then user-added custom entries. Returns null if the id
 * matches nothing.
 */
export function resolveConnector(
  ctx: vscode.ExtensionContext,
  id: string,
  catalog: ReadonlyArray<CatalogEntry>
): CatalogEntry | (CustomConnector & { categories: string[]; icon: string; builtIn: false }) | null {
  const builtin = catalog.find((c) => c.id === id);
  if (builtin) return builtin;
  const custom = loadCustomConnectors(ctx).find((c) => c.id === id);
  if (!custom) return null;
  return {
    ...custom,
    categories: ["custom"],
    icon: "cloud",
    builtIn: false
  };
}
