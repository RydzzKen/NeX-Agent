import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../src/tools/types.js";
import { memoryTool } from "../src/tools/memory.js";
import { readFacts } from "../src/memory/long_term.js";

let dir: string;
let saved: string | undefined;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "nex-memtool-"));
  saved = process.env.AGENT_CONFIG_DIR;
  process.env.AGENT_CONFIG_DIR = dir;
});

afterEach(async () => {
  if (saved === undefined) delete process.env.AGENT_CONFIG_DIR;
  else process.env.AGENT_CONFIG_DIR = saved;
  await fs.rm(dir, { recursive: true, force: true });
});

function makeCtx() {
  const refresh = vi.fn(async () => undefined);
  const ctx = {
    mode: "build",
    signal: new AbortController().signal,
    refreshMemory: refresh,
  } as unknown as ToolContext;
  return { ctx, refresh };
}

describe("memory tool", () => {
  it("menyimpan fakta dan memicu refreshMemory", async () => {
    const { ctx, refresh } = makeCtx();
    const result = await memoryTool.execute({ action: "add", key: "nama", value: "Rydz" }, ctx);
    expect(result.ok).not.toBe(false);
    expect(result.content).toContain("nama = Rydz");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await readFacts(dir)).toMatchObject([{ key: "nama", value: "Rydz" }]);
  });

  it("memperbarui fakta dengan key sama, bukan menduplikasi", async () => {
    const { ctx } = makeCtx();
    await memoryTool.execute({ action: "add", key: "hobi", value: "coding" }, ctx);
    await memoryTool.execute({ action: "add", key: "Hobi", value: "gaming" }, ctx);
    const facts = await readFacts(dir);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ key: "Hobi", value: "gaming" });
  });

  it("list menampilkan fakta yang tersimpan", async () => {
    const { ctx } = makeCtx();
    await memoryTool.execute({ action: "add", key: "bahasa", value: "Indonesia" }, ctx);
    const result = await memoryTool.execute({ action: "list" }, ctx);
    expect(result.content).toContain("- bahasa: Indonesia");
  });

  it("list pada store kosong memberi pesan ramah", async () => {
    const { ctx } = makeCtx();
    const result = await memoryTool.execute({ action: "list" }, ctx);
    expect(result.ok).not.toBe(false);
    expect(result.content).toContain("Belum ada memori");
  });

  it("forget menghapus berdasarkan key", async () => {
    const { ctx, refresh } = makeCtx();
    await memoryTool.execute({ action: "add", key: "nama", value: "Rydz" }, ctx);
    refresh.mockClear();
    const result = await memoryTool.execute({ action: "forget", key: "NAMA" }, ctx);
    expect(result.content).toContain("Dilupakan: nama");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await readFacts(dir)).toEqual([]);
  });

  it("forget key yang tidak ada → error yang dikembalikan", async () => {
    const { ctx } = makeCtx();
    const result = await memoryTool.execute({ action: "forget", key: "tiada" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.content).toContain("Tidak ada memori");
  });

  it("add tanpa key/value → error yang dikembalikan", async () => {
    const { ctx } = makeCtx();
    const result = await memoryTool.execute({ action: "add", key: "nama" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.content).toContain("butuh `key` dan `value`");
  });

  it("menolak kredensial/rahasia dan tidak menyimpannya", async () => {
    const { ctx, refresh } = makeCtx();
    const result = await memoryTool.execute(
      { action: "add", key: "api key", value: "sk-rahasia" },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain("kredensial");
    expect(refresh).not.toHaveBeenCalled();
    expect(await readFacts(dir)).toEqual([]);
  });
});
