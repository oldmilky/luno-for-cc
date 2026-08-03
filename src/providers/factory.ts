// ─────────────────────────────────────────────────────────────
// Provider factory — subscription-only.
//
// Luno runs exclusively on the Claude Code subscription via the
// user's own `claude` CLI; the previous API-key fork (direct calls
// to the Anthropic Messages API + in-process tool execution) is
// gone. This file is kept as the single entry point for any future
// provider work so call sites don't need to know about transport
// details.
// ─────────────────────────────────────────────────────────────

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import * as vscode from "vscode";
import { ClaudeCliProvider } from "./claude-cli.js";
import type { PendingSetting } from "./cli/options.js";
import type { EffortLevel } from "../core/effort.js";
import { PermissionMode, StreamDelta, TaskType } from "../core/types.js";
import type { ToolGrant } from "../core/tool-grants.js";
import { ConventionsFile } from "../services/conventions.js";
import { ideEditorOps } from "../services/ide/editor.js";
import { rejectAllPendingDiffs } from "../services/ide/diff-tabs.js";
import { warn as logWarn } from "../services/logger.js";

export interface ProviderContext {
  cwd: string;
  permissionMode?: PermissionMode;
  allowedBashPatterns?: string[];
  /** Skill ids the user has toggled OFF in the picker. Enforced via
   *  --disallowedTools + --append-system-prompt. */
  disabledSkills?: string[];
  /** Heuristic task classification for the current turn — drives task-type
   *  playbook injection in plan mode. */
  taskType?: TaskType;
  /** Project conventions file (CLAUDE.md / AGENTS.md / etc.) for the current
   *  workspace — auto-discovered, injected into the system prompt. */
  conventions?: ConventionsFile | null;
  /** The editor's Problems for this turn, already formatted. */
  diagnostics?: string | null;
  /** The active file and selection for this turn, already formatted. */
  editorContext?: string | null;
  getResumeSessionId?: () => string | undefined;
  setResumeSessionId?: (id: string) => void;
  /** Standing "always allow" grants, read per decision so one granted from a
   *  card silences the next call of the same turn. */
  getToolGrants?: () => ReadonlyArray<ToolGrant>;
  /** Settings-shaped argv, present from construction so the bridge and the
   *  first turn build the same command line. */
  additionalDirectories?: string[];
  fallbackModels?: string[];
  maxBudgetUsd?: number;
  sessionName?: string;
  safeMode?: boolean;
  /** Told the CLI's slash-command list when a turn reports one. */
  onSlashCommands?: (names: string[]) => void;
  /** Auth token (OAuth or API key) injected into the CLI's environment. */
  token?: string;
  /** Optional path to a temp JSON file in CLI's `--mcp-config` format. */
  mcpConfigPath?: string;
  /** Names of the MCP servers in mcpConfigPath — used for auto-mode allowlist. */
  mcpServerNames?: string[];
  /** Reasoning effort for the session (`--effort`). */
  effort?: EffortLevel;
  /** Extended-thinking toggle (`alwaysThinkingEnabled` via `--settings`). */
  thinking?: boolean;
  /** Keep one CLI process alive across turns. Required by Remote Control,
   *  whose bridge ends when the process does. */
  sessionMode?: boolean;
  /** Whether replacing the CLI process right now would destroy running work —
   *  see `ClaudeCliOpts.hasLiveWork`. */
  hasLiveWork?: () => boolean;
  /** Which composer controls the running process is not honouring yet. */
  onSettingsPending?: (pending: PendingSetting[]) => void;
  /** Text the CLI was still holding when a turn was stopped, handed back to
   *  the composer so nothing typed is lost. */
  onStillQueued?: (text: string) => void;
  /** Session mode only: deltas that arrive while no turn is streaming — the
   *  other device talking to a conversation the panel is not driving. */
  onOutOfTurn?: (delta: StreamDelta) => void;
  /** Ultracode (`ultracode` via `--settings`): xhigh plus standing workflow
   *  orchestration. Pins the effort it runs at, so it travels with `effort`
   *  rather than replacing it. */
  ultracode?: boolean;
}

// Binary paths we've already made executable this session. The resolution
// helpers below run once per turn (and once per MCP call), so we memoise to
// avoid a redundant stat/chmod syscall on every spawn.
const ensuredExecutable = new Set<string>();

