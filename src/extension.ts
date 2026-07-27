import * as vscode from "vscode";
import { ChatPanelProvider } from "./ui/panel.js";
import { generateConventionsCommand } from "./commands/init-conventions.js";
import { registerDevAutoRestart } from "./dev-reload.js";
import { registerOutputChannel, showLogs } from "./ui/output-channel.js";

export function activate(ctx: vscode.ExtensionContext) {
  // First, so anything logged during the rest of activation is captured.
  ctx.subscriptions.push(registerOutputChannel());
  registerDevAutoRestart(ctx);

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
    vscode.commands.registerCommand("luno.showLogs", () => showLogs())
  );
}

export function deactivate() {}
