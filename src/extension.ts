import * as vscode from "vscode";
import { ChatPanelProvider } from "./ui/panel.js";
import { generateConventionsCommand } from "./commands/init-conventions.js";
import { nextCycleMode } from "./core/permission-cycle.js";
import { scopeForWrite } from "./ui/domains/settings-scope.js";
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
    vscode.commands.registerCommand("luno.openInNewTab", () =>
      panel.openInNewTab()
    ),
    vscode.commands.registerCommand("luno.toggleChat", () =>
      vscode.commands.executeCommand("workbench.view.extension.luno")
    ),
    vscode.commands.registerCommand("luno.cycleMode", async () => {
      const cfg = vscode.workspace.getConfiguration("luno");
      const next = nextCycleMode(
        cfg.get<PermissionMode>("permissionMode", "default")
      );
      // Writes to the scope the value is read from. Writing Global here while a
      // `.vscode/settings.json` pinned the mode made Shift+Tab a silent no-op —
      // the same defect the panel's own picker had.
      const TARGETS = {
        workspaceFolder: vscode.ConfigurationTarget.WorkspaceFolder,
        workspace: vscode.ConfigurationTarget.Workspace,
        global: vscode.ConfigurationTarget.Global
      } as const;
      await cfg.update(
        "permissionMode",
        next,
        TARGETS[scopeForWrite(cfg.inspect("permissionMode"))]
      );
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
