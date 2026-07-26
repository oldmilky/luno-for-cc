#!/usr/bin/env node
// PostToolUse(Edit|Write|MultiEdit): enforce the parts of
// `.claude/rules/comments.md` that can be detected without judgement.
//
// Deliberately narrow. Every pattern here is high-precision — a hit is a real
// violation, not a guess — because a comment linter that cries wolf gets muted
// within a day. "This comment explains WHAT the code does" needs a reader, and
// that reader is the review, not this script.
//
// Exits 2 on a hit so the finding reaches the agent that just wrote the line
// and can fix it immediately.

import fs from "node:fs";
import path from "node:path";

const CHECKED = new Set([".ts", ".tsx", ".js", ".mjs", ".scss", ".css"]);

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
if (!file || !CHECKED.has(path.extname(file).toLowerCase())) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const rel = path.relative(root, file);
if (rel.startsWith("..") || rel.split(path.sep)[0] === "ghost.one") {
  process.exit(0);
}

let source;
try {
  source = fs.readFileSync(file, "utf8");
} catch {
  process.exit(0);
}

// Code that was commented out rather than deleted. Anchored on syntax that only
// appears in real statements, so prose starting with "const" cannot trip it.
const COMMENTED_OUT =
  /^\s*\/\/\s*(const|let|var|function|return|import|export|await)\b.*[;{)]\s*$/;

const RULES = [
  {
    test: (line) => COMMENTED_OUT.test(line),
    msg: "commented-out code — delete it, git remembers"
  },
  // Before the Cyrillic rule on purpose: `Ф` is Cyrillic, and the generic rule
  // would otherwise claim an English comment is Russian. First match wins.
  //
  // No `\b` before `Ф` — JS word boundaries are defined by [A-Za-z0-9_], so
  // Cyrillic never sits on one and the assertion can never hold.
  {
    test: (line) => /^\s*\/\/.*Ф\d/.test(line),
    msg: "phase label points at docs/PLAN.md, which is not in the published repo"
  },
  {
    test: (line) => /^\s*\/\/.*[Ѐ-ӿ]/.test(line),
    msg: "Russian comment — code and comments are English"
  },
  {
    test: (line) =>
      /^\s*\/\/\s*TODO\b/i.test(line) && !/TODO\([^)]+\)/i.test(line),
    msg: "TODO without an owner — fix it now, or record it in docs/PLAN.md"
  },
  {
    test: (line) => /^\s*\/\/\s*(-{3,}|={3,}|\*{3,})\s*$/.test(line),
    msg: "decorative divider inside code"
  },
  {
    test: (line) => /^\s*\/\/\s*(Removed|Deprecated)\b/i.test(line),
    msg: "tombstone comment — delete the code and the note with it"
  }
];

const findings = [];
source.split(/\r?\n/).forEach((line, i) => {
  for (const rule of RULES) {
    if (rule.test(line)) {
      findings.push(`${rel}:${i + 1}  ${rule.msg}\n      ${line.trim()}`);
      break;
    }
  }
});

if (findings.length === 0) process.exit(0);

process.stderr.write(
  `Comment policy (.claude/rules/comments.md) — ${findings.length} to fix:\n\n` +
    findings.map((f) => `  ${f}`).join("\n\n") +
    "\n"
);
process.exit(2);
