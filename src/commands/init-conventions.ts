// Luno: Generate CLAUDE.md
//
// Scans the workspace for the basics (manifest files + top-level layout) and
// uses the active panel to draft a CLAUDE.md tailored to the project. The
// draft opens in a side-by-side diff view; the user reviews and saves
// manually. We never silently write to disk.

import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ChatPanelProvider } from "../ui/panel.js";

export async function generateConventionsCommand(
  panel: ChatPanelProvider
): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showWarningMessage("Luno: open a folder first.");
    return;
  }

  const targetPath = path.join(workspaceRoot, "CLAUDE.md");
  try {
    await fs.access(targetPath);
    const choice = await vscode.window.showWarningMessage(
      "CLAUDE.md already exists. Overwrite with a freshly generated draft?",
      { modal: true },
      "Open existing",
      "Generate new"
    );
    if (choice === "Open existing") {
      await vscode.window.showTextDocument(vscode.Uri.file(targetPath));
      return;
    }
    if (choice !== "Generate new") return;
  } catch {
    /* doesn't exist — proceed */
  }

  const summary = await scanWorkspace(workspaceRoot);
  const prompt = buildScaffoldingPrompt(workspaceRoot, summary);

  vscode.window.showInformationMessage(
    "Luno: drafting CLAUDE.md… the chat panel is generating it. Save the result to CLAUDE.md when ready."
  );
  await panel.sendUserMessage(prompt);

  const inGitignore = await isCurrentlyGitignored(workspaceRoot, "CLAUDE.md");
  if (inGitignore) {
    vscode.window.showWarningMessage(
      "CLAUDE.md is listed in .gitignore. Remove it from .gitignore so the conventions are committed and shared with your team."
    );
  }
}

interface ScanSummary {
  manifests: string[];
  topLevelDirs: string[];
  hasTests: boolean;
  hasReadme: boolean;
}

async function scanWorkspace(root: string): Promise<ScanSummary> {
  const candidateManifests = [
    "package.json",
    "tsconfig.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "Gemfile",
    "composer.json",
    "build.gradle",
    "pom.xml"
  ];
  const manifests: string[] = [];
  for (const m of candidateManifests) {
    try {
      await fs.access(path.join(root, m));
      manifests.push(m);
    } catch {
      /* skip */
    }
  }

  const entries = await fs.readdir(root, { withFileTypes: true });
  const topLevelDirs = entries
    .filter(
      (e) =>
        e.isDirectory() &&
        !e.name.startsWith(".") &&
        e.name !== "node_modules" &&
        e.name !== "dist"
    )
    .map((e) => e.name)
    .slice(0, 30);

  const hasTests = topLevelDirs.some((d) =>
    /^(tests?|spec|__tests__)$/i.test(d)
  );
  let hasReadme = false;
  try {
    await fs.access(path.join(root, "README.md"));
    hasReadme = true;
  } catch {
    /* no readme */
  }

  return { manifests, topLevelDirs, hasTests, hasReadme };
}

function buildScaffoldingPrompt(root: string, summary: ScanSummary): string {
  return `Generate a CLAUDE.md for this project at ${root}. Read the actual files; don't invent.

## Detected at scan time
- Manifests present: ${summary.manifests.join(", ") || "(none)"}
- Top-level directories: ${summary.topLevelDirs.join(", ") || "(none)"}
- Has tests directory: ${summary.hasTests}
- Has README.md: ${summary.hasReadme}

## Required structure (use these exact H2 sections, in order)

## Project
One paragraph: what this project is, its language, and its primary purpose. Pull from README.md if present.

## Layout
A directory tree showing the top-level folders and what each owns. Read each significant folder to confirm.

## Commands
The exact commands for build / test / lint / dev / package. Pull from package.json scripts (or pyproject.toml / Makefile / etc.).

## Conventions
Bullets covering: language version, module style (ESM/CJS), strictness, error handling, naming, import order. Cite file:line for any non-obvious pattern.

## Canonical examples per layer
A table mapping "if you're adding X" → "read this file first → mirror its structure". Pick the strongest example for each kind of change someone might make.

## Don't touch / be careful with
List of paths or patterns to avoid (build output, vendored code, generated files). Include any sharp edges you noticed while scanning.

## Adding a new X — recipes
For 2-3 most common change types in this repo, give the exact steps (which files to create/edit, which conventions to follow).

## Hard rules
- Cite file:line for every claim about conventions or structure.
- If the project is unclear about something (e.g., no test framework detected), say so explicitly rather than guessing.
- Keep total length under 400 lines. Density beats completeness — the model reads this every turn.

Write the full CLAUDE.md content as your response. After you've drafted it, the user will copy it into CLAUDE.md at the workspace root.`;
}

async function isCurrentlyGitignored(
  root: string,
  file: string
): Promise<boolean> {
  try {
    const ignored = await fs.readFile(path.join(root, ".gitignore"), "utf8");
    const lines = ignored
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    return lines.some(
      (l) => l === file || l === `/${file}` || l === `${file}/`
    );
  } catch {
    return false;
  }
}
