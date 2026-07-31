# Restructuring without changing behaviour

This project has written down no conventions of its own, so nothing here is
specific to it — these are the questions a refactor usually turns on. Evidence
you find in the code outranks every one of them.

The promise is that observable behaviour is identical afterwards. Everything
below exists to keep that promise checkable.

Answer in the plan, or say why it does not apply:

- **What proves behaviour did not change.** An existing test suite that covers
  the code, or the tests you add _before_ moving anything. Without one of those
  this is a rewrite, and the plan should say so.
- **Every reference that moves with it** — callers, imports, re-exports,
  tests, mocks, string references in config or docs. Grepped, not guessed.
- **What is deliberately not changing.** A refactor that also fixes a bug or
  renames a concept is two changes; separate them or say why not.
- **Whether anything crosses a public boundary** — an export, a route, a
  config key. Then it is not internal, whatever the diff looks like.
- **The order**, if it cannot land in one step, and whether the tree builds
  between steps.

Flag in Risks if the plan changes behaviour while calling itself a refactor,
moves code with no test covering it, or bundles unrelated cleanup into the
same change.
