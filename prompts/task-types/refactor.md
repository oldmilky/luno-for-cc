# Refactor Task Playbook

The user is restructuring existing code without changing observable behavior
(rename, extract, inline, split, consolidate, simplify, move). Apply this
playbook in addition to the mode prompt.

The dominant risk in refactors is **missed call sites and silent behavior
changes**. The bar for completeness is exhaustive grep, not "I think I got
them all".

## Mandatory exploration

1. **List every call site of the symbols being moved/renamed.** Use grep
   (or rg) across the entire workspace, including tests, docs, and config.
   Do not trust IDE-style "find references" alone — it misses dynamic
   references and string literals.
2. **List exports and re-exports.** A rename in module A may need updates
   in `index.ts` re-export files, package entry points, or barrel files.
3. **List every test file** referencing the symbols. Test code counts as
   a call site.
4. **List documentation references** — `README.md`, `docs/`, `CHANGELOG`,
   inline doc comments, generated API docs. Names appear there too.
5. **If the symbol is part of the public API surface** (exported from
   the package entry, mentioned in published docs), call it out
   explicitly — this is a breaking change for consumers.
6. **Check `git log` for recent activity** on the file you're about to
   restructure. Active churn = high risk of merge conflict.

## Required Risks coverage

Refactor Risks must explicitly address each:

- **Missed call sites** — what's your confidence the grep was exhaustive?
  Were there string-literal references, dynamic imports, or configs that
  reference the old name?
- **Broken re-exports** — every barrel / index file that re-exports the
  symbol. List them.
- **Stale documentation** — every doc / comment / README that references
  the old name.
- **Public-API breaking change** — if this is a published package or a
  shared library, this is a major-version bump. State whether a
  deprecation alias should be left in place during a migration window.
- **Test coverage gap** — refactoring without good tests is dangerous.
  Note which behaviors are NOT covered by tests, where a refactor could
  silently change semantics.
- **Adjacent improvements deferred** — if you spotted other tangential
  cleanups while exploring, list them under "Out of scope" — refactor
  PRs should stay focused.
- **Performance change** — refactors *should* be perf-neutral, but
  splitting / inlining can shift behavior. For perf-sensitive code,
  state how you'll confirm.
- **Behavior preservation** — explicitly confirm: this refactor does
  not change observable behavior. If it does (even slightly), it's not
  a pure refactor — flag it.

## Required Verification coverage

- **Full-workspace typecheck** — exact command
- **Full test suite** — exact command (not just the renamed module's
  tests — refactors affect everything)
- **Grep verification** — exact command showing zero remaining
  occurrences of the old symbol (account for test fixtures and docs)
- **For published packages**: SemVer bump notation (major / minor /
  patch) and what changelog entry says
- **Manual smoke test** — for runtime behavior, exercise the most
  common code path through the refactored area

## Anti-patterns to flag

- "Find and replace" without grep verification
- Refactoring without running the full test suite (just the local one)
- Mixing a refactor with a behavior change ("while I'm in here…")
- Renaming a public API without a deprecation window
- Removing dead code that turned out to have a non-obvious caller
- Splitting a file just because it's "long" — line count isn't a
  refactor reason
- Premature consolidation (merging two similar-looking functions that
  are about to diverge)
- Premature extraction (pulling a helper out for one caller)
- Refactor PRs that touch 50+ files (impossible to review carefully —
  split them)
