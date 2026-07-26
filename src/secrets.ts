// ─────────────────────────────────────────────────────────────
// Auth-token storage for Luno's subscription-only flow.
//
// Tokens we accept (both work with the bundled Claude Code CLI when
// passed as ANTHROPIC_API_KEY):
//   • `sk-ant-oat...`   — Claude Code subscription OAuth token
//   • `sk-ant-api...`   — Anthropic Console API key
//
// We never write to `~/.claude/` ourselves — instead we inject the
// stored token into the CLI's environment when we spawn it. This keeps
// auth fully owned by Luno (logout → secret deleted → CLI sees
// no key) and avoids touching files the CLI manages.
// ─────────────────────────────────────────────────────────────

import * as vscode from "vscode";

const TOKEN_KEY = "luno.claudeToken.v1";

export async function getToken(
  ctx: vscode.ExtensionContext
): Promise<string | undefined> {
  return ctx.secrets.get(TOKEN_KEY);
}

export async function setToken(
  ctx: vscode.ExtensionContext,
  token: string
): Promise<void> {
  await ctx.secrets.store(TOKEN_KEY, token);
}

export async function deleteToken(
  ctx: vscode.ExtensionContext
): Promise<void> {
  await ctx.secrets.delete(TOKEN_KEY);
}

export type TokenKind = "oauth" | "api" | "unknown";

/** Classify a pasted token without making any network call. */
export function classifyToken(token: string): TokenKind {
  const t = token.trim();
  if (t.startsWith("sk-ant-oat")) return "oauth";
  if (t.startsWith("sk-ant-api")) return "api";
  return "unknown";
}
