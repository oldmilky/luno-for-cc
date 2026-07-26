# Full-Stack Task Playbook

The user is changing code that spans both backend and frontend (e.g. a feature
that requires a new API endpoint AND a UI surface that consumes it). Apply this
playbook in addition to the mode prompt — and read both the backend and frontend
playbooks' "Anti-patterns" sections too.

## Mandatory exploration

1. **Read the backend route table AND the frontend caller(s).** Confirm both
   sides exist or identify which side needs creation. Cite both file:line.
2. **Read shared contracts.** TypeScript types, OpenAPI/JSON-Schema specs,
   protobuf definitions — anything the two sides depend on. List them.
3. **Find the canonical existing fullstack feature.** Read end-to-end how data
   flows: form submit → API call → controller → service → DB → response → UI
   render. Cite each layer. Mirror this flow in your plan.
4. **Read the e2e / integration test pattern** if one exists. The new feature
   should be covered the same way.
5. **Identify the deploy boundary.** Backend and frontend usually deploy
   independently — note which deploys first and what state the system is in
   between deploys.

## Required Risks coverage

Fullstack Risks must explicitly address each:

- **API contract drift** — request/response shapes must match exactly. Field
  names, optionality, enum values. State how you'll keep both sides in sync
  (shared types? OpenAPI generation?).
- **Phased deploy state** — for the period after one side ships and before
  the other catches up: does the system fail gracefully? Is the new endpoint
  unused (safe) or the new UI calling a missing endpoint (broken)?
- **Auth / tenant scoping at both layers** — the frontend may show data the
  backend would refuse, or vice versa. Confirm both layers enforce the same
  constraints.
- **Type safety across boundary** — generated types, runtime validators
  (zod / class-validator), or hand-written DTOs — which strategy and why.
- **Error propagation** — backend errors must reach the user understandably.
  State which error shapes the UI handles and which fall through to a
  generic "something went wrong" message.
- **Loading / empty / error UI states** — every new fetch needs all four
  visual states (loading, success, empty, error). Confirm they exist.
- **Pagination / large data** — if the endpoint returns lists, the UI must
  paginate or virtualize. Confirm the strategy at both layers matches.

## Required Verification coverage

- **Backend test command** — exact string for the new endpoint's tests
- **Frontend test command** — exact string for the new component's tests
- **E2E test** — exact command + scenario name (or note one will be added)
- **Manual verification recipe**:
  - How to run dev servers (both BE and FE)
  - URL to visit
  - Steps to exercise the feature
  - What to check in browser network tab + server logs
- **Type drift check** — command to regenerate / verify shared types if you
  use codegen

## Anti-patterns to flag

- Adding a backend response field without updating the frontend consumer
- Hardcoding the API base URL in the UI instead of using the existing client
- Implementing tenant scoping only on one layer
- Returning HTTP 200 with `{error: "..."}` body instead of a real error code
- Skipping the loading / empty / error states "we'll add them later"
- Changing the response shape and not bumping API version (breaks every
  deployed frontend client until they update)
