// ─────────────────────────────────────────────────────────────
// Skills Marketplace — fetch catalog from claude-plugins.dev and
// install/uninstall skills into the canonical Claude Code paths:
//
//   user scope     → ~/.claude/skills/<name>/
//   project scope  → <workspace>/.claude/skills/<name>/
//
// claude-plugins.dev exposes a JSON API at /api/skills with shape:
//   { skills: [{ name, namespace, sourceUrl, description, author,
//                stars, installs, metadata: { repoOwner, repoName,
//                directoryPath, rawFileUrl } }],
//     total, limit, offset }
//
// Skills are sub-directories of public GitHub repos. We download
// every file under metadata.directoryPath using the GitHub Contents
// API, recursively (capped to MAX_DEPTH/MAX_FILES so a runaway
// repo can't fill the disk).
// ─────────────────────────────────────────────────────────────

import * as https from "node:https";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const API_BASE = "https://claude-plugins.dev/api/skills";

export interface MarketplaceSkill {
  /** UUID assigned by claude-plugins.dev — stable, our internal ref. */
  id: string;
  /** Bare skill name (== directory name once installed). */
  name: string;
  /** "@author/repo/skill-name" — display + match key. */
  namespace: string;
  description: string;
  author: string;
  stars: number;
  installs: number;
  /** GitHub URL to the skill subdirectory — for the Docs ↗ link. */
  sourceUrl: string;
  repoOwner: string;
  repoName: string;
  directoryPath: string;
  rawFileUrl: string;
}

export interface MarketplaceListResult {
  skills: MarketplaceSkill[];
  total: number;
  offset: number;
  limit: number;
}

export interface MarketplaceListOptions {
  offset?: number;
  limit?: number;
  query?: string;
}

/**
 * Fetch a page of the marketplace. Pagination is server-side.
 */
export async function fetchMarketplace(
  opts: MarketplaceListOptions = {}
): Promise<MarketplaceListResult> {
  const url = new URL(API_BASE);
  url.searchParams.set("offset", String(opts.offset ?? 0));
  url.searchParams.set("limit", String(opts.limit ?? 24));
  if (opts.query && opts.query.trim()) {
    url.searchParams.set("q", opts.query.trim());
  }
  interface RawSkill {
    id: string;
    name: string;
    namespace: string;
    sourceUrl: string;
    description: string | null;
    author: string;
    stars: number;
    installs: number;
    metadata?: {
      repoOwner?: string;
      repoName?: string;
      directoryPath?: string;
      rawFileUrl?: string;
    };
  }
  interface RawResponse {
    skills: RawSkill[];
    total: number;
    limit: number;
    offset: number;
  }
  const json = await getJson<RawResponse>(url.toString());
  return {
    skills: json.skills.map((s) => ({
      id: s.id,
      name: s.name,
      namespace: s.namespace,
      description: s.description ?? "",
      author: s.author,
      stars: s.stars ?? 0,
      installs: s.installs ?? 0,
      sourceUrl: s.sourceUrl,
      repoOwner: s.metadata?.repoOwner ?? "",
      repoName: s.metadata?.repoName ?? "",
      directoryPath: s.metadata?.directoryPath ?? "",
      rawFileUrl: s.metadata?.rawFileUrl ?? ""
    })),
    total: json.total,
    offset: json.offset,
    limit: json.limit
  };
}

export interface SkillDetail {
  skill: MarketplaceSkill;
  /** Raw SKILL.md markdown (frontmatter stripped) for in-panel preview. */
  content: string;
}

/**
 * Resolve a single skill by name and download its SKILL.md so the panel can
 * preview it without sending the user to the website. We reuse the catalog
 * search (`q=`) to find the entry, then fetch its raw SKILL.md.
 */
export async function fetchSkillDetail(name: string): Promise<SkillDetail> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("No skill name provided.");

  const { skills } = await fetchMarketplace({ query: trimmed, limit: 10 });
  if (skills.length === 0) {
    throw new Error(`No skill named "${trimmed}" found in the marketplace.`);
  }
  // Prefer an exact name match; fall back to the top-ranked result.
  const skill =
    skills.find((s) => s.name.toLowerCase() === trimmed.toLowerCase()) ??
    skills[0];

  let content = "";
  if (skill.rawFileUrl) {
    try {
      content = stripFrontmatter(
        (await getRaw(skill.rawFileUrl)).toString("utf-8")
      );
    } catch {
      // Network/404 — fall through with empty content; caller shows description.
      content = "";
    }
  }
  return { skill, content };
}

/** Remove a leading YAML frontmatter block (`---\n…\n---`) for cleaner preview. */
function stripFrontmatter(md: string): string {
  // \uFEFF is an optional leading BOM — written escaped because a literal
  // one is invisible in an editor and reads as a stray character in a regex.
  const m = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(md);
  return m ? md.slice(m[0].length).trimStart() : md;
}

// ── Install / uninstall ─────────────────────────────────────

export type InstallScope = "user" | "project";

export interface InstallResult {
  ok: boolean;
  scope: InstallScope;
  installPath: string;
  filesWritten: number;
  error?: string;
}

export interface InstallTarget {
  name: string;
  repoOwner: string;
  repoName: string;
  directoryPath: string;
}

