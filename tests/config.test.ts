import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearRecentCustomModels,
  listRecentCustomModels,
  loadConfig,
  rememberCustomModel,
  rememberModel,
  saveConfig,
} from "../src/config/config.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "nex-cfg-"));
  process.env.AGENT_CONFIG_DIR = dir;
});

afterEach(async () => {
  delete process.env.AGENT_CONFIG_DIR;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("config model memory", () => {
  it("rememberModel menulis model per workspace dan defaultModel global", async () => {
    await rememberModel("/ws/a", "claude-3");
    const cfg = await loadConfig();
    expect(cfg.models?.["/ws/a"]).toBe("claude-3");
    expect(cfg.defaultModel).toBe("claude-3");
  });

  it("pindah workspace memperbarui defaultModel ke pilihan terakhir", async () => {
    await rememberModel("/ws/a", "claude-3");
    await rememberModel("/ws/b", "gpt-4o");
    const cfg = await loadConfig();
    expect(cfg.models?.["/ws/a"]).toBe("claude-3");
    expect(cfg.models?.["/ws/b"]).toBe("gpt-4o");
    expect(cfg.defaultModel).toBe("gpt-4o");
  });

  it("saveConfig parsial tidak menghapus models/defaultModel", async () => {
    await rememberModel("/ws/a", "claude-3");
    await saveConfig({ markdown: false });
    const cfg = await loadConfig();
    expect(cfg.models?.["/ws/a"]).toBe("claude-3");
    expect(cfg.defaultModel).toBe("claude-3");
    expect(cfg.markdown).toBe(false);
  });

  it("defaultModel tidak tertulis bila config kosong", async () => {
    const cfg = await loadConfig();
    expect(cfg.defaultModel).toBeUndefined();
  });
});

describe("config custom model memory", () => {
  it("menyimpan nama custom, terbaru lebih dulu", async () => {
    await rememberCustomModel("model-a");
    await rememberCustomModel("model-b");
    expect(await listRecentCustomModels()).toEqual(["model-b", "model-a"]);
  });

  it("mendedupe secara case-insensitive dan memindah ke depan", async () => {
    await rememberCustomModel("Model-A");
    await rememberCustomModel("model-b");
    await rememberCustomModel("MODEL-A");
    expect(await listRecentCustomModels()).toEqual(["MODEL-A", "model-b"]);
  });

  it("mengabaikan nama kosong/spasi", async () => {
    await rememberCustomModel("   ");
    expect(await listRecentCustomModels()).toEqual([]);
  });

  it("memangkas riwayat pada batas maksimum", async () => {
    for (let i = 0; i < 25; i += 1) await rememberCustomModel(`m-${i}`);
    const list = await listRecentCustomModels();
    expect(list).toHaveLength(20);
    expect(list[0]).toBe("m-24");
    expect(list).not.toContain("m-0");
  });

  it("rememberModel tidak menghapus riwayat custom", async () => {
    await rememberCustomModel("custom-x");
    await rememberModel("/ws/a", "gpt-4o");
    expect(await listRecentCustomModels()).toEqual(["custom-x"]);
    const cfg = await loadConfig();
    expect(cfg.models?.["/ws/a"]).toBe("gpt-4o");
  });

  it("clearRecentCustomModels menghapus riwayat", async () => {
    await rememberCustomModel("custom-x");
    await clearRecentCustomModels();
    expect(await listRecentCustomModels()).toEqual([]);
  });
});