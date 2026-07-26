---
name: audit
description: Deep read-only review of the branch diff against a base ref, across several lenses, with every HIGH finding independently refuted before it is reported. Use when the user says /audit or wants a thorough review of a branch rather than the working tree.
user-invocable: true
argument-hint: "[base ref, default main] [medium|high]"
---

A deep parallel read of the current branch's diff. One reviewer per lens, then
skeptics who try to **refute** each finding, so plausible-but-wrong ones do not
survive into the report.

`$ARGUMENTS`: first token is the base ref (default `main`), second is effort —
`medium` (default) runs one skeptic per finding, `high` runs three and takes the
majority.

This is the deeper sibling of `/check`. `/check` reads the working tree in
seconds; `/audit` reads everything since a base ref and is worth the wait before
something lands.

## Phase 0 — Scope

```bash
git diff --name-only <base>...HEAD
git diff --stat <base>...HEAD
```

Drop lockfiles and pure-formatting churn — a reformat commit is not review
material and will drown the signal. Empty list → say so and stop.

Note the shape early: a diff that is 90% one mechanical rename wants a different
read than one that rewrites the permission path.

## Phase 1 — Lenses, in parallel

Dispatch in **one message** so they actually run concurrently. Give each the
file list and the base ref.

| Lens        | Who                           | Looks for                                                                                                                                                               |
| ----------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Security    | `extension-security-reviewer` | spawn, credentials, the permission gate, CSP, postMessage trust                                                                                                         |
| Webview     | `webview-design-reviewer`     | tokens, motion presets, icons, the seven traps                                                                                                                          |
| Correctness | general-purpose               | wrong conditions, unawaited promises, swallowed errors, stale state, races                                                                                              |
| Contract    | general-purpose               | the `postMessage` union — a message added on one side and unhandled on the other, a field the host reads but the webview never sends, a type widened to make it compile |

The contract lens is specific to this codebase and earns its place: the protocol
is the seam between two separately-compiled programs, so nothing enforces it but
review. An unhandled message type fails silently at runtime.

Skip a lens whose files are untouched, and say which you skipped.

## Phase 2 — Refute

Every HIGH and CRITICAL goes to a skeptic whose brief is adversarial: _read the
code and show this cannot happen_. It must produce a concrete input, sequence or
state — "looks fine to me" is not a refutation, and neither is "looks bad" a
confirmation.

Default to **refuted when uncertain**. A review that reports ten things of which
six are real trains the reader to skim; one that reports four real ones gets
read.

At `high` effort, three skeptics per finding with different angles — does it
reproduce, is the input actually reachable, does an existing guard already cover
it — and the majority decides.

## Phase 3 — Report

```
## /audit — HEAD vs <base> (<n> files, effort <e>)

### Confirmed HIGH / CRITICAL (<n>)
1. **<title>** — [<file>:<line>](<file>#L<line>) · <severity>
   <what breaks>
   <the input or sequence that breaks it>
   Fix: <concrete>

### Confirmed MEDIUM / LOW (<n>)
- <title> — [<file>](<file>) — <one line>

### Refuted (<n>)
- <title> — <why it cannot happen, one line>

### Not reviewed
- <lens skipped and why · files dropped as churn>

### Verdict
clean · <n> confirmed · <n> HIGH+ — fix before this lands
```

## Phase 4 — Offer, do not act

Ask whether to fix the confirmed findings. **Nothing is edited during an audit.**
Fixing is a separate step the user opts into, so the review and the change never
blur into one diff.

## Hard rules

- **Read-only.** No edits, no commits, no pushes.
- **Verification gates the report.** Only what survived a skeptic is reported as
  confirmed.
- **No lint-level noise.** eslint, stylelint and prettier already ran; repeating
  them is not a finding.
- **Say what you did not look at.** A silent gap reads as a clean bill of health.
- A claim about rendered behaviour needs `/browser`, not an assertion.
