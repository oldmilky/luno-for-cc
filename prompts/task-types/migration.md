# Migration / Upgrade Task Playbook

The user is upgrading a dependency, framework, language version, or migrating
from one library/service to another. Apply this playbook in addition to the
mode prompt.

The dominant risk in migrations is **silent behavioral changes that pass tests
but break production**. The playbook focuses on surfacing those.

## Mandatory exploration

1. **Read the target version's release notes / changelog / breaking-changes
   document.** Cite the URL or file. List every breaking change relevant to
   how this codebase uses the dependency.
2. **List all usages.** For library/API migrations, grep every import / call
   site. For language version bumps, grep for syntax that changed semantics.
   Count them — the plan must state the scope ("47 call sites across 12
   files").
3. **Read the lockfile delta.** A `package.json` change cascades through
   transitive deps. Run / inspect `npm ls <pkg>`, `cargo tree`, etc. List
   transitive changes that affect runtime behavior.
4. **Find a similar past migration in git history** if one exists. Cite the
   commit. The same approach often applies.
5. **Check deprecation timeline.** If you're migrating *off* a deprecated API,
   confirm the new API is stable (not itself in beta). If you're staying on
   an old API, confirm when it gets removed.

## Required Risks coverage

Migration Risks must explicitly address each:

- **Behavioral diffs vs. API diffs** — APIs that compile fine but behave
  differently are the most dangerous. List every behavioral diff you found
  in the changelog.
- **Backward compatibility for downstream** — if this codebase publishes
  packages or APIs, migration may force consumers to upgrade. Note who.
- **Transitive deps** — a major-version bump usually cascades. List the
  transitive bumps and any that introduce their own breaking changes.
- **Dual-deploy / phased rollout** — for runtime migrations (DB, message
  format, RPC protocol): can old and new code coexist? If not, what's
  the cutover sequence?
- **Rollback complexity** — can you roll back the code without rolling
  back data? If not, the rollback is destructive — say so.
- **Type / lint changes** — major upgrades often tighten types or rules.
  Estimate how many call sites need touch-up.
- **Performance regression** — new versions sometimes regress. Note any
  perf-sensitive paths and how you'll measure before/after.
- **Security surface change** — new versions may add or remove security
  features (e.g. stricter defaults). Note any.
- **License change** — confirm the target version's license is still
  compatible with this project's distribution requirements.

## Required Verification coverage

- **Full typecheck** — exact command (often catches the bulk of API breaks)
- **Full test suite** — exact command, with expected runtime
- **Smoke test** — exercise the most critical user-facing paths the
  migrated dependency is on
- **Lockfile diff review** — command to view `npm install --dry-run`,
  `cargo update --dry-run`, etc.
- **Rollback command** — exact `git revert <commit>` plan + lockfile
  restoration
- **Behavioral diff log** — list of intentional behavior changes (not
  bugs) that consumers need to know about

## Anti-patterns to flag

- Bumping multiple unrelated deps in the same PR (hard to bisect failures)
- Skipping the changelog because "tests pass"
- Replacing a library wholesale without listing call sites
- Migrating data without a backup confirmed
- Pinning to `^` or `latest` after the migration (re-introduces drift)
- Disabling tests / type errors "to unblock the upgrade"
- No documented rollback path for a runtime migration
