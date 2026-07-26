# New Implementation Task Playbook

The user is building something that doesn't exist yet (a new feature, module,
service, tool, or component from scratch). Apply this playbook in addition to
the mode prompt.

The dominant risk for new code is **inappropriate abstraction** and **drift
from project conventions** — the wrong shape locks in tech debt that is hard
to reverse later.

## Mandatory exploration

1. **Read project conventions** (CLAUDE.md, AGENTS.md, README) for what good
   looks like in this codebase. Cite the conventions file in Approach.
2. **Find the closest analogous existing thing.** Even if it's not the same
   kind of feature, something nearby has the right shape. New API endpoint?
   Read a sibling endpoint. New CLI command? Read a sibling command. Cite
   it as the canonical example to mirror.
3. **List dependencies before adding new ones.** If a `package.json`,
   `pyproject.toml`, or `Cargo.toml` already has a library that solves
   the problem (HTTP client, validator, retry), use it. Adding a new dep
   requires explicit justification in Risks.
4. **Identify where this fits in the module structure.** Don't drop new
   files in arbitrary locations — match the existing organization.
5. **Read the test pattern** for the layer you're adding to. New code
   without tests is incomplete.

## Required Risks coverage

New implementation Risks must explicitly address each:

- **Premature abstraction** — are you generalizing for hypothetical future
  cases, or solving the actual case in front of you? Default to concrete.
  Three similar lines is better than a wrong abstraction.
- **Convention drift** — does the new code match the codebase's existing
  naming, error handling, logging, and import style? Cite the file you
  mirrored.
- **Dependency selection** — for any new dep: license compatibility,
  maintenance status (last commit, open issues), bundle/binary size,
  transitive footprint. Justify the pick over alternatives that already
  exist in the project.
- **Naming** — does the public surface use names that match the rest of
  the codebase's vocabulary? (e.g. don't introduce `fetchUserData()` if
  the codebase uses `getUser()` everywhere.)
- **Module placement** — is the file in the right folder per the project's
  layout? Cite a sibling file that establishes the convention.
- **Future extensibility tradeoff** — what design decisions are hard to
  reverse later? Note them so the user can push back if needed.
- **Test coverage** — what's covered, what isn't, why. New code starting
  with low coverage is a debt seed.
- **Documentation** — does this need a README update, an inline docstring,
  or a usage example? Whose responsibility?

## Required Verification coverage

- **Test command** — exact path and command for the new code's tests
- **Typecheck / lint command** — exact strings
- **Integration check** — how does the new code interact with existing
  surrounding code? Show a manual or automated check.
- **End-user verification** — for user-facing features: how to exercise
  the new behavior. URL, command, UI flow.
- **Documentation update** — note any README / docs files that need
  updates as part of this change

## Anti-patterns to flag

- Adding a new dependency when the project already has one that does
  the job
- Creating a new abstraction layer "for future flexibility" without a
  concrete second use case
- Naming that breaks codebase conventions for personal preference
- Dropping files in a random folder because the right location wasn't
  obvious
- Skipping tests because "I'll add them later"
- Reinventing a utility that exists in `lib/` or `utils/`
- Over-engineering: a function with three callers does not need a
  factory + builder + strategy pattern
- Introducing a new code style (different naming, different error
  handling) instead of mirroring the existing pattern
