# Backend work

This project has written down no conventions of its own, so nothing here is
specific to it — these are the questions server-side work usually turns on.
Evidence you find in the code outranks every one of them.

Answer in the plan, or say why it does not apply:

- **Which existing endpoint has this shape**, read end to end, cited. The plan
  mirrors it rather than inventing a second house style.
- **What wraps it** — auth, validation, rate limiting, tenant scoping. Does the
  new path get the same chain, and what proves it?
- **Every field read or written**, confirmed against the schema rather than
  assumed from a name.
- **Who consumes the response.** A changed shape is breaking for all of them;
  name them or say the change is additive.
- **What the query does on the largest realistic dataset**, not the dev one,
  and which index that depends on.
- **Where the commit and rollback boundaries sit** for anything that writes
  more than once, and what a partial failure leaves behind.

Flag in Risks if the approach would filter on user input before tenant scoping,
add a filter or sort with no backing index, change a response shape without a
version or a flag, or migrate a schema without a backfill and a rollback.
