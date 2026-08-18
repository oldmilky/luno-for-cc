// ─────────────────────────────────────────────────────────────
// What a picked file is, and what it becomes on the wire.
//
// Ported whole from the reference client (anthropic.claude-code 2.1.233,
// `webview/index.js`), read statically on 2026-08-17. The lists are theirs
// because the API's acceptance is theirs: a media type outside them is not a
// stylistic difference, it is a request the server rejects.
//
// Pure and React-free so it runs in the node test project beside
// `startup-suggestions` and `question-answers` — this is a decision about a
// file, not about a component.
//
// It lives here rather than in `src/core/` for a reason worth knowing before
// moving it: the two halves compile separately and `webview/src` cannot import
// from `src/`. The picker is in the webview, so the classifier is too.
// ─────────────────────────────────────────────────────────────

/**
 * What the API can be handed, and the one answer that means "it cannot".
 *
 * `unsupported` is a value rather than a `null` because the caller has
 * something to say about it: the reference drops such a file with a
 * `console.error` nobody sees, and a file that silently does not arrive is the
 * worst of the outcomes available.
 */
export type AttachmentKind = "image" | "pdf" | "text" | "unsupported";

/** The four the API takes. Not a subset of what a browser can decode — no
 *  `image/svg+xml` (it is text, and travels as one), no `bmp`, no `heic`. */
const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp"
]);

/** `application/*` types that are text in everything but their label. */
const TEXT_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/x-javascript",
  "application/x-typescript",
  "application/x-yaml",
  "application/yaml",
  "application/x-sh",
  "application/x-shellscript",
  "application/sql",
  "application/graphql",
  "application/toml",
  "application/x-toml"
]);

/**
 * Extensions that are text, and filenames that are text without one.
 *
 * Both jobs in one set because the reference checks the same set twice — once
 * against the last dot-segment, once against the whole lowercased name — which
 * is what makes `makefile`, `dockerfile` and `gemfile` work with no extension
 * at all.
 */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  // config
  "json",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "config",
  "env",
  "properties",
  // languages
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "mts",
  "cts",
  "py",
  "pyw",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "scala",
  "c",
  "h",
  "cpp",
  "hpp",
  "cc",
  "cxx",
  "cs",
  "fs",
  "fsx",
  "swift",
  "php",
  "pl",
  "pm",
  "lua",
  "r",
  "jl",
  "ex",
  "exs",
  "erl",
  "hrl",
  "clj",
  "cljs",
  "cljc",
  "elm",
  "hs",
  "ml",
  "mli",
  "v",
  "sv",
  "vhd",
  "vhdl",
  "asm",
  "s",
  // markup and styles
  "html",
  "htm",
  "xhtml",
  "xml",
  "svg",
  "css",
  "scss",
  "sass",
  "less",
  "vue",
  "svelte",
  "astro",
  // shells
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "psm1",
  "psd1",
  "bat",
  "cmd",
  // data and queries
  "csv",
  "tsv",
  "sql",
  "graphql",
  "gql",
  "prisma",
  // prose
  "md",
  "mdx",
  "markdown",
  "rst",
  "txt",
  "text",
  "rtf",
  "tex",
  "latex",
  "org",
  "adoc",
  "asciidoc",
  // build files, named rather than extended
  "makefile",
  "cmake",
  "gradle",
  "dockerfile",
  "containerfile",
  "vagrantfile",
  "rakefile",
  "gemfile",
  "podfile",
  "fastfile",
  "brewfile",
  "procfile",
  // the rest
  "lock",
  "sum",
  "log",
  "diff",
  "patch",
  "gitignore",
  "gitattributes",
  "editorconfig",
  "prettierrc",
  "eslintrc",
  "babelrc",
  "npmrc",
  "nvmrc",
  "yarnrc"
]);

/** Bare filenames that carry prose and never an extension. */
const TEXT_FILENAMES: ReadonlySet<string> = new Set([
  "license",
  "readme",
  "changelog",
  "authors",
  "contributors",
  "copying"
]);

function isTextLike(mediaType: string, fileName: string): boolean {
  if (mediaType.startsWith("text/")) return true;
  if (TEXT_MEDIA_TYPES.has(mediaType)) return true;
  const name = fileName.toLowerCase();
  const extension = name.split(".").pop();
  if (extension && TEXT_EXTENSIONS.has(extension)) return true;
  return TEXT_EXTENSIONS.has(name) || TEXT_FILENAMES.has(name);
}

/**
 * What this file is, in the order the reference decides it.
 *
 * The order matters and is not alphabetical: an `image/*` type wins before
 * anything else looks at the name, and `application/pdf` is checked before the
 * text rules — which would otherwise never claim it, but the order is the
 * reference's and there is no reason to differ.
 *
 * The browser leaves `File.type` empty for an extension it does not know, which
 * is exactly when the name has to answer — so a `.ts` file with no media type
 * still classifies as text.
 *
 * Office documents (`.docx`, `.xlsx`, `.pptx`) land on `unsupported`, and that
 * is parity rather than an omission: neither the CLI's `Read` nor the reference
 * client opens one. See `.claude/plans/attachments.md`.
 */
export function classifyAttachment(
  mediaType: string,
  fileName: string
): AttachmentKind {
  const type = mediaType.toLowerCase();
  if (IMAGE_MEDIA_TYPES.has(type)) return "image";
  if (type === "application/pdf") return "pdf";
  if (isTextLike(type, fileName)) return "text";
  return "unsupported";
}

export type { AttachmentBlock } from "../../../lib/rpc";
import type { AttachmentBlock } from "../../../lib/rpc";

/** `data:<media type>;base64,<payload>` split into its two halves, or null for
 *  anything that is not one. */
export function parseDataUrl(
  dataUrl: string
): { mediaType: string; base64: string } | null {
  const comma = dataUrl.indexOf(",");
  if (comma === -1 || !dataUrl.startsWith("data:")) return null;
  const header = dataUrl.slice(5, comma);
  const base64 = dataUrl.slice(comma + 1);
  if (!base64) return null;
  const mediaType = header.split(";")[0].trim().toLowerCase();
  return { mediaType: mediaType || "application/octet-stream", base64 };
}

/**
 * The block to send for one picked file, or `null` when there is none to send.
 *
 * A text file is **decoded here** and travels as its own characters rather than
 * as base64 — that is what the reference does, and it is what lets the model
 * quote the file instead of a wall of base64. An image and a PDF stay base64,
 * because that is what they are.
 *
 * Returns null rather than throwing on a malformed data URL: this runs on
 * whatever the clipboard or the file picker produced, and a broken one is a
 * file to report, not a crash to take the composer down with.
 */
export function toAttachmentBlock(
  fileName: string,
  dataUrl: string
): AttachmentBlock | null {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return null;
  const { mediaType, base64 } = parsed;
  switch (classifyAttachment(mediaType, fileName)) {
    case "image":
      return {
        type: "image",
        source: { type: "base64", media_type: mediaType, data: base64 }
      };
    case "pdf":
      return {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: base64
        },
        title: fileName
      };
    case "text": {
      const text = decodeBase64Text(base64);
      if (text === null) return null;
      return {
        type: "document",
        source: { type: "text", media_type: "text/plain", data: text },
        title: fileName
      };
    }
    case "unsupported":
      return null;
  }
}

/** Base64 → the text it holds, UTF-8 aware. `atob` alone yields one character
 *  per *byte*, which turns every non-ASCII character in a source file into
 *  mojibake on the way to the model. */
function decodeBase64Text(base64: string): string | null {
  try {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return null;
  }
}
