// ─────────────────────────────────────────────────────────────
// Publishing the slash-command list to the composer.
//
// The CLI's own list is authoritative but arrives no earlier than the first
// turn's `init` event, so it is cached across windows. Disk is scanned every
// time: a user who just wrote a command file expects to be able to type it.
// ─────────────────────────────────────────────────────────────

import * as vscode from "vscode";
import {
  mergeCommands,
  scanCommandFiles,
  type SlashCommand
} from "../../services/slash-commands.js";
import type { Post } from "../messages.js";

/** Where the CLI's list survives a window reload. */
const CACHE_KEY = "luno.slashCommands.v1";

export function rememberCliCommands(
  ctx: vscode.ExtensionContext,
  names: string[]
): void {
  void ctx.globalState.update(CACHE_KEY, names);
}

function cachedCliCommands(ctx: vscode.ExtensionContext): string[] {
  const cached = ctx.globalState.get<string[]>(CACHE_KEY, []);
  return Array.isArray(cached)
    ? cached.filter((n) => typeof n === "string")
    : [];
}

/**
 * Publish what the composer should offer after a slash.
 *
 * Best-effort like every other broadcast here: with nothing to say the popover
 * simply does not open, which is better than a composer that throws on `/`.
 */
export async function broadcastSlashCommands(
  post: Post,
  ctx: vscode.ExtensionContext,
  workspaceRoot: string | undefined
): Promise<void> {
  try {
    const fromDisk: SlashCommand[] = await scanCommandFiles(workspaceRoot);
    post({
      type: "slashCommands",
      commands: mergeCommands(fromDisk, cachedCliCommands(ctx))
    });
  } catch {
    // No popover beats a broken composer.
  }
}
