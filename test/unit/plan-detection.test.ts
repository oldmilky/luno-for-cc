import { describe, it, expect, beforeEach } from "vitest";
import {
  PlanInterceptor,
  looksLikePlanFile,
  parseBashHeredocWrite
} from "../../src/core/plan-intercept.js";
import { Session } from "../../src/core/session.js";
import { PlanRevisionMeta } from "../../src/core/types.js";

describe("looksLikePlanFile (broadened)", () => {
  it("matches the legacy ~/.claude/plans/ path", () => {
    expect(
      looksLikePlanFile(
        "/Users/me/.claude/plans/go-through-reports-v2-route-js-and-sleepy-sloth.md"
      )
    ).toBe(true);
  });

  it("matches per-project plan paths", () => {
    expect(
      looksLikePlanFile(
        "/Users/me/.claude/projects/-Users-me-app/plans/feature-x-and-quick-fox.md"
      )
    ).toBe(true);
  });

  it("matches per-session and per-agent plan paths", () => {
    expect(
      looksLikePlanFile("/Users/me/.claude/sessions/abcd/plans/plan.md")
    ).toBe(true);
    expect(
      looksLikePlanFile("/Users/me/.claude/agents/researcher/plans/notes.md")
    ).toBe(true);
  });

  it("matches workspace-local plans/ directories", () => {
    expect(looksLikePlanFile("/repo/plans/foo.md")).toBe(true);
    expect(looksLikePlanFile("plans/foo.md")).toBe(true);
  });

  it("rejects non-markdown files even under plans/", () => {
    expect(looksLikePlanFile("/repo/plans/foo.txt")).toBe(false);
    expect(looksLikePlanFile("/repo/plans/foo.json")).toBe(false);
  });

  it("rejects markdown files NOT under a plans/ segment", () => {
    expect(looksLikePlanFile("/repo/docs/foo.md")).toBe(false);
    expect(looksLikePlanFile("README.md")).toBe(false);
  });
});

describe("parseBashHeredocWrite", () => {
  it("parses cat > path <<'EOF' style", () => {
    const cmd = `cat > /tmp/.claude/plans/foo.md <<'EOF'
hello
world
EOF`;
    const out = parseBashHeredocWrite(cmd);
    expect(out?.path).toBe("/tmp/.claude/plans/foo.md");
    expect(out?.content).toBe("hello\nworld");
  });

  it("parses cat >> path <<EOF (append) style", () => {
    const cmd = `cat >> /repo/plans/x.md <<EOF
appended
EOF`;
    const out = parseBashHeredocWrite(cmd);
    expect(out?.path).toBe("/repo/plans/x.md");
    expect(out?.content).toBe("appended");
  });

  it("parses tee path <<MARK style", () => {
    const cmd = `tee /tmp/plans/foo.md <<MARK
content
MARK`;
    const out = parseBashHeredocWrite(cmd);
    expect(out?.path).toBe("/tmp/plans/foo.md");
    expect(out?.content).toBe("content");
  });

  it("parses cat <<EOF > path style (heredoc declared first)", () => {
    const cmd = `cat <<'EOF' > /tmp/plans/notes.md
plan body
EOF`;
    const out = parseBashHeredocWrite(cmd);
    expect(out?.path).toBe("/tmp/plans/notes.md");
    expect(out?.content).toBe("plan body");
  });

  it("returns null for non-heredoc commands", () => {
    expect(parseBashHeredocWrite("ls -la")).toBeNull();
    expect(parseBashHeredocWrite("echo hi > /tmp/foo.md")).toBeNull();
    expect(parseBashHeredocWrite("")).toBeNull();
  });
});

describe("PlanInterceptor — Bash heredoc fallback", () => {
  it("emits a plan_revision when CLI writes a plan via Bash heredoc", () => {
    const session = new Session();
    const p = new PlanInterceptor(session);
    const cmd = `cat > /Users/me/.claude/plans/feature-x.md <<'EOF'
## Plan
some content
EOF`;
    expect(p.consume("Bash", "tu_bash_1", { command: cmd })).toBe(true);
    p.flush();
    const rev = session.timeline.find((e) => e.kind === "plan_revision");
    expect(rev).toBeDefined();
    const meta = rev!.meta as unknown as PlanRevisionMeta;
    expect(meta.body).toBe("## Plan\nsome content");
    expect(meta.planFilePath).toBe("/Users/me/.claude/plans/feature-x.md");
    expect(p.interceptedToolIds.has("tu_bash_1")).toBe(true);
  });

  it("ignores Bash commands that aren't writing a plan file", () => {
    const session = new Session();
    const p = new PlanInterceptor(session);
    expect(p.consume("Bash", "tu_bash_2", { command: "ls -la" })).toBe(false);
    expect(session.timeline.filter((e) => e.kind === "plan_revision")).toHaveLength(0);
  });
});

describe("PlanInterceptor — broadened tool name detection", () => {
  it("intercepts a tool named 'WritePlan' (not in the static set) when it writes a plan-file", () => {
    const session = new Session();
    const p = new PlanInterceptor(session);
    const intercepted = p.consume("WritePlan", "tu_wp_1", {
      file_path: "/Users/me/.claude/plans/feature.md",
      content: "## Plan\nhi"
    });
    expect(intercepted).toBe(true);
    const rev = session.timeline.find((e) => e.kind === "plan_revision");
    expect(rev).toBeDefined();
  });

  it("intercepts custom 'create_file' name with target_file path", () => {
    const session = new Session();
    const p = new PlanInterceptor(session);
    const intercepted = p.consume("create_file", "tu_cf_1", {
      target_file: "/Users/me/.claude/plans/x.md",
      content: "body"
    });
    expect(intercepted).toBe(true);
  });
});
