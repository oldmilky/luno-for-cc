// ─────────────────────────────────────────────────────────────
// The sidebar view.
//
// This used to be the whole extension host: one class holding the session, the
// checkpoints, the in-flight turn, the handler table and the webview, which is
// precisely why there could only ever be one chat. Switching conversations had
// to kill the running turn, because there was nowhere else to put it.
//
// What is left here is the `WebviewViewProvider` contract and the commands
// `extension.ts` binds. The conversation itself lives in `ConversationHost`,
// and everything shared between conversations lives in `ConversationRegistry`.
// ─────────────────────────────────────────────────────────────

import * as vscode from "vscode";

import { ConversationHost } from "./conversation-host.js";
import { ConversationRegistry } from "./conversation-registry.js";

export class ChatPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "luno.chat";

  private readonly registry: ConversationRegistry;
  private readonly sidebar: ConversationHost;

  constructor(ctx: vscode.ExtensionContext) {
    this.registry = new ConversationRegistry(ctx);
    this.sidebar = this.registry.create();
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.sidebar.attach({
      webview: view.webview,
      // `show` is optional on the view type and absent in some hosts, hence the
      // guard rather than a direct call.
      reveal: () => view.show?.(true)
    });
  }

  // ── Commands bound in extension.ts ───────────────────────────
  //
  // They address the sidebar conversation. Once conversations can also open as
  // editor tabs, "the sidebar one" stops being the obvious target and these
  // route to whichever is focused instead.

  newSession() {
    this.sidebar.newSession();
  }

  async sendUserMessage(text: string) {
    await this.sidebar.sendUserMessage(text);
  }

  commentOnEditorSelection() {
    this.sidebar.commentOnEditorSelection();
  }

  sendSelectionToChat() {
    this.sidebar.sendSelectionToChat();
  }

  openConnectors() {
    this.sidebar.openConnectors();
  }
}
