import * as vscode from "vscode";
import { ChatPanelProvider } from "./ui/panel.js";
import { generateConventionsCommand } from "./commands/init-conventions.js";
import { registerDevAutoRestart } from "./dev-reload.js";
import { registerOutputChannel, showLogs } from "./ui/output-channel.js";
import { registerTerminalCapture } from "./ui/domains/terminal-capture.js";
import { registerIdeSelectionTracker } from "./services/ide/editor.js";
import { registerDiffTabs } from "./services/ide/diff-tabs.js";
import { promptFromUri } from "./core/open-uri.js";

export function activate(ctx: vscode.ExtensionContext) {
  // First, so anything logged during the rest of activation is captured.
  ctx.subscriptions.push(registerOutputChannel());
  registerDevAutoRestart(ctx);
  // Before the panel: a terminal command run during startup is one the user
  // may well be about to ask about.
  ctx.subscriptions.push(registerTerminalCapture());
  // Likewise early: `getLatestSelection` can only answer about selections made
  // after this is listening, and the first turn may ask about one made before
  // the panel was ever opened.
  ctx.subscriptions.push(registerIdeSelectionTracker());
  // The proposed-diff scheme and its two title-bar commands. Without this
  // `openDiff` has nowhere to put the proposal and no way for anyone to answer
  // it — which is the one failure that parks a turn forever.
  ctx.subscriptions.push(registerDiffTabs());

  const panel = new ChatPanelProvider(ctx);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatPanelProvider.viewId, panel, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand("luno.newChat", () => panel.newSession()),
    vscode.commands.registerCommand("luno.openInNewTab", () =>
      panel.openInNewTab()
    ),
    vscode.commands.registerCommand("luno.toggleChat", () =>
      vscode.commands.executeCommand("workbench.view.extension.luno")
    ),
    // The mode belongs to a conversation, not the workspace, so this cycles
    // whichever chat the user is working in and leaves the others alone.
    vscode.commands.registerCommand("luno.cycleMode", () => panel.cycleMode()),
    vscode.commands.registerCommand("luno.sendSelection", () =>
      panel.sendSelectionToChat()
    ),
    vscode.commands.registerCommand("luno.commentOnSelection", () =>
      panel.commentOnEditorSelection()
    ),
    vscode.commands.registerCommand("luno.generateConventions", () =>
      generateConventionsCommand(panel)
    ),
    vscode.commands.registerCommand("luno.openConnectors", () =>
      panel.openConnectors()
    ),
    vscode.commands.registerCommand("luno.showLogs", () => showLogs()),
    // A support switch, next to Show Logs and for the same reason: when
    // something misbehaves, this is how you tell a broken setup from a broken
    // extension. Takes effect on the next message rather than immediately —
    // the flag reaches the CLI at spawn, and replacing a live process would
    // take any running agent down with it.
    vscode.commands.registerCommand("luno.toggleSafeMode", async () => {
      const config = vscode.workspace.getConfiguration("luno");
      const next = !config.get<boolean>("safeMode", false);
      await config.update("safeMode", next, true);
      void vscode.window.showInformationMessage(
        next
          ? "LUNO safe mode is ON — the next message runs with CLAUDE.md, skills, hooks and MCP servers all disabled."
          : "LUNO safe mode is OFF — your customizations are back on the next message."
      );
    })
  );

  // `vscode://<publisher>.<name>/open?prompt=…` — the integration path other
  // tools use to hand work over. The prompt is put in the composer and left
  // there: a link on a web page must not be able to start a turn in an agent
  // that spawns processes and holds a subscription credential. The person at
  // the keyboard presses send.
  ctx.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: (uri) => {
        const prompt = promptFromUri(uri.path, uri.query);
        if (prompt) panel.prefillComposer(prompt);
      }
    })
  );
}

export function deactivate() {}
