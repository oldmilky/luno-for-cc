// ─────────────────────────────────────────────────────────────
// Minimal MCP client — JSON-RPC 2.0 over Streamable HTTP (or
// legacy SSE). We only implement what Luno needs today:
//
//   • initialize          — handshake + capability negotiation
//   • tools/list          — discover available tools
//   • tools/call          — invoke a tool with arguments
//
// We deliberately don't pull in @modelcontextprotocol/sdk: the
// extension already ships a Node bundle and the SDK adds a non-
// trivial dependency surface. The protocol shape we care about
// is small and stable.
//
// The server response can come back two ways depending on the
// `Accept` header and server behavior:
//
//   • application/json     — single JSON-RPC envelope (we use this)
//   • text/event-stream    — one envelope per `data:` line; we just
//                            read the first `event: message`'s data
// ─────────────────────────────────────────────────────────────

import * as crypto from "node:crypto";
import { ConnectorTool } from "./storage.js";

const PROTOCOL_VERSION = "2025-06-18";

export interface McpClientOptions {
  /** The server's main MCP endpoint (the URL the user pastes / catalog ships). */
  url: string;
  /** Streamable-HTTP or legacy SSE. SSE servers usually still accept POSTs. */
  transport: "streamable-http" | "sse";
  /** Bearer token. Omit for servers that don't require auth. */
  accessToken?: string;
  /** Extra headers merged over the defaults — used for servers imported from
   *  Claude Code's config, which may carry a non-Bearer or custom auth header
   *  (e.g. `{ Authorization: "Bearer …" }` straight out of ~/.claude.json). */
  headers?: Record<string, string>;
  /** Per-request timeout. */
  timeoutMs?: number;
}

export interface InitializeResult {
  protocolVersion: string;
  serverInfo?: { name: string; version: string };
  capabilities?: Record<string, unknown>;
}

export interface ToolsListResult {
  tools: ConnectorTool[];
}

export interface ToolCallResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
    | { type: "resource"; resource: Record<string, unknown> }
  >;
  isError?: boolean;
}

// ── Public client ──────────────────────────────────────────

export class McpClient {
  private sessionId?: string;

  constructor(private readonly opts: McpClientOptions) {}

  /** Run the standard 3-call connection sweep: initialize + tools/list. */
  async connectAndList(): Promise<{
    info: InitializeResult;
    tools: ConnectorTool[];
  }> {
    const info = await this.initialize();
    let tools: ConnectorTool[] = [];
    if (
      info.capabilities &&
      (info.capabilities as { tools?: unknown }).tools !== undefined
    ) {
      const listed = await this.listTools();
      tools = listed.tools;
    }
    return { info, tools };
  }

