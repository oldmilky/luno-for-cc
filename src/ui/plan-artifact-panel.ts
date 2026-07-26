import * as vscode from "vscode";
import { PlanRevisionMeta } from "../core/types.js";
import { buildWebviewHtml } from "./webview-html.js";

/**
 * Opens a plan revision as a real VS Code editor tab — a `WebviewPanel`
 * pinned to the user's active view column. Reuses the same compiled
 * webview bundle as the chat panel; the bundle's entry script reads
 * `window.LUNO_MODE` and `window.LUNO_REVISION_ID` to decide
 * whether to render the chat shell or the artifact shell.
 *
 * The host is the single source of truth for state. All RPCs from any
 * artifact panel flow back through the same handler in ChatPanelProvider,
 * and any timeline events that need to be reflected in open artifact
 * panels are broadcast via `broadcast()`.
 *
 * Multiple revisions can be open simultaneously. Re-opening an already-
 * open revision reveals the existing tab instead of creating a duplicate.
 */
export class PlanArtifactManager {
  private panels = new Map<string, vscode.WebviewPanel>();
  /** Caller-supplied dispatcher for messages coming back from a panel. */
  private onMessage?: (msg: { type: string; [k: string]: unknown }) => void;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  setMessageHandler(
    handler: (msg: { type: string; [k: string]: unknown }) => void
  ) {
    this.onMessage = handler;
  }

  /** Open (or reveal) the editor tab for a specific plan revision. */
  open(revisionMeta: PlanRevisionMeta): void {
    const revisionId = revisionMeta.revisionId;
    const existing = this.panels.get(revisionId);
    if (existing) {
      existing.reveal(vscode.ViewColumn.Active);
      return;
    }

    const title = deriveTitle(revisionMeta);
    const panel = vscode.window.createWebviewPanel(
      "lunoPlanArtifact",
      title,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.ctx.extensionUri, "webview", "dist")
        ]
      }
    );
    panel.iconPath = new vscode.ThemeIcon("notebook");
    panel.webview.html = this.html(panel.webview, revisionId);
    panel.webview.onDidReceiveMessage((msg) => {
      if (msg && typeof msg.type === "string") this.onMessage?.(msg);
    });
    panel.onDidDispose(() => {
      this.panels.delete(revisionId);
    });

    this.panels.set(revisionId, panel);
    // Note: don't post the initial timeline here — the webview's message
    // listener isn't attached yet (React hasn't mounted), so a synchronous
    // post would be dropped. The artifact app sends `requestArtifactState`
    // from its mount effect; the host responds via `postToPanel()`.
  }

  /** Push a single message to every open artifact panel. */
  broadcast(msg: unknown): void {
    for (const panel of this.panels.values()) {
      panel.webview.postMessage(msg);
    }
  }

  /** Post a message to a specific artifact panel keyed by revisionId. */
  postToPanel(revisionId: string, msg: unknown): void {
    const panel = this.panels.get(revisionId);
    if (panel) panel.webview.postMessage(msg);
  }

  /** Close any artifact panel showing a revision that no longer exists. */
  closeIfPresent(revisionId: string): void {
    const panel = this.panels.get(revisionId);
    if (panel) panel.dispose();
  }

  closeAll(): void {
    for (const panel of this.panels.values()) panel.dispose();
    this.panels.clear();
  }

  private html(webview: vscode.Webview, revisionId: string): string {
    // `LUNO_MODE` tells the webview entry to mount ArtifactApp instead of
    // the chat shell; revisionId scopes the artifact to a single plan.
    return buildWebviewHtml({
      webview,
      extensionUri: this.ctx.extensionUri,
      title: "Luno — Plan",
      globals: { LUNO_MODE: "artifact", LUNO_REVISION_ID: revisionId }
    });
  }
}

function deriveTitle(meta: PlanRevisionMeta): string {
  if (meta.planFilePath) {
    const tail = meta.planFilePath.split("/").pop();
    if (tail) return `Plan — ${tail}`;
  }
  // Pull H1 from the body when available.
  const h1 = meta.body.match(/^\s{0,3}#\s+(.+?)\s*$/m);
  if (h1) return `Plan — ${h1[1]}`;
  return "Plan";
}
