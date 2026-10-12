import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, rememberModel, saveConfig } from "../src/config/config.js";

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