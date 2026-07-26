---
name: check
description: Fast read-only review of the uncommitted working tree. Use when the user says /check, or mid-feature before continuing or committing. Cheaper than a full review and never edits anything.
user-invocable: true
argument-hint: ""
---

A gut-check between edits: run the gates, then fan the specialist reviewers
over **uncommitted changes only**. Read-only — no edits, no commit, no push.

Use it mid-feature after a meaningful chunk of work, and before `/gitpush` as a
safety net. It is not a branch review: committed history is out of scope.

## Phase 0 — Scope and gates

```bash
git status --porcelain
git diff --name-only
git diff --staged --name-only
```

Empty on all three → say there is nothing uncommitted and stop.

Then run the gates, because a review of code that does not compile is wasted:

```bash
bun run lint
bun run test
```

Report a failure immediately and stop — a red gate is the finding.

## Phase 1 — Fan out

Split the changed files and dispatch **in one message so they run in parallel**:

| Changed                         | Reviewer                       |
| ------------------------------- | ------------------------------ |
| anything under `src/**`         | `extension-security-reviewer`  |
| anything under `webview/src/**` | `webview-design-reviewer`      |
| either                          | a correctness pass — see below |

Give each agent the explicit file list and this instruction: _review only these
files, against the working-tree diff, and report HIGH/CRITICAL first._

The correctness pass is a general-purpose agent asked to find bugs a reader
would miss: wrong condition, off-by-one, a promise not awaited, an error path
that swallows, state that can go stale. Tell it to ignore style — the linters
own that now.

## Phase 2 — Verify before reporting

Every HIGH and CRITICAL gets one skeptic whose job is to **refute** it: read the
code around the claim and say whether the described failure can actually happen,
with a concrete input or sequence. Default to refuted when unsure.

Findings that survive get reported. Refuted ones get one line each. This step is
not ceremony — in past rounds it caught a `motion.li` conversion that killed a
class-level opacity, an `overflow: hidden` clipping a focus ring, and a
truncation bug inside the tooltip primitive itself.

MEDIUM and LOW are listed unverified, one line each. Do not expand them.

## Phase 3 — Report

```
## /check — working tree (<n> files)

Gates: lint <state> · test <n> passed / <n> skipped

### Confirmed HIGH / CRITICAL (<n>)
1. **<title>** — [<file>:<line>](<file>#L<line>)
   <what breaks, and the input or sequence that breaks it>
   Fix: <concrete>

### Worth a glance (<n>)
- <title> — [<file>](<file>)

### Refuted (<n>)
- <title> — <one line why not>

### Verdict
clean, keep going  /  <n> to fix before commit
```

Nothing confirmed → a single line: `/check clean across <n> files, gates green`.

## Hard rules

- **Read-only.** No edits during the review. Offer to fix afterwards as a
  separate, explicit step.
- **Working tree only.** Committed history belongs to a branch review.
- **Only HIGH/CRITICAL are verified.** Verifying everything turns a gut-check
  into the thing it exists to avoid.
- **No lint-level noise.** eslint, stylelint and prettier already ran; repeating
  them is not a finding.
- A claim about rendered behaviour needs `/browser`, not an assertion.
