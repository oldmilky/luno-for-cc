// ─────────────────────────────────────────────────────────────
// Authentication: which credential LUNO has, and the flows that get one.
//
// There are two paths to being signed in, and the difference matters:
//
//   1. A token in VS Code's SecretStorage, pasted by the user. LUNO injects it
//      into the CLI's environment on each spawn.
//   2. `claude setup-token` wrote credentials into Claude Code's *own* store.
//      LUNO holds nothing and injects nothing — the CLI finds its own creds.
//      All we keep is a flag saying that happened.
//
// `authed` is therefore "not explicitly signed out AND (we hold a token OR the
// CLI does)". The `signedOut` flag is sticky and wins: if SecretStorage ever
// returns a stale token after a logout, the explicit user action still decides.
// ─────────────────────────────────────────────────────────────

import * as vscode from "vscode";
import * as fs from "node:fs";
import {
  classifyToken,
  deleteToken,
  getToken,
  setToken
} from "../../secrets.js";
import { resolveClaudeBinary } from "../../providers/factory.js";
import type { PermissionMode } from "../../core/types.js";
import type { EffortLevel } from "../../providers/claude-cli.js";
import type { Post } from "../messages.js";

const CREDS_READY_KEY = "luno.claudeCredsReady.v1";

/**
 * The gate's answer. A discriminated union rather than a boolean plus a separate
 * getter, so the token is unreachable without having passed the check.
 */
export type TurnCredential =
  { ok: true; token: string | undefined } | { ok: false };

export interface AuthHooks {
  /** Signed in — refresh whatever only makes sense with a credential. */
  onAuthed: () => Promise<void>;
  /** Signed out — stop the running turn and drop its continuation state. */
  onSignOut: () => void;
}

export class AuthManager {
  /**
   * Sticky: set the moment the user clicks Logout, cleared only by signing back
   * in. It outranks a token still sitting in SecretStorage, so an explicit
   * logout cannot be undone by a stale read.
   */
  private signedOut = false;

  /**
   * The `claude setup-token` terminal, when one is open.
   *
   * A visible terminal rather than a child process because `setup-token` is
   * interactive: it prints a URL and then waits, either for a pasted code on
   * stdin or for its own local callback server. Nothing headless can service
   * that.
   */
  private setupTerminal?: vscode.Terminal;

  constructor(
    private readonly post: Post,
    private readonly ctx: vscode.ExtensionContext,
    private readonly hooks: AuthHooks
  ) {}

  /** Publish auth state plus the settings the composer renders from. */
  async broadcast(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("luno");
    const token = await getToken(this.ctx);
    const credsReady = this.ctx.globalState.get<boolean>(
      CREDS_READY_KEY,
      false
    );
    const authed = !this.signedOut && (!!token || credsReady);

    this.post({
      type: "auth",
      authed,
      model: cfg.get<string>("model", "default"),
      permissionMode: cfg.get<PermissionMode>("permissionMode", "default"),
      effort: cfg.get<EffortLevel>("effort", "high"),
      thinking: cfg.get<boolean>("thinking", true)
    });

    if (authed) await this.hooks.onAuthed();
  }

  /**
   * Gate a turn on having a usable credential.
   *
   * Returns false in two cases, and the second one is deliberate rather than a
   * bug worth "fixing":
   *
   *   1. There is no credential at all. The UI is refreshed to the welcome
   *      screen and the turn is refused.
   *   2. A credential exists but `signedOut` was still set — the user signed in
   *      through `claude setup-token` in another window, say. The flag is
   *      repaired and auth re-broadcast, but this turn is **still** refused, so
   *      the user sees the signed-in state before pressing send again rather
   *      than a turn starting out of an interface that says "signed out".
   */
  async ensureAuthedForTurn(): Promise<TurnCredential> {
    const token = await getToken(this.ctx);
    const credsReady = this.ctx.globalState.get<boolean>(
      CREDS_READY_KEY,
      false
    );
    const hasCredential = !!token || credsReady;

    // `token` rides along on success so a caller cannot reach it without
    // passing the gate. It is legitimately undefined when `credsReady` carried
    // the day: the CLI has its own creds and wants nothing injected.
    if (hasCredential && !this.signedOut) return { ok: true, token };

    this.signedOut = !hasCredential;
    await this.broadcast();
    return { ok: false };
  }

