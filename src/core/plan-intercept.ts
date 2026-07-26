import { randomUUID } from "node:crypto";
import { Session } from "./session.js";
import {
  PlanQuestionEntry,
  PlanQuestionOption,
  PlanRevisionMeta,
  PlanSections,
  PlanTask,
  PlanTaskFileRef,
  TimelineEvent
} from "./types.js";

export const PLAN_TOOL_NAMES = new Set(["ExitPlanMode", "TodoWrite", "AskUserQuestion"]);

/**
 * Tool names that write file content. The CLI's plan-mode workflow writes
 * the plan markdown to a file *before* calling ExitPlanMode, so we sniff
 * these to recover the plan body. Covers api-key (fs_write) and Claude CLI
 * (Write/Create/Edit/MultiEdit) shapes, plus any future variant whose name
 * contains write/create/edit (case-insensitive).
 */
const WRITE_TOOL_NAMES = new Set([
  "Write",
  "Create",
  "Edit",
  "MultiEdit",
  "fs_write",
  "str_replace_editor"
]);

// Matches names that start with a write-like verb (Write, Edit, Create, Save,
// Update, Put, Insert) or contain such a verb at a snake_case / kebab-case
// boundary. Allows PascalCase suffixes (WritePlan, EditFile) by treating an
// uppercase letter after the verb as a valid boundary too.
const WRITE_TOOL_NAME_RE_PREFIX = /^(write|edit|create|save|update|put|insert)(?:$|[_-]|[A-Z])/i;
const WRITE_TOOL_NAME_RE_BOUNDARY = /[_-](write|edit|create|save|update|put|insert)(?:$|[_-]|[A-Z])/i;

function isWriteToolName(name: string): boolean {
  return (
    WRITE_TOOL_NAMES.has(name) ||
    WRITE_TOOL_NAME_RE_PREFIX.test(name) ||
    WRITE_TOOL_NAME_RE_BOUNDARY.test(name)
  );
}

/**
 * True if `path` looks like a plan-mode markdown file. Permissive on
 * directory structure — any `*.md` under a `plans/` segment counts. Catches:
 *   ~/.claude/plans/foo.md                              (legacy CLI path)
 *   ~/.claude/projects/<encoded-cwd>/plans/foo.md       (newer per-project)
 *   ~/.claude/agents/<id>/plans/foo.md
 *   ~/.claude/sessions/<id>/plans/foo.md
 *   <workspace>/plans/foo.md
 *   <workspace>/.claude/plans/foo.md
 */
export function looksLikePlanFile(p: string): boolean {
  if (!p) return false;
  if (!/\.(md|markdown)$/i.test(p)) return false;
  return /(?:^|\/)plans\//i.test(p);
}

interface PendingPlan {
  body?: string;
  tasks?: PlanTask[];
  toolUseId?: string;
  planFilePath?: string;
}

/**
 * Folds CLI-emitted ExitPlanMode + TodoWrite tool_use blocks into structured
 * `plan_revision` timeline events, and AskUserQuestion blocks into
 * `plan_question` events. One instance per orchestrator turn — call
 * `consume(name, id, input)` from `tool_use_end`, `flush()` after the stream
 * ends. Intercepted tool ids are tracked so the orchestrator can suppress
 * duplicate `tool_call` / `tool_result` timeline emissions.
 */
export class PlanInterceptor {
  private pending: PendingPlan = {};
  /** Plan-file writes seen this turn, by toolUseId, in arrival order. */
  private planFileWrites: Array<{ toolUseId: string; path: string; content: string }> = [];
  readonly interceptedToolIds = new Set<string>();

  constructor(private session: Session) {}

