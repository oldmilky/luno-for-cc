// ─────────────────────────────────────────────────────────────
// argv for a `claude` spawn, and the two questions asked about argv after it
// is built: what changed, and does the change force a new process.
//
// Separate from the provider because building a command line is a pure
// function of the options — which is what lets the flag set be tested without
// spawning anything, and why `buildArgs` has more test coverage than the
// spawn does.
//
// `respawnFingerprint` is the load-bearing one: it decides whether the next
// turn reuses the running process or replaces it, and a replacement kills
// every background agent living inside it.
// ─────────────────────────────────────────────────────────────

import { fallbackModelList, maxBudgetUsd } from "../../core/workspace-dirs.js";
import {
  EFFORT_LADDERS,
  EFFORT_LEVELS,
  type EffortLevel
} from "../../core/effort.js";
import {
  regexToCliPatterns,
  isDestructiveBash,
  isNetworkBash,
  ROUTE_TO_CLASSIFIER_BASH
} from "../../core/permission-policy.js";
import { ideAllowedToolPatterns } from "../../core/ide-tools.js";
import type { PermissionMode } from "../../core/types.js";
import {
  getCommonPrompt,
  getModePrompt,
  getTaskTypePrompt
} from "../../services/prompt-loader.js";
import type { ClaudeCliOpts } from "./options.js";

/** The CLI only services interactive per-tool approval over the stream-json
 *  control channel; that's `default`, `acceptEdits` and `auto` — acceptEdits
 *  waves edits through and still asks about everything else. `plan` stays
 *  read-only and keeps the simpler text-input invocation (the plan flow handles
 *  its own approval via ExitPlanMode). `bypass` needs no channel either — the
 *  CLI approves everything itself and never asks, so keeping stdin open for
 *  control responses that can never arrive would be dead weight. */
function usesPermissionProtocol(mode: PermissionMode): boolean {
  return mode === "default" || mode === "acceptEdits" || mode === "auto";
}

/** Diagnostics and editor context as a block that rides with the turn text.
 *  Session mode only: there the system prompt is fixed at spawn, and these two
 *  describe the moment the message was sent. */
export function turnPreamble(opts: ClaudeCliOpts): string {
  const parts = [opts.diagnostics, opts.editorContext].filter(
    (p): p is string => Boolean(p && p.trim())
  );
  return parts.length ? parts.join("\n\n") + "\n\n" : "";
}

/** argv reduced to what forces a respawn. `--resume` is dropped: it only
 *  matters at spawn, and it changes as soon as the first turn reports a
 *  session id, which would otherwise replace the process every turn. */
/**
 * What changed between two argv lists, short enough for one log line.
 *
 * Values are truncated: a `--append-system-prompt` payload is a whole document,
 * and the useful part is which flag moved, not what it now says.
 */
