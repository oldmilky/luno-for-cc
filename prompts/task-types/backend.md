# Backend Task Playbook

The user is changing backend code (API routes, controllers, services, models,
middleware, migrations). Apply this playbook in addition to the mode prompt.

## Mandatory exploration (before drafting Approach)

1. **Read the route table / router file.** Confirm where this endpoint registers and
   what middleware chain wraps it (auth, validation, rate limit, tenant scoping).
2. **Read the canonical example.** Find one existing endpoint of the same shape
   (CRUD, list-with-filters, webhook, batch, etc.) and read it end-to-end. The plan
   must cite it as the file you're mirroring (file:line).
3. **Read the schema/model.** Every field your code reads or writes must be confirmed
   in the model definition. List the fields explicitly in Context.
4. **Read the test file pattern.** Find the test file that covers the canonical
   example. Note its shape (unit + integration) so the new code can be tested
   the same way. The plan's Verification section must reference it.
5. **List call sites and consumers.** For any change to a public response shape:
   grep for every frontend / downstream caller. Backwards compatibility is a Risk
   bullet, not an afterthought.
6. **For schema migrations**: list every consumer of the affected columns/tables,
   plus the rollback path.

## Required Risks coverage (in addition to the standard list)

Backend Risks must explicitly address each of these:

- **Auth & permissions** — does the new code path enforce the same auth as the
  canonical example? Cite the middleware/check that proves it.
- **Multi-tenancy / scoping** — confirm that new filter/query inputs cannot bypass
  `storeId` / `tenantId` / `userId` scoping. A new range filter applied *before*
  the tenant `$match` is a security bug.
- **Transaction boundaries** — for multi-write operations, where are the commit /
  rollback boundaries? What happens on partial failure?
- **Rate limits & quotas** — new external calls or expensive queries should
  acknowledge any rate limit they could hit.
- **Response shape (breaking change)** — if the response shape changes (e.g.
  array → `{data, pagination}`), this is breaking for every consumer. Flag
  consumers explicitly. Consider a feature flag or version bump.
- **Performance under scale** — for new query shapes, state expected behavior
  on the *largest* realistic dataset, not the current dev DB size.
- **Index requirements** — for any new `$match`, `find`, or sort field, confirm
  an index exists or call out the index that needs to be added before this
  ships. For aggregation pipelines, note where in the pipeline the filter sits
  (post-`$addFields` filters can't use field indexes).
- **Migration safety** — for schema changes: zero-downtime path, backfill
  strategy, rollback command.

## Required Verification coverage

- **Test command** — exact string, including the specific test file:
  `npm test -- path/to/foo.test.ts` (not just `npm test`)
- **Typecheck command** — exact string
- **For API changes** — `curl` or `httpie` example exercising the new route
  (request body, headers, expected response shape)
- **For migrations** — exact run command + exact rollback command
- **For shape changes** — note that downstream consumers must be updated; list
  them or explicitly defer to a follow-up

## Anti-patterns to flag

If the plan would do any of these, call it out in Risks (or refuse and ask):

- Filtering by user-controlled field *before* tenant scoping
- Adding a range filter without a backing index on the underlying field
- Changing a response shape without versioning or a feature flag
- "Apply same pattern to all other widgets" without listing them — implicit
  scope creep
- Hand-wave on search semantics ("filtered post-query in JS") without stating
  whether pagination or filter happens first and what the order means at scale
