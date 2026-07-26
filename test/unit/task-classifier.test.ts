import { describe, it, expect } from "vitest";
import { classifyTask } from "../../src/core/task-classifier.js";

describe("classifyTask", () => {
  describe("docs-driven", () => {
    it("matches explicit URLs", () => {
      expect(classifyTask("implement per https://example.com/spec")).toBe("docs-driven");
      expect(classifyTask("see http://docs.example.com/auth")).toBe("docs-driven");
    });

    it("matches 'follow the docs/spec' phrasing", () => {
      expect(classifyTask("follow the docs for stripe")).toBe("docs-driven");
      expect(classifyTask("per the spec from RFC 7519")).toBe("docs-driven");
    });
  });

  describe("refactor", () => {
    it("matches refactor verbs", () => {
      expect(classifyTask("rename foo to bar")).toBe("refactor");
      expect(classifyTask("extract this into a helper")).toBe("refactor");
      expect(classifyTask("consolidate these utilities")).toBe("refactor");
    });
  });

  describe("integration", () => {
    it("matches vendor names", () => {
      expect(classifyTask("add stripe checkout")).toBe("integration");
      expect(classifyTask("set up slack notifications")).toBe("integration");
      expect(classifyTask("add a github webhook")).toBe("integration");
    });

    it("matches integration-folder paths", () => {
      expect(classifyTask("change this", "src/integrations/sentry.ts")).toBe("integration");
      expect(classifyTask("update", "lib/webhooks/handler.ts")).toBe("integration");
    });
  });

  describe("frontend", () => {
    it("matches UI file extensions", () => {
      expect(classifyTask("add a label", "src/Component.tsx")).toBe("frontend");
      expect(classifyTask("update", "styles/main.css")).toBe("frontend");
    });

    it("matches UI keywords", () => {
      expect(classifyTask("create a new button component")).toBe("frontend");
      expect(classifyTask("add a modal dialog")).toBe("frontend");
    });

    it("matches component-folder paths", () => {
      expect(classifyTask("change this", "app/components/Card.tsx")).toBe("frontend");
    });
  });

  describe("backend", () => {
    it("matches backend keywords", () => {
      expect(classifyTask("add a new endpoint")).toBe("backend");
      expect(classifyTask("write a database migration")).toBe("backend");
      expect(classifyTask("set up rest api")).toBe("backend");
    });

    it("matches backend-folder paths", () => {
      expect(classifyTask("change this", "src/api/users.ts")).toBe("backend");
      expect(classifyTask("update", "server/handlers/auth.go")).toBe("backend");
    });
  });

  describe("generic fallback", () => {
    it("returns generic for ambiguous prompts", () => {
      expect(classifyTask("hello")).toBe("generic");
      expect(classifyTask("what does this do")).toBe("generic");
      expect(classifyTask("explain")).toBe("generic");
    });

    it("returns generic when no signals match", () => {
      expect(classifyTask("write a function")).toBe("generic");
    });
  });

  describe("priority ordering", () => {
    it("docs-driven wins over refactor when URL is present", () => {
      expect(classifyTask("rename per https://example.com/style")).toBe("docs-driven");
    });

    it("bugfix wins over refactor when fix verb is present", () => {
      // "fix" is more specific than "refactor" — bugfix should fire first
      expect(classifyTask("fix the rename bug in auth")).toBe("bugfix");
    });

    it("refactor wins over integration when verb + vendor both present", () => {
      expect(classifyTask("rename the stripe client")).toBe("refactor");
    });

    it("integration wins over frontend when both signals present", () => {
      expect(classifyTask("add stripe button")).toBe("integration");
    });

    it("devops wins over backend when CI/IaC file is active", () => {
      expect(classifyTask("update the deploy", ".github/workflows/deploy.yml")).toBe("devops");
    });

    it("migration wins over generic when bumping a dependency", () => {
      expect(classifyTask("upgrade react to v19")).toBe("migration");
    });
  });

  describe("devops", () => {
    it("matches Terraform / IaC files", () => {
      expect(classifyTask("update", "infra/main.tf")).toBe("devops");
      expect(classifyTask("change", "terraform/modules/vpc/main.tfvars")).toBe("devops");
    });

    it("matches Dockerfile", () => {
      expect(classifyTask("update", "services/web/Dockerfile")).toBe("devops");
    });

    it("matches CI workflow yaml", () => {
      expect(classifyTask("change", ".github/workflows/ci.yml")).toBe("devops");
    });

    it("matches k8s / helm folders", () => {
      expect(classifyTask("update manifest", "k8s/deployments/api.yaml")).toBe("devops");
      expect(classifyTask("update", "helm/web/values.yaml")).toBe("devops");
    });

    it("matches devops keywords", () => {
      expect(classifyTask("set up github actions for deploys")).toBe("devops");
      expect(classifyTask("add a kubernetes rollout strategy")).toBe("devops");
      expect(classifyTask("plan a canary deployment")).toBe("devops");
    });
  });

  describe("bugfix", () => {
    it("matches fix verbs", () => {
      expect(classifyTask("fix the broken login flow")).toBe("bugfix");
      expect(classifyTask("the api throws error on empty body")).toBe("bugfix");
      expect(classifyTask("page crashes when user is null")).toBe("bugfix");
    });

    it("matches regression / failing test language", () => {
      expect(classifyTask("regression after the auth merge")).toBe("bugfix");
      expect(classifyTask("failing test in user.service.spec.ts")).toBe("bugfix");
    });

    it("matches stack trace mentions", () => {
      expect(classifyTask("undefined is not a function in checkout")).toBe("bugfix");
    });
  });

  describe("migration", () => {
    it("matches dep file changes", () => {
      expect(classifyTask("update", "package.json")).toBe("migration");
      expect(classifyTask("update", "Cargo.toml")).toBe("migration");
      expect(classifyTask("change", "pnpm-lock.yaml")).toBe("migration");
    });

    it("matches upgrade verbs", () => {
      expect(classifyTask("upgrade tailwind to v4")).toBe("migration");
      expect(classifyTask("bump axios")).toBe("migration");
      expect(classifyTask("switch from moment to date-fns")).toBe("migration");
      expect(classifyTask("port to react 19")).toBe("migration");
    });
  });

  describe("fullstack", () => {
    it("matches explicit multi-layer phrases", () => {
      expect(classifyTask("end-to-end profile editing feature")).toBe("fullstack");
      expect(classifyTask("frontend and backend changes for invites")).toBe("fullstack");
      expect(classifyTask("wire the new modal to the api")).toBe("fullstack");
      expect(classifyTask("client and server changes")).toBe("fullstack");
    });
  });

  describe("new-impl", () => {
    it("matches greenfield verbs without other strong signals", () => {
      expect(classifyTask("create a new project for analytics")).toBe("new-impl");
      expect(classifyTask("scaffold a fresh package")).toBe("new-impl");
      expect(classifyTask("set up a new module from scratch")).toBe("new-impl");
    });

    it("does NOT swallow backend / frontend tasks even with new-ish verbs", () => {
      // "create endpoint" should still be backend (more specific signal)
      expect(classifyTask("create endpoint for invoices")).toBe("backend");
      // "create button component" should still be frontend
      expect(classifyTask("create button component")).toBe("frontend");
    });
  });
});
