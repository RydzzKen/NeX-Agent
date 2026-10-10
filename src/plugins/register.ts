import type { ToolRisk } from "../core/types.js";
import type { AnyTool } from "../tools/registry.js";
import { jsonSchemaToZod } from "../tools/json_to_zod.js";
import { ToolDeniedError } from "../tools/errors.js";
import type { McpServerConfig } from "./config.js";
import type { McpToolInfo } from "./mcp.js";

/**
 * Menerjemahkan tool MCP menjadi `ToolDefinition` yang bisa didaftarkan ke
 * `ToolRegistry`.
 *
 * Klasifikasi risiko (keputusan keamanan):
 * 1. `tools.<nama>.risk` di `plugins.json` — menang atas segalanya.
 * 2. `risk` per server — baseline default `read` (tool asing dianggap aman
 *    dulu, sesuai "default aman").
 * 3. Heuristik nama — tool dengan kata kerja destruktif (mis. `delete_row`)
 *    dinaikkan ke `mutate` agar tidak jalan tanpa persetujuan.
 *
 * Tool `mutate` diblokir di mode Plan (penegakan ada di loop) dan selalu
 * melewati `ctx.confirm` sebelum memanggil server.
 */

/** Prefiks penanda tool MCP sekaligus penghindar tabrakan dengan tool bawaan. */
export const MCP_TOOL_PREFIX = "mcp__";
/** Batas nama tool/fungsi di provider (mis. OpenAI: 64 karakter). */
export const MAX_TOOL_NAME_LENGTH = 64;

const MUTATING_VERBS = new Set([
  "add",
  "apply",
  "approve",
  "cancel",
  "clear",
  "commit",
  "create",
  "delete",
  "deploy",
  "destroy",
  "drop",
  "exec",
  "execute",
  "grant",
  "import",
  "insert",
  "install",
  "kill",
  "merge",
  "modify",
  "move",
  "patch",
  "post",
  "publish",
  "push",
  "put",
  "revoke",
  "rename",
  "remove",
  "reset",
  "run",
  "send",
  "set",
  "start",
  "stop",
  "submit",
  "terminate",
  "truncate",
  "uninstall",
  "update",
  "upload",
  "write",
]);

/** True bila nama tool mengandung kata kerja yang jelas menulis/mengubah state. */
export function isMutatingToolName(name: string): boolean {
  const tokens = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return tokens.some((token) => MUTATING_VERBS.has(token));
}

/** Tentukan risiko satu tool: override per tool > baseline server > heuristik. */
export function resolveToolRisk(tool: Pick<McpToolInfo, "name">, config: McpServerConfig): ToolRisk {
  const override = config.tools[tool.name]?.risk;
  if (override) return override;
  if (config.risk === "mutate") return "mutate";
  return isMutatingToolName(tool.name) ? "mutate" : "read";
}

function sanitizePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Nama tool pada provider. `undefined` bila hasilnya kosong atau melebihi
 * batas (nama terlalu panjang akan ditolak provider dan merusak seluruh
 * request, jadi tool dilewati saja).
 */
export function mcpToolName(server: string, tool: string): string | undefined {
  const cleanServer = sanitizePart(server);
  const cleanTool = sanitizePart(tool);
  if (!cleanServer || !cleanTool) return undefined;
  const name = `${MCP_TOOL_PREFIX}${cleanServer}__${cleanTool}`;
  return name.length <= MAX_TOOL_NAME_LENGTH ? name : undefined;
}

function shortValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value.length > 24 ? `${value.slice(0, 23)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.length} item]`;
  if (typeof value === "object") return "{…}";
  return String(value);
}

/** Ringkasan argumen untuk ditampilkan di layar (dipotong). */
export function summarizeArgs(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return "";
  const text = entries.map(([key, value]) => `${key}=${shortValue(value)}`).join(", ");
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/** Sumber pemanggilan yang dibutuhkan tool (memudahkan tes). */
export interface McpToolCaller {
  callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: { signal?: AbortSignal },
  ): Promise<{ content: string; isError: boolean }>;
}

export interface BuiltMcpTool {
  /** Definisi untuk didaftarkan ke `ToolRegistry`. */
  tool: AnyTool;
  /** Nama tool sesuai server (untuk pemanggilan). */
  mcpName: string;
  /** Nama tool pada provider. */
  registryName: string;
  risk: ToolRisk;
}

export interface BuildMcpToolsResult {
  tools: BuiltMcpTool[];
  skipped: Array<{ name: string; reason: string }>;
}

export function buildMcpTools(params: {
  server: string;
  config: McpServerConfig;
  client: McpToolCaller;
  tools: McpToolInfo[];
}): BuildMcpToolsResult {
  const { server, config, client } = params;
  const tools: BuiltMcpTool[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const used = new Set<string>();

  for (const info of params.tools) {
    if (config.tools[info.name]?.enabled === false) continue;

    const registryName = mcpToolName(server, info.name);
    if (!registryName) {
      skipped.push({
        name: info.name,
        reason: `nama provider melebihi ${MAX_TOOL_NAME_LENGTH} karakter atau tidak valid`,
      });
      continue;
    }
    if (used.has(registryName)) {
      skipped.push({ name: info.name, reason: `bentrok nama dengan tool lain (${registryName})` });
      continue;
    }

    const risk = resolveToolRisk(info, config);
    const mcpName = info.name;
    const tool: AnyTool = {
      name: registryName,
      description: info.description?.trim() || `Tool MCP dari server ${server}.`,
      risk,
      schema: jsonSchemaToZod(info.inputSchema),
      jsonSchema: info.inputSchema,
      summarize: (input) => summarizeArgs(input),
      async execute(input, ctx) {
        if (risk === "mutate") {
          const decision = await ctx.confirm({
            kind: "mcp",
            title: `Panggil tool MCP ${server}`,
            detail: `${mcpName}(${summarizeArgs(input)})`,
          });
          if (decision === "no") {
            throw new ToolDeniedError(`Pengguna menolak tool MCP: ${registryName}`, "tool MCP mutating");
          }
        }
        const args =
          typeof input === "object" && input !== null && !Array.isArray(input)
            ? (input as Record<string, unknown>)
            : {};
        const result = await client.callTool(mcpName, args, { signal: ctx.signal });
        return {
          content: result.content,
          ok: !result.isError,
          summary: `${server}/${mcpName}${result.isError ? " (error)" : ""}`,
        };
      },
    };

    used.add(registryName);
    tools.push({ tool, mcpName, registryName, risk });
  }

  return { tools, skipped };
}