# DevOps Task Playbook

The user is changing CI/CD, infrastructure-as-code, container configs, deploy
scripts, or anything that affects how the system is built / shipped / run.
Apply this playbook in addition to the mode prompt.

These changes have **higher blast radius and slower feedback loops** than
application code. The bar for explicit risk analysis is correspondingly higher.

## Mandatory exploration

1. **Read existing files of the same kind.** GitHub Actions workflow → read
   another workflow. Terraform module → read a sibling module. Dockerfile →
   read a sibling. Cite the canonical example.
2. **List every environment affected.** Dev, staging, prod, regional? Note
   which environments this change applies to and which it deliberately
   skips.
3. **Identify the secrets / credentials path.** How are secrets currently
   provided (env vars, secret manager, mounted files)? Confirm your change
   uses the same mechanism — never hardcode.
4. **Read the rollback / undo mechanism** for the kind of resource you're
   touching (Helm rollback? Terraform plan/destroy? `gh workflow run` an
   undo job?). Cite the exact command.
5. **Find monitoring / alerting** that would notice if this misbehaves.
   Dashboards, runbooks, on-call docs. Cite them.

## Required Risks coverage

DevOps Risks must explicitly address each:

- **Blast radius** — list every environment, service, pipeline, and team
  potentially affected. Be specific. "Production deploy" is too vague —
  which prod region? Which services?
- **Secrets exposure** — does any change risk leaking credentials in logs,
  build artifacts, error messages, or repo history? Confirm the secrets
  flow stays inside the secret manager.
- **Rollback** — exact command to revert this change. If rollback is
  destructive (data loss), say so explicitly.
- **Drift** — does this change make environments diverge (e.g. apply only
  to staging)? If yes, when does prod catch up and how?
- **Idempotency** — can this be safely re-run? IaC, migrations, deploy
  jobs should all be idempotent. State whether yours is and why.
- **Failed mid-deploy state** — what happens if the change fails halfway
  through? Atomic? Partial-state-recoverable? Manual cleanup needed?
- **Cost impact** — new resources (instances, storage, log volume, build
  minutes) — give an order-of-magnitude cost estimate.
- **Security posture** — IAM changes, network exposure (new public
  endpoints / open ports), permission grants. List every new permission.
- **Compliance / audit** — does this change touch a compliance-relevant
  surface (logging, retention, encryption, access control)? If yes, who
  needs to sign off.

## Required Verification coverage

- **Lint / validate** — `terraform fmt && terraform validate`,
  `actionlint .github/workflows/*.yml`, `docker build` — exact commands
- **Dry-run / plan** — `terraform plan`, `helm diff upgrade`,
  `kubectl apply --dry-run=server` — must run before apply
- **Rollback command** — exact string, tested
- **Smoke test** — what to check after deploy succeeds
- **Monitoring hook** — what dashboard / alert will confirm the change
  is healthy in production
- **Phased rollout** — if this is a large blast radius, name the stages
  (one canary node → 1% → 10% → 100%) and the gate criteria

## Anti-patterns to flag

- Hardcoded secrets, even "temporarily"
- IaC change without `terraform plan` shown
- "Just SSH in and run X" — operational changes should be codified
- Bumping prod and dev together with no canary / staging soak
- New public endpoint without auth / rate limit / WAF rule
- Disabling a CI check "to unblock" without explicit follow-up to fix
- Deleting state (terraform state rm, DB drop) without a backup confirmed
- Changing build artifact format without a backward-compat window
