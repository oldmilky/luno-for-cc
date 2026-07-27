import * as path from "node:path";
import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(exec);
const MAX_PER_SESSION = 20;

/** Checkpoints older than this are swept at startup. They pin file contents
 *  from a tree that has moved on, and nobody rewinds a month-old chat. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Bumped when the on-disk shape changes; an unreadable or older file is
 *  discarded rather than migrated — a lost undo history is recoverable, a
 *  misread one restores wrong bytes over the user's work. */
const STATE_VERSION = 1;

/** Where snapshots live, given VS Code's per-extension storage path. A
 *  function rather than a constant so this module keeps importing no vscode
 *  API — `src/core` and the services under it are unit-tested off an editor. */
export function checkpointStoreDir(globalStoragePath: string): string {
  return path.join(globalStoragePath, "checkpoints");
}

interface PersistedState {
  v: number;
  order: string[];
  checkpoints: Array<{
    turnId: string;
    createdAt: number;
    files: Array<{ relPath: string; existed: boolean; content?: string }>;
  }>;
}

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

  /** Where this session's snapshots live, or undefined when there is nowhere
   *  to put them and rewind lasts only as long as the window does. */
  private readonly stateFile?: string;

  /** Serialises writes. Two turns can finish close enough together that their
   *  saves interleave, and a half-written state file is worse than none. */
  private writing: Promise<void> = Promise.resolve();

  /**
   * @param sessionId keys the snapshots on disk. Checkpoints belong to one
   *   conversation: a rewind restoring files snapshotted by a different chat
   *   is data loss, so nothing is shared between sessions.
   * @param storeDir root for persisted snapshots. Omit both to keep the
   *   in-memory behaviour, which is what the tests without storage exercise.
   */
  constructor(
    private workspaceRoot: string,
    sessionId?: string,
    storeDir?: string
  ) {
    if (sessionId && storeDir) {
      this.stateFile = path.join(storeDir, `${sessionId}.json`);
      this.load();
    }
  }

  /** The checkout every snapshot in here is relative to. A conversation can
   *  move into its own worktree after checkpoints were armed, and snapshots
   *  taken against the wrong root would restore into the wrong tree. */
  get root(): string {
    return this.workspaceRoot;
  }

  /**
   * Read this session's snapshots back.
   *
   * Synchronous on purpose: `hasSnapshotFor` and `hasCheckpoint` are sync, and
   * the webview asks them as soon as it mounts. An async load would answer
   * "no snapshot" for the first render after a reload — which renders as a
   * missing Undo button on files that can, in fact, be reverted.
   */
  private load(): void {
    if (!this.stateFile) return;
    try {
      const raw = JSON.parse(
        readFileSync(this.stateFile, "utf8")
      ) as PersistedState;
      if (raw.v !== STATE_VERSION || !Array.isArray(raw.checkpoints)) return;
      for (const cp of raw.checkpoints) {
        this.checkpoints.set(cp.turnId, {
          turnId: cp.turnId,
          createdAt: cp.createdAt,
          files: cp.files.map((f) => ({
            relPath: f.relPath,
            existed: f.existed,
            content:
              f.content === undefined
                ? undefined
                : Buffer.from(f.content, "base64")
          }))
        });
      }
      this.order = raw.order.filter((id) => this.checkpoints.has(id));
    } catch {
      // No file yet, or one this build cannot read. Either way the session
      // starts with no undo history rather than refusing to open.
    }
  }

  private persist(): Promise<void> {
    if (!this.stateFile) return Promise.resolve();
    const file = this.stateFile;
    const state: PersistedState = {
      v: STATE_VERSION,
      order: [...this.order],
      checkpoints: this.order.flatMap((id) => {
        const cp = this.checkpoints.get(id);
        if (!cp) return [];
        return [
          {
            turnId: cp.turnId,
            createdAt: cp.createdAt,
            files: cp.files.map((f) => ({
              relPath: f.relPath,
              existed: f.existed,
              ...(f.content ? { content: f.content.toString("base64") } : {})
            }))
          }
        ];
      })
    };
    this.writing = this.writing.then(async () => {
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify(state));
      } catch {
        // Losing the mirror costs rewind after a reload, not this session's.
      }
    });
    return this.writing;
  }

  /** Forget a session's snapshots for good. Called when its chat is deleted —
   *  the undo history of a conversation the user removed is not theirs to
   *  keep, and it pins file contents nothing will ever restore. */
  static async forget(storeDir: string, sessionId: string): Promise<void> {
    try {
      await fs.rm(path.join(storeDir, `${sessionId}.json`), { force: true });
    } catch {
      // Nothing to drop.
    }
  }

  /** Sweep snapshots nobody will rewind to. Best-effort and never throws:
   *  this runs at startup, where a storage hiccup must not block activation. */
  static async prune(storeDir: string, now = Date.now()): Promise<void> {
    try {
      const entries = await fs.readdir(storeDir);
      for (const name of entries) {
        if (!name.endsWith(".json")) continue;
        const full = path.join(storeDir, name);
        const st = await fs.stat(full);
        if (now - st.mtimeMs > MAX_AGE_MS) await fs.rm(full, { force: true });
      }
    } catch {
      // No store yet.
    }
  }

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
    await this.persist();
  }

  /**
   * Snapshot keyed on a plan revision event id so each revision becomes
   * its own restore point. Same body as captureBefore — separate name to
   * make call sites self-documenting.
   */
  async captureBeforePlanRevision(revisionEventId: string): Promise<void> {
    await this.captureBefore(revisionEventId);
  }

  async restore(
    turnId: string
  ): Promise<{ restored: number; deleted: number }> {
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
    await this.persist();
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
      await this.persist();
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
    await this.persist();
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
          ? {
              turnId: cp.turnId,
              createdAt: cp.createdAt,
              fileCount: cp.files.length
            }
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
