import { describe, it, expect } from "vitest";
import { resolveMarkdownHref } from "../../webview/src/features/chat/timeline/markdown-links.js";

// markdown-links.ts is React-free, so it runs in the node environment.
// A webview swallows `target="_blank"` and `window.open`, so every link in a
// rendered message has to be classified here and dispatched to the host.

describe("resolveMarkdownHref — outward", () => {
  it("sends a web URL to the host", () => {
    expect(resolveMarkdownHref("https://example.com/a?b=1#c")).toEqual({
      kind: "external",
      url: "https://example.com/a?b=1#c"
    });
  });

  it("treats any scheme as outward, not just http", () => {
    for (const url of ["mailto:a@b.c", "vscode://x/y", "file:///tmp/a"]) {
      expect(resolveMarkdownHref(url).kind).toBe("external");
    }
  });
});

describe("resolveMarkdownHref — into the workspace", () => {
  it("reads a bare relative path", () => {
    expect(resolveMarkdownHref("src/core/session.ts")).toEqual({
      kind: "file",
      path: "src/core/session.ts"
    });
  });

  it("reads a single line from the fragment", () => {
    expect(resolveMarkdownHref("src/ui/panel.ts#L42")).toEqual({
      kind: "file",
      path: "src/ui/panel.ts",
      startLine: 42,
      endLine: 42
    });
  });

  it("reads a range in both spellings", () => {
    // GitHub writes `#L42-L51`; the official extension's own prompt shows the
    // same form, but a model shortens it to `#L42-51` often enough to matter.
    expect(resolveMarkdownHref("a.ts#L42-L51")).toMatchObject({
      startLine: 42,
      endLine: 51
    });
    expect(resolveMarkdownHref("a.ts#L42-51")).toMatchObject({
      startLine: 42,
      endLine: 51
    });
  });

  it("drops a leading ./", () => {
    expect(resolveMarkdownHref("./webview/src/App.tsx")).toMatchObject({
      path: "webview/src/App.tsx"
    });
  });

  it("keeps a folder path", () => {
    expect(resolveMarkdownHref("src/ui/domains/")).toMatchObject({
      path: "src/ui/domains/"
    });
  });

  it("reads a Windows absolute path as a file, not a scheme", () => {
    // `C:` matches the scheme grammar, and treating it as a protocol would
    // hand the host a URL it cannot open.
    expect(resolveMarkdownHref("C:/MAIN/WEB/x.ts#L3")).toMatchObject({
      kind: "file",
      path: "C:/MAIN/WEB/x.ts",
      startLine: 3
    });
    expect(resolveMarkdownHref("C:\\MAIN\\x.ts").kind).toBe("file");
  });

  it("ignores a fragment that is not a line reference", () => {
    expect(resolveMarkdownHref("docs/TOKENS.md#colour")).toEqual({
      kind: "file",
      path: "docs/TOKENS.md"
    });
  });
});

describe("resolveMarkdownHref — nothing to dispatch", () => {
  it("leaves an in-document anchor alone", () => {
    expect(resolveMarkdownHref("#risks")).toEqual({ kind: "inert" });
  });

  it("leaves an empty or missing href alone", () => {
    expect(resolveMarkdownHref(undefined)).toEqual({ kind: "inert" });
    expect(resolveMarkdownHref("   ")).toEqual({ kind: "inert" });
    expect(resolveMarkdownHref("./")).toEqual({ kind: "inert" });
  });
});