  /** Returns true if this tool_use was a plan-related event we handled. */
  consume(name: string, toolUseId: string, input: Record<string, unknown>): boolean {
    // Snoop plan-file writes so ExitPlanMode can recover the plan body
    // from the file the CLI just wrote (its actual plan-mode workflow).
    if (isWriteToolName(name)) {
      const path = readWritePath(input);
      if (looksLikePlanFile(path)) {
        const content = readWriteContent(input);
        if (content) {
          this.planFileWrites.push({ toolUseId, path, content });
          this.interceptedToolIds.add(toolUseId);
          // Emit the revision immediately so the PlanCard appears in
          // place of the Write card, not deferred to the end of the
          // stream (where it would land below the summary text).
          this.emitFileBackedRevision(path, content, toolUseId);
          return true;
        }
      }
      return false;
    }
    // Bash heredoc fallback — newer CLI variants sometimes write the plan
    // file via `cat > path <<EOF ... EOF` instead of the Write tool.
    if (/^bash$/i.test(name)) {
      const cmd = typeof input.command === "string" ? input.command : "";
      const parsed = parseBashHeredocWrite(cmd);
      if (parsed && looksLikePlanFile(parsed.path)) {
        this.planFileWrites.push({
          toolUseId,
          path: parsed.path,
          content: parsed.content
        });
        this.interceptedToolIds.add(toolUseId);
        this.emitFileBackedRevision(parsed.path, parsed.content, toolUseId);
        return true;
      }
      return false;
    }
    switch (name) {
      case "ExitPlanMode": {
        this.interceptedToolIds.add(toolUseId);
        const body = typeof input.plan === "string" ? input.plan : "";
        if (body) {
          // Legacy ExitPlanMode shape that carries the plan in `input.plan`.
          // Emit a revision (or pair with an upcoming TodoWrite).
          this.pending.body = body;
          this.pending.toolUseId = toolUseId;
          if (this.pending.tasks) this.flushRevision();
        }
        // When body is empty, the plan-file Write that preceded this call
        // has already produced a plan_revision via emitFileBackedRevision —
        // ExitPlanMode is just the "I'm done planning" signal. No-op here.
        return true;
      }
      case "TodoWrite": {
        const tasks = parseTasks(input);
        this.pending.tasks = tasks;
        if (this.pending.body !== undefined) {
          this.flushRevision();
        } else {
          this.flushRevision(/* taskOnly */ true);
        }
        this.interceptedToolIds.add(toolUseId);
        return true;
      }
      case "AskUserQuestion": {
        const questions = parseQuestions(input);
        if (questions.length === 0) return false;
        this.session.emitPlanQuestion({
          questionId: randomUUID(),
          toolUseId,
          revisionId: latestRevisionId(this.session.timeline),
          questions
        });
        this.interceptedToolIds.add(toolUseId);
        return true;
      }
      default:
        return false;
    }
  }

  /** Flush a leftover plan body (no paired TodoWrite) at end-of-stream. */
  flush(): void {
    if (this.pending.body !== undefined && this.pending.tasks === undefined) {
      this.flushRevision();
    }
  }

  /**
   * Emit a plan_revision built from a plan-file Write call, in place. Used
   * for the CLI's actual plan-mode workflow where the body lives in the
   * file and ExitPlanMode (when called) carries no plan field.
   */
  private emitFileBackedRevision(planFilePath: string, body: string, toolUseId: string): void {
    const prior = priorRevision(this.session.timeline);
    const meta: PlanRevisionMeta = {
      revisionId: randomUUID(),
      parentRevisionId: prior?.revisionId,
      toolUseId,
      body,
      tasks: prior?.tasks ?? [],
      bodyChanged: body !== (prior?.body ?? ""),
      planFilePath,
      sections: parsePlanSections(body)
    };
    this.session.emitPlanRevision(meta);
  }

  private flushRevision(taskOnly = false): void {
    const prior = priorRevision(this.session.timeline);
    const body = this.pending.body ?? prior?.body ?? "";
    const tasks = this.pending.tasks ?? prior?.tasks ?? [];
    const meta: PlanRevisionMeta = {
      revisionId: randomUUID(),
      parentRevisionId: prior?.revisionId,
      toolUseId: this.pending.toolUseId,
      body,
      tasks,
      bodyChanged: !taskOnly && body !== (prior?.body ?? ""),
      planFilePath: this.pending.planFilePath ?? prior?.planFilePath,
      sections: body ? parsePlanSections(body) : prior?.sections
    };
    this.session.emitPlanRevision(meta);
    this.pending = {};
  }
}

/**
 * Parse the H2 sections required by `plan-mode.md` out of the plan body.
 * Each required section maps to one of the keys in PlanSections. Heading
 * matching is case-insensitive and tolerates synonyms (e.g. "Risks &
 * mitigations" → risks). The captured value is the trimmed body text under
 * the heading, up to the next H2 or end of document. Empty string means
 * the heading exists but has no content; undefined means the heading
 * wasn't found at all. The PlanCard badge in the webview uses these flags
 * to render a "5/5 sections" or "⚠ missing: Risks, Conventions" indicator.
 */
export function parsePlanSections(body: string): PlanSections {
  const out: PlanSections = {};
  if (!body) return out;

  // Split on H2 headings while keeping the heading text. Lines starting with
  // exactly `## ` (not `###` or higher).
  const lines = body.split(/\r?\n/);
  let currentKey: keyof PlanSections | null = null;
  let currentBuf: string[] = [];

  const flush = (): void => {
    if (currentKey !== null) {
      const text = currentBuf.join("\n").trim();
      out[currentKey] = text;
    }
    currentBuf = [];
  };

  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      currentKey = matchSectionHeading(m[1]);
    } else if (currentKey !== null) {
      currentBuf.push(line);
    }
  }
  flush();

  return out;
}

