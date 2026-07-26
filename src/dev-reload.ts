// ─────────────────────────────────────────────────────────────
// Dev auto-restart for extension-host code.
//
// The webview hot-reloads through Vite (see webview-html.ts), but
// extension-host code cannot: VS Code loads it once per extension
// host process and offers no way to unload or re-require a module.
// The closest thing to HMR is restarting just that process, which
// is much cheaper than reloading the whole window — editors, the
// terminal and the rest of the workbench stay put.
//
// So: watch our own bundle, and when `bun run watch` rewrites it,
// restart the host. Edit → save → esbuild (~20 ms) → restart.
//
// Only ever runs in an Extension Development Host (F5). In a normal
// install the running code lives in ~/.cursor/extensions, and a
// restart would just reload the same stale bundle — pointless, and
// nothing a daily driver should do behind the user's back.
// ─────────────────────────────────────────────────────────────

import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";

/** Coalesce the burst of writes esbuild emits for one rebuild. */
const DEBOUNCE_MS = 250;

export function registerDevAutoRestart(ctx: vscode.ExtensionContext): void {
  if (ctx.extensionMode !== vscode.ExtensionMode.Development) return;
  if (
    !vscode.workspace
      .getConfiguration("luno")
      .get<boolean>("devAutoRestart", true)
  ) {
    return;
  }

  const bundle = path.join(ctx.extensionPath, "dist", "extension.js");
  if (!fs.existsSync(bundle)) return;

  let timer: NodeJS.Timeout | undefined;
  let disposed = false;

  // Watch the directory rather than the file: esbuild writes by replacing the
  // inode, which detaches a file watch after the first rebuild.
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(path.dirname(bundle), (_event, filename) => {
      if (disposed || filename !== "extension.js") return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        vscode.window.setStatusBarMessage(
          "Luno: reloading extension host…",
          1500
        );
        void vscode.commands.executeCommand(
          "workbench.action.restartExtensionHost"
        );
      }, DEBOUNCE_MS);
    });
  } catch (err) {
    console.warn("[luno] dev auto-restart unavailable:", err);
    return;
  }

  ctx.subscriptions.push({
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
      watcher.close();
    }
  });

  console.log("[luno] dev auto-restart armed — watching", bundle);
}
