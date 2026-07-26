---
paths:
  - "**/*.{ts,tsx,js,mjs,scss,css}"
---

# Comment policy

**Default: no comments.** Self-explanatory code — good names, small functions,
clear control flow — needs none. Feeling the urge to comment means: rename a
variable, extract a helper, or split the block. A comment is the last resort.

## Allowed only when the WHY is genuinely non-obvious

- A hidden constraint or subtle invariant the code depends on
  `// must resolve through resolveClaudeBinary — a direct bundled path breaks a CLI-less build`
- A workaround for a specific bug or library quirk, named concretely
  `// framer writes opacity inline; a class rule cannot outrank it`
- Behaviour that would visibly surprise a careful reader
- A measured number and where it came from
  `// 450ms: crossing a toolbar strobes every label below this`
- Public-API JSDoc on exported types and shared helpers — only where the
  contract is non-trivial (param shape, error semantics, who must call it)

This codebase leans harder on the second and fourth kinds than most, and that is
deliberate: the traps in `CLAUDE.md` are all invisible to the compiler, so the
comment is the only thing standing between the next reader and the same bug.

## Forbidden — delete on sight

- Explaining _what_ the code does: `// fetch the session`, `// loop over items`,
  `// set state`, `// return result`. The identifiers already say it.
- Task/PR/ticket references: `// added for #123`, `// per Rodion's request`.
  Belongs in the commit message; rots fast.
- Russian comments inside code — code is English.
- Decorative banners _inside_ a function: `// ===== helpers =====`, `// ---`.
  A file-top block explaining the module's job is fine and this repo uses one.
- Commented-out code — delete it, git remembers.
- Tombstones: `// Removed X`, `// Deprecated Y`, `// TODO: refactor later`
- Redundant JSDoc on obvious functions: `/** Returns the id */ getId()`
- Restating a type signature: `// userId: string` above `userId: string`
- A TODO without an owner and a concrete next step — fix it now, or write it
  down in `docs/PLAN.md` where the rest of the backlog lives

## Phase labels

Comments that read `Converted from Tailwind in Ф2а` or `stripped in Ф0` point at
a phase log that is not in the published repo. Do not add more. Existing ones
are a known cleanup, not a pattern to follow.

## The test

If a reviewer cannot tell _why_ a comment is there without reading the
surrounding 20 lines, the comment is wrong: rewrite it to state the WHY
explicitly, or delete it.

Applies to every language in the repo. Project-level Markdown (CLAUDE.md, rules,
README, docs) is exempt — those files _are_ the explanation.
