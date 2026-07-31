# Infrastructure and delivery work

This project has written down no conventions of its own, so nothing here is
specific to it — these are the questions infrastructure work usually turns on.
Evidence you find in the code outranks every one of them.

The difference from ordinary code: a mistake here is not caught by a failing
test, it is caught by an outage.

Answer in the plan, or say why it does not apply:

- **What this touches when it runs** — which environment, which resources,
  whether anything is destroyed and recreated rather than updated in place.
- **The plan output before the apply.** For anything declarative, the diff is
  the review; say what you expect that diff to contain.
- **Blast radius.** If this is wrong, what stops working, and for whom.
- **The rollback**, as an exact command or an exact revert, not "redeploy the
  previous version" in the abstract.
- **Which secrets or credentials are involved**, and where they come from.
  None of them appear in the plan.
- **What proves it worked** after the rollout, beyond the pipeline going green.

Flag in Risks if the change replaces a stateful resource, widens a permission
or a network rule, has no rollback, or is only verifiable in production.