  async initialize(): Promise<InitializeResult> {
    const result = await this.rpc<InitializeResult>("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "luno-vscode", version: "0.1.0" }
    });
    // The server is meant to reply with its own session id in a header on
    // the response; we capture it in `rpc()` directly.
    // After initialize, the spec calls for a `notifications/initialized`
    // notification — fire it best-effort.
    void this.notify("notifications/initialized", {}).catch(() => undefined);
    return result;
  }

  async listTools(): Promise<ToolsListResult> {
    return this.rpc<ToolsListResult>("tools/list", {});
  }

  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolCallResult> {
    return this.rpc<ToolCallResult>("tools/call", { name, arguments: args });
  }

  // ── Internals ─────────────────────────────────────────────

  private async rpc<T>(
    method: string,
    params: Record<string, unknown>
  ): Promise<T> {
    const id = randomId();
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.opts.timeoutMs ?? 30_000
    );

    let res: Response;
    try {
      res = await fetch(this.opts.url, {
        method: "POST",
        headers: this.headers(),
        body,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `MCP ${method} → HTTP ${res.status}: ${text || res.statusText}`
      );
    }

    // Capture the session id the server hands back on initialize. We send
    // it on every subsequent call so the server can route state.
    const sid = res.headers.get("mcp-session-id");
    if (sid && method === "initialize") this.sessionId = sid;

    // Pass our request id so parseEnvelope returns *this* call's frame, not
    // whatever happens to come first on a multiplexed SSE stream.
    const env = await parseEnvelope(res, id);
    if (env.error) {
      throw new Error(
        `MCP ${method} error ${env.error.code}: ${env.error.message}`
      );
    }
    return env.result as T;
  }

  private async notify(
    method: string,
    params: Record<string, unknown>
  ): Promise<void> {
    const body = JSON.stringify({ jsonrpc: "2.0", method, params });
    await fetch(this.opts.url, {
      method: "POST",
      headers: this.headers(),
      body
    }).catch(() => undefined);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": "Luno-VSCode/0.1.0"
    };
    if (this.opts.accessToken) {
      h.Authorization = `Bearer ${this.opts.accessToken}`;
    }
    if (this.sessionId) {
      h["Mcp-Session-Id"] = this.sessionId;
    }
    // Caller-supplied headers win (e.g. an imported server's stored auth header).
    if (this.opts.headers) {
      for (const [k, v] of Object.entries(this.opts.headers)) h[k] = v;
    }
    return h;
  }
}

// ── Envelope parsing ────────────────────────────────────────

interface JsonRpcEnvelope {
  jsonrpc: "2.0";
  id?: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Parse either a JSON or SSE-formatted JSON-RPC response.
 *
 * SSE servers stream `event: message\ndata: { … }\n\n` blocks and may
 * multiplex several JSON-RPC frames (notifications, server→client requests,
 * and responses to different ids) onto one stream. When `expectedId` is
 * given we return the response frame whose `id` matches it, skipping
 * notifications and frames belonging to other requests. Without an
 * `expectedId` we fall back to the first valid response frame (used by the
 * single-shot tests).
 *
 * A response frame with no `id` at all (some servers omit it) is kept as a
 * last-resort fallback so we don't error out on otherwise-valid replies.
 */
export async function parseEnvelope(
  res: Response,
  expectedId?: string | number
): Promise<JsonRpcEnvelope> {
  const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
  if (ctype.includes("text/event-stream")) {
    const text = await res.text();
    let fallback: JsonRpcEnvelope | undefined;
    for (const d of extractSseData(text)) {
      let env: JsonRpcEnvelope;
      try {
        env = JSON.parse(d) as JsonRpcEnvelope;
      } catch {
        continue; // skip non-JSON events (comments, pings, …)
      }
      if (env.jsonrpc !== "2.0") continue;
      // Only responses carry result/error; ignore notifications + requests.
      if (env.result === undefined && !env.error) continue;
      if (expectedId === undefined) return env; // legacy: first valid response
      if (idsMatch(env.id, expectedId)) return env; // the frame we asked for
      // A response that doesn't echo an id can't be attributed to another
      // request — hold onto it in case nothing matches.
      if (env.id === undefined && !fallback) fallback = env;
    }
    if (fallback) return fallback;
    throw new Error("SSE stream contained no JSON-RPC envelope");
  }
  const text = await res.text();
  if (!text) throw new Error("Empty response body");
  return JSON.parse(text) as JsonRpcEnvelope;
}

/**
 * Pull the JSON payloads out of an SSE body. Splits into events on blank
 * lines and concatenates each event's `data:` lines (SSE permits a single
 * logical payload to span several `data:` lines).
 */
function extractSseData(text: string): string[] {
  const out: string[] = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, "")) // drop the one optional leading space
      .join("\n")
      .trim();
    if (data) out.push(data);
  }
  return out;
}

/** JSON-RPC ids round-trip as string or number; compare leniently. */
function idsMatch(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return false;
  return a === b || String(a) === String(b);
}

function randomId(): string {
  return crypto.randomBytes(8).toString("hex");
}
