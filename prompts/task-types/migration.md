# Upgrading or replacing something

This project has written down no conventions of its own, so nothing here is
specific to it — these are the questions a migration usually turns on. Evidence
you find in the code outranks every one of them.

The work is rarely the new thing. It is everything still holding the old one.

Answer in the plan, or say why it does not apply:

- **The exact versions**, from and to, read from the lockfile rather than
  assumed from the manifest.
- **What actually breaks between them**, from the upgrade notes for every
  version you are crossing — not just the newest. Cite them.
- **Every place the old thing is used**, grepped. The count is the size of the
  job; a plan without it is a guess.
- **Whether both can coexist** while you move, or whether it is one commit for
  everything. Say which, because it decides how this ships.
- **What happens to data or state** written by the old version, if any, and
  how it is read afterwards.
- **The rollback**, and whether it is still available after the first
  irreversible step.

Flag in Risks if the plan crosses several major versions in one step, upgrades
something with no test coverage over its use, or has no way back once data has
been written in the new shape.
