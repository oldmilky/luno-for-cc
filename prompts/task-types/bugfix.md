# Bug Fix Task Playbook

The user wants to fix broken behavior. Apply this playbook in addition to the
mode prompt.

The biggest single failure mode for bug fixes is **patching the symptom instead
of the root cause**. The whole playbook is structured to push back against that.

## Mandatory exploration

1. **Reproduce the bug** before drafting. State the exact reproduction steps in
   Context. If you cannot reproduce it (intermittent / data-dependent /
   environment-specific), say so explicitly and explain what evidence you're
   working from instead.
2. **Find when it was introduced.** Use `git log -S '<symbol>'` or
   `git blame` on the failing line. Cite the commit. This often reveals the
   intent and constrains the fix.
3. **Find adjacent code paths with the same shape.** A bug rarely lives alone.
   If `processOrders()` has the bug, search for sibling `processX` functions
   that may have the same defect.
4. **Find the test that should have caught this** — does it exist and was it
   skipped/disabled? Does it not exist at all? Either way, the fix must
   include a test that fails before the fix and passes after.
5. **Read the function's call sites.** Confirm the fix doesn't break any
   caller that depends on the buggy-but-working behavior.

## Required Risks coverage

Bug fix Risks must explicitly address each:

- **Root cause vs. symptom** — name the actual root cause. If you're treating
  a symptom because the root cause is too risky to fix now, say so explicitly
  and link to a follow-up issue.
- **Regression risk to other paths** — list other code paths that exercise
  the same function / data. Could the fix break them?
- **Adjacent bugs** — did exploration find sibling code paths with the same
  defect? List them, even if not in scope to fix now.
- **Test coverage gap** — name the missing test that allowed this to ship.
  The fix must add it.
- **Backward compatibility** — if the bug was load-bearing (callers
  worked around it), fixing it can break them. List affected callers.
- **Data already corrupted** — if the bug produced bad data in production,
  identify the data and decide: leave it, migrate it, or quarantine it.

## Required Verification coverage

- **Failing test** — exact path of the test that fails before the fix
- **Test command** — exact string to run that test in isolation
- **Repro recipe** — manual steps to confirm the bug is gone (matching the
  ones from Context, with the expected outcome flipped)
- **Regression check** — command to run the broader test suite around the
  affected area (not just the new test)
- **Production verification** (if applicable) — what to check in logs /
  dashboards after deploy to confirm the bug stayed fixed

## Anti-patterns to flag

- "Fixed it!" without a failing test to prove it
- Try/catch swallowing the error instead of fixing it
- Adding a special-case branch for the buggy input instead of fixing the
  underlying logic
- Fixing the bug only at the call site that complained, leaving identical
  bugs in 3 other call sites
- Changing test assertions to match the buggy output instead of fixing
  the code
- "It works on my machine" — if you can't reproduce in test or CI, the
  fix is unverified
- Deleting a test that was failing because of the bug
