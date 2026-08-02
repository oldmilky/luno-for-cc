// ─────────────────────────────────────────────────────────────
// The websocket, and nothing else.
//
// Kept behind an interface the orchestrator is written against, so the rules
// that matter — preroll, one retry, the stop policy, the close handshake —
// are testable without a network. This file is the only place `ws` is
// imported, and the only reason it is a dependency at all: the endpoint
// authenticates with a header, and the platform's own WebSocket constructor
// takes protocols, not headers.
// ─────────────────────────────────────────────────────────────

import WebSocket from "ws";

export interface VoiceSocketHandlers {
  onOpen(): void;
  onMessage(raw: string): void;
  /** Transport-level failure. The message is passed through verbatim so the
   *  orchestrator can read a status code out of it. */
  onError(message: string): void;
  onClose(): void;
}

export interface VoiceSocket {
  send(data: string | Uint8Array): void;
  close(): void;
  readonly open: boolean;
}

export type VoiceConnect = (
  url: string,
  headers: Record<string, string>,
  handlers: VoiceSocketHandlers
) => VoiceSocket;

export const connectVoiceSocket: VoiceConnect = (url, headers, handlers) => {
  const ws = new WebSocket(url, { headers });
  let closed = false;

  ws.on("open", () => handlers.onOpen());
  ws.on("message", (data) => handlers.onMessage(data.toString()));
  ws.on("error", (err: Error) => handlers.onError(err.message));
  ws.on("close", () => {
    closed = true;
    handlers.onClose();
  });

  return {
    send(data) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    close() {
      if (!closed && ws.readyState !== WebSocket.CLOSED) ws.close();
    },
    get open() {
      return ws.readyState === WebSocket.OPEN;
    }
  };
};
