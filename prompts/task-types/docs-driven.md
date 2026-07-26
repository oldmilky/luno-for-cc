# Docs-Driven Task Playbook

The user is implementing something against external documentation (an RFC, a
library's docs page, a vendor spec). Apply this playbook in addition to the
mode prompt.

The dominant risks here are **doc/version mismatch** (docs describe a newer
or older version than is installed) and **misinterpretation of the spec**.

## Mandatory exploration

1. **Fetch the referenced URL(s)** using your web-fetch capability. Read the
   relevant section in full. Cite the specific anchor / section heading.
2. **Pin against the installed version.** Read `package.json` /
   `pyproject.toml` / `Cargo.toml` to confirm the version. Then verify the
   docs you fetched apply to that version. State the version explicitly.
   Flag any deprecated / removed APIs you'd touch.
3. **Grep for prior usage** of the same library / API in the codebase. If
   there's existing usage, mirror its patterns and cite the file.
4. **Check for project-internal docs** that already describe how this
   library is used (`docs/`, README, ADRs). Cite them if found.
5. **If the docs reference multiple approaches** (e.g. "you can use X or
   Y"), name which one you chose and why — based on what the codebase
   already uses, what's most stable, and what fits the project's
   constraints.
6. **Read the test pattern** for the layer you're adding to.

## Required Risks coverage

Docs-driven Risks must explicitly address each:

- **Doc / version mismatch** — confirm the docs you read match the
  installed version. State the version you verified against.
- **API stability** — is the API marked stable, beta, experimental,
  deprecated? Flag anything that isn't stable.
- **Deprecated calls** — if the docs deprecate a call you'd use, name
  the recommended replacement and use it instead.
- **Breaking changes between versions** — if the project plans to
  upgrade soon, anticipate the API changes you'll inherit.
- **Misinterpretation risk** — if the spec is ambiguous on an edge case,
  state your interpretation explicitly so the reviewer can challenge it.
- **External dependency on the doc source** — if the doc URL goes away
  (vendor docs change), is the implementation still maintainable? Add
  a comment in code citing the relevant spec.
- **Compliance / standards conformance** — if implementing an RFC or
  standard, list the MUST / SHOULD requirements and which you cover.

## Required Verification coverage

- **Doc citation** — link to the specific doc section (with anchor) you
  implemented against
- **Version pin** — exact version string from the lockfile
- **Test command** — exact path of the test exercising the new behavior
- **Conformance check** — for standards (RFCs, JSON-Schema, OpenAPI),
  the validator command if one exists
- **Behavior verification** — example input → expected output, matching
  the spec's examples where possible

## Anti-patterns to flag

- Implementing against the latest docs when an older version is installed
- Picking an experimental API when a stable equivalent exists
- "Just trusting the docs" without writing a test that exercises the
  edge cases the docs describe
- Inventing behavior the docs don't specify because "it makes sense"
- Hardcoding values from doc examples instead of parameterizing
- No doc citation in the code (future maintainers won't know where the
  behavior comes from)
- Implementing a deprecated call because it's what the example shows
- Skipping the spec's MUST requirements as "nice to have"
