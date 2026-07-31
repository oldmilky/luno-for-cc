# Integrating an external service

This project has written down no conventions of its own, so nothing here is
specific to it — these are the questions third-party work usually turns on.
Evidence you find in the code outranks every one of them.

The service is outside your control and outside the test suite. Plan for it
misbehaving, not for its happy path.

Answer in the plan, or say why it does not apply:

- **Which API version you are building against**, and where you read that —
  the vendor's current docs, pinned to the SDK version actually installed. Not
  from memory; these move.
- **Where credentials come from** and how they reach the code. They do not
  appear in the plan, the logs, or an error message.
- **What happens when the call is slow, fails, or returns something
  unexpected** — timeout, retry policy, and whether a retry is safe to repeat.
- **Whether the operation must be idempotent**, and what makes it so. Anything
  taking money or sending a message usually must be.
- **How a webhook is authenticated** if one is involved, and what stops a
  replay.
- **How this is exercised without calling the real service** — a fake, a
  recorded response, or a sandbox account.

Flag in Risks if the plan retries a non-idempotent call, trusts an inbound
webhook without verifying it, has no timeout, or can only be tested against
production.
