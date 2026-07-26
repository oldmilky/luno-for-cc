---
name: ship
description: Full delivery pipeline for non-trivial work — plan, implement, gates, browser evidence, independent review, report. Use when the user says /ship or asks to take a feature end to end. Never commits.
user-invocable: true
argument-hint: "<what to build>"
---

Shipping end to end. Task: `$ARGUMENTS`

This is the full ceremony: plan → implement → gates → browser evidence →
independent review → report. No auto-commit; the user reviews the diff and runs
`/gitpush`.

Each phase has a gate. On a failure, decide between fix-and-retry (cheap and
obvious) and stop-and-ask (risky or ambiguous). When in doubt, ask — one
question is cheaper than 400 lines in the wrong place.

## Phase 0 — Pre-flight

1. Read `CLAUDE.md`. If the task touches `webview/src/**`, read `docs/TOKENS.md`
   too.
2. `git status --porcelain` — start from a known state. Uncommitted work from
   something else means stop and ask, because the final diff will not be yours.
3. Nothing long-running needs to be up. Unlike a web app, this project has no
   dev server to depend on: `/browser` starts its own harness in Phase 5. If the
   user happens to be running `bun run dev:webview`, leave it alone.

## Phase 1 — Plan

Before writing code, state:

- Which files get created or modified, with paths
- Which side of the `postMessage` boundary the work lives on — extension host,
  webview, or both. If both, name the messages that cross
- Which existing primitives, tokens and motion presets get reused instead of
  new ones
- What will prove it works: which test, and what the browser harness will show

**Gate 1.** Trivial work — a single-file fix, a copy change — proceeds without
approval. Anything touching multiple files, the protocol, or the permission
path gets the plan shown as a todo list and **stops for confirmation**.

## Phase 2 — Implement

Host first when both sides are involved: the protocol shape it exposes is what
the webview then consumes.

The rules that matter here, all from `CLAUDE.md`:

- No colour, radius, shadow or duration literals — tokens
- Motion is a spread preset from `design/motion.ts`, never a hand-written
  transition, even when the number would match
- Icons come from `design/icons.tsx`; tooltips from `design/primitives/Tooltip`
- New protocol messages are added to the union in `webview/src/lib/rpc.ts` and
  handled host-side — an unhandled message fails silently, which is the worst
  kind
- `src/core/*` imports zero VS Code APIs. Keep it that way; that is what makes
  it testable

The PostToolUse hooks format the file and check the comment policy as you write.
Do not run prettier by hand.

## Phase 3 — Gates

```bash
bun run lint    # tsc over BOTH projects, then eslint, then stylelint
bun run test    # 357 passed, 6 skipped is the floor
```

**Gate 3.** Failures in files you wrote: fix, up to three attempts. Failures in
files you did not touch: stop and report — do not "fix" them inside a feature
change. New eslint _warnings_ are worth a line in the report, not a stop.

## Phase 4 — Tests for the change

If the work touched `src/core/*` or `src/services/*`, it is unit-testable and
should have a test. If it touched only rendering, it usually is not — say so.

Never invent a test that passes regardless. A missing test named in the report
is better than a placeholder that always goes green.

## Phase 5 — Browser evidence

Skip only if nothing under `webview/src/**` changed — and say so.

Otherwise run `/browser`: start the harness, drive the state the change affects,
and come back with something measured. A screenshot proves it rendered; a
computed value proves it is right.

**Gate 5.** A dangling class name, a dead keyframe or a killed opacity all look
correct in the diff and wrong on screen. This phase is the only place they
surface.

## Phase 6 — Console sanity

In the same harness run, read the console. A missing favicon is noise. A React
key warning, an act() warning, a failed asset, or a thrown error is yours until
proven otherwise.

## Phase 7 — Independent review

Dispatch the reviewers that match what you touched, in parallel, briefed with
the file list:

- `src/**` → `extension-security-reviewer`
- `webview/src/**` → `webview-design-reviewer`

They run in their own context and read the diff cold, which is the point — you
have been staring at this for an hour.

**Gate 7.** CRITICAL or HIGH: stop, do not write a "ready to commit" report, fix
and re-run from Phase 3. MEDIUM/LOW: proceed, but quote them verbatim in the
report so the user sees them before committing.

Skip only for work with no surface at all — a doc edit, a comment. Say so in one
line. When unsure, run it; it costs a minute.

## Report

```
## /ship — <feature>

Phases:  plan ✅ · implement ✅ · gates ✅ · tests ✅ · browser ✅ · review ✅

### Changed
- [path](path) — why

### Crossing the boundary (if any)
- `<message>` — webview → host, handled in `panel.ts:<line>`

### Evidence
- gates: lint clean, <n> passed / <n> skipped
- browser: <what was driven, and the number that was measured>
- review: <verdict per agent>

### Concerns raised, not blocking
- <verbatim from the reviewers>

### Left undone
- <anything skipped, and why>

### Next
Review the diff, then `/gitpush`.
```

## Hard rules

- **Never commit or push.** That is `/gitpush`, and it is the user's call.
- **Never skip a phase silently.** Skipping is fine; skipping quietly is not.
- **Never touch `.env`, credentials, or `ghost.one/`.**
- **Never invent a test to fill Phase 4.**
- **Stop on ambiguity.**