/**
 * Best-effort: make a bundled native binary runnable on macOS / Linux.
 *
 * VS Code does not reliably preserve the Unix executable bit when a `.vsix` is
 * installed (it survives `vsce package` inconsistently across versions and is
 * commonly stripped on extraction), so a freshly installed extension can ship
 * a `claude` binary the OS refuses to exec — surfacing as `spawn EACCES` or a
 * terminal launch failing with exit code 126. We defensively restore the `+x`
 * bits the first time we touch the binary, the same way Microsoft's C/C++, Go,
 * and rust-analyzer extensions chmod their bundled tools at activation.
 *
 * On Windows the bit is meaningless — executability comes from the `.exe`
 * extension — so we skip it entirely (chmod modes are a no-op there anyway).
 *
 * Never throws: a missing file (the caller surfaces a clearer "binary not
 * found" error) or a read-only install location must not take down the
 * extension. Exported for unit testing.
 */
export function ensureExecutable(binaryPath: string): void {
  if (process.platform === "win32") return;
  if (ensuredExecutable.has(binaryPath)) return;

  let mode: number;
  try {
    mode = fs.statSync(binaryPath).mode;
  } catch {
    // Not on disk yet — don't memoise, so a later call retries once it exists.
    return;
  }
  ensuredExecutable.add(binaryPath);

  const withExec = mode | 0o111; // +x for user, group, other
  if (withExec === mode) return; // already executable — nothing to do

  try {
    fs.chmodSync(binaryPath, withExec);
  } catch (err) {
    // Read-only filesystem or insufficient permissions. The spawn may still
    // fail, but that path surfaces its own actionable error to the user.
    logWarn(`[luno] could not make ${binaryPath} executable:`, err);
  }
}

// An extension *can* ship the CLI inside itself via the
// `@anthropic-ai/claude-code` npm dep, whose postinstall copies the
// platform-native binary to bin/claude.exe (same filename on every OS — on
// Unix the `.exe` suffix is ignored and the file is executed by content).
//
// LUNO does not: it runs the user's own install, so this path normally does
// NOT exist. It stays as the last-resort fallback for a re-bundled build;
// `resolveClaudeBinary` is what every call site must use.
//
// `ensureExecutable` runs here so every consumer gets a runnable binary
// through one chokepoint, with no per-call-site chmod scattered around.
//
// Exported for the unit tests only — production code goes through
// `resolveClaudeBinary`.
export function bundledClaudeBinary(): string {
  const binary = path.resolve(
    __dirname,
    "..",
    "node_modules",
    "@anthropic-ai",
    "claude-code",
    "bin",
    "claude.exe"
  );
  ensureExecutable(binary);
  return binary;
}

// ─────────────────────────────────────────────────────────────
// Finding the CLI
//
// LUNO ships no binary, so the one we run is always someone else's install.
// The manifest default used to be an absolute path to one machine's npm
// global — which meant every other machine had a broken extension until the
// user found the setting. We look for it instead, the way a shell would.
// ─────────────────────────────────────────────────────────────

/** True only for a regular file — a *directory* named `claude` is not a CLI. */
function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// We spawn without `shell: true`, and Node refuses to exec a .cmd/.bat
// directly (EINVAL since v20). That matters on Windows: npm's global install
// puts `claude.cmd` + `claude.ps1` shims on PATH and the real executable a
// level down in node_modules. Resolving to the shim would look like success
// here and fail on the first turn, so Windows only ever accepts `claude.exe`.
const WINDOWS_NPM_NESTED = path.join(
  "node_modules",
  "@anthropic-ai",
  "claude-code",
  "bin",
  "claude.exe"
);

/** The first runnable `claude` inside `dir`, or null. */
function probeDir(dir: string): string | null {
  const win = process.platform === "win32";

  const direct = path.join(dir, win ? "claude.exe" : "claude");
  if (isFile(direct)) return direct;

  // Windows-only: step past the shim to the executable it wraps. On Unix the
  // PATH entry is a symlink to the package's bin, which spawns fine as-is.
  if (win) {
    const nested = path.join(dir, WINDOWS_NPM_NESTED);
    if (isFile(nested)) return nested;
  }
  return null;
}

/**
 * Install locations to try after PATH. The extension host does not reliably
 * inherit a login shell's PATH — a GUI-launched editor on macOS is the
 * classic case — so a `claude` that works in the user's terminal can be
 * invisible to us. These are the two official installers' destinations.
 */
