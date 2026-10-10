import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPluginsConfig, McpConfigError, resolveTemplates } from "../src/plugins/config.js";
import type { ProviderCredentials } from "../src/providers/provider.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "nex-plugins-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function writePlugins(content: string): Promise<void> {
  await fs.writeFile(path.join(dir, "plugins.json"), content, "utf8");
}

describe("loadPluginsConfig", () => {
  it("berkas hilang → konfigurasi kosong tanpa error", async () => {
    const config = await loadPluginsConfig(dir);
    expect(config.servers).toEqual({});
    expect(config.errors).toEqual({});
    expect(config.fileError).toBeUndefined();
  });

  it("JSON rusak → fileError", async () => {
    await writePlugins("{ tidak valid");
    const config = await loadPluginsConfig(dir);
    expect(config.fileError).toBeDefined();
    expect(config.servers).toEqual({});
  });

  it("mem-parsing server valid, mengisi default, dan menandai yang rusak terpisah", async () => {
    await writePlugins(
      JSON.stringify({
        mcp: {
          context7: { transport: "http", url: "https://mcp.context7.com/mcp" },
          stdio: { command: "npx", args: ["-y", "pkg"], risk: "mutate" },
          tanpaUrl: { transport: "sse" },
          "nama buruk!": { command: "x" },
          nonaktif: { transport: "stdio", command: "x", enabled: false },
          salahTipe: { transport: "stdio", args: "bukan-array" },
        },
      }),
    );
    const config = await loadPluginsConfig(dir);

    expect(config.servers.context7!).toMatchObject({
      name: "context7",
      transport: "http",
      url: "https://mcp.context7.com/mcp",
      enabled: true,
      args: [],
      env: {},
      headers: {},
      tools: {},
    });
    expect(config.servers.stdio!.risk).toBe("mutate");
    expect(config.servers.nonaktif!.enabled).toBe(false);

    // Server rusak tidak menggagalkan yang lain; masuk ke `errors`.
    expect(config.errors["tanpaUrl"]).toContain("url");
    expect(config.errors["nama buruk!"]).toContain("tidak valid");
    expect(config.errors["salahTipe"]).toBeDefined();
    expect(config.servers["tanpaUrl"]).toBeUndefined();
  });

  it("superRefine: transport non-stdio tanpa url ditolak", async () => {
    await writePlugins(JSON.stringify({ mcp: { s: { transport: "http", command: "npx" } } }));
    const config = await loadPluginsConfig(dir);
    expect(config.errors["s"]).toContain("url");
  });
});

describe("resolveTemplates", () => {
  const credential: ProviderCredentials = { apiKey: "kunci-rahasia", baseURL: "https://api.example.test" };

  it("mengisi ${apiKey}/${baseURL} dari kredensial dan nama lain dari env", () => {
    const out = resolveTemplates(
      { AUTH: "Bearer ${apiKey}", URL: "${baseURL}", VAR: "${DIAMBIL_DARI_ENV}" },
      { credential, env: { DIAMBIL_DARI_ENV: "nilai-env" } },
    );
    expect(out).toEqual({
      AUTH: "Bearer kunci-rahasia",
      URL: "https://api.example.test",
      VAR: "nilai-env",
    });
  });

  it("mendukung literal + beberapa template dalam satu nilai", () => {
    expect(resolveTemplates({ V: "pre-${apiKey}-${baseURL}-post" }, { credential })).toEqual({
      V: "pre-kunci-rahasia-https://api.example.test-post",
    });
  });

  it("template yang tak tersedia → McpConfigError (fail closed)", () => {
    expect(() => resolveTemplates({ K: "${apiKey}" }, { env: {} })).toThrow(McpConfigError);
    expect(() => resolveTemplates({ K: "${VARIABEL_TAK_ADA}" }, { env: {} })).toThrow(/VARIABEL_TAK_ADA/);
    expect(() => resolveTemplates({ K: "${apiKey}" }, { credential, env: {} })).not.toThrow();
  });
});