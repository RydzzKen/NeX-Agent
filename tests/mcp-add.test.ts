import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPluginsConfig, McpConfigError } from "../src/plugins/config.js";
import { applyMcpAdd, planMcpAdd, sanitizeServerName } from "../src/plugins/mcp_add.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "nex-mcp-add-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function readJson(): Promise<{ mcp: Record<string, Record<string, unknown>> }> {
  return JSON.parse(await fs.readFile(path.join(dir, "plugins.json"), "utf8"));
}

describe("sanitizeServerName", () => {
  it("membuang scope, versi, ekstensi, dan karakter tidak valid", () => {
    expect(sanitizeServerName("@playwright/mcp-server")).toBe("playwright-mcp-server");
    expect(sanitizeServerName("@playwright/mcp@1.2.3")).toBe("playwright-mcp");
    expect(sanitizeServerName("server.mjs")).toBe("server");
    expect(sanitizeServerName("nama buruk!")).toBe("nama-buruk");
  });
});

describe("planMcpAdd — command mentah (stdio)", () => {
  it("menebak nama dari paket dan menyusun konfigurasi stdio", () => {
    const plan = planMcpAdd(["npx", "@playwright/mcp-server"]);
    expect(plan).toEqual({
      kind: "server",
      serverName: "playwright-mcp-server",
      explicitName: false,
      server: { transport: "stdio", command: "npx", args: ["@playwright/mcp-server"] },
    });
  });

  it("membuang versi paket dan mempertahankan flag sebagai args", () => {
    const plan = planMcpAdd(["npx", "-y", "@playwright/mcp@latest", "--headless"]);
    expect(plan.serverName).toBe("playwright-mcp");
    expect(plan.server).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest", "--headless"],
    });
  });

  it("menghormati --name eksplisit (termasuk bentuk =)", () => {
    const plan = planMcpAdd(["--name", "pw", "node", "server.js"]);
    expect(plan.serverName).toBe("pw");
    expect(plan.explicitName).toBe(true);
    expect(plan.server).toEqual({ transport: "stdio", command: "node", args: ["server.js"] });
    expect(planMcpAdd(["--name=pw", "node", "s.js"]).serverName).toBe("pw");
  });

  it("menolak command kosong atau opsi tanpa nilai", () => {
    expect(() => planMcpAdd([])).toThrow(McpConfigError);
    expect(() => planMcpAdd(["--name"])).toThrow(/butuh nilai/);
    expect(() => planMcpAdd(["--halo", "x"])).toThrow(/tidak dikenal/);
  });
});

describe("planMcpAdd — preset", () => {
  it("mengenali alias preset dan memakai konfigurasinya", () => {
    const plan = planMcpAdd(["context7"]);
    expect(plan.kind).toBe("preset");
    expect(plan.presetAlias).toBe("context7");
    expect(plan.serverName).toBe("context7");
    expect(plan.server).toMatchObject({ transport: "http", url: "https://mcp.context7.com/mcp" });
    expect(plan.presetNote).toBeTruthy();
  });

  it("mendukung nama kustom untuk preset", () => {
    expect(planMcpAdd(["context7", "c7"]).serverName).toBe("c7");
    expect(planMcpAdd(["--name", "x", "context7"]).serverName).toBe("x");
  });

  it("nama tak dikenal diperlakukan sebagai command, bukan error", () => {
    const plan = planMcpAdd(["mcp-server", "--flag"]);
    expect(plan.kind).toBe("server");
    expect(plan.server).toEqual({ transport: "stdio", command: "mcp-server", args: ["--flag"] });
  });
});

describe("planMcpAdd — URL", () => {
  it("--url membuat server http dan menebak nama dari host", () => {
    const plan = planMcpAdd(["--url", "https://mcp.context7.com/mcp"]);
    expect(plan.kind).toBe("server");
    expect(plan.serverName).toBe("context7");
    expect(plan.explicitName).toBe(false);
    expect(plan.server).toEqual({ transport: "http", url: "https://mcp.context7.com/mcp" });
  });

  it("mendukung --sse dan --transport=sse", () => {
    expect(planMcpAdd(["--url", "https://x.example/mcp", "--sse"]).server.transport).toBe("sse");
    expect(planMcpAdd(["--url", "https://x.example/mcp", "--transport=sse"]).server.transport).toBe("sse");
  });

  it("menolak transport asing dan kombo url+stdio", () => {
    expect(() => planMcpAdd(["--url", "https://x.example", "--transport", "ws"])).toThrow(/stdio\|http\|sse/);
    expect(() => planMcpAdd(["--url", "https://x.example", "--transport", "stdio"])).toThrow(/stdio/);
  });
});

describe("applyMcpAdd", () => {
  it("menulis konfigurasi yang bisa dimuat kembali", async () => {
    const name = await applyMcpAdd(planMcpAdd(["npx", "@playwright/mcp-server"]), dir);
    expect(name).toBe("playwright-mcp-server");

    const config = await loadPluginsConfig(dir);
    expect(config.fileError).toBeUndefined();
    expect(config.servers["playwright-mcp-server"]).toMatchObject({
      transport: "stdio",
      command: "npx",
      args: ["@playwright/mcp-server"],
    });
  });

  it("menulis referensi rahasia, bukan nilai (supabase)", async () => {
    await applyMcpAdd(planMcpAdd(["supabase"]), dir);
    const doc = await readJson();
    expect(doc.mcp.supabase!.credential).toBe("supabase");
    expect(doc.mcp.supabase!.env).toEqual({ SUPABASE_ACCESS_TOKEN: "${apiKey}" });
  });

  it("nama hasil tebakan yang bentrok diberi akhiran -2", async () => {
    await applyMcpAdd(planMcpAdd(["npx", "@playwright/mcp-server"]), dir);
    const second = await applyMcpAdd(planMcpAdd(["npx", "@playwright/mcp-server"]), dir);
    expect(second).toBe("playwright-mcp-server-2");
  });

  it("nama eksplisit yang bentrok ditolak", async () => {
    await applyMcpAdd(planMcpAdd(["--name", "pw", "npx", "@playwright/mcp"]), dir);
    await expect(applyMcpAdd(planMcpAdd(["--name", "pw", "npx", "@playwright/mcp"]), dir)).rejects.toThrow(
      /sudah ada/,
    );
  });
});