function knownInstallDirs(): string[] {
  const home = os.homedir();
  // Claude Code's native installer, on every platform.
  const dirs = [path.join(home, ".claude", "local")];

  if (process.platform === "win32") {
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, "npm"));
  } else {
    dirs.push(
      path.join(home, ".local", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin"
    );
  }
  return dirs;
}

// Positive results only. Memoising a miss would mean a user who installs the
// CLI mid-session stays broken until they reload the window — and a miss
// already means chat does not work, so re-walking PATH costs nothing that
// matters. The memo is re-validated because an npm update can replace the
// file we found.
let discovered: string | null = null;

/**
 * Search PATH, then the known install dirs, for a spawnable `claude`.
 * Exported for the unit tests; production code goes through
 * `resolveClaudeBinary`.
 */
export function discoverClaudeBinary(): string | null {
  if (discovered && isFile(discovered)) return discovered;
  discovered = null;

  const pathDirs = (process.env.PATH ?? "")
    .split(path.delimiter)
    // Windows PATH entries are sometimes quoted; `path.join` would keep the
    // quote and every probe would miss.
    .map((d) => d.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);

  for (const dir of [...pathDirs, ...knownInstallDirs()]) {
    const hit = probeDir(dir);
    if (hit) {
      discovered = hit;
      return hit;
    }
  }
  return null;
}

/**
 * The `claude` binary Luno should run — **the single entry point**. Every
 * call site (chat stream, sign-in terminal, capability probe, MCP bridge,
 * silent logout) must resolve through here; reaching for
 * `bundledClaudeBinary()` directly breaks on a build with no bundled CLI,
 * which is exactly what LUNO is.
 *
 * Order: `luno.claudeBinaryPath` if it points at a file that exists, then
 * auto-discovery, then the bundled path as a last resort for a re-bundled
 * build. The override stays first so a user with several installs can pin
 * one — that is also the "dynamic models" property: model aliases (`opus`,
 * `default`, …) resolve to whatever the *binary* knows, so pointing this at a
 * self-updating native install means new models appear as that CLI updates,
 * with no new Luno release.
 *
 * Never chmods what it finds. `ensureExecutable` exists for a binary *we*
 * ship; reaching into someone's own install and changing its mode is not our
 * call.
 */
export function resolveClaudeBinary(): string {
  const override = vscode.workspace
    .getConfiguration("luno")
    .get<string>("claudeBinaryPath", "")
    .trim();
  if (override && fs.existsSync(override)) return override;
  return discoverClaudeBinary() ?? bundledClaudeBinary();
}

// Concrete on purpose: Remote Control is a CLI-provider capability, and the
// caller that turns it on needs to reach it. Every existing use still sees a
// ChatProvider, which this implements.
export function createProvider(ctx: ProviderContext): ClaudeCliProvider {
  return new ClaudeCliProvider({
    sessionMode: ctx.sessionMode,
    hasLiveWork: ctx.hasLiveWork,
    onSettingsPending: ctx.onSettingsPending,
    onStillQueued: ctx.onStillQueued,
    onOutOfTurn: ctx.onOutOfTurn,
    binary: resolveClaudeBinary(),
    cwd: ctx.cwd,
    permissionMode: ctx.permissionMode,
    allowedBashPatterns: ctx.allowedBashPatterns,
    disabledSkills: ctx.disabledSkills,
    taskType: ctx.taskType,
    conventions: ctx.conventions,
    diagnostics: ctx.diagnostics,
    editorContext: ctx.editorContext,
    getResumeSessionId: ctx.getResumeSessionId,
    getToolGrants: ctx.getToolGrants,
    // Not on ProviderContext: the `ide` server is one per extension host, not
    // one per conversation, so there is nothing for a caller to decide and no
    // reason to thread it through five hops that could each drop it.
    ideOps: ideEditorOps,
    onAbortIdeWork: rejectAllPendingDiffs,
    additionalDirectories: ctx.additionalDirectories,
    fallbackModels: ctx.fallbackModels,
    maxBudgetUsd: ctx.maxBudgetUsd,
    sessionName: ctx.sessionName,
    safeMode: ctx.safeMode,
    setResumeSessionId: ctx.setResumeSessionId,
    onSlashCommands: ctx.onSlashCommands,
    token: ctx.token,
    mcpConfigPath: ctx.mcpConfigPath,
    mcpServerNames: ctx.mcpServerNames,
    effort: ctx.effort,
    thinking: ctx.thinking
  });
}
