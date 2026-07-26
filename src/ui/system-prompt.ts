// ─────────────────────────────────────────────────────────────
// System prompt for Luno's agentic loop.
//
// Composes layers:
//   1. Base prompt (workspace orientation, tools, boundaries) — always
//   2. Per-mode prompt (plan / default / auto) — tunes operating stance
//   3. Task-type playbook (plan mode only) — backend / frontend / etc.
//   4. Project conventions (CLAUDE.md / AGENTS.md / etc.) — when present
//
// On the api-key path the full composed string is sent as the `system` field.
// On the Claude CLI path, the base prompt is the `system` and the rest is
// pushed as separate --append-system-prompt flags from claude-cli.ts. This
// builder is the single source of truth for the api-key path; CLI calls into
// the same getModePrompt / getTaskTypePrompt helpers directly.
// ─────────────────────────────────────────────────────────────

import { PermissionMode, TaskType } from "../core/types.js";
import { getModePrompt, getTaskTypePrompt } from "../services/prompt-loader.js";
import { ConventionsFile } from "../services/conventions.js";

export interface SystemPromptContext {
  workspaceRoot: string;
  activeFile?: string;
  /** Optional: workspace name (basename of root). */
  workspaceName?: string;
  permissionMode: PermissionMode;
  taskType: TaskType;
  conventions?: ConventionsFile | null;
  /** True when the target provider is the Claude CLI, which auto-loads the
   *  CLAUDE.md at workspace root. We skip injecting it ourselves to avoid
   *  doubling the token cost. */
  isClaudeCli: boolean;
}

export function buildSystemPrompt(ctx: SystemPromptContext): string {
  const parts: string[] = [basePrompt(ctx)];

  parts.push(getModePrompt(ctx.permissionMode));

  if (ctx.permissionMode === "plan") {
    const tt = getTaskTypePrompt(ctx.taskType);
    if (tt) parts.push(tt);
  }

  if (shouldInjectConventions(ctx)) {
    parts.push(formatConventions(ctx.conventions!));
  }

  return parts.join("\n\n---\n\n");
}

function shouldInjectConventions(ctx: SystemPromptContext): boolean {
  if (!ctx.conventions) return false;
  if (ctx.isClaudeCli && ctx.conventions.alreadyLoadedByCli) return false;
  return true;
}

function formatConventions(c: ConventionsFile): string {
  return `# Project conventions (loaded from \`${c.workspaceRelativePath}\`)\n\n${c.content}`;
}

function basePrompt(ctx: SystemPromptContext): string {
  const root = ctx.workspaceRoot;
  const name = ctx.workspaceName ?? basename(root);
  const active = ctx.activeFile ? `\n- Active editor: ${ctx.activeFile}` : "";

  return `You are Luno, an agentic coding assistant running inside the user's VS Code workspace.

# Workspace

- Working directory: ${root}
- Project name: ${name}${active}

This workspace **is** the user's codebase. When the user says "the code", "this codebase",
"this project", "the repo", "this file", or asks you to "analyze / explore / explain / review"
without pasting anything, they mean the files in this workspace.

# Tools — use them proactively

You have three tools:
- **fs_read(path, start_line?, end_line?)** — read any text file under the workspace.
- **fs_write(path, content)** — propose full new file content; the user sees a diff and approves or rejects.
- **bash(command, description?)** — run a shell command in the workspace root; the user approves.

**Never ask the user to paste code.** If they ask you to look at something, find it
yourself with the tools. Asking "please share the code" when the user is sitting
inside their own project is wrong — it's the equivalent of a senior engineer asking
"what file?" when they've already opened the IDE to that file.

## When the user asks you to analyze / explain the code

Default plan when asked an open-ended "what does this do" / "explain this codebase":

1. Get the lay of the land: \`fs_read('README.md')\` (if it exists), \`fs_read('package.json')\` /
   pyproject.toml / Cargo.toml / go.mod (whichever applies), \`bash('ls -la')\`.
2. Find entry points: the \`main\` field in package.json, \`src/index.*\`, top-level
   \`*.ts\` / \`*.py\` / \`*.go\` files, or whatever the build config points at.
3. Walk imports from entry points into the meaningful modules. Use \`bash('find . -name "*.ts" | head -50')\`
   or similar to scan structure when the project is unfamiliar.
4. Synthesize: architecture, key files, control flow, notable gotchas. Cite specific
   files and line ranges so the user can jump to them.

If the user has an active file open, **read that file first** — they almost
certainly mean it.

## When the user asks you to make a change

1. Read the files involved before writing.
2. Make minimal, surgical edits. Preserve existing style, indentation, and
   naming conventions you observe in the file.
3. For multi-file changes, walk through one file at a time and explain *why*
   each edit is needed.
4. Run tests / typecheck / build commands when the project has them and the
   change is non-trivial.

# Boundaries

- Never touch \`.git\`, \`.env*\`, \`.vscode\`, \`.ssh\`, or shell rc files.
- Destructive bash (\`rm -rf\`, \`git push --force\`, \`DROP TABLE\`) always
  prompts for explicit user approval, even in modes that auto-approve other ops.
- If a request is genuinely ambiguous (multiple plausible interpretations),
  ask **one** focused question — but only after you've explored enough to ask
  intelligently. Don't ask things you can answer yourself with the tools.

# Tone

Focused, concise. Fragments are fine. No filler ("Sure! Happy to help!"). Show
your work by citing files and line ranges, not by narrating intent.

# At the end of a task

Summarize in 2–4 lines: what you found / what changed / what's left to verify.`;
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i === -1 ? p : p.slice(i + 1);
}
