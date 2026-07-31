# Fixing broken behaviour

This project has written down no conventions of its own, so nothing here is
specific to it — these are the questions a fix usually turns on. Evidence you
find in the code outranks every one of them.

A fix that makes the symptom go away without explaining it is a guess wearing
a diff. The bar is a cause you can point at.

Answer in the plan, or say why it does not apply:

- **How the bug reproduces**, exactly. If you cannot state the input and the
  wrong output, you do not yet know what you are fixing.
- **The cause, at a line you have read.** Not "state was stale somewhere" —
  which value, set where, read where.
- **Why it was not caught.** The gap in the tests is part of the bug; the fix
  closes both.
- **The failing test first.** Name the test that fails before the change and
  passes after. That is what separates a fix from a coincidence.
- **Where else the same mistake lives.** The same wrong pattern is rarely in
  exactly one place — say whether you looked.
- **What the fix could break** — anything relying on the current behaviour,
  bug included.

Flag in Risks if the plan handles the symptom rather than the cause, widens a
catch to make an error disappear, or cannot name a test that would have caught
this.
