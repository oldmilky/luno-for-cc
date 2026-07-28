#!/usr/bin/env node
// SessionStart(compact): re-inject the handful of facts that, once compacted
// away, cost a whole round to rediscover.
//
// Not a summary of CLAUDE.md — that gets re-read anyway. This is the short list
// of things an agent silently gets wrong: the runtime, the gate numbers, and
// the traps that are invisible to the compiler.

const brief = `## Post-compaction brief — LUNO for CC

Runtime is **bun**, not npm. Respond in Russian; code and comments in English.

A VS Code / Cursor extension in two halves that talk over postMessage:
  src/         extension host — spawns the user's own \`claude\` CLI, permissions, MCP
  webview/src/ React 19 + SCSS modules + framer-motion, reads design tokens only

DEFINITION OF DONE — do not claim completion without all four:
  1. \`bun run lint\` clean (tsc over BOTH projects, then eslint, then stylelint)
  2. \`bun run test\` at the count in CLAUDE.md, or better — never below
  3. behaviour verified where it runs — the browser harness for UI, tests for host logic
  4. every claim tied to output actually seen

Traps that are invisible to the compiler:
  - framer writes opacity inline; no class rule can outrank it
  - CSS Modules scope @keyframes names — \`:global(name)\` in an animation shorthand is a dead reference
  - CSS cannot animate an exit; both directions need framer + AnimatePresence
  - exits use --ease-soft, never --ease-out
  - a dangling \`s.someName\` renders unstyled and the build stays green

Never hard-code a colour, duration or icon — tokens, design/motion.ts, design/icons.tsx.
Never commit anything under ghost.one/.
docs/PLAN.md and docs/DESIGN.md are gitignored working notes; read them for context.
`;

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: brief
    }
  })
);
