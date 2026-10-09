import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointManager } from "../src/core/checkpoint.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nex-cp-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("CheckpointManager", () => {
  it("memulihkan tiga file ke kondisi semula setelah undoLast", async () => {
    const files = ["a.ts", "b.ts", "c.ts"].map((f) => path.join(root, f));
    for (const file of files) await fs.writeFile(file, "awal\n", "utf8");

    const manager = new CheckpointManager(path.join(root, ".state"));
    manager.beginTask();
    await manager.snapshotBefore(1, files);
    for (const file of files) await fs.writeFile(file, "diubah\n", "utf8");

    const result = await manager.undoLast(root);
    expect(result.entries).toHaveLength(3);
    for (const file of files) {
      expect(await fs.readFile(file, "utf8")).toBe("awal\n");
    }
  });

  it("mengembalikan ke kondisi sebelum langkah tertentu", async () => {
    const file = path.join(root, "x.ts");
    await fs.writeFile(file, "v0\n", "utf8");

    const manager = new CheckpointManager(path.join(root, ".state"));
    manager.beginTask();
    await manager.snapshotBefore(1, [file]);
    await fs.writeFile(file, "v1\n", "utf8");
    await manager.snapshotBefore(2, [file]);
    await fs.writeFile(file, "v2\n", "utf8");

    await manager.undoTostep(2, root);
    expect(await fs.readFile(file, "utf8")).toBe("v1\n");
  });

  it("menghapus file yang dibuat dalam tugas saat undo", async () => {
    const file = path.join(root, "baru.ts");
    const manager = new CheckpointManager(path.join(root, ".state"));
    manager.beginTask();
    await manager.snapshotBefore(1, [file]);
    await fs.writeFile(file, "isi\n", "utf8");

    await manager.undoLast(root);
    await expect(fs.readFile(file, "utf8")).rejects.toThrow();
  });
});