const MAX_DEPTH = 8;
const MAX_FILES_PER_SKILL = 500;

/**
 * Download every file in a skill's source directory from GitHub into the
 * appropriate `.claude/skills/<name>/` directory. The user picks the scope
 * via the picker; project scope requires an open workspace.
 */
export async function installSkill(
  target: InstallTarget,
  scope: InstallScope,
  workspaceRoot: string | undefined
): Promise<InstallResult> {
  const root = installRoot(target.name, scope, workspaceRoot);
  if (!root) {
    return {
      ok: false,
      scope,
      installPath: "",
      filesWritten: 0,
      error:
        "No workspace open — open a folder before installing for project scope."
    };
  }
  if (!target.repoOwner || !target.repoName || !target.directoryPath) {
    return {
      ok: false,
      scope,
      installPath: root,
      filesWritten: 0,
      error: "Skill is missing GitHub source metadata."
    };
  }

  try {
    await fs.mkdir(root, { recursive: true });
    const counter = { written: 0 };
    await downloadDir(
      target.repoOwner,
      target.repoName,
      target.directoryPath,
      root,
      0,
      counter
    );
    return {
      ok: true,
      scope,
      installPath: root,
      filesWritten: counter.written
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      scope,
      installPath: root,
      filesWritten: 0,
      error: msg
    };
  }
}

export async function uninstallSkill(
  name: string,
  scope: InstallScope,
  workspaceRoot: string | undefined
): Promise<{ ok: boolean; scope: InstallScope; error?: string }> {
  const root = installRoot(name, scope, workspaceRoot);
  if (!root) {
    return { ok: false, scope, error: "No workspace open." };
  }
  try {
    await fs.rm(root, { recursive: true, force: true });
    return { ok: true, scope };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, scope, error: msg };
  }
}

export function installRoot(
  name: string,
  scope: InstallScope,
  workspaceRoot: string | undefined
): string | null {
  // Guard against path traversal — `name` becomes the directory under
  // `.claude/skills/`, so anything containing slashes or `..` would let
  // an uninstall escape the skills folder.
  if (!name || /[/\\]/.test(name) || name === "." || name === "..") {
    return null;
  }
  if (scope === "user") {
    return path.join(os.homedir(), ".claude", "skills", name);
  }
  if (!workspaceRoot) return null;
  return path.join(workspaceRoot, ".claude", "skills", name);
}

interface DownloadCounter {
  written: number;
}

interface GhContent {
  name: string;
  type: "file" | "dir" | "submodule" | "symlink";
  download_url: string | null;
  path: string;
}

async function downloadDir(
  owner: string,
  repo: string,
  dir: string,
  dest: string,
  depth: number,
  counter: DownloadCounter
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  if (counter.written >= MAX_FILES_PER_SKILL) return;

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURI(dir)}`;
  const items = await getJson<GhContent[] | GhContent>(url);
  const arr = Array.isArray(items) ? items : [items];

  for (const item of arr) {
    if (counter.written >= MAX_FILES_PER_SKILL) break;
    if (item.type === "dir") {
      const subDest = path.join(dest, item.name);
      await fs.mkdir(subDest, { recursive: true });
      await downloadDir(owner, repo, item.path, subDest, depth + 1, counter);
    } else if (item.type === "file" && item.download_url) {
      const buf = await getRaw(item.download_url);
      await fs.writeFile(path.join(dest, item.name), buf);
      counter.written++;
    }
    // submodules / symlinks: skipped on purpose.
  }
}

// ── HTTP helpers ───────────────────────────────────────────

const COMMON_HEADERS: Record<string, string> = {
  "User-Agent": "Luno-VSCode",
  Accept: "application/json"
};

function getJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const fetchOnce = (u: string, redirectsLeft: number) => {
      const req = https.get(u, { headers: COMMON_HEADERS }, (res) => {
        const status = res.statusCode ?? 0;
        if (
          status >= 300 &&
          status < 400 &&
          res.headers.location &&
          redirectsLeft > 0
        ) {
          fetchOnce(res.headers.location, redirectsLeft - 1);
          res.resume();
          return;
        }
        if (status !== 200) {
          reject(new Error(`HTTP ${status} for ${u}`));
          res.resume();
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")) as T);
          } catch (e) {
            reject(e);
          }
        });
        res.on("error", reject);
      });
      req.on("error", reject);
      req.setTimeout(15000, () => req.destroy(new Error("request timed out")));
    };
    fetchOnce(url, 3);
  });
}

function getRaw(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const fetchOnce = (u: string, redirectsLeft: number) => {
      const req = https.get(
        u,
        { headers: { "User-Agent": "Luno-VSCode" } },
        (res) => {
          const status = res.statusCode ?? 0;
          if (
            status >= 300 &&
            status < 400 &&
            res.headers.location &&
            redirectsLeft > 0
          ) {
            fetchOnce(res.headers.location, redirectsLeft - 1);
            res.resume();
            return;
          }
          if (status !== 200) {
            reject(new Error(`HTTP ${status} for ${u}`));
            res.resume();
            return;
          }
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
          res.on("error", reject);
        }
      );
      req.on("error", reject);
      req.setTimeout(30000, () => req.destroy(new Error("download timed out")));
    };
    fetchOnce(url, 3);
  });
}
