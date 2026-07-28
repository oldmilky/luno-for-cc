---
name: analyze
description: Generate or refresh the project map — the structural overview an agent reads before touching unfamiliar parts of the codebase. Use when the user says /analyze, after a structural change, or when the map has gone stale.
user-invocable: true
argument-hint: "[area to focus on]"
---

Write `.claude/project-map.md`: what lives where, what talks to what, and where
the load-bearing pieces are. Optional `$ARGUMENTS` narrows the refresh to one
area instead of the whole tree.

The map is **not auto-loaded** — `CLAUDE.md` is. This is the file an agent reads
on demand before working somewhere it has not been, which is why it must be
short enough to actually read and honest about size.

## What to gather

Measure, do not recall:

```bash
git ls-files -- src webview/src | xargs wc -l | sort -rn | head -20
git ls-files -- src webview/src | wc -l
```

- **Both halves.** `src/` is the extension host, `webview/src/` is the React
  app. They are separate builds joined by `postMessage`, and that seam is the
  single most important thing on the map.
- **The protocol.** Enumerate the message union in `webview/src/lib/rpc.ts` by
  area — chat, permissions, plan, skills, MCP, checkpoints — with a count each,
  both directions. A reader wants to know the shape, not all hundred names.
  Then say **what enforces it**: `HandlerTable` in `src/ui/messages.ts` makes a
  missing handler a compile error, and `test/unit/protocol-contract.test.ts`
  fails when the two declarations drift. That answer changes over time and is
  the most useful sentence on the map — check it, do not copy it forward.
- **Entry points.** `extension.ts`, `panel.ts`, `main.tsx`, and what each owns.
- **The pure core.** `src/core/*` imports no VS Code API and is unit-tested in
  isolation — say so, because it is the only part that can be tested cheaply.
- **The design system.** `themes/*` (core tokens per palette, derived in
  `_base.scss`) → modules; `design/motion.ts`; `design/icons.tsx`;
  `design/primitives/*`. There is no `design/tokens` directory — tokens are CSS
  custom properties, and they live in `themes/`.
- **Sizes.** Name the files over ~700 lines. Whichever is largest is the
  god-file — say so plainly rather than let each newcomer rediscover it, and
  measure which one that is rather than assuming it is still the last one.

## What makes this map worth reading

Anyone can list directories. What saves time is the part a directory listing
cannot show:

- **Where the seams are.** Which file you change to add a message, a token, a
  motion preset, an icon — one line each.
- **What is shared and therefore dangerous.** `theme.css`, `design/motion.ts`,
  `themes/_base.scss` are read by everything; two agents editing them at once is
  how the last rounds produced conflicts.
- **What is inherited and unreviewed.** The extension host came from a fork and
  the webview was rewritten. Say which parts have had eyes on them.
- **What is big for a reason and what is big by accident.**

## Format

Write it to `.claude/project-map.md`, under ~150 lines:

```markdown
# Project map

_Generated <date>. Regenerate with `/analyze` after structural changes._

## Two halves

<the postMessage seam, one paragraph>

## Extension host — `src/`

| Path | Owns | Lines |

## Webview — `webview/src/`

| Path | Owns | Lines |

## The protocol

<message areas with counts, where to add one>

## Where to change what

| To add… | Touch |

## Shared resources — edit deliberately

<the three files, and why>

## Size and debt

<files over 700 lines, with a one-line judgement each>
```

Prefer a table to a paragraph, a number to an adjective, and a path to a
description.

## Hard rules

- **Read-only apart from the map itself.**
- **Measure sizes and counts.** A map that says "large" instead of "2,763 lines"
  is a map nobody trusts twice.
- **Do not restate `CLAUDE.md`.** Rules live there; structure lives here. If the
  two disagree, `CLAUDE.md` wins and the map is stale.
- **Keep it short.** A map nobody finishes reading is a map nobody reads.
- Do not commit it — leave that to `/gitpush`.
