# Building something that does not exist yet

This project has written down no conventions of its own, so nothing here is
specific to it — these are the questions greenfield work usually turns on.
Evidence you find in the code outranks every one of them.

Nothing constrains you here, which is the danger: the result has to look like
it belongs in a codebase it was not shaped by.

Answer in the plan, or say why it does not apply:

- **The closest thing that already exists**, cited. Even for something new,
  some file in this repo already handles config, errors, logging or tests the
  way yours should. Find it and mirror it; do not start a second style.
- **Where it lives**, and why there rather than somewhere else. A new
  top-level directory is a claim about the project's structure — justify it.
- **Its boundary.** What it exposes, what it hides, what it depends on. If you
  cannot say that in three sentences, it is doing too much.
- **The smallest version worth having.** What is deliberately not in the first
  cut, listed, so scope is a decision rather than an accident.
- **How it is tested**, in the shape this project already tests things.
- **What happens on the failure path**, not only the intended one.

Flag in Risks if the plan introduces a dependency the project could do
without, builds for requirements nobody stated, or invents a second way to do
something the codebase already does.
