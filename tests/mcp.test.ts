import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Approvals } from "../src/core/approvals.js";
import { silentIO } from "../src/core/io.js";
import { TodoStore } from "../src/core/todos.js";
import { PermissionManager } from "../src/safety/permissions.js";
import { createPathResolver } from "../src/safety/policy.js";
import { createWorkspace } from "../src/safety/workspace.js";
import { CredentialStore } from "../src/config/credentials.js";
import { nullLogger } from "../src/logging/logger.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolContext } from "../src/tools/types.js";
import type { McpServerConfig } from "../src/plugins/config.js";
import { McpClient } from "../src/plugins/mcp.js";
import { McpManager } from "../src/plugins/manager.js";

const MOCK_SERVER = fileURLToPath(new URL("./fixtures/mock-mcp-server.mjs", import.meta.url));
const ENV_SERVER = fileURLToPath(new URL("./fixtures/env-mcp-server.mjs", import.meta.url));

function makeConfig(partial: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: "mock",
    transport: "stdio",
    command: process.execPath,
    args: [MOCK_SERVER],
    env: {},
    headers: {},
    enabled: true,
    tools: {},
    ...partial,
  };
}

function makeContext(root: string, approveAll: boolean): ToolContext {
  const workspace = createWorkspace(root);
  const permissions = new PermissionManager(workspace.root);
  const io = silentIO(approveAll ? "yes" : "no");
  const approvals = new Approvals(io, { yes: approveAll, interactive: true });
  const resolvePath = createPathResolver({ workspace, permissions, approvals, getMode: () => "build" });
  return {
    workspace,
    permissions,
    mode: "build",
    signal: new AbortController().signal,
    logger: { log() {}, info() {}, debug() {}, warn() {}, error() {} },
    todos: new TodoStore(),
    resolvePath,
    confirm: (req, opts) => approvals.confirm(req, opts),
    confirmSensitive: (req) => approvals.requestSensitiveAccess(req),
  };
}

describe("McpClient (transport stdio)", () => {
  const clients: McpClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  });

  it("initialize + tools/list mengikuti paginasi dan memvalidasi skema", async () => {
    const client = await McpClient.connect(makeConfig());
    clients.push(client);
    expect(client.info.name).toBe("mock-mcp");
    expect(client.info.version).toBe("1.2.3");
    expect(client.info.protocolVersion).toBe("2025-03-26");

    const tools = await client.listTools();
    expect(tools).toHaveLength(2);
    const echo = tools.find((tool) => tool.name === "echo");
    expect(echo?.description).toBe("Ulangi teks masukan.");
    expect(echo?.inputSchema.properties).toEqual({
      text: { type: "string", description: "Teks yang diulang" },
    });
    expect(tools.find((tool) => tool.name === "delete_table")).toBeDefined();
  });

  it("tools/call mengembalikan konten teks", async () => {
    const client = await McpClient.connect(makeConfig());
    clients.push(client);
    const result = await client.callTool("echo", { text: "halo" });
    expect(result.isError).toBe(false);
    expect(result.content).toBe("echo:halo");
  });

  it("tools/call menandai isError dari server", async () => {
    const client = await McpClient.connect(makeConfig());
    clients.push(client);
    const result = await client.callTool("broken", {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("gagal");
  });

  it("error protokol diteruskan sebagai error (tidak crash)", async () => {
    const client = await McpClient.connect(makeConfig());
    clients.push(client);
    await expect(client.callTool("nope", {})).rejects.toThrow(/Unknown tool: nope/);
  });

  it("gagal bila command tidak ada (spawn error)", async () => {
    await expect(McpClient.connect(makeConfig({ command: "perintah-tak-ada-xyz" }))).rejects.toThrow();
  });
});

