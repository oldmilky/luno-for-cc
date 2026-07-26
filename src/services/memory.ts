import * as vscode from "vscode";
import * as path from "node:path";
import * as os from "node:os";

const PROJECT_FILE = "CLAUDE.md";
const USER_FILE = path.join(os.homedir(), ".luno", "memory.md");

async function readIfExists(uri: vscode.Uri): Promise<string | null> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export async function loadMemory(workspaceRoot: string | undefined): Promise<{
  project: string | null;
  user: string | null;
  combined: string;
}> {
  const project = workspaceRoot
    ? await readIfExists(vscode.Uri.file(path.join(workspaceRoot, PROJECT_FILE)))
    : null;
  const user = await readIfExists(vscode.Uri.file(USER_FILE));

  const parts: string[] = [];
  if (user) parts.push(`# User memory (global)\n${user.trim()}`);
  if (project) parts.push(`# Project memory (${PROJECT_FILE})\n${project.trim()}`);

  return { project, user, combined: parts.join("\n\n") };
}

export async function appendUserMemory(text: string) {
  const dir = path.dirname(USER_FILE);
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
  const existing = (await readIfExists(vscode.Uri.file(USER_FILE))) ?? "";
  const sep = existing && !existing.endsWith("\n\n") ? "\n\n" : "";
  const updated = existing + sep + "- " + text.trim() + "\n";
  await vscode.workspace.fs.writeFile(vscode.Uri.file(USER_FILE), new TextEncoder().encode(updated));
}

export function userMemoryPath() {
  return USER_FILE;
}
