import * as path from "node:path";
import * as fs from "node:fs/promises";
import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(exec);
const MAX_PER_SESSION = 20;

interface FileSnapshot {
  relPath: string;
  existed: boolean;
  content?: Buffer;
}

interface Checkpoint {
  turnId: string;
  createdAt: number;
  files: FileSnapshot[];
}

export class CheckpointService {
  private checkpoints: Map<string, Checkpoint> = new Map();
  private order: string[] = [];

  constructor(private workspaceRoot: string) {}

  /**
   * Normalize a path coming from the agent/tool into a workspace-relative
   * form. Absolute paths inside the workspace get their prefix stripped;
   * absolute paths outside return null (we can't snapshot those safely);
   * relative paths pass through. This keeps every stored relPath in the
   * same shape so lookups during restore always hit.
   */
  private normalizeRel(input: string): string | null {
    if (!input) return null;
    // POSIX absolute or Windows drive-letter absolute
    const isAbs = input.startsWith("/") || /^[A-Za-z]:[\\/]/.test(input);
    if (!isAbs) return input.replace(/\\/g, "/");
    // Try to derive a workspace-relative path
    const root = this.workspaceRoot.replace(/[\\/]+$/, "");
    const normInput = input.replace(/\\/g, "/");
    const normRoot = root.replace(/\\/g, "/");
    if (normInput === normRoot) return null;
    if (normInput.startsWith(normRoot + "/")) {
      return normInput.slice(normRoot.length + 1);
    }
    return null;
  }

  async captureBefore(turnId: string): Promise<void> {
    const paths = await this.listCandidatePaths();
    const files: FileSnapshot[] = [];
    for (const rel of paths) {
      const abs = path.join(this.workspaceRoot, rel);
      try {
        const content = await fs.readFile(abs);
        files.push({ relPath: rel, existed: true, content });
      } catch {
        files.push({ relPath: rel, existed: false });
      }
    }
    this.checkpoints.set(turnId, { turnId, createdAt: Date.now(), files });
    this.order.push(turnId);
    this.gc();
  }

  /**
   * Snapshot keyed on a plan revision event id so each revision becomes
   * its own restore point. Same body as captureBefore — separate name to
   * make call sites self-documenting.
   */
  async captureBeforePlanRevision(revisionEventId: string): Promise<void> {
    await this.captureBefore(revisionEventId);
  }