describe("McpManager", () => {
  let dir: string;
  let registry: ToolRegistry;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "nex-mcp-manager-"));
    registry = new ToolRegistry();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function writePlugins(entry: unknown): Promise<void> {
    await fs.writeFile(path.join(dir, "plugins.json"), JSON.stringify({ mcp: entry }), "utf8");
  }

  it("menghubungkan server, mendaftarkan tool dengan risk, dan membersihkan saat stop", async () => {
    await writePlugins({
      mock: { transport: "stdio", command: process.execPath, args: [MOCK_SERVER] },
    });
    const manager = new McpManager({ configDir: dir, logger: nullLogger });
    await manager.start(registry);

    expect(registry.get("mcp__mock__echo")?.risk).toBe("read");
    expect(registry.get("mcp__mock__delete_table")?.risk).toBe("mutate"); // heuristik

    const status = manager.status();
    expect(status).toHaveLength(1);
    expect(status[0]!.name).toBe("mock");
    expect(status[0]!.connected).toBe(true);
    expect(status[0]!.transport).toBe("stdio");
    expect(status[0]!.tools).toBe(2);
    expect(status[0]!.registered).toContain("mcp__mock__echo");

    await manager.stop();
    expect(registry.get("mcp__mock__echo")).toBeUndefined();
    expect(registry.get("mcp__mock__delete_table")).toBeUndefined();
  });

  it("tool mutating tidak diekspos ke model di mode Plan", async () => {
    await writePlugins({
      mock: { transport: "stdio", command: process.execPath, args: [MOCK_SERVER] },
    });
    const manager = new McpManager({ configDir: dir, logger: nullLogger });
    await manager.start(registry);

    const plan = registry.specs("plan").map((spec) => spec.name);
    expect(plan).toContain("mcp__mock__echo");
    expect(plan).not.toContain("mcp__mock__delete_table");

    const build = registry.specs("build").map((spec) => spec.name);
    expect(build).toContain("mcp__mock__delete_table");

    await manager.stop();
  });

  it("server yang gagal dijalankan tercatat sebagai error, tidak menggagalkan sisanya", async () => {
    await writePlugins({
      gagal: { transport: "stdio", command: "perintah-tak-ada-xyz" },
      mock: { transport: "stdio", command: process.execPath, args: [MOCK_SERVER] },
    });
    const manager = new McpManager({ configDir: dir, logger: nullLogger });
    await manager.start(registry);

    expect(registry.get("mcp__mock__echo")).toBeDefined();
    const byName = (name: string) => manager.status().find((s) => s.name === name);
    expect(byName("gagal")?.connected).toBe(false);
    expect(byName("gagal")?.error).toBeDefined();
    expect(byName("mock")?.connected).toBe(true);

    await manager.stop();
  });

  it("template rahasia yang tak terpenuhi → status error (fail closed)", async () => {
    await writePlugins({
      mock: {
        transport: "stdio",
        command: process.execPath,
        args: [MOCK_SERVER],
        env: { TOKEN: "${apiKey}" },
      },
    });
    const manager = new McpManager({ configDir: dir, logger: nullLogger });
    await manager.start(registry);
    expect(manager.status()[0]!.connected).toBe(false);
    expect(manager.status()[0]!.error).toContain("apiKey");
  });

  it("reload memutuskan lalu menghubungkan ulang", async () => {
    await writePlugins({
      mock: { transport: "stdio", command: process.execPath, args: [MOCK_SERVER] },
    });
    const manager = new McpManager({ configDir: dir, logger: nullLogger });
    await manager.start(registry);
    expect(registry.get("mcp__mock__echo")).toBeDefined();

    await manager.reload(registry);
    expect(manager.status()).toHaveLength(1);
    expect(manager.status()[0]!.connected).toBe(true);
    expect(registry.get("mcp__mock__echo")).toBeDefined();

    await manager.stop();
    expect(registry.get("mcp__mock__echo")).toBeUndefined();
  });

  it("tool interaktif: mutate butuh persetujuan, read langsung jalan (end-to-end)", async () => {
    await writePlugins({
      mock: { transport: "stdio", command: process.execPath, args: [MOCK_SERVER] },
    });
    const manager = new McpManager({ configDir: dir, logger: nullLogger });
    await manager.start(registry);

    const deleteTool = registry.get("mcp__mock__delete_table")!;
    await expect(deleteTool.execute({ name: "users" }, makeContext(dir, false))).rejects.toThrow(
      /Pengguna menolak/,
    );

    const denied = registry.get("mcp__mock__delete_table")!;
    const result = await denied.execute({ name: "users" }, makeContext(dir, true));
    expect(result.ok).toBe(true);
    expect(result.content).toContain("deleted:users");

    const readTool = registry.get("mcp__mock__echo")!;
    const readResult = await readTool.execute({ text: "test" }, makeContext(dir, false));
    expect(readResult.content).toBe("echo:test");

    await manager.stop();
  });

  it("kredensial dari CredentialStore diteruskan ke env server (rahasia dalam proses, bukan config)", async () => {
    const credentials = new CredentialStore(dir);
    await credentials.set("myapi", { apiKey: "kunci-proses" });
    await writePlugins({
      env: {
        transport: "stdio",
        command: process.execPath,
        args: [ENV_SERVER],
        credential: "myapi",
        env: { API_TOKEN: "${apiKey}" },
      },
    });
    const manager = new McpManager({ configDir: dir, credentials, logger: nullLogger });
    await manager.start(registry);

    const tool = registry.get("mcp__env__show_env")!;
    const result = await tool.execute({ var: "API_TOKEN" }, makeContext(dir, false));
    expect(result.content).toContain("kunci-proses");

    await manager.stop();
    await fs.rm(path.join(dir, "credentials.json"), { force: true });
  });
});