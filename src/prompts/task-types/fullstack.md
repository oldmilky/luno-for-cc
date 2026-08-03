# Work crossing client and server

This project has written down no conventions of its own, so nothing here is
specific to it — these are the questions a change spanning both layers usually
turns on. Evidence you find in the code outranks every one of them.

The contract between the halves is the whole risk. Everything else is two
ordinary changes.

Answer in the plan, or say why it does not apply:

- **The exact shape crossing the boundary** — fields, types, nullability,
  error shape. Written once in the plan, so both sides are built against the
  same thing rather than two readings of a sentence.
- **Where that shape is defined**, and whether both halves read the same
  definition or each restate it. If they restate it, say what keeps them
  aligned.
- **Which half ships first**, and whether the other keeps working in the gap.
  A deploy is rarely simultaneous.
- **What the client does when the call fails** — not just the success path.
- **Whether existing callers of the old shape still work**, named.

Flag in Risks if the plan changes both sides at once with no compatible
intermediate state, invents a second source of truth for the same shape, or
leaves the failure path undescribed.
