import { TaskType } from "./types.js";

// Pure heuristic task classifier. Order matters — first match wins. The model
// is also instructed to state its own classification in plan mode, so a
// misfire here doesn't block — the task-type playbook just augments whatever
// the model decides.
//
// Priority order (top wins):
//   1. docs-driven   — explicit URL or "follow the docs/spec/RFC"
//   2. devops        — IaC / CI / container / k8s files or keywords
//   3. migration     — package.json / lockfile / "upgrade/migrate" verbs
//   4. bugfix        — "fix/bug/broken/error/crash" verbs
//   5. refactor      — pure-restructure verbs (no new behavior)
//   6. fullstack     — explicit multi-layer mention
//   7. integration   — vendor names or integration paths
//   8. frontend      — UI files / keywords
//   9. backend       — API/server files / keywords
//   10. new-impl     — "create/build/scaffold/from scratch" verbs
//   11. generic      — fallback

export function classifyTask(prompt: string, activeFile?: string): TaskType {
  const p = prompt.toLowerCase();
  const f = (activeFile ?? "").toLowerCase();

  // 1. Docs-driven
  if (
    /\bhttps?:\/\//.test(prompt) ||
    /\b(per the (spec|docs|rfc)|follow the (spec|docs|rfc)|according to (the )?docs)\b/.test(p)
  ) {
    return "docs-driven";
  }

  // 2. DevOps — IaC / CI / container / k8s file paths or extensions
  if (
    /\.(tf|tfvars|hcl)$/.test(f) ||
    /(^|\/)dockerfile(\..+)?$/.test(f) ||
    /\.(ya?ml)$/.test(f) && /(\.github\/workflows|\.gitlab-ci|circleci|travis|azure-pipelines|cloudbuild|bitbucket-pipelines)/.test(f) ||
    /(?:^|\/)(infra|infrastructure|terraform|k8s|kubernetes|helm|ansible|chef|puppet|cloudformation|pulumi)\//.test(f) ||
    /\b(terraform|kubernetes|kubectl|helm chart|github actions|gitlab ci|circleci|jenkins|argocd|spinnaker|ansible|cloudformation|pulumi|deploy(ment)?|rollout|canary|blue.green|infra|iac)\b/.test(p)
  ) {
    return "devops";
  }

  // 3. Migration — package files or upgrade verbs
  if (
    /(?:^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|cargo\.toml|cargo\.lock|pyproject\.toml|requirements\.txt|gemfile|gemfile\.lock|go\.mod|go\.sum|composer\.json|composer\.lock)$/.test(f) ||
    /\b(upgrade|migrate(?: from)?|bump|switch from|replace .+ with|move from .+ to|port to)\b/.test(p)
  ) {
    return "migration";
  }

  // 4. Bug fix — fix verbs / error language
  if (
    /\b(fix(es|ing|ed)?|bug|broken|crashes?|throws? error|failing test|regression|doesn'?t work|not working|stack ?trace|exception|null ?pointer|undefined is not)\b/.test(p)
  ) {
    return "bugfix";
  }

  // 5. Refactor — restructure verbs
  if (
    /\b(rename|extract|inline|split|consolidate|deduplicate|refactor|restructure|move (this|the)|reorganize|simplify(?! the)|clean.up)\b/.test(p)
  ) {
    return "refactor";
  }

  // 6. Full-stack — explicit multi-layer signal
  if (
    /\b(end.to.end|frontend (?:and|\+) backend|backend (?:and|\+) frontend|client (?:and|\+) server|server (?:and|\+) client|api (?:and|\+) ui|ui (?:and|\+) api|wire .+ to .+|full.?stack)\b/.test(p)
  ) {
    return "fullstack";
  }

  // 7. Integration — vendor names or integration-folder paths
  if (
    /\b(stripe|twilio|slack|sendgrid|shopify|github(?: api)?|google api|aws|azure|firebase|supabase|webhook|oauth|paypal|braintree|auth0|okta|segment|mixpanel|datadog|sentry|openai|anthropic)\b/.test(p) ||
    /(?:^|\/)(integrations?|clients?|webhooks?|providers?|connectors?)\//.test(f)
  ) {
    return "integration";
  }

  // 8. Frontend — UI extensions / paths / keywords
  if (
    /\.(tsx|jsx|vue|svelte|css|scss|sass|less|astro)$/.test(f) ||
    /(?:^|\/)(components?|pages?|app|ui|views?|screens?|features?\/[^/]+|widgets?)\//.test(f) ||
    /\b(component|button|modal|page|form|layout|css|tailwind|styled-components|design system|hook(?:s)?|state management|redux|zustand|jotai|recoil|accessibilit|a11y|responsive)\b/.test(p)
  ) {
    return "frontend";
  }

  // 9. Backend — API/server paths or keywords
  if (
    /(?:^|\/)(api|routes?|controllers?|models?|migrations?|services?|handlers?|middleware|server|backend|resolvers?)\//.test(f) ||
    /\b(endpoint|route|migration|database|sql|orm|prisma|drizzle|sequelize|mongoose|fastapi|express|nest|graphql|rest api|grpc|message queue|pubsub|kafka)\b/.test(p)
  ) {
    return "backend";
  }

  // 10. New implementation — greenfield verbs (lower priority so it doesn't
  //     swallow more specific signals like backend/frontend).
  if (
    /\b(create (?:a )?new|build (?:a )?new|scaffold|set up (?:a )?new|implement from scratch|greenfield|new project|new (?:module|package|library|service))\b/.test(p)
  ) {
    return "new-impl";
  }

  return "generic";
}