  /**
   * Start `claude setup-token` in a terminal the user can see and type into.
   */
  startSetup(): void {
    // Drop any prior terminal first: one that still has `claude` running would
    // take the new command as REPL input instead of executing it.
    this.cancelSetup();

    const binary = resolveClaudeBinary();
    if (!fs.existsSync(binary)) {
      this.post({
        type: "setupProgress",
        stage: "error",
        error:
          "Claude CLI not found. Luno searched PATH and the standard install " +
          "locations and came up empty. Install Claude Code, or set " +
          '"luno.claudeBinaryPath" to your claude binary (run `where claude` / ' +
          "`which claude` to find it), or paste a token manually below."
      });
      return;
    }

    this.post({ type: "setupProgress", stage: "launching" });

    // The binary IS the terminal's process (`shellPath` + `shellArgs`), rather
    // than a command typed into whatever shell happens to be default. Routing
    // through a shell breaks on Windows: PowerShell parses a line that *starts*
    // with a quoted path — `"C:\…\claude.exe" setup-token` — as a string
    // literal and rejects the trailing argument. It would need a leading `&`,
    // which then breaks cmd.exe and POSIX shells. With no shell in the way it
    // behaves identically everywhere and the path may contain spaces. stdin and
    // stdout are still the terminal's, so the flow stays interactive.
    const term = vscode.window.createTerminal({
      name: "Luno Sign-in",
      shellPath: binary,
      shellArgs: ["setup-token"]
    });
    this.setupTerminal = term;
    term.show(true);
    this.post({ type: "setupProgress", stage: "awaitingBrowser" });

    // If the user closes the terminal mid-flow, drop the handle so the welcome
    // screen does not sit on "awaiting browser" forever. Deliberately not an
    // error: they may have closed it *after* signing in, and will click
    // "I've signed in" next.
    const closeSub = vscode.window.onDidCloseTerminal((closed) => {
      if (closed !== term) return;
      closeSub.dispose();
      if (this.setupTerminal === term) this.setupTerminal = undefined;
    });
  }

  /** Cancel a pending `setup-token`. */
  cancelSetup(): void {
    this.setupTerminal?.dispose();
    this.setupTerminal = undefined;
  }

  /**
   * The user says they signed in. The terminal flow put credentials in Claude
   * Code's own store, so there is nothing for LUNO to hold — record that it
   * happened and let the CLI find its own creds on every spawn.
   */
  async confirmSetup(): Promise<void> {
    this.post({ type: "setupProgress", stage: "saving" });
    await this.ctx.globalState.update(CREDS_READY_KEY, true);
    this.signedOut = false;
    this.cancelSetup();
    this.post({ type: "setupProgress", stage: "done" });
    await this.broadcast();
  }

  /**
   * Sign out. LUNO owns this state, so it is one durable operation: confirm,
   * stop the stream, delete the secret, return to the welcome screen. No CLI
   * invocation and nothing touched under `~/.claude/`.
   */
  async logout(): Promise<void> {
    const pick = await vscode.window.showWarningMessage(
      "Sign out of Claude?",
      {
        modal: true,
        detail:
          "Removes the auth token stored in VS Code's SecretStorage and returns you to the welcome screen. Chat history, checkpoints, and pinned files are preserved."
      },
      "Sign out"
    );
    if (pick !== "Sign out") return;

    this.hooks.onSignOut();
    await deleteToken(this.ctx);

    // The CLI's own credential flag has to go too, or the user stays authed
    // through Claude Code's keychain entry after we wiped ours. We do not run
    // `claude logout` — it opens an interactive flow — and the next
    // `setup-token` overwrites those creds anyway.
    await this.ctx.globalState.update(CREDS_READY_KEY, false);

    this.signedOut = true;
    await this.broadcast();
  }

  /**
   * Accept a pasted token. Format check only — the real validation is the first
   * prompt streaming through the CLI, and a network round-trip here would just
   * be a second place for the answer to be wrong.
   */
  async submitToken(rawToken: string): Promise<void> {
    const token = rawToken.trim();
    if (!token) {
      this.post({ type: "tokenResult", ok: false, error: "Token is empty." });
      return;
    }

    if (classifyToken(token) === "unknown") {
      this.post({
        type: "tokenResult",
        ok: false,
        error:
          "Unrecognized token format. Use a Claude Code OAuth token (sk-ant-oat…) or an Anthropic Console API key (sk-ant-api…)."
      });
      return;
    }

    await setToken(this.ctx, token);
    this.signedOut = false;
    this.post({ type: "tokenResult", ok: true });
    await this.broadcast();
  }

  dispose(): void {
    this.cancelSetup();
  }
}