  async restore(turnId: string): Promise<{ restored: number; deleted: number }> {
    const cp = this.checkpoints.get(turnId);
    if (!cp) return { restored: 0, deleted: 0 };
    let restored = 0;
    let deleted = 0;
    for (const f of cp.files) {
      const abs = path.join(this.workspaceRoot, f.relPath);
      if (f.existed && f.content) {
        try {
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, f.content);
          restored++;
        } catch {
          // Skip a file we can't restore (EACCES/EISDIR/ENOENT race, etc.)
          // and keep going — one bad path must not abort the whole restore.
        }
      } else {
        try {
          await fs.unlink(abs);
          deleted++;
        } catch {
          // already absent
        }
      }
    }
    const idx = this.order.indexOf(turnId);
    if (idx !== -1) {
      const drop = this.order.slice(idx + 1);
      for (const d of drop) this.checkpoints.delete(d);
      this.order = this.order.slice(0, idx + 1);
    }
    return { restored, deleted };
  }

  /**
   * Restore a single file from the most recent checkpoint that snapshotted
   * it. Walks checkpoints newest → oldest, finds the first matching entry,
   * and writes (or deletes) the file. Accepts either workspace-relative or
   * absolute paths (inside the workspace) so callers don't need to know the
   * internal storage shape.
   *
   * Returns one of:
   *   - `{ deleted: false }` — file was overwritten with the snapshot
   *   - `{ deleted: true }`  — file was removed (snapshot recorded it as
   *                            not yet existing before the turn)
   *   - `null`               — no snapshot exists for this path
   */
  async restoreFile(relPath: string): Promise<{ deleted: boolean } | null> {
    const rel = this.normalizeRel(relPath) ?? relPath.replace(/\\/g, "/");
    for (let i = this.order.length - 1; i >= 0; i--) {
      const cp = this.checkpoints.get(this.order[i]);
      if (!cp) continue;
      const snap = cp.files.find((f) => f.relPath === rel);
      if (!snap) continue;
      const abs = path.join(this.workspaceRoot, rel);
      if (snap.existed && snap.content) {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, snap.content);
        return { deleted: false };
      }
      try {
        await fs.unlink(abs);
      } catch {
        // already absent
      }
      return { deleted: true };
    }
    return null;
  }

  /**
   * True when at least one checkpoint snapshotted this file. Used so the
   * webview can hide or disable the per-file revert affordance for files
   * that were created/edited before checkpoints existed (e.g. a restored
   * session before the user's first prompt).
   */
  hasSnapshotFor(relPath: string): boolean {
    const rel = this.normalizeRel(relPath) ?? relPath.replace(/\\/g, "/");
    for (const id of this.order) {
      const cp = this.checkpoints.get(id);
      if (cp?.files.some((f) => f.relPath === rel)) return true;
    }
    return false;
  }

  /**
   * Snapshot additional files not known at captureBefore time. Called when
   * the orchestrator sees a write/edit tool call fire mid-turn.
   *
   * IMPORTANT: in Claude CLI mode the `tool_call` event reaches us AFTER
   * the CLI has already executed the tool — reading from disk at that
   * point captures the *post-edit* content. To get a usable pre-edit
   * snapshot, we prefer `git show HEAD:<rel>` for tracked files (HEAD is
   * the most recent committed state). Falls back to the disk read for
   * brand-new untracked files where HEAD doesn't carry the file. Without
   * this, revert would write the post-edit content back as the "pre-edit"
   * state, making the Undo button silently a no-op.
   *
   * Accepts either workspace-relative or absolute paths.
   */
  async addFileToLatest(relPath: string): Promise<void> {
    if (this.order.length === 0) return;
    const rel = this.normalizeRel(relPath);
    if (!rel) return;
    const latest = this.checkpoints.get(this.order[this.order.length - 1]);
    if (!latest) return;
    if (latest.files.some((f) => f.relPath === rel)) return;

    // 1) Try git HEAD. This is the authoritative pre-edit state for any
    //    file that was committed and clean before the turn — covers the
    //    common case where the user starts a turn on a fresh tree.
    const head = await this.readGitHeadContent(rel);
    if (head !== null) {
      latest.files.push({ relPath: rel, existed: true, content: head });
      return;
    }

    // 2) Untracked file. If it exists on disk right now, we have to assume
    //    we beat the agent to the write (best-effort) OR the agent edited
    //    an already-modified file whose pre-state was captured by
    //    captureBefore. In either case `latest.files.some(...)` above would
    //    have already returned, so reaching here means this is a fresh
    //    file. Snapshot as `existed: false` so revert deletes it.
    const abs = path.join(this.workspaceRoot, rel);
    try {
      await fs.stat(abs);
      // File exists but isn't tracked — treat as "didn't exist pre-turn"
      // so revert removes it. Storing current content would just rewrite
      // the post-edit state back, which is what we're trying to avoid.
      latest.files.push({ relPath: rel, existed: false });
    } catch {
      latest.files.push({ relPath: rel, existed: false });
    }
  }

  /**
   * Read a file's content at the current HEAD commit, in bytes.
   * Returns null when the file isn't tracked, HEAD is missing, or git
   * isn't available. Uses spawn (not exec) so binary files round-trip
   * cleanly via raw stdout buffers.
   */
  private readGitHeadContent(rel: string): Promise<Buffer | null> {
    return new Promise<Buffer | null>((resolve) => {
      let settled = false;
      const finish = (v: Buffer | null) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      try {
        const child = spawn("git", ["show", `HEAD:${rel}`], {
          cwd: this.workspaceRoot,
          stdio: ["ignore", "pipe", "pipe"]
        });
        const chunks: Buffer[] = [];
        child.stdout.on("data", (c: Buffer) => chunks.push(c));
        child.stderr.on("data", () => {
          /* discard — non-zero exit signals not-tracked */
        });
        child.on("error", () => finish(null));
        child.on("close", (code) => {
          if (code !== 0) return finish(null);
          finish(Buffer.concat(chunks));
        });
        // Hard timeout in case git hangs on a corrupt repo.
        setTimeout(() => {
          if (!settled) {
            child.kill("SIGTERM");
            finish(null);
          }
        }, 3000).unref();
      } catch {
        finish(null);
      }
    });
  }

  hasCheckpoint(turnId: string): boolean {
    return this.checkpoints.has(turnId);
  }

  list(): { turnId: string; createdAt: number; fileCount: number }[] {
    return this.order
      .map((id) => {
        const cp = this.checkpoints.get(id);
        return cp
          ? { turnId: cp.turnId, createdAt: cp.createdAt, fileCount: cp.files.length }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
  }

  clear() {
    this.checkpoints.clear();
    this.order = [];
  }

  private gc() {
    while (this.order.length > MAX_PER_SESSION) {
      const oldest = this.order.shift();
      if (oldest) this.checkpoints.delete(oldest);
    }
  }

  private async listCandidatePaths(): Promise<string[]> {
    try {
      const { stdout } = await pexec("git status --porcelain=v1 -uall", {
        cwd: this.workspaceRoot,
        timeout: 5000,
        maxBuffer: 2_000_000
      });
      const files = new Set<string>();
      for (const rawLine of stdout.split("\n")) {
        if (!rawLine) continue;
        // Porcelain v1 format: `XY path` where XY is 2 status chars + 1 space.
        // Lines may have leading space in XY (e.g. " M path"). Do not trim.
        const p = rawLine.slice(3).trim();
        if (p) files.add(p);
      }
      return [...files];
    } catch {
      return [];
    }
  }
}