export function argvDiff(
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>
): string {
  const clip = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}…` : s);
  const gone = before.filter((a) => !after.includes(a));
  const added = after.filter((a) => !before.includes(a));
  const parts: string[] = [];
  if (gone.length) parts.push(`-${gone.map(clip).join(" -")}`);
  if (added.length) parts.push(`+${added.map(clip).join(" +")}`);
  return parts.join(" ") || "argument order";
}

/** `--allowedTools` patterns for connected MCP servers, in a fixed order — see
 *  the note at the call site for why the order is load-bearing. */
export function mcpToolPatterns(names: ReadonlyArray<string> = []): string[] {
  return [...new Set(names)].sort().map((n) => `mcp__${n}`);
}

export function respawnFingerprint(args: ReadonlyArray<string>): string {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--resume") {
      i++;
      continue;
    }
    // The MCP config is written to a fresh `mkdtemp` directory every turn, so
    // its path differs even when nothing about the servers did. Left in, it
    // replaced the process on *every* turn — and with Remote Control on, each
    // replacement hands out a new session URL and silently strands the phone on
    // the old one. The server set still counts: it reaches argv separately, as
    // `--allowedTools mcp__<name>`.
    if (args[i] === "--mcp-config") {
      i++;
      continue;
    }
    // `set_model` exists and `applyLiveOptions` sends it, so the model has no
    // business replacing a process. Left in, it did: `/rc` spawns through
    // `buildArgs("", undefined, …)` with no `--model` at all, and the first
    // ordinary turn adds one — the fingerprints diverged over nothing and the
    // phone lost its bridge on the user's next message.
    if (args[i] === "--model") {
      i++;
      continue;
    }
    // Renaming a chat must not take its CLI process away. The name is what
    // `/resume` shows in a terminal; nothing about the running turn depends on
    // it, and the next spawn picks up whatever it is called by then.
    if (args[i] === "--name") {
      i++;
      continue;
    }
    kept.push(args[i]);
  }
  return JSON.stringify(kept);
}

/**
 * @param _userText kept so every caller still reads as "the args for this
 *   prompt", but no configuration puts the prompt in argv any more — it is
 *   written to stdin by the caller.
 */
/**
 * The `--effort` level this model and posture would be launched with, or
 * undefined when the flag is dropped.
 *
 * Ultracode outranks whatever level came with it: the setting is defined as
 * xhigh + workflows, and a stored posture pairing it with `max` would ask for a
 * combination the CLI does not offer. A pinned model that predates the level
 * would reject the flag, and the failure would arrive as a CLI error with
 * nothing pointing back at the picker — dropping it runs at the model's own
 * default instead.
 *
 * Shared with `setLiveModel`, which may not push a model whose ladder disagrees
 * with the running one: the level reaches the CLI through argv, and argv cannot
 * be rebuilt under a live process.
 */

export function effortFlag(
  model: string | undefined,
  opts: ClaudeCliOpts
): EffortLevel | undefined {
  const effort = opts.ultracode ? "xhigh" : opts.effort;
  const ladder = model ? EFFORT_LADDERS[model] : undefined;
  const takesEffort = !ladder || ladder.includes(effort as EffortLevel);
  if (!effort || !EFFORT_LEVELS.includes(effort) || !takesEffort) {
    return undefined;
  }
  return effort;
}

export function buildArgs(
  _userText: string,
  model: string | undefined,
  opts: ClaudeCliOpts
): string[] {
  const mode = opts.permissionMode ?? "default";
  const permissionProtocol = usesPermissionProtocol(mode);

  // Session mode drops `--print`, matching how the official extension spawns
  // the CLI: the process outlives the turn and keeps taking input. `-p` would
  // also stay alive under stream-json input, but Remote Control is only ever
  // exercised upstream in the no-print configuration, so we run the one that
  // is known to work rather than the one that merely should.
  const args = opts.sessionMode ? [] : ["-p"];
  args.push(
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose"
  );
  // The prompt always travels on stdin (see stream()), never as a positional
  // argument. Measured on 2.1.219: with the prompt in argv the CLI reports
  // `no stdin data received in 3s, proceeding without it` and opens its print
  // wind-down window, which terminates every background task still running
  // CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS later — a workflow was stopped at
  // 10m07s with `status: "stopped"`. The same workflow under stream-json input,
  // where stdin never closes and the window never opens, ran 13m14s to its own
  // completion. Bypass and Plan were the two modes still on the argv path.
  args.push("--input-format", "stream-json");
  if (permissionProtocol || opts.sessionMode) {
    // Route per-tool approval back to us over the control channel instead of
    // the CLI's own interactive prompt (which a headless run can't service).
    args.push("--permission-prompt-tool", "stdio");
  }
  if (opts.sessionMode) {
    // Without this a prompt typed on a connected phone or browser reaches
    // stdout nowhere — measured — and the panel would render an answer to a
    // question it never saw. It echoes our own stdin messages back too, so the
    // reader drops anything carrying `isReplay` that it just sent itself.
    args.push("--replay-user-messages");
  }
  if (model) args.push("--model", model);

  const effort = effortFlag(model, opts);
  if (effort) args.push("--effort", effort);

  // `--settings` layers a JSON blob on top of the resolved settings sources
  // (user/project/local) for this run only, so anything we set here leaves
  // every other setting intact.
  //   • alwaysThinkingEnabled — extended-thinking toggle (when defined).
  //   • permissions.ask — route git to our classifier even when a project
  //     allowlist pre-approves it. `ask` outranks `allow` in the CLI's
  //     deny → ask → allow resolution, so it can't be silently overridden.
  const settings: Record<string, unknown> = {};
  if (typeof opts.thinking === "boolean") {
    settings.alwaysThinkingEnabled = opts.thinking;
  }
  //   • ultracode — session-scoped by the CLI's own definition, which is why it
  //     travels here per run rather than being written to a settings file. Sent
  //     only when on: the key's absence is its off state, and writing `false`
  //     would override a settings file that deliberately turned it on.
  if (opts.ultracode) settings.ultracode = true;
  // Only inject the `ask` routing in the modes that both service the approval
  // channel and have no classifier of their own — `default` and `acceptEdits`.
  // (git is not an edit tool, so acceptEdits gates it exactly as default does.)
  //
  // Plan and bypass have no prompt tool, so an `ask` rule there would have
  // nothing to answer it: in plan it could block even read-only git, and in
  // bypass it would reintroduce the very prompt the mode exists to remove.
  //
  // `auto` is excluded for a different and sharper reason. A matched `ask` rule
  // is one of the CLI's enumerated reasons to skip its classifier entirely and
  // prompt instead, so this would put a card in front of *every* git call —
  // measured against 2.1.219 with an `ask` rule on `Bash(echo:*)`, which turned
  // `echo hello` into an approval request and, with the rule removed, did not.
  if (mode === "default" || mode === "acceptEdits") {
    settings.permissions = {
      ask: ROUTE_TO_CLASSIFIER_BASH.map((p) => `Bash(${p})`)
    };
  }
  if (Object.keys(settings).length > 0) {
    args.push("--settings", JSON.stringify(settings));
  }

  const cliMode = mapPermissionMode(opts.permissionMode ?? "default");
  args.push("--permission-mode", cliMode);

  if (opts.permissionMode === "auto") {
    // Pre-allow the safe, reversible tools. Under the CLI's own `auto` this is
    // mostly redundant — its classifier has a fast path for anything
    // `acceptEdits` would take — but it is not free of purpose: it is the whole
    // of Agent mode on the day the CLI declines to run that classifier and
    // downgrades us to `default`, and every call it covers is one the
    // classifier is not paid a model call to judge.
    //
    // Bash is deliberately NOT pre-allowed except for the user's own
    // allow-listed patterns. Edits stay reversible via the checkpoint system,
    // which is what makes auto-applying them safe.
    const tools = [
      "Read",
      "Glob",
      "Grep",
      "Edit",
      "Write",
      "MultiEdit",
      "NotebookEdit",
      ...(opts.allowedBashPatterns ?? []).flatMap((p) =>
        regexToCliPatterns(p)
          // Never pre-allow a destructive or network/external command, even if
          // the user allow-listed it — those must always surface the approval
          // card. Dropping them here means the CLI re-asks (routing them to us)
          // instead of auto-running.
          .filter((cli) => !isDestructiveBash(cli) && !isNetworkBash(cli))
          .map((cli) => `Bash(${cli})`)
      ),
      // Pre-allow every tool from each connected MCP server. Pattern is
      // `mcp__<server>` per Claude Code's MCP tool naming convention.
      //
      // Sorted, because argv decides whether a session-mode process survives
      // the turn: these names arrive from three sources merged through a Set,
      // one of them a cache a probe rewrites, so the same servers can come back
      // in a different order. A reordered argv replaced the CLI process — and
      // with Remote Control on, that hands the phone a session URL it is not
      // holding.
      ...mcpToolPatterns(opts.mcpServerNames),
      // The editor server goes in per tool, never as one `mcp__<name>` block:
      // the nine tools differ in weight, and `saveDocument` writing to disk has
      // no business riding in on `getWorkspaceFolders`'s ticket.
      ...ideAllowedToolPatterns()
    ];
    args.push("--allowedTools", ...tools);
  } else if (
    opts.permissionMode === "default" ||
    opts.permissionMode === "acceptEdits"
  ) {
    // These modes otherwise gate every tool call behind an interactive
    // prompt the `-p` flow can't service — the agent ends up verbalizing
    // "I need permission" instead of actually invoking the tool. Connecting
    // an MCP server via the Connectors page is an explicit consent grant
    // (OAuth + click-through), so pre-allow that server's tools here.
    // Plan mode is intentionally not covered — it's read-only by design.
    args.push(
      "--allowedTools",
      ...mcpToolPatterns(opts.mcpServerNames),
      ...ideAllowedToolPatterns()
    );
  }

  // Skills the user has toggled off in the picker need to be *actually*
  // blocked. Belt-and-suspenders:
  //   1. --disallowedTools "Skill(<name>)" — if Claude Code's permission
  //      system honors per-skill patterns, this is hard enforcement.
  //   2. --append-system-prompt — even if the flag pattern is ignored, the
  //      agent reads the appended instruction and refuses. Together they
  //      cover both the gate path and the model-decides path.
  const disabled = (opts.disabledSkills ?? []).filter((s) => s.length > 0);
  if (disabled.length > 0) {
    args.push("--disallowedTools", ...disabled.map((id) => `Skill(${id})`));
    const list = disabled.map((id) => `\`${id}\``).join(", ");
    args.push(
      "--append-system-prompt",
      `The user has disabled the following Claude Code skills via Luno's Skills picker: ${list}. Do not invoke any of them, even if a task would benefit. If you would normally use a disabled skill, tell the user which skill is disabled and ask them to re-enable it from the Skills picker before retrying. All other skills remain available.`
    );
  }

  // What holds in every mode: the environment, what this surface can do, and
  // the rules the approval posture does not change.
  const commonAppend = getCommonPrompt();
  if (commonAppend) args.push("--append-system-prompt", commonAppend);

  // Per-mode prompt: the posture this approval mode implies, and nothing else.
  const modeAppend = getModePrompt(mode);
  if (modeAppend) args.push("--append-system-prompt", modeAppend);

  // Plan mode, and only when the project has written nothing of its own: the
  // task-type playbook is a stand-in for conventions, not a supplement to them.
  // A project with a CLAUDE.md has said what matters here far more precisely,
  // and a generic checklist landing beside it competes rather than adds.
  if (mode === "plan" && opts.taskType && !opts.conventions) {
    const taskAppend = getTaskTypePrompt(opts.taskType);
    if (taskAppend) args.push("--append-system-prompt", taskAppend);
  }

  // What the language servers already know. Sent as its own append so it can
  // be dropped without disturbing the mode or conventions prompts.
  //
  // Both of these describe the tree and the cursor *as of this message*, so
  // they change every turn. A session-mode process is spawned once and cannot
  // have its system prompt rewritten, so there they travel with the turn text
  // instead (see turnPreamble) rather than being frozen at spawn — stale
  // diagnostics are worse than none.
  if (opts.diagnostics && !opts.sessionMode) {
    args.push("--append-system-prompt", opts.diagnostics);
  }

  // What the user has open and highlighted as they send the message.
  if (opts.editorContext && !opts.sessionMode) {
    args.push("--append-system-prompt", opts.editorContext);
  }

  // Project conventions. CLAUDE.md at root is auto-loaded by the CLI itself —
  // re-injecting would double the token cost — so skip in that case.
  if (opts.conventions && !opts.conventions.alreadyLoadedByCli) {
    args.push(
      "--append-system-prompt",
      `Project conventions from \`${opts.conventions.workspaceRelativePath}\`:\n\n${opts.conventions.content}`
    );
  }

  // Hand the CLI a list of remote MCP servers it should connect to for
  // this turn. The file is generated per-turn from Luno's connector
  // state, and the bearer tokens it contains live in OS temp with
  // mode 0600 — see writeCliMcpConfig() in services/mcp/index.ts.
  if (opts.mcpConfigPath) {
    args.push("--mcp-config", opts.mcpConfigPath);
  }

  // Every other folder in a multi-root window. Without it the agent knows
  // about one of them and reports the rest as missing files.
  if (opts.additionalDirectories?.length) {
    args.push("--add-dir", ...opts.additionalDirectories);
  }
  // One flag with a comma-separated list, not one flag per model — READ from
  // `--help`. Repeated, only the last would survive.
  const fallback = fallbackModelList(opts.fallbackModels, opts.model);
  if (fallback) args.push("--fallback-model", fallback);
  // `--max-budget-usd` is documented as working only with `--print`, which is
  // the `-p` this argv always begins with.
  const budget = maxBudgetUsd(opts.maxBudgetUsd);
  if (budget !== null) args.push("--max-budget-usd", String(budget));
  // What `/resume` in a terminal will call this conversation. Excluded from
  // `respawnFingerprint`, so renaming a chat does not replace its process.
  const name = opts.sessionName?.trim();
  if (name) args.push("--name", name);
  if (opts.safeMode) args.push("--safe-mode");
  // `--prompt-suggestions true` is deliberately NOT passed. The flag exists and
  // is accepted, but two isolated probes against 2.1.219 — a trivial turn and a
  // substantive one in a real project — produced no `prompt_suggestion` event
  // at all. A renderer built against a shape never observed is guesswork at
  // field names, and argv nothing consumes is noise.

  const resumeId = opts.getResumeSessionId?.();
  if (resumeId) args.push("--resume", resumeId);

  return args;
}

export function mapPermissionMode(m: PermissionMode): string {
  switch (m) {
    case "plan":
      return "plan";
    // Edits apply without a card; everything else still meets one. The CLI has
    // had this mode all along and no LUNO build has ever been able to reach it.
    case "acceptEdits":
      return "acceptEdits";
    // The CLI approves every tool itself and never emits a `can_use_tool`
    // request, so our permission policy is not consulted at all — not for
    // edits, not for `rm`, not for the destructive/network gate. That is the
    // mode's entire purpose; the guard against reaching it lives in the UI and
    // in `setPermissionMode`, not here.
    case "bypass":
      return "bypassPermissions";
    // The CLI's own `auto`: a model classifier reads the conversation and the
    // call and decides, escalating what it will not judge to the approval card
    // over the same control channel. It is not `acceptEdits` — that auto-runs
    // destructive `Bash` with no prompt — and it is no longer our own regex
    // policy either, which stays as the fallback for when the CLI declines to
    // run it.
    //
    // Asking for it is always safe: measured on 2.1.219, a CLI that cannot
    // provide it downgrades in silence and reports the mode it actually took in
    // `system/init`. That report is what `cliPermissionMode` reads.
    case "auto":
      return "auto";
    default:
      return "default";
  }
}
