#!/usr/bin/env node
// PostToolUse(Edit|Write|MultiEdit): run prettier over the file that was just
// written, so formatting never becomes a review topic.
//
// One Node script rather than a bash shim calling PowerShell: the shim pattern
// needs an absolute path baked in, which breaks the moment the repo is cloned
// anywhere else.
//
// Never blocks. A formatter that can fail a turn is a formatter that gets
// disabled.

import { execFileSync } from "node:child_process";
import path from "node:path";

const FORMATTABLE = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".json",
  ".scss",
  ".css",
  ".md"
]);

const payload = await new Promise((resolve) => {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    try {
      resolve(JSON.parse(raw));
    } catch {
      resolve(null);
    }
  });
  process.stdin.on("error", () => resolve(null));
});

const file = payload?.tool_input?.file_path;
if (!file) process.exit(0);
if (!FORMATTABLE.has(path.extname(file).toLowerCase())) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

// Outside the repo, or inside a directory prettier is told to skip — either way
// not ours to touch.
const rel = path.relative(root, file);
if (rel.startsWith("..") || path.isAbsolute(rel)) process.exit(0);
if (rel.split(path.sep)[0] === "ghost.one") process.exit(0);

try {
  execFileSync("bunx", ["prettier", "--write", "--ignore-unknown", file], {
    cwd: root,
    stdio: "ignore",
    timeout: 20_000,
    shell: process.platform === "win32"
  });
} catch {
  // Unformattable (a syntax error mid-edit is the common case) or prettier is
  // not installed yet. The lint gate will say so; a hook should not.
}

process.exit(0);
