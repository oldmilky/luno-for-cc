// ─────────────────────────────────────────────────────────────
// stdio MCP client — JSON-RPC 2.0 over a locally-spawned process.
//
// This is the local counterpart to client.ts (Streamable-HTTP / SSE).
// Claude Code lets you register stdio servers with
//
//   claude mcp add <name> -- <command> [args…]
//
// i.e. a child process that speaks MCP over its stdin/stdout. We mirror
// that here so a user can add a local command server from Luno's
// "Add custom connector" form and get a live tool count.
//
// Framing (MCP stdio transport): newline-delimited JSON — one JSON-RPC
// message per line on stdin/stdout, no embedded newlines. stderr is for
// the server's own logging and is captured only to enrich error messages.
//
// Note: this client is used only for the connectors UI (validate the
// command + list tools). Actual tool calls during a turn are made by the
// Claude Code CLI, which spawns its own copy of the server from the
// `--mcp-config` we hand it. So spawning fresh for each handshake here is
// fine — these are short-lived validation runs.
// ─────────────────────────────────────────────────────────────

import { spawn } from "node:child_process";
import * as readline from "node:readline";
import * as crypto from "node:crypto";
import { ConnectorTool } from "./storage.js";
import { InitializeResult, ToolCallResult } from "./client.js";

const PROTOCOL_VERSION = "2025-06-18";

export interface StdioClientOptions {
  /** Executable to run (e.g. "npx", "uvx", "/usr/local/bin/my-server"). */
  command: string;
  /** Arguments passed to the command. */
  args?: string[];
  /** Extra environment variables, merged over the host's process.env. */
  env?: Record<string, string>;
  /** Working directory for the child (defaults to the host's cwd). */
  cwd?: string;
  /** Per-request timeout. */
  timeoutMs?: number;
}

interface JsonRpcEnvelope {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface StdioSession {
  initialize(): Promise<InitializeResult>;
  request<T>(method: string, params: Record<string, unknown>): Promise<T>;
  dispose(): void;
}

export class StdioMcpClient {
  constructor(private readonly opts: StdioClientOptions) {}

  /** Spawn, initialize, list tools, then tear the process down. */
  async connectAndList(): Promise<{ info: InitializeResult; tools: ConnectorTool[] }> {
    const session = await this.start();
    try {
      const info = await session.initialize();
      let tools: ConnectorTool[] = [];
      // Most stdio servers advertise a `tools` capability; some don't but
      // still answer tools/list. Attempt it either way and tolerate failure.
      try {
        const listed = await session.request<{ tools?: ConnectorTool[] }>("tools/list", {});
        tools = listed.tools ?? [];
      } catch {
        // Server has no tools (or doesn't implement tools/list) — leave empty.
      }
      return { info, tools };
    } finally {
      session.dispose();
    }
  }

  /** Spawn, initialize, invoke a single tool, then tear the process down. */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const session = await this.start();
    try {
      await session.initialize();
      return await session.request<ToolCallResult>("tools/call", { name, arguments: args });
    } finally {
      session.dispose();
    }
  }

  // ── Internals ─────────────────────────────────────────────

  private async start(): Promise<StdioSession> {
    const timeoutMs = this.opts.timeoutMs ?? 30_000;
    const child = spawn(this.opts.command, this.opts.args ?? [], {
      cwd: this.opts.cwd,
      env: { ...process.env, ...(this.opts.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"]
    });

    const pending = new Map<
      string,
      { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
    >();
    let spawnError: Error | null = null;
    let exited = false;
    let exitErr: Error | null = null;
    let stderrTail = "";

    const failAll = (err: Error) => {
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      pending.clear();
    };

    child.on("error", (err) => {
      spawnError = err;
      failAll(err);
    });
    child.stderr.on("data", (b: Buffer) => {
      stderrTail = (stderrTail + b.toString("utf8")).slice(-2048);
    });
    // A broken stdin pipe (EPIPE — server closed stdin or died mid-write) emits
    // an async 'error' on the writable. With no listener Node escalates it to an
    // uncaughtException that would take the whole extension host down, so we
    // must handle it here.
    child.stdin.on("error", (err) => {
      spawnError = err;
      failAll(err);
    });
    child.on("exit", (code, signal) => {
      // Don't reject in-flight requests here: the server's final response may
      // still be buffered in the stdout pipe. Record the exit and let the
      // readline 'close' handler (which fires only after every line has been
      // delivered) decide whether anything was genuinely left unanswered.
      exited = true;
      const detail = stderrTail.trim().slice(-500);
      exitErr = new Error(
        `MCP stdio server "${this.opts.command}" exited (${signal ?? `code ${code}`}).` +
          (detail ? ` ${detail}` : "")
      );
    });

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let env: JsonRpcEnvelope;
      try {
        env = JSON.parse(trimmed) as JsonRpcEnvelope;
      } catch {
        return; // server log noise on stdout — ignore
      }
      if (env.id === undefined) return; // notification / server→client request
      const key = String(env.id);
      const p = pending.get(key);
      if (!p) return; // a frame for some id we're not waiting on
      pending.delete(key);
      clearTimeout(p.timer);
      if (env.error) {
        p.reject(new Error(`MCP error ${env.error.code}: ${env.error.message}`));
      } else {
        p.resolve(env.result);
      }
    });
    // Fires after the last buffered 'line' has been emitted, so any response
    // the server sent right before exiting has already resolved its request.
    // Whatever is still pending here truly got no answer.
    rl.on("close", () => {
      if (pending.size) {
        failAll(exitErr ?? new Error(`MCP stdio server "${this.opts.command}" closed its output.`));
      }
    });

    const send = (msg: object) => {
      if (spawnError) throw spawnError;
      if (exited) throw new Error("MCP stdio server is not running.");
      try {
        child.stdin.write(JSON.stringify(msg) + "\n");
      } catch (err) {
        // Synchronous write failure (e.g. stream already destroyed) — surface
        // it as a normal error rather than letting it escape.
        throw err instanceof Error ? err : new Error(String(err));
      }
    };

    const request = <T>(method: string, params: Record<string, unknown>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        if (spawnError) return reject(spawnError);
        const id = randomId();
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP stdio ${method} timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
        try {
          send({ jsonrpc: "2.0", id, method, params });
        } catch (e) {
          clearTimeout(timer);
          pending.delete(id);
          reject(e as Error);
        }
      });

    const dispose = () => {
      rl.close();
      if (!child.killed) {
        child.kill("SIGTERM");
        const t = setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 2000);
        t.unref?.();
      }
    };

    // Let an immediate spawn failure (e.g. ENOENT for a missing command)
    // surface before we hand back a session, so the UI shows "command not
    // found" rather than a generic request timeout.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (spawnError) {
      dispose();
      throw spawnError;
    }

    const initialize = async (): Promise<InitializeResult> => {
      const result = await request<InitializeResult>("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "luno-vscode", version: "0.1.0" }
      });
      // Best-effort post-initialize notification per the MCP lifecycle spec.
      try {
        send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      } catch {
        // ignore — initialize already succeeded
      }
      return result;
    };

    return { initialize, request, dispose };
  }
}

function randomId(): string {
  return crypto.randomBytes(8).toString("hex");
}
