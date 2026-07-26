import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// The host and the webview are separate compilations. The webview declares
// what it sends (`Outbound` in webview/src/lib/rpc.ts); the host declares what
// it accepts (`InboundType` in src/ui/messages.ts). Nothing links the two —
// no shared module, no import, no build step — so they drift the moment
// someone adds a message on one side only.
//
// The failure is silent by nature: the webview posts, the host has no handler,
// nothing happens, no error. This test is the only thing standing between that
// and a shipped feature that does nothing when clicked.
//
// It reads the two files as text rather than importing them. `rpc.ts` is a
// browser module that calls `acquireVsCodeApi()` at module scope, so importing
// it here would throw before a single type could be read.

const ROOT = path.resolve(__dirname, "..", "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

/** Type names in the `Outbound` union — the webview → host direction. */
function webviewSends(): string[] {
  const src = read("webview/src/lib/rpc.ts");
  const start = src.indexOf("export type Outbound");
  expect(start, "Outbound union not found in rpc.ts").toBeGreaterThan(-1);

  // The union runs until the next top-level `export`, which is `Inbound`.
  const after = src.indexOf("\nexport ", start + 1);
  const block = src.slice(start, after === -1 ? undefined : after);

  return unique([...block.matchAll(/type:\s*"([a-zA-Z]+)"/g)].map((m) => m[1]));
}

/** Members of `InboundType` — what the host's handler table is keyed by. */
function hostAccepts(): string[] {
  const src = read("src/ui/messages.ts");
  const start = src.indexOf("export type InboundType");
  expect(start, "InboundType not found in messages.ts").toBeGreaterThan(-1);

  const end = src.indexOf(";", start);
  const block = src.slice(start, end);

  return unique([...block.matchAll(/\|\s*"([a-zA-Z]+)"/g)].map((m) => m[1]));
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)].sort();
}

describe("webview ↔ host protocol contract", () => {
  it("the parsers find something — a silent zero would pass every assertion", () => {
    // Both sides are read by regex over source text, so a rename that breaks
    // the parse would otherwise turn this whole file green and useless.
    expect(webviewSends().length).toBeGreaterThan(50);
    expect(hostAccepts().length).toBeGreaterThan(50);
  });

  it("every message the webview sends has a handler on the host", () => {
    const unhandled = webviewSends().filter((t) => !hostAccepts().includes(t));
    expect(
      unhandled,
      `rpc.ts sends these, src/ui/messages.ts does not list them — ` +
        `the webview would post and nothing would happen:\n  ${unhandled.join("\n  ")}`
    ).toEqual([]);
  });

  it("the host accepts nothing the webview never sends", () => {
    const orphaned = hostAccepts().filter((t) => !webviewSends().includes(t));
    expect(
      orphaned,
      `src/ui/messages.ts lists these, rpc.ts never sends them — ` +
        `dead handlers, or a message removed on one side only:\n  ${orphaned.join("\n  ")}`
    ).toEqual([]);
  });
});
