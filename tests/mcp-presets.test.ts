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
import { addMcpPreset, findMcpPreset, listMcpPresets } from "../src/plugins/presets.js";

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

  it("addMcpPreset menulis konfigurasi yang valid dan bisa dimuat", async () => {
    const added = await addMcpPreset("context7", undefined, dir);
    expect(added.serverName).toBe("context7");

    const config = await loadPluginsConfig(dir);
    expect(config.servers.context7).toMatchObject({
      transport: "http",
      url: "https://mcp.context7.com/mcp",
      risk: "read",
    });
  });

  it("menulis referensi rahasia, bukan nilai (supabase)", async () => {
    await addMcpPreset("supabase", undefined, dir);
    const doc = await readJson();
    const entry = (doc.mcp as Record<string, Record<string, unknown>>).supabase!;
    expect(entry.credential).toBe("supabase");
    expect(entry.env).toEqual({ SUPABASE_ACCESS_TOKEN: "${apiKey}" });
  });

  it("mendukung nama kustom untuk server", async () => {
    const added = await addMcpPreset("context7", "c7", dir);
    expect(added.serverName).toBe("c7");
    expect(await hasMcpServer("c7", dir)).toBe(true);
    expect(await hasMcpServer("context7", dir)).toBe(false);
  });

  it("menolak preset tak dikenal / nama yang sudah dipakai", async () => {
    await expect(addMcpPreset("nope", undefined, dir)).rejects.toThrow(/Tersedia/);

    await addMcpPreset("playwright", undefined, dir);
    await expect(addMcpPreset("playwright", undefined, dir)).rejects.toThrow(/sudah ada/);
  });
});
