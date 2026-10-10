import path from "node:path";
import { describe, expect, it } from "vitest";
import { Approvals } from "../src/core/approvals.js";
import { silentIO } from "../src/core/io.js";
import { TodoStore } from "../src/core/todos.js";
import { PermissionManager } from "../src/safety/permissions.js";
import { createPathResolver } from "../src/safety/policy.js";
import { createWorkspace } from "../src/safety/workspace.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolContext } from "../src/tools/types.js";
import type { McpServerConfig } from "../src/plugins/config.js";
import {
  buildMcpTools,
  isMutatingToolName,
  mcpToolName,
  resolveToolRisk,
} from "../src/plugins/register.js";

function makeConfig(partial: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: "srv",
    transport: "stdio",
    command: "node",
    args: [],
    env: {},
    headers: {},
    enabled: true,
    tools: {},
    ...partial,
  };
}

function makeContext(approveAll: boolean): ToolContext {
  const workspace = createWorkspace(path.resolve("."));
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

function mockCaller() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    async callTool(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return { content: `hasil:${name}`, isError: false };
    },
  };
}

describe("isMutatingToolName", () => {
  it("mendeteksi kata kerja yang jelas menulis/mengubah state", () => {
    expect(isMutatingToolName("delete_table")).toBe(true);
    expect(isMutatingToolName("execute_sql")).toBe(true);
    expect(isMutatingToolName("send_mail")).toBe(true);
    expect(isMutatingToolName("reset_password")).toBe(true);
  });

  it("tool read-only tetap read", () => {
    expect(isMutatingToolName("get_docs")).toBe(false);
    expect(isMutatingToolName("search_users")).toBe(false);
    expect(isMutatingToolName("browser_click")).toBe(false);
    expect(isMutatingToolName("resolve-library-id")).toBe(false);
  });
});

describe("resolveToolRisk", () => {
  const named = (name: string) => ({ name });

  it("default tool asing = read", () => {
    expect(resolveToolRisk(named("list_issues"), makeConfig())).toBe("read");
  });

  it("heuristik menaikkan tool bernama destruktif ke mutate", () => {
    expect(resolveToolRisk(named("delete_table"), makeConfig())).toBe("mutate");
  });

  it("baseline server `risk: mutate` berlaku untuk semua tool-nya", () => {
    expect(resolveToolRisk(named("list_issues"), makeConfig({ risk: "mutate" }))).toBe("mutate");
  });

  it("override per tool menang atas heuristik dan baseline", () => {
    const config = makeConfig({
      risk: "mutate",
      tools: { delete_table: { risk: "read", enabled: true } },
    });
    expect(resolveToolRisk(named("delete_table"), config)).toBe("read");
    expect(resolveToolRisk(named("list_issues"), config)).toBe("mutate");
  });
});

describe("mcpToolName", () => {
  it("memakai prefiks dan sanitasi karakter terlarang", () => {
    expect(mcpToolName("context7", "resolve-library-id")).toBe("mcp__context7__resolve-library-id");
    expect(mcpToolName("srv", "get.items")).toBe("mcp__srv__get_items");
  });

  it("mengembalikan undefined bila nama melebihi batas", () => {
    expect(mcpToolName("x".repeat(50), "y".repeat(40))).toBeUndefined();
  });
});

describe("buildMcpTools", () => {
  it("membangun tool dengan schema Zod (validasi) dan jsonSchema asli (provider)", () => {
    const inputSchema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };
    const { tools } = buildMcpTools({
      server: "srv",
      config: makeConfig(),
      client: mockCaller(),
      tools: [{ name: "add_item", description: "Tambah item.", inputSchema }],
    });
    const built = tools[0]!;
    expect(built.registryName).toBe("mcp__srv__add_item");
    expect(built.mcpName).toBe("add_item");
    expect(built.risk).toBe("mutate"); // heuristik "add"
    expect(built.tool.jsonSchema).toEqual(inputSchema);
    expect(built.tool.schema.safeParse({ name: "x" }).success).toBe(true);
    expect(built.tool.schema.safeParse({}).success).toBe(false);
  });

  it("tool yang dinonaktifkan dilewati; yang terlalu panjang tercatat", () => {
    const { tools, skipped } = buildMcpTools({
      server: "srv",
      config: makeConfig({ tools: { off: { enabled: false } } }),
      client: mockCaller(),
      tools: [
        { name: "off", inputSchema: {} },
        { name: "z".repeat(90), inputSchema: {} },
      ],
    });
    expect(tools).toHaveLength(0);
    expect(skipped).toHaveLength(1);
  });

  it("tool read dijalankan tanpa persetujuan", async () => {
    const caller = mockCaller();
    const { tools } = buildMcpTools({
      server: "srv",
      config: makeConfig(),
      client: caller,
      tools: [{ name: "get_info", inputSchema: { type: "object" } }],
    });
    const result = await tools[0]!.tool.execute({}, makeContext(false));
    expect(result.ok).toBe(true);
    expect(caller.calls).toHaveLength(1);
  });

  it("tool mutate wajib persetujuan: ditolak saat 'no', jalan saat disetujui", async () => {
    const caller = mockCaller();
    const { tools } = buildMcpTools({
      server: "srv",
      config: makeConfig(),
      client: caller,
      tools: [
        {
          name: "delete_row",
          inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
        },
      ],
    });
    const tool = tools[0]!.tool;

    await expect(tool.execute({ id: 1 }, makeContext(false))).rejects.toThrow(/Pengguna menolak/);
    expect(caller.calls).toHaveLength(0);

    const result = await tool.execute({ id: 1 }, makeContext(true));
    expect(result.ok).toBe(true);
    expect(result.content).toBe("hasil:delete_row");
    expect(caller.calls).toHaveLength(1);
    expect(caller.calls[0]!.args).toEqual({ id: 1 });
  });

  it("isError dari server → ok:false dan ringkasan menandai error", async () => {
    const { tools } = buildMcpTools({
      server: "srv",
      config: makeConfig(),
      client: {
        async callTool() {
          return { content: "gagal", isError: true };
        },
      },
      tools: [{ name: "get_info", inputSchema: {} }],
    });
    const result = await tools[0]!.tool.execute({}, makeContext(true));
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("error");
  });

  it("bisa didaftarkan, ditolak saat bentrok, dan dilepas dari ToolRegistry", () => {
    const registry = new ToolRegistry();
    const { tools } = buildMcpTools({
      server: "srv",
      config: makeConfig(),
      client: mockCaller(),
      tools: [{ name: "get_info", inputSchema: {} }],
    });
    const [tool] = tools;
    expect(registry.has("mcp__srv__get_info")).toBe(false);
    expect(registry.register(tool!.tool)).toBe(true);
    expect(registry.register(tool!.tool)).toBe(false); // tabrakan: tidak menimpa
    expect(registry.get("mcp__srv__get_info")?.risk).toBe("read");
    expect(registry.unregister("mcp__srv__get_info")).toBe(true);
    expect(registry.has("mcp__srv__get_info")).toBe(false);
  });
});