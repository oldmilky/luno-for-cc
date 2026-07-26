import * as vscode from "vscode";
import { ChatPanelProvider } from "./ui/panel.js";
import { generateConventionsCommand } from "./commands/init-conventions.js";
import { PermissionMode } from "./core/types.js";
import { registerDevAutoRestart } from "./dev-reload.js";

export function activate(ctx: vscode.ExtensionContext) {
  registerDevAutoRestart(ctx);

  const panel = new ChatPanelProvider(ctx);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatPanelProvider.viewId, panel, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  ctx.subscriptions.push(
    vscode.commands.registerCommand("luno.newChat", () => panel.newSession()),
    vscode.commands.registerCommand("luno.toggleChat", () =>
      vscode.commands.executeCommand("workbench.view.extension.luno")
    ),
    vscode.commands.registerCommand("luno.cycleMode", async () => {
      const cfg = vscode.workspace.getConfiguration("luno");
      const order: PermissionMode[] = ["default", "plan", "auto"];
      const cur = cfg.get<PermissionMode>("permissionMode", "default");
      const next = order[(order.indexOf(cur) + 1) % order.length];
      await cfg.update("permissionMode", next, vscode.ConfigurationTarget.Global);
      vscode.window.setStatusBarMessage(`Luno mode: ${next}`, 2000);
    }),
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
    )
  );
}

export function deactivate() {}

