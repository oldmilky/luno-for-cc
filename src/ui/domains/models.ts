// ─────────────────────────────────────────────────────────────
// Model list and alias resolution.
//
// The picker offers aliases (`opus`, `sonnet`, `default`) because that is what
// keeps working when Anthropic ships a new model — the CLI maps them, not us.
// The cost is that the user picks "opus" and cannot see what actually ran, so
// each alias is resolved once to its concrete id by starting a throwaway turn
// and reading the CLI's `init` event.
//
// Three call sites write to the cache, which is why this is a class holding
// its own state rather than a pair of functions:
//
//   broadcast()  the picker opens, or the panel reloads
//   record()     a real turn reported its model — authoritative, free
//   clear()      `luno.claudeBinaryPath` changed, so every mapping is suspect
//
// `dispose()` exists because a probe is a live child process; without it a
// wedged one outlives the extension.
// ─────────────────────────────────────────────────────────────

import * as vscode from "vscode";
import * as fs from "node:fs";
import * as readline from "node:readline";
import { spawn, ChildProcess } from "node:child_process";
import { resolveClaudeBinary } from "../../providers/factory.js";
import { getToken } from "../../secrets.js";
import type { Post } from "../messages.js";

export type ModelGroup = "alias" | "version";

export interface ModelInfo {
  value: string;
  label: string;
  note: string;
  supportsTools: boolean;
  group: ModelGroup;
}

/**
 * Models surfaced in the picker.
 *
 * LUNO runs on the Claude Code subscription through the user's own CLI, so the
 * picker offers the CLI's *aliases* rather than pinned version ids. Per
 * `claude --help`, `--model` takes "an alias for the latest model (e.g.
 * 'sonnet' or 'opus')" — each always resolves to the newest release for that
 * tier on the user's plan. No hardcoded version numbers to go stale: the
 * picker tracks whatever Claude Code ships as latest.
 *
 * Reference: https://code.claude.com/docs/en/model-config
 */
export function availableModels(): ModelInfo[] {
  return [
    {
      value: "default",
      label: "Default",
      note: "Most capable for complex work",
      supportsTools: true,
      group: "alias"
    },
    {
      value: "opus",
      label: "Opus",
      note: "Deepest reasoning, hardest problems",
      supportsTools: true,
      group: "alias"
    },
    {
      value: "sonnet",
      label: "Sonnet",
      note: "Best for everyday tasks",
      supportsTools: true,
      group: "alias"
    },
    {
      value: "haiku",
      label: "Haiku",
      note: "Fastest for quick answers",
      supportsTools: true,
      group: "alias"
    }
  ];
}

/** A probe that has not answered in this long is never going to. */
const PROBE_TIMEOUT_MS = 10_000;

export class ModelResolver {
  /** alias → concrete model id, once known. */
  private readonly resolved = new Map<string, string>();
  /** Guards against a second sweep starting while the first is mid-flight. */
  private resolving = false;
  private probe?: ChildProcess;

  constructor(
    private readonly post: Post,
    private readonly ctx: vscode.ExtensionContext
  ) {}

  /** Publish the list, then fill in concrete versions in the background. */
  async broadcast(): Promise<void> {
    this.post({ type: "models", models: availableModels() });
    void this.resolveVersions();
  }

  /**
   * Record a mapping observed during a real turn. Free and authoritative — the
   * CLI just told us what it ran — so it beats anything a probe could learn.
   */
  record(alias: string, model: string): void {
    this.resolved.set(alias, model);
    this.post({ type: "activeModel", model, alias });
  }

  /**
   * Drop every mapping. Pointing at a different `claude` binary changes what
   * the aliases resolve to, so a cached version is worse than none.
   */
  clear(): void {
    this.resolved.clear();
  }

  /** Kill an in-flight probe. Called on extension teardown. */
  dispose(): void {
    this.probe?.kill("SIGKILL");
    this.probe = undefined;
  }

  private async resolveVersions(): Promise<void> {
    const aliases = availableModels().map((m) => m.value);

    // Re-post what is already known before doing any work — a panel reload
    // should not look like a regression while the probes run.
    for (const alias of aliases) {
      const model = this.resolved.get(alias);
      if (model) this.post({ type: "activeModel", model, alias });
    }

    if (this.resolving) return;
    const missing = aliases.filter((a) => !this.resolved.has(a));
    if (missing.length === 0) return;

    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) return;

    // The *same* binary a turn would use, so the version shown is the version
    // that runs. Resolving against a different install would be a lie.
    const binary = resolveClaudeBinary();
    if (!fs.existsSync(binary)) return;

    const token = await getToken(this.ctx);

    this.resolving = true;
    try {
      // Sequential: never more than one CLI process alive for this.
      for (const alias of missing) {
        const model = await this.probeAlias(alias, binary, cwd, token);
        if (model) {
          this.resolved.set(alias, model);
          this.post({ type: "activeModel", model, alias });
        }
      }
    } finally {
      this.resolving = false;
    }
  }

  /**
   * Start a turn that is killed the moment the CLI announces which model it
   * picked. Resolves to null on any error or timeout so the caller moves on to
   * the next alias instead of stalling the sweep.
   */
  private probeAlias(
    alias: string,
    binary: string,
    cwd: string,
    token: string | undefined
  ): Promise<string | null> {
    return new Promise((resolve) => {
      const env = token
        ? { ...process.env, ANTHROPIC_API_KEY: token }
        : process.env;

      // The prompt is never seen — we kill at the init event.
      // `--no-session-persistence` keeps this from leaving an empty session.
      const child = spawn(
        binary,
        [
          "-p",
          "--model",
          alias,
          "--output-format",
          "stream-json",
          "--verbose",
          "--no-session-persistence",
          "."
        ],
        { cwd, env, stdio: ["ignore", "pipe", "ignore"] }
      );
      this.probe = child;

      let settled = false;
      const finish = (result: string | null) => {
        if (settled) return;
        settled = true;
        if (this.probe === child) this.probe = undefined;
        if (!child.killed) child.kill("SIGKILL");
        resolve(result);
      };

      const rl = readline.createInterface({
        input: child.stdout!,
        crlfDelay: Infinity
      });
      rl.on("line", (line) => {
        if (settled) return;
        const trimmed = line.trim();
        if (!trimmed) return;
        let ev: { type?: string; subtype?: string; model?: string };
        try {
          ev = JSON.parse(trimmed);
        } catch {
          return;
        }
        if (
          ev.type === "system" &&
          ev.subtype === "init" &&
          typeof ev.model === "string"
        ) {
          finish(ev.model);
        }
      });

      child.once("error", () => finish(null));
      child.once("exit", () => finish(null));
      setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    });
  }
}
