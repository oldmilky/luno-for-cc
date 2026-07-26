import { describe, it, expect, vi } from "vitest";

// client.ts transitively imports storage.ts which imports `* as vscode`.
vi.mock("vscode", () => ({}));

import { parseEnvelope } from "../../src/services/mcp/client.js";

/** Build a minimal fetch Response double for parseEnvelope. */
function res(contentType: string, body: string): any {
  return {
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? contentType : null) },
    text: async () => body
  };
}

describe("parseEnvelope", () => {
  it("parses a plain JSON JSON-RPC result", async () => {
    const env = await parseEnvelope(
      res("application/json", JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }))
    );
    expect(env.result).toEqual({ ok: true });
  });

  it("parses a JSON-RPC error envelope", async () => {
    const env = await parseEnvelope(
      res("application/json", JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "boom" } }))
    );
    expect(env.error?.message).toBe("boom");
  });

  it("parses an SSE-framed JSON-RPC envelope", async () => {
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"x":1}}\n\n';
    const env = await parseEnvelope(res("text/event-stream", sse));
    expect(env.result).toEqual({ x: 1 });
  });

  it("throws when an SSE stream has no JSON-RPC envelope", async () => {
    await expect(parseEnvelope(res("text/event-stream", "data: hello\n\n"))).rejects.toThrow(
      /no JSON-RPC envelope/
    );
  });

  it("throws on an empty JSON body", async () => {
    await expect(parseEnvelope(res("application/json", ""))).rejects.toThrow(/Empty response body/);
  });

  // Fix for audit finding #7: parseEnvelope now takes the request id and
  // returns the matching frame, so a multiplexed SSE stream yields THIS call's
  // response rather than whatever came first.
  it("returns the frame matching the requested id on a multiplexed stream", async () => {
    const sse =
      'data: {"jsonrpc":"2.0","id":99,"result":{"first":true}}\n\n' +
      'data: {"jsonrpc":"2.0","id":1,"result":{"second":true}}\n\n';
    const env = await parseEnvelope(res("text/event-stream", sse), 1);
    expect(env.result).toEqual({ second: true });
  });

  it("matches ids leniently across string vs number", async () => {
    const sse = 'data: {"jsonrpc":"2.0","id":"abc","result":{"ok":true}}\n\n';
    const env = await parseEnvelope(res("text/event-stream", sse), "abc");
    expect(env.result).toEqual({ ok: true });
  });

  it("skips notifications and other-id frames, returning the matched response", async () => {
    const sse =
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n' +
      'data: {"jsonrpc":"2.0","id":7,"result":{"v":7}}\n\n' +
      'data: {"jsonrpc":"2.0","id":8,"result":{"v":8}}\n\n';
    const env = await parseEnvelope(res("text/event-stream", sse), 8);
    expect(env.result).toEqual({ v: 8 });
  });

  it("falls back to the first valid response when no id is requested", async () => {
    const sse =
      'data: {"jsonrpc":"2.0","id":99,"result":{"first":true}}\n\n' +
      'data: {"jsonrpc":"2.0","id":1,"result":{"second":true}}\n\n';
    const env = await parseEnvelope(res("text/event-stream", sse));
    expect(env.result).toEqual({ first: true });
  });

  it("falls back to an id-less response when no frame matches the requested id", async () => {
    const sse = 'data: {"jsonrpc":"2.0","result":{"only":true}}\n\n';
    const env = await parseEnvelope(res("text/event-stream", sse), 42);
    expect(env.result).toEqual({ only: true });
  });

  it("parses a JSON payload split across multiple data: lines", async () => {
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":3,\ndata: "result":{"multi":true}}\n\n';
    const env = await parseEnvelope(res("text/event-stream", sse), 3);
    expect(env.result).toEqual({ multi: true });
  });
});
