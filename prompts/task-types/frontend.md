# Frontend work

This project has written down no conventions of its own, so nothing here is
specific to it — these are the questions UI work usually turns on. Evidence you
find in the code outranks every one of them.

Answer in the plan, or say why it does not apply:

- **Which sibling component you are mirroring**, cited: file layout, prop
  shape, and how it is styled. Match what is there; do not introduce a second
  styling approach.
- **Which primitives already exist** — button, input, modal, toast. Rebuilding
  one that exists is the most common waste in this layer.
- **Where design values come from** — tokens, theme file, or hard-coded. If a
  system exists, new values come from it.
- **Every state the surface can be in**: loading, empty, error, and populated.
  A plan that describes only the happy path is incomplete.
- **How it is reached by keyboard**, and what happens to focus when something
  opens and closes.
- **What re-renders**, if the change touches state on a list or a hot path.

Flag in Risks if the approach adds a dependency for something small, puts a
click handler on a non-interactive element, ships a new string past an
existing i18n setup, or changes a shared primitive without naming its
consumers.
