// ─────────────────────────────────────────────────────────────
// MCP connectors — the cards in the connectors modal.
//
// Every operation has the same shape: do the thing, echo a `connectorResult`
// so the webview can clear its spinner, then re-broadcast the list so the card
// re-renders from the new truth. The echo happens on failure too — a modal
// that only hears back when things go right stays spinning forever.
//
// Nothing here reads panel state. It takes `post` and the extension context,
// which is why this was the second-easiest domain to lift out.
// ─────────────────────────────────────────────────────────────

import * as vscode from "vscode";
import {
  listConnectors,
  connect,
  cancelConnect,
  disconnect,
  addCustom,
  removeCustom,
  removeManaged,
  connectWithApiKey,
  refreshManagedConnectors,
  refreshClaudeCodeStatus,
  OAuthCancelled,
  type CustomDraft
} from "../../services/mcp/index.js";
import { resolveClaudeBinary } from "../../providers/factory.js";
import { openSetupTerminal } from "./terminal.js";
import type { Post } from "../messages.js";

export type { CustomDraft };

export function broadcastConnectors(
  post: Post,
  ctx: vscode.ExtensionContext
): void {
  try {
    post({ type: "connectorsList", connectors: listConnectors(ctx) });
  } catch (err) {
    post({ type: "error", message: `Couldn't list connectors: ${why(err)}` });
  }
}

/**
 * Fill in what a plain list cannot know: tool counts for Claude-Code-managed
 * servers, and the `claude mcp list` status — the only source for whether a
 * claude.ai connector is actually connected. Runs both in parallel, then
 * re-broadcasts so e.g. a Figma the user authorized inside Claude Code flips
 * to connected here.
 *
 * Best-effort: a failure caches as a card-level error rather than breaking the
 * modal.
 */
export async function refreshManagedAndRebroadcast(
  post: Post,
  ctx: vscode.ExtensionContext
): Promise<void> {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  await Promise.allSettled([
    refreshManagedConnectors(),
    refreshClaudeCodeStatus(resolveClaudeBinary(), cwd)
  ]);
  broadcastConnectors(post, ctx);
}

export async function connectConnector(
  post: Post,
  ctx: vscode.ExtensionContext,
  id: string
): Promise<void> {
  try {
    const connector = await connect(ctx, id);
    post({
      type: "connectorResult",
      action: "connect",
      id,
      ok: true,
      connector
    });
  } catch (err) {
    // A cancellation is not an error the user needs in red — flag it so the
    // webview clears the spinner without raising a toast.
    post({
      type: "connectorResult",
      action: "connect",
      id,
      ok: false,
      cancelled: err instanceof OAuthCancelled,
      error: why(err)
    });
  }
  broadcastConnectors(post, ctx);
}

/**
 * A local API-token preset (Figma's figma-developer-mcp and friends): store the
 * token in SecretStorage and spawn the server. No OAuth, nothing leaves the
 * machine.
 */
export async function connectConnectorWithApiKey(
  post: Post,
  ctx: vscode.ExtensionContext,
  id: string,
  apiKey: string
): Promise<void> {
  try {
    const connector = await connectWithApiKey(ctx, id, apiKey);
    post({
      type: "connectorResult",
      action: "connect",
      id,
      ok: true,
      connector
    });
  } catch (err) {
    post({
      type: "connectorResult",
      action: "connect",
      id,
      ok: false,
      error: why(err)
    });
  }
  broadcastConnectors(post, ctx);
}

export function cancelConnectorConnect(post: Post, id: string): void {
  // Echoed unconditionally so the webview can drop its pending state even when
  // there was no attempt in flight — the user clicking Cancel just after the
  // host resolved is the common case.
  post({
    type: "connectorResult",
    action: "cancel",
    id,
    ok: cancelConnect(id)
  });
}

export async function disconnectConnector(
  post: Post,
  ctx: vscode.ExtensionContext,
  id: string
): Promise<void> {
  try {
    await disconnect(ctx, id);
    post({ type: "connectorResult", action: "disconnect", id, ok: true });
  } catch (err) {
    post({
      type: "connectorResult",
      action: "disconnect",
      id,
      ok: false,
      error: why(err)
    });
  }
  broadcastConnectors(post, ctx);
}

export async function addCustomConnector(
  post: Post,
  ctx: vscode.ExtensionContext,
  draft: CustomDraft
): Promise<void> {
  try {
    const connector = await addCustom(ctx, draft);
    post({
      type: "connectorResult",
      action: "add",
      id: connector.id,
      ok: true,
      connector
    });
  } catch (err) {
    // No id to report — the connector was never created.
    post({
      type: "connectorResult",
      action: "add",
      id: "",
      ok: false,
      error: why(err)
    });
  }
  broadcastConnectors(post, ctx);
}

export async function removeCustomConnector(
  post: Post,
  ctx: vscode.ExtensionContext,
  id: string
): Promise<void> {
  try {
    if (id.startsWith("managed:")) {
      // Owned by Claude Code's own config, so removal goes through the
      // supported `claude mcp remove` — run in the workspace, or the local and
      // project scopes resolve somewhere else.
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      await removeManaged(id, resolveClaudeBinary(), cwd);
    } else {
      await removeCustom(ctx, id);
    }
    post({ type: "connectorResult", action: "remove", id, ok: true });
  } catch (err) {
    post({
      type: "connectorResult",
      action: "remove",
      id,
      ok: false,
      error: why(err)
    });
  }
  broadcastConnectors(post, ctx);
}

/**
 * Hand a connector off to Claude Code's own `/mcp` flow.
 *
 * Some vendors only allow Claude Code's pre-registered OAuth client — Figma is
 * the usual one — so LUNO cannot complete the handshake itself at any level of
 * effort. Instead it drives the flow the user would run by hand: clear the
 * stale error so the card stops showing a 403, open `claude` in a terminal, and
 * type `/mcp` once the TUI is up. The connector reappears here as a managed
 * card on the next listing.
 */
export async function setupConnectorViaClaudeCode(
  post: Post,
  ctx: vscode.ExtensionContext,
  id: string
): Promise<void> {
  try {
    await disconnect(ctx, id);
  } catch {
    // best-effort — the point is to clear a stale record, not to succeed
  }

  // Same terminal `runTerminalCommand` uses — see `domains/terminal.ts`. Both
  // features used to name it independently, which hid the fact that starting
  // one disposes the other's.
  const term = openSetupTerminal();

  // The second send is delayed so the TUI has booted and is reading stdin. If
  // the timing misses, the user types `/mcp` themselves — the card says so.
  setTimeout(() => term.sendText("claude", true), 300);
  setTimeout(() => term.sendText("/mcp", true), 4000);

  vscode.window.showInformationMessage(
    "Opened Claude Code — choose your connector in the /mcp menu and authorize it in the browser. It'll appear in Luno once connected."
  );
  broadcastConnectors(post, ctx);
}

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
