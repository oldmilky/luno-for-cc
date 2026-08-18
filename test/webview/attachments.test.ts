import { describe, it, expect } from "vitest";
import {
  classifyAttachment,
  parseDataUrl,
  toAttachmentBlock
} from "../../webview/src/features/chat/composer/attachments.js";

// The lists here are the reference client's, read out of
// anthropic.claude-code 2.1.233 on 2026-08-17, and the API's acceptance is what
// makes them not ours to improve: a media type outside them is a request the
// server refuses, not a stylistic difference.
//
// React-free, so it runs in the node project.

describe("classifyAttachment — images", () => {
  for (const mime of [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "IMAGE/PNG"
  ]) {
    it(`takes ${mime}`, () => {
      expect(classifyAttachment(mime, "shot.png")).toBe("image");
    });
  }

  it("refuses an image format the API does not take", () => {
    // A browser decodes these happily, which is exactly why the check is on the
    // API's list and not on what can be rendered.
    expect(classifyAttachment("image/bmp", "old.bmp")).toBe("unsupported");
    expect(classifyAttachment("image/heic", "iphone.heic")).toBe("unsupported");
  });

  it("sends an SVG as text, not as an image", () => {
    // It is markup. The API's image list does not have it, and the model can
    // read the source — which is more useful than a picture of it anyway.
    expect(classifyAttachment("image/svg+xml", "logo.svg")).toBe("text");
  });
});

describe("classifyAttachment — documents", () => {
  it("takes a PDF", () => {
    expect(classifyAttachment("application/pdf", "spec.pdf")).toBe("pdf");
  });

  it("takes text by media type", () => {
    expect(classifyAttachment("text/plain", "notes.txt")).toBe("text");
    expect(classifyAttachment("text/x-anything", "weird")).toBe("text");
    expect(classifyAttachment("application/json", "package.json")).toBe("text");
    expect(classifyAttachment("application/x-sh", "deploy")).toBe("text");
  });

  it("takes text by extension when the browser names no type", () => {
    // `File.type` is empty for anything the browser does not recognise, which
    // is most source files. The name is the only thing left to read.
    expect(classifyAttachment("", "main.rs")).toBe("text");
    expect(classifyAttachment("", "Component.tsx")).toBe("text");
    expect(classifyAttachment("", "query.graphql")).toBe("text");
    expect(classifyAttachment("", "bun.lock")).toBe("text");
  });

  it("takes the files that have no extension at all", () => {
    expect(classifyAttachment("", "Makefile")).toBe("text");
    expect(classifyAttachment("", "Dockerfile")).toBe("text");
    expect(classifyAttachment("", "LICENSE")).toBe("text");
    expect(classifyAttachment("", "README")).toBe("text");
    expect(classifyAttachment("", ".gitignore")).toBe("text");
  });
});

describe("classifyAttachment — what it refuses", () => {
  // Parity, and the decision recorded in .claude/plans/attachments.md: neither
  // the CLI's Read nor the reference client opens an Office document. The UI
  // says so out loud rather than dropping it the way the reference does.
  for (const [mime, name] of [
    [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "report.docx"
    ],
    [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "budget.xlsx"
    ],
    [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "deck.pptx"
    ]
  ]) {
    it(`refuses ${name}`, () => {
      expect(classifyAttachment(mime, name)).toBe("unsupported");
    });
  }

  it("refuses binaries with nothing to read", () => {
    expect(classifyAttachment("application/zip", "bundle.zip")).toBe(
      "unsupported"
    );
    expect(classifyAttachment("video/mp4", "clip.mp4")).toBe("unsupported");
    expect(classifyAttachment("application/octet-stream", "a.bin")).toBe(
      "unsupported"
    );
  });
});

describe("parseDataUrl", () => {
  it("splits a well-formed one", () => {
    expect(parseDataUrl("data:image/png;base64,AAAA")).toEqual({
      mediaType: "image/png",
      base64: "AAAA"
    });
  });

  it("answers null rather than throwing on junk", () => {
    expect(parseDataUrl("not a data url")).toBeNull();
    expect(parseDataUrl("data:image/png;base64,")).toBeNull();
  });
});

describe("toAttachmentBlock", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

  it("builds an image block that keeps its media type", () => {
    expect(toAttachmentBlock("shot.png", "data:image/png;base64,AAAA")).toEqual(
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "AAAA" }
      }
    );
  });

  it("builds a PDF block titled with the file name", () => {
    expect(
      toAttachmentBlock("spec.pdf", "data:application/pdf;base64,JVBERi0=")
    ).toEqual({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: "JVBERi0="
      },
      title: "spec.pdf"
    });
  });

  it("decodes a text file rather than sending its base64", () => {
    // The point of the whole distinction: the model quotes the file, instead of
    // being handed a wall of base64 it has to be told how to read.
    const block = toAttachmentBlock(
      "notes.md",
      `data:text/markdown;base64,${b64("# Title\nbody")}`
    );
    expect(block).toEqual({
      type: "document",
      source: { type: "text", media_type: "text/plain", data: "# Title\nbody" },
      title: "notes.md"
    });
  });

  it("decodes text as UTF-8, not one character per byte", () => {
    // `atob` alone turns every non-ASCII character into mojibake, which is
    // most of a comment written in anything but English.
    const block = toAttachmentBlock(
      "readme.md",
      `data:text/markdown;base64,${b64("привет — ok")}`
    );
    expect((block as { source: { data: string } } | null)?.source.data).toBe(
      "привет — ok"
    );
  });

  it("has nothing to send for an unsupported file", () => {
    expect(
      toAttachmentBlock(
        "report.docx",
        "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,UEsD"
      )
    ).toBeNull();
  });

  it("has nothing to send for a malformed data URL", () => {
    expect(
      toAttachmentBlock("shot.png", "definitely not a data url")
    ).toBeNull();
  });
});
