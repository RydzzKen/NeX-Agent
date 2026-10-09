import fs from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../logging/logger.js";

export interface FileSnapshot {
  /** Path absolut. */
  path: string;
  existed: boolean;
  /** Konten sebelum langkah; null bila file tidak ada. */
  content: string | null;
}

export interface CheckpointStep {
  index: number;
  snapshots: FileSnapshot[];
}

export interface CheckpointTask {
  id: string;
  at: string;
  steps: CheckpointStep[];
}

export interface UndoEntry {
  path: string;
  display: string;
  /** Konten yang dipulihkan (sebelum). */
  before: string | null;
  /** Konten saat ini (sesudah). */
  after: string | null;
}

export interface UndoResult {
  entries: UndoEntry[];
}

/**
 * Checkpoint & undo (F-04).
 *
 * Snapshot diambil per langkah mutating: sebelum langkah dieksekusi, konten
 * setiap file yang akan diubah dicatat. Undo memulihkan snapshot dari langkah
 * terbesar lebih dulu sehingga kondisi paling awal menang.
 */
export class CheckpointManager {
  private tasks: CheckpointTask[] = [];
  private current: CheckpointTask | null = null;

  constructor(
    private readonly dir: string,
    private readonly logger?: Logger,
  ) {}

  static async load(dir: string, logger?: Logger): Promise<CheckpointManager> {
    const manager = new CheckpointManager(dir, logger);
    try {
      const raw = await fs.readFile(path.join(dir, "checkpoints.json"), "utf8");
      manager.tasks = JSON.parse(raw) as CheckpointTask[];
    } catch {
      manager.tasks = [];
    }
    return manager;
  }

  beginTask(): string {
    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.current = { id, at: new Date().toISOString(), steps: [] };
    this.tasks.push(this.current);
    void this.persist();
    return id;
  }

  get currentTask(): CheckpointTask | null {
    return this.current;
  }

  /** Snapshot file sebelum sebuah langkah mutating. */
  async snapshotBefore(stepIndex: number, absPaths: string[]): Promise<void> {
    if (!this.current) this.beginTask();
    const snapshots: FileSnapshot[] = [];
    for (const abs of absPaths) {
      if (snapshots.some((s) => s.path === abs)) continue;
      let existed = true;
      let content: string | null = null;
      try {
        content = await fs.readFile(abs, "utf8");
      } catch {
        existed = false;
        content = null;
      }
      snapshots.push({ path: abs, existed, content });
    }
    if (snapshots.length === 0) return;
    this.current!.steps.push({ index: stepIndex, snapshots });
    await this.persist();
  }

  private snapshotsAtOrAfter(task: CheckpointTask, minStep: number): FileSnapshot[] {
    // Untuk tiap path, ambil snapshot dengan langkah terkecil >= minStep:
    // itu adalah kondisi tepat sebelum langkah target.
    const pairs = task.steps
      .filter((s) => s.index >= minStep)
      .flatMap((s) => s.snapshots.map((snap) => ({ step: s.index, snap })))
      .sort((a, b) => a.step - b.step);
    const seen = new Set<string>();
    const ordered: FileSnapshot[] = [];
    for (const { snap } of pairs) {
      if (seen.has(snap.path)) continue;
      seen.add(snap.path);
      ordered.push(snap);
    }
    return ordered;
  }

  private async apply(snapshots: FileSnapshot[], root: string): Promise<UndoEntry[]> {
    const entries: UndoEntry[] = [];
    for (const snap of snapshots) {
      let after: string | null = null;
      try {
        after = await fs.readFile(snap.path, "utf8");
      } catch {
        after = null;
      }
      if (snap.existed) {
        await fs.mkdir(path.dirname(snap.path), { recursive: true });
        await fs.writeFile(snap.path, snap.content ?? "", "utf8");
      } else {
        await fs.rm(snap.path, { force: true });
      }
      entries.push({
        path: snap.path,
        display: path.relative(root, snap.path) || snap.path,
        before: snap.content,
        after,
      });
    }
    this.logger?.info("undo.applied", { files: snapshots.map((s) => s.path) });
    return entries;
  }

  /** Kembalikan seluruh perubahan tugas terakhir ke kondisi awal tugas. */
  async undoLast(workspaceRoot: string): Promise<UndoResult> {
    const task = this.current ?? this.tasks[this.tasks.length - 1];
    if (!task || task.steps.length === 0) return { entries: [] };
    const firstStep = Math.min(...task.steps.map((s) => s.index));
    const snapshots = this.snapshotsAtOrAfter(task, firstStep);
    const entries = await this.apply(snapshots, workspaceRoot);
    // Tugas yang di-undo tidak bisa di-undo lagi.
    this.tasks = this.tasks.filter((t) => t !== task);
    if (this.current === task) this.current = null;
    await this.persist();
    return { entries };
  }

  /** Kembalikan perubahan ke kondisi sebelum langkah `stepIndex`. */
  async undoTostep(stepIndex: number, workspaceRoot: string): Promise<UndoResult> {
    const task = this.current ?? this.tasks[this.tasks.length - 1];
    if (!task) return { entries: [] };
    const snapshots = this.snapshotsAtOrAfter(task, stepIndex);
    const entries = await this.apply(snapshots, workspaceRoot);
    task.steps = task.steps.filter((s) => s.index < stepIndex);
    if (task.steps.length === 0) {
      this.tasks = this.tasks.filter((t) => t !== task);
      if (this.current === task) this.current = null;
    }
    await this.persist();
    return { entries };
  }

  hasUndo(): boolean {
    const task = this.current ?? this.tasks[this.tasks.length - 1];
    return Boolean(task && task.steps.length > 0);
  }

  private async persist(): Promise<void> {
    try {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(path.join(this.dir, "checkpoints.json"), JSON.stringify(this.tasks), "utf8");
    } catch (err) {
      this.logger?.warn("checkpoint.persist_failed", { error: (err as Error).message });
    }
  }
}
