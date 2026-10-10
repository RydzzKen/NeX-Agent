import { z } from "zod";
import type { ProviderCredentials } from "../providers/provider.js";
import { JsonRpcConnection, type RpcTransport } from "./jsonrpc.js";
import { createStdioTransport } from "./stdio.js";
import { createHttpTransport } from "./http.js";
import { createSseTransport } from "./sse.js";
import { formatZodIssues, resolveTemplates, type McpServerConfig } from "./config.js";

/**
 * Klien MCP: inisialisasi sesi, daftar tool, dan panggil tool.
 *
 * Mendukung transport stdio (proses lokal) dan HTTP (Streamable HTTP maupun
 * HTTP+SSE lama). Semua balasan server divalidasi dengan Zod; kegagalan
 * protokol dikembalikan sebagai error agar loop agent mengembalikannya ke model,
 * bukan menjatuhkan sesi.
 */

/** Versi protokol MCP yang diminta; balasan server diterima apa adanya. */
export const MCP_PROTOCOL_VERSION = "2025-03-26";
export const MCP_CLIENT_NAME = "nex-agent";
/** Metadata klien yang dilaporkan ke server. */
export const MCP_CLIENT_VERSION = "0.1.0";

/** Timeout bawaan per panggilan (initialize, list, call). */
export const DEFAULT_MCP_TIMEOUT_MS = 60_000;

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  content: string;
  isError: boolean;
}

export interface McpServerInfo {
  name?: string;
  version?: string;
  protocolVersion?: string;
}

export interface McpConnectOptions {
  /** Kredensial dari CredentialStore untuk template `${apiKey}`/`${baseURL}`. */
  credential?: ProviderCredentials;
  /** Sumber variabel lingkungan (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Output stderr/diagnostik server (jangan simpan ke log). */
  onDiagnostic?: (text: string) => void;
  /** Override timeout global. */
  timeoutMs?: number;
}

const initializeResultSchema = z
  .object({
    protocolVersion: z.string().optional(),
    serverInfo: z.object({ name: z.string().optional(), version: z.string().optional() }).optional(),
  })
  .passthrough();

const toolsListResultSchema = z
  .object({
    tools: z.array(z.unknown()).default([]),
    nextCursor: z.string().optional(),
  })
  .passthrough();

const toolInfoSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: z.record(z.unknown()).optional(),
});

const contentItemSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    data: z.string().optional(),
    mimeType: z.string().optional(),
    resource: z.unknown().optional(),
  })
  .passthrough();

const callResultSchema = z
  .object({
    content: z.array(contentItemSchema).default([]),
    isError: z.boolean().optional(),
  })
  .passthrough();

type ContentItem = z.infer<typeof contentItemSchema>;

function renderContent(item: ContentItem): string {
  if (item.type === "text") return item.text ?? "";
  if (item.type === "image" || item.type === "audio") {
    // Jangan menyalin data biner ke konteks; cukup ukurannya.
    return `[${item.type} ${item.mimeType ?? "?"} — ${item.data?.length ?? 0} byte base64]`;
  }
  if (item.type === "resource") {
    const resource = item.resource as { text?: unknown; uri?: unknown } | undefined;
    if (resource && typeof resource.text === "string") return resource.text;
    if (resource && typeof resource.uri === "string") return `[resource ${resource.uri}]`;
    return JSON.stringify(item.resource ?? null);
  }
  return JSON.stringify(item);
}

export class McpClient {
  private constructor(
    private readonly conn: JsonRpcConnection,
    readonly info: McpServerInfo,
    private readonly timeoutMs: number,
  ) {}

  /** Buka koneksi, lakukan handshake `initialize`, dan ambil info server. */
  static async connect(config: McpServerConfig, opts: McpConnectOptions = {}): Promise<McpClient> {
    const timeoutMs = config.timeoutMs ?? opts.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
    const secretCtx = { credential: opts.credential, env: opts.env };
    const env = resolveTemplates(config.env, secretCtx);
    const headers = resolveTemplates(config.headers, secretCtx);

    let transport: RpcTransport;
    let ready: Promise<void> = Promise.resolve();
    if (config.transport === "stdio") {
      transport = createStdioTransport({
        command: config.command ?? "",
        args: config.args,
        env,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.onDiagnostic ? { onDiagnostic: opts.onDiagnostic } : {}),
      });
    } else if (config.transport === "http") {
      transport = createHttpTransport({
        url: config.url ?? "",
        headers,
        ...(opts.onDiagnostic ? { onDiagnostic: opts.onDiagnostic } : {}),
      });
    } else {
      const sse = createSseTransport({
        url: config.url ?? "",
        headers,
        endpointTimeoutMs: timeoutMs,
        ...(opts.onDiagnostic ? { onDiagnostic: opts.onDiagnostic } : {}),
      });
      transport = sse.transport;
      ready = sse.ready;
    }

    const conn = new JsonRpcConnection(transport, timeoutMs);
    try {
      await ready;
      const raw = await conn.request(
        "initialize",
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
        },
        { timeoutMs },
      );
      const parsed = initializeResultSchema.safeParse(raw);
      const info: McpServerInfo = parsed.success
        ? {
            ...(parsed.data.serverInfo?.name ? { name: parsed.data.serverInfo.name } : {}),
            ...(parsed.data.serverInfo?.version ? { version: parsed.data.serverInfo.version } : {}),
            ...(parsed.data.protocolVersion ? { protocolVersion: parsed.data.protocolVersion } : {}),
          }
        : {};
      conn.notify("notifications/initialized");
      return new McpClient(conn, info, timeoutMs);
    } catch (err) {
      await conn.close().catch(() => undefined);
      throw err;
    }
  }

  /** Daftar tool, mengikuti paginasi `nextCursor`. */
  async listTools(signal?: AbortSignal): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < 50; page++) {
      const raw = await this.conn.request("tools/list", cursor ? { cursor } : {}, {
        ...(signal ? { signal } : {}),
        timeoutMs: this.timeoutMs,
      });
      const parsed = toolsListResultSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(`Balasan tools/list tidak valid: ${formatZodIssues(parsed.error)}`);
      }
      for (const entry of parsed.data.tools) {
        const tool = toolInfoSchema.safeParse(entry);
        // Satu entri rusak tidak boleh menggugurkan seluruh daftar.
        if (!tool.success) continue;
        if (seen.has(tool.data.name)) continue;
        seen.add(tool.data.name);
        tools.push({
          name: tool.data.name,
          ...(tool.data.description ? { description: tool.data.description } : {}),
          inputSchema: tool.data.inputSchema ?? {},
        });
      }
      cursor = parsed.data.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<McpCallResult> {
    const raw = await this.conn.request(
      "tools/call",
      { name, arguments: args },
      { ...(opts.signal ? { signal: opts.signal } : {}), timeoutMs: opts.timeoutMs ?? this.timeoutMs },
    );
    const parsed = callResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Balasan tools/call tidak valid: ${formatZodIssues(parsed.error)}`);
    }
    const parts = parsed.data.content.map(renderContent).filter((part) => part.length > 0);
    return { content: parts.join("\n") || "(server tidak mengembalikan keluaran)", isError: Boolean(parsed.data.isError) };
  }

  close(): Promise<void> {
    return this.conn.close();
  }
}