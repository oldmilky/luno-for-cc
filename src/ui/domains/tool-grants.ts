// ─────────────────────────────────────────────────────────────
// Where standing permissions live.
//
// `globalState`, so a grant holds in every folder the user opens. That was
// decided deliberately and it is the riskier of the two options: a grant made
// in your own repository is in force inside a clone of someone else's. Two
// things answer for that and neither is optional — the destructive/network
// gate still runs first (see `decidePermission`), and the list is visible and
// revocable from the panel.
//
// Not `workspaceState` and not settings.json: the first would have made it
// per-folder, which is not what was asked for, and the second is a file that
// gets committed — handing your approvals to everyone who clones the project.
// ─────────────────────────────────────────────────────────────

import * as vscode from "vscode";
import {
  addGrant,
  parseGrants,
  removeGrant,
  type ToolGrant
} from "../../core/tool-grants.js";
import type { Post } from "../messages.js";

const STORE_KEY = "luno.toolGrants";

export function readGrants(ctx: vscode.ExtensionContext): ToolGrant[] {
  return parseGrants(ctx.globalState.get(STORE_KEY));
}

export async function grantTool(
  ctx: vscode.ExtensionContext,
  grant: ToolGrant
): Promise<ToolGrant[]> {
  const next = addGrant(readGrants(ctx), grant);
  await ctx.globalState.update(STORE_KEY, next);
  return next;
}

export async function revokeTool(
  ctx: vscode.ExtensionContext,
  key: string
): Promise<ToolGrant[]> {
  const next = removeGrant(readGrants(ctx), key);
  await ctx.globalState.update(STORE_KEY, next);
  return next;
}

export async function revokeAllTools(
  ctx: vscode.ExtensionContext
): Promise<ToolGrant[]> {
  await ctx.globalState.update(STORE_KEY, []);
  return [];
}

export function broadcastGrants(
  post: Post,
  grants: ReadonlyArray<ToolGrant>
): void {
  post({ type: "toolGrants", grants: [...grants] });
}
