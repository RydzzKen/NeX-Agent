import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hasMcpServer,
  isValidMcpServerName,
  loadPluginsConfig,
  McpConfigError,
  removeMcpServer,
  saveMcpServer,
} from "../src/plugins/config.js";
import { findMcpPreset, listMcpPresets } from "../src/plugins/presets.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "nex-presets-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function pluginsPath(): string {
  return path.join(dir, "plugins.json");
}

async function readJson(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(pluginsPath(), "utf8")) as Record<string, unknown>;
}

describe("saveMcpServer / removeMcpServer", () => {
  it("membuat plugins.json valid yang bisa dimuat kembali", async () => {
    await saveMcpServer("lokal", { command: "node", args: ["server.js"] }, dir);

    const config = await loadPluginsConfig(dir);
    expect(config.fileError).toBeUndefined();
    expect(config.servers.lokal).toMatchObject({
      name: "lokal",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      enabled: true,
    });
  });

  it("berkas dibuat dengan izin 600", async () => {
    await saveMcpServer("lokal", { command: "node" }, dir);
    const stat = await fs.stat(pluginsPath());
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("mempertahankan server lain dan kolom tingkat atas yang tidak dikenal", async () => {
    await fs.writeFile(
      pluginsPath(),
      JSON.stringify({ catatan: "jangan dihapus", mcp: { lama: { command: "x" } } }),
      "utf8",
    );

    await saveMcpServer("baru", { command: "y" }, dir);
    await removeMcpServer("lama", dir);

    const doc = await readJson();
    expect(doc.catatan).toBe("jangan dihapus");
    expect(doc.mcp).toEqual({ baru: { command: "y" } });
  });

  it("menolak nama server tidak valid", async () => {
    await expect(saveMcpServer("nama buruk!", { command: "x" }, dir)).rejects.toBeInstanceOf(McpConfigError);
    expect(isValidMcpServerName("nama buruk!")).toBe(false);
    expect(isValidMcpServerName("context7")).toBe(true);
  });

  it("menolak konfigurasi tidak valid (stdio tanpa command) tanpa menulis berkas", async () => {
    await expect(saveMcpServer("rusak", { transport: "stdio" }, dir)).rejects.toBeInstanceOf(McpConfigError);
    await expect(fs.access(pluginsPath())).rejects.toThrow();
  });

  it("menolak dan tidak menimpa bila plugins.json bukan JSON valid", async () => {
    await fs.writeFile(pluginsPath(), "{ bukan json", "utf8");
    await expect(saveMcpServer("x", { command: "y" }, dir)).rejects.toBeInstanceOf(McpConfigError);
    await expect(removeMcpServer("x", dir)).rejects.toBeInstanceOf(McpConfigError);
    // Berkas asli tidak diubah.
    expect(await fs.readFile(pluginsPath(), "utf8")).toBe("{ bukan json");
  });

  it("removeMcpServer → true bila ada, false bila tidak", async () => {
    await saveMcpServer("a", { command: "y" }, dir);
    expect(await hasMcpServer("a", dir)).toBe(true);
    expect(await hasMcpServer("z", dir)).toBe(false);
    expect(await removeMcpServer("a", dir)).toBe(true);
    expect(await removeMcpServer("a", dir)).toBe(false);
  });
});

describe("preset MCP", () => {
  it("berisi preset yang didokumentasikan", () => {
    const names = listMcpPresets().map((p) => p.name);
    expect(names).toContain("context7");
    expect(names).toContain("playwright");
    expect(names).toContain("supabase");
  });

  it("findMcpPreset tidak peduli huruf besar-kecil dan spasi", () => {
    expect(findMcpPreset("  Context7 ")?.name).toBe("context7");
    expect(findMcpPreset("tidak-ada")).toBeUndefined();
  });
});
