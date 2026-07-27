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
import { EFFORT_LADDERS } from "../../providers/claude-cli.js";
import type { EffortLevel } from "../../providers/claude-cli.js";
import type { Post } from "../messages.js";

export type ModelGroup = "alias" | "version";

export interface ModelInfo {
  value: string;
  label: string;
  note: string;
  supportsTools: boolean;
  group: ModelGroup;
  /** One reason to reach for a pinned version, and one reason not to. Both or
   *  neither — a row that argues only one side is an advertisement. */
  plus?: string;
  minus?: string;
  /**
   * Levels this model accepts from `--effort`, in order. An empty array means
   * it rejects the flag entirely.
   *
   * We push `--effort` on every spawn next to `--model`, so a level the model
   * never had is not a missing feature — it is a CLI error the user cannot
   * read. Absent on aliases: those always resolve to something current.
   */
  effort?: ReadonlyArray<EffortLevel>;
  /** Whether the user's own CLI served this id when asked. `undefined` until
   *  the probe has answered for it. */
  available?: boolean;
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
      value: "fable",
      label: "Fable",
      note: "The most powerful, for the hardest problems",
      supportsTools: true,
      group: "alias"
    },
    {
      value: "sonnet",
      label: "Sonnet",
      note: "Best for everyday tasks",
      supportsTools: true,
      group: "alias"
    }
  ];
}

/**
 * Pinned versions, offered behind their own door.
 *
 * The aliases above exist so the picker never carries a version number that can
 * go stale. This list is the deliberate opposite: pinning is the whole point,
 * so the ids are literal and they *will* rot. Two things keep that honest —
 * every entry is probed against the user's own CLI before it is offered, and a
 * model with a published retirement date is left out rather than shipped to die
 * in the user's picker (which is why Opus 4.1, retiring 2026-08-05, is absent).
 *
 * Each row argues both sides. A list of older models with only upsides is a
 * list that talks people into a worse model.
 */
export function legacyModels(): ModelInfo[] {
  // The ladder is looked up by id rather than written per row, so the picker
  // and the spawn read the same table and cannot disagree about a version.
  return LEGACY.map((m) => ({ ...m, effort: EFFORT_LADDERS[m.value] }));
}

const LEGACY: ReadonlyArray<ModelInfo> = [
  // Two aliases behind this door, and the only rows here that do not pin a
  // version — both still track the latest of their tier. They sit here rather
  // than on the front page because a short page is what makes it readable in a
  // sidebar, and neither is the one to reach for first.
  //
  // `opus` is NOT the same model as `default`, however alike the two rows read:
  // measured against 2.1.219, `default` serves `claude-opus-5[1m]` and `opus`
  // serves `claude-opus-5`. The difference is the million-token window, so this
  // row is how you ask for the one without it.
  {
    value: "opus",
    label: "Opus",
    note: "Opus 5 without the 1M window",
    plus: "The same model the default serves, on the standard context window",
    minus:
      "Long sessions fold sooner — there is a million fewer tokens of room",
    supportsTools: true,
    group: "alias"
  },
  {
    value: "haiku",
    label: "Haiku",
    note: "Fastest for quick answers — tracks the latest Haiku, not a pin",
    plus: "Answers in a fraction of the time and spends far less of the quota",
    minus: "Loses the thread on long multi-step work with many tool calls",
    supportsTools: true,
    group: "alias"
  },
  {
    value: "claude-opus-4-8",
    label: "Opus 4.8",
    note: "The Opus before the current one",
    plus: "Warmer, less hedged prose; holds a long autonomous run together",
    minus: "Narrates more between tool calls, and asks before small decisions",
    supportsTools: true,
    group: "version"
  },
  {
    value: "claude-opus-4-7",
    label: "Opus 4.7",
    note: "More literal, less eager to reach for a tool",
    plus: "First with high-resolution vision — 2576px on the long edge",
    minus: "New tokenizer: the same text costs up to 1.35× more of your quota",
    supportsTools: true,
    group: "version"
  },
  {
    value: "claude-opus-4-6",
    label: "Opus 4.6",
    note: "The last Opus on the old tokenizer",
    plus: "Older tokenizer, so the same text spends less of your quota",
    minus: "No xhigh, and it writes maths as LaTeX unless told otherwise",
    supportsTools: true,
    group: "version"
  },
  {
    value: "claude-opus-4-5",
    label: "Opus 4.5",
    note: "The settled one",
    plus: "Older prompts were tuned against it and still land as written",
    minus: "Its effort ladder stops at high",
    supportsTools: true,
    group: "version"
  },
  {
    value: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    note: "The Sonnet before the current one",
    plus: "A 1M window and adaptive thinking at Sonnet's speed",
    minus: "Clearly behind Sonnet 5 on agentic and coding work",
    supportsTools: true,
    group: "version"
  },
  {
    value: "claude-sonnet-4-5",
    label: "Sonnet 4.5",
    note: "The most written-about Sonnet",
    plus: "Most published prompts and recipes still target this one",
    minus: "Rejects --effort outright, so the effort control goes dark",
    supportsTools: true,
    group: "version"
  }
];

/** A probe that has not answered in this long is never going to. */
const PROBE_TIMEOUT_MS = 10_000;

export class ModelResolver {
  /** alias → concrete model id, once known. */
  private readonly resolved = new Map<string, string>();
  /** Guards against a second sweep starting while the first is mid-flight. */
  private resolving = false;
  private probe?: ChildProcess;
  /** Pinned id → whether this CLI served it. Empty until the panel is opened. */
  private readonly legacyAvailable = new Map<string, boolean>();
  private legacyProbed = false;

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
   * Answer the picker's older-models panel, and find out on the first ask which
   * of those ids this user's CLI will actually serve.
   *
   * Lazy on purpose: the list costs one CLI spawn per entry, and most sessions
   * never open the panel at all. The answer is cached, so opening it twice
   * costs nothing the second time.
   */
  async broadcastLegacy(probe: boolean): Promise<void> {
    this.post({ type: "legacyModels", models: this.legacyWithAvailability() });
    if (!probe || this.legacyProbed) return;
    await this.probeLegacy();
    this.post({ type: "legacyModels", models: this.legacyWithAvailability() });
  }

  private legacyWithAvailability(): ModelInfo[] {
    return legacyModels().map((m) => ({
      ...m,
      available: this.legacyAvailable.get(m.value)
    }));
  }

  /**
   * Ask the CLI for each pinned id in turn. A model the plan does not carry —
   * or one that was retired out from under this list — never reaches the `init`
   * event, so `probeAlias` answers `null` and the row is offered as unavailable
   * rather than as a button that fails on the first turn.
   */
  private async probeLegacy(): Promise<void> {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) return;
    const binary = resolveClaudeBinary();
    if (!fs.existsSync(binary)) return;
    const token = await getToken(this.ctx);

    // Wait out an alias sweep rather than racing it: this class keeps exactly
    // one child in `this.probe`, and a second sweep would overwrite the handle
    // `dispose()` needs to kill.
    while (this.resolving) await new Promise((r) => setTimeout(r, 120));

    this.resolving = true;
    try {
      for (const model of legacyModels()) {
        const served = await this.probeAlias(model.value, binary, cwd, token);
        this.legacyAvailable.set(model.value, served !== null);
        // Post per model, not once at the end: a spawn that goes the full
        // 10s timeout would otherwise hold every other row at "checking".
        this.post({
          type: "legacyModels",
          models: this.legacyWithAvailability()
        });
      }
      this.legacyProbed = true;
    } finally {
      this.resolving = false;
    }
  }

  /**
   * Drop every mapping. Pointing at a different `claude` binary changes what
   * the aliases resolve to, so a cached version is worse than none.
   */
  clear(): void {
    this.resolved.clear();
    // A different binary is a different set of models, not just a different
    // mapping — what it refused yesterday it may serve today.
    this.legacyAvailable.clear();
    this.legacyProbed = false;
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