/**
 * Map a free-form H2 heading to one of the five canonical section keys, or
 * null if it's an unrelated heading we should ignore.
 *
 * We match on *keyword presence* anywhere in the heading rather than only when
 * the keyword leads it. This is deliberately tolerant: the model is steered to
 * use the exact names, but real plans drift to natural variants — "Potential
 * Risks", "Testing & Verification", "Implementation Approach", "Context:",
 * "Conventions followed" — and badging those as "missing" punishes a perfectly
 * good plan. The earliest-appearing keyword wins, so "Conventions & Approach"
 * resolves to its leading noun (conventions). Headings that contain none of the
 * canonical words ("Out of scope", "Open questions") fall through to null and
 * stay ignored, so unknown sections never masquerade as a required one.
 */
function matchSectionHeading(heading: string): keyof PlanSections | null {
  // Normalize: lowercase, expand "&" to "and", and collapse every run of
  // non-alphanumerics to a single space so punctuation (":", "—", "/") never
  // hides a keyword. Word-boundary prefixes then match singular/plural and
  // -ed/-ing variants (risk/risks, verify/verification, convention/conventions)
  // without matching keywords embedded mid-word ("brisk" ≠ "risk").
  const norm = heading
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!norm) return null;

  const patterns: ReadonlyArray<[keyof PlanSections, RegExp]> = [
    ["context", /\bcontext/],
    ["approach", /\bapproach/],
    ["conventions", /\bconvention/],
    ["risks", /\brisk/],
    ["verification", /\bverif/]
  ];

  let best: { key: keyof PlanSections; idx: number } | null = null;
  for (const [key, re] of patterns) {
    const m = re.exec(norm);
    if (m && (best === null || m.index < best.idx)) {
      best = { key, idx: m.index };
    }
  }
  return best?.key ?? null;
}

/**
 * Parse a bash command for a `cat > path <<MARKER ... MARKER` style write.
 * Returns the destination path and inline content if matched. Returns null
 * for shell commands that don't match the heredoc-write shape.
 *
 * Supports common variations:
 *   cat > /path/file.md <<'EOF' ... EOF
 *   cat >> /path/file.md <<EOF ... EOF
 *   cat <<EOF > /path/file.md ... EOF
 *   tee /path/file.md <<EOF ... EOF
 *   tee -a /path/file.md <<'MARK' ... MARK
 */
export function parseBashHeredocWrite(
  cmd: string
): { path: string; content: string } | null {
  if (!cmd) return null;

  // Form 1: `<verb> [opts] <path> <<['"]?MARKER['"]?\n...\nMARKER`
  // Form 2: `<verb> <<['"]?MARKER['"]?... <path>...`  (heredoc before path)
  // We support both by trying redirect-after-path first, then path-after-heredoc.

  // cat > path <<MARKER  /  cat >> path <<MARKER  /  tee path <<MARKER
  let m = /(?:cat|tee)\s+(?:-a\s+)?(?:>+\s*)?(\S+\.(?:md|markdown))\s*<<-?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\2\s*$/m.exec(
    cmd
  );
  if (m) return { path: m[1], content: m[3] };

  // cat <<MARKER > path  ...  MARKER  (heredoc declared before redirect)
  m = /cat\s+<<-?\s*['"]?(\w+)['"]?\s*>+\s*(\S+\.(?:md|markdown))\s*\n([\s\S]*?)\n\1\s*$/m.exec(
    cmd
  );
  if (m) return { path: m[2], content: m[3] };

  return null;
}

/** Pull the destination path out of a Write/Edit/Create input shape. Tolerates
 *  the various field-name conventions different SDKs / CLI versions use. */
function readWritePath(input: Record<string, unknown>): string {
  const candidates = [
    input.path,
    input.file_path,
    input.filePath,
    input.target_file,
    input.target,
    input.destination,
    input.uri
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c) return c;
  }
  return "";
}

/** Pull the new file content out of a Write/Edit/Create input shape. */
function readWriteContent(input: Record<string, unknown>): string {
  const candidates = [
    input.content,
    input.file_text,
    input.text,
    input.new_str,
    input.body,
    input.markdown,
    input.data,
    input.value
  ];
  for (const c of candidates) {
    if (typeof c === "string") return c;
  }
  return "";
}

function parseTasks(input: Record<string, unknown>): PlanTask[] {
  const todos = Array.isArray(input.todos) ? input.todos : [];
  return todos.map((t, i) => {
    const obj = (t ?? {}) as Record<string, unknown>;
    const content = String(obj.content ?? "");
    const activeForm = String(obj.activeForm ?? content);
    const fileRefs = extractFileRefs(`${content} ${activeForm}`);
    return {
      id: String(obj.id ?? `t${i + 1}`),
      content,
      activeForm,
      status: normalizeStatus(obj.status),
      ...(fileRefs.length > 0 ? { fileRefs } : {})
    };
  });
}

