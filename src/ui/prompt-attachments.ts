// ─────────────────────────────────────────────────────────────
// Pasted images, out of the prompt and onto disk.
//
// A screenshot dropped into the composer arrives as an inline
// `![name](data:image/…;base64,…)` blob. Left in place it becomes a multi-MB
// string in the prompt and the CLI refuses the turn as too long, so each blob
// is written under `<workspace>/.luno/attachments/` and the markdown is
// rewritten to point at the file.
//
// Its own module because it is the one part of the host that touches the
// workspace on the way to building a prompt, and because `.luno/` needs a
// gitignore of its own — a detail worth finding without reading a class.
// ─────────────────────────────────────────────────────────────

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

// ── Prompt attachments ───────────────────────────────────────

const INLINE_DATA_IMAGE_RE =
  /!\[([^\]]*)\]\(data:image\/([a-zA-Z0-9+.-]+);base64,([A-Za-z0-9+/=]+)\)/g;

/**
 * Strip inline `![name](data:image/...;base64,...)` blobs out of a prompt by
 * writing them to disk under `<workspace>/.luno/attachments/` and replacing
 * the markdown with a relative path reference. Without this, dropping a
 * screenshot into the composer puts a multi-MB base64 string into the prompt
 * text — and the CLI rejects the turn with "Prompt is too long".
 *
 * The rewritten message:
 *   1. Stays small (a relative path instead of base64) so it fits the token
 *      budget and serializes cleanly into the session timeline.
 *   2. Points at a real file in the workspace so the agent's Read tool can
 *      view the image directly.
 *
 * `.luno/` is added to the workspace `.gitignore` on first use so users
 * don't accidentally commit the temp attachments.
 */
export async function extractInlineImages(
  prompt: string,
  workspaceRoot: string
): Promise<string> {
  if (!INLINE_DATA_IMAGE_RE.test(prompt)) return prompt;
  INLINE_DATA_IMAGE_RE.lastIndex = 0;

  const attachmentsDir = path.join(workspaceRoot, ".luno", "attachments");
  await fs.promises.mkdir(attachmentsDir, { recursive: true });
  await ensureLunoGitignore(workspaceRoot);

  // Walk all matches synchronously, queue the writes, then splice the prompt
  // in one pass. Doing the writes off the regex iteration keeps replacement
  // bookkeeping simple.
  const matches: Array<{
    full: string;
    name: string;
    relPath: string;
    buffer: Buffer;
  }> = [];
  let m: RegExpExecArray | null;
  while ((m = INLINE_DATA_IMAGE_RE.exec(prompt)) !== null) {
    const [full, rawName, ext, base64] = m;
    const buffer = Buffer.from(base64, "base64");
    const id = crypto.randomBytes(6).toString("hex");
    const safeExt = ext.toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
    const fileName = `${id}.${safeExt}`;
    const absPath = path.join(attachmentsDir, fileName);
    await fs.promises.writeFile(absPath, buffer);
    const relPath = path.posix.join(".luno", "attachments", fileName);
    matches.push({ full, name: rawName || fileName, relPath, buffer });
  }

  let out = prompt;
  for (const mt of matches) {
    out = out.replace(mt.full, `![${mt.name}](${mt.relPath})`);
  }
  return out;
}

async function ensureLunoGitignore(workspaceRoot: string): Promise<void> {
  const gitignorePath = path.join(workspaceRoot, ".gitignore");
  try {
    const existing = await fs.promises.readFile(gitignorePath, "utf8");
    if (/^\.luno\/?\s*$/m.test(existing)) return;
    const sep = existing.endsWith("\n") ? "" : "\n";
    await fs.promises.appendFile(gitignorePath, `${sep}.luno/\n`);
  } catch {
    // No .gitignore yet (or read failed) — create one. Best-effort; ignore
    // write failures (read-only FS, permissions, etc.).
    try {
      await fs.promises.writeFile(gitignorePath, ".luno/\n");
    } catch {
      /* swallow */
    }
  }
}
