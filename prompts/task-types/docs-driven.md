# Building against external documentation

This project has written down no conventions of its own, so nothing here is
specific to it — these are the questions spec-driven work usually turns on.
Evidence you find in the code outranks every one of them.

The failure mode is specific: implementing the documentation you remember
rather than the one that governs the version installed here.

Answer in the plan, or say why it does not apply:

- **Fetch the source and cite the section.** Not a summary from memory. If a
  URL was given, read it; if a spec was named, find the current text.
- **Which version it describes, against which version is installed.** Read the
  installed one from the lockfile. When they differ, the lockfile wins and the
  plan says so.
- **The parts that actually apply.** A spec covers cases this project will
  never hit; name the subset you are implementing and what you are leaving out
  deliberately.
- **Where the docs and this codebase disagree** — naming, error handling,
  structure. The codebase wins for style; the spec wins for the wire.
- **What the spec requires that is easy to skip** — required fields, error
  codes, ordering, encoding, limits.
- **How conformance is checked**, beyond "it worked once".

Flag in Risks if the plan cites documentation it did not fetch, follows a
version other than the one installed, or copies an example verbatim without
adapting it to this codebase's conventions.