/**
 * Pull file/range references out of free-form task text. Supports:
 *
 *   foo/bar.ts                 → { path, startLine: 1, endLine: 1 }
 *   foo/bar.ts:42              → { path, startLine: 42, endLine: 42 }
 *   foo/bar.ts:42-58           → { path, startLine: 42, endLine: 58 }
 *   [Click me](foo/bar.ts)     → { path, label: "Click me" }
 *   `foo/bar.ts`               → strip backticks, then any of the above
 *
 * Filters extensions to a known programming/markup set so we don't catch
 * stray "phase 1.0" or version numbers. Dedupes by path+range.
 */
const FILE_EXT = "(?:ts|tsx|js|jsx|mjs|cjs|json|md|markdown|rs|py|go|java|kt|c|h|cc|hh|cpp|hpp|cs|rb|php|swift|sh|bash|yml|yaml|toml|html|css|scss|less|sql|graphql|gql|proto|tf|env|gitignore|dockerfile)";
const MD_LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const BARE_RE = new RegExp(
  `(?:^|[\\s\`(\\[])((?:[\\w./-]+/)?[\\w.-]+\\.${FILE_EXT})(?::(\\d+)(?:[\\u2013\\u2014-](\\d+))?)?`,
  "gi"
);

export function extractFileRefs(text: string): PlanTaskFileRef[] {
  if (!text) return [];
  const out: PlanTaskFileRef[] = [];
  const seen = new Set<string>();

  // First: markdown links — they may carry a useful label.
  let m: RegExpExecArray | null;
  while ((m = MD_LINK_RE.exec(text))) {
    const label = m[1].trim();
    const target = m[2];
    const ref = parseRef(target, label);
    if (ref && addUnique(seen, ref)) out.push(ref);
  }

  // Then: bare paths (markdown links above already pulled a portion of the
  // string out of consideration, but BARE_RE is permissive enough that the
  // dedupe key catches re-matches).
  while ((m = BARE_RE.exec(text))) {
    const path = m[1];
    const start = m[2] ? parseInt(m[2], 10) : 1;
    const end = m[3] ? parseInt(m[3], 10) : start;
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    const ref: PlanTaskFileRef = { path, startLine: start, endLine: end };
    if (addUnique(seen, ref)) out.push(ref);
  }

  return out;
}

function parseRef(target: string, label?: string): PlanTaskFileRef | null {
  // Path may be "foo/bar.ts" or "foo/bar.ts:42-58"
  const cleaned = target.replace(/^`+|`+$/g, "");
  const m = cleaned.match(
    new RegExp(`^((?:[\\w./-]+/)?[\\w.-]+\\.${FILE_EXT})(?::(\\d+)(?:-(\\d+))?)?$`, "i")
  );
  if (!m) return null;
  const start = m[2] ? parseInt(m[2], 10) : 1;
  const end = m[3] ? parseInt(m[3], 10) : start;
  return { path: m[1], startLine: start, endLine: end, ...(label ? { label } : {}) };
}

function addUnique(seen: Set<string>, ref: PlanTaskFileRef): boolean {
  const key = `${ref.path}:${ref.startLine}-${ref.endLine}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

function normalizeStatus(s: unknown): PlanTask["status"] {
  if (s === "in_progress" || s === "completed" || s === "pending") return s;
  return "pending";
}

function parseQuestions(input: Record<string, unknown>): PlanQuestionEntry[] {
  const qs = Array.isArray(input.questions) ? input.questions : [];
  return qs
    .map((raw): PlanQuestionEntry | null => {
      const q = (raw ?? {}) as Record<string, unknown>;
      const question = String(q.question ?? "").trim();
      if (!question) return null;
      const opts = Array.isArray(q.options) ? q.options : [];
      const options: PlanQuestionOption[] = opts.map((o) => {
        const obj = (o ?? {}) as Record<string, unknown>;
        return {
          label: String(obj.label ?? ""),
          description: typeof obj.description === "string" ? obj.description : undefined
        };
      });
      return {
        question,
        header: typeof q.header === "string" ? q.header : undefined,
        options,
        multiSelect: q.multiSelect === true
      };
    })
    .filter((x): x is PlanQuestionEntry => x !== null);
}

function priorRevision(timeline: TimelineEvent[]): PlanRevisionMeta | undefined {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i];
    if (e.kind === "plan_revision" && e.meta) {
      return e.meta as unknown as PlanRevisionMeta;
    }
  }
  return undefined;
}

function latestRevisionId(timeline: TimelineEvent[]): string | undefined {
  return priorRevision(timeline)?.revisionId;
}
