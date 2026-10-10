import { configDir } from "../config/config.js";
import type { CredentialStore } from "../config/credentials.js";
import { nullLogger, type Logger } from "../logging/logger.js";
import type { ToolRegistry } from "../tools/registry.js";
import { loadPluginsConfig, type McpServerConfig, type McpTransport } from "./config.js";
import { McpClient } from "./mcp.js";
import { buildMcpTools } from "./register.js";

/**
 * Orkestrasi koneksi MCP untuk satu sesi: muat `plugins.json`, hubungkan tiap
 * server aktif, daftarkan tool-nya ke `ToolRegistry`, dan bersihkan saat tutup.
 *
 * Kegagalan satu server tidak pernah menjatuhkan sesi — hanya dicatat sebagai
 * status yang bisa dilihat lewat `/mcp`.
 */

export interface McpStatus {
  name: string;
  transport?: McpTransport;
  enabled: boolean;
  connected: boolean;
  /** Jumlah tool terdaftar ke registry. */
  tools: number;
  /** Nama tool pada provider (prefiks `mcp__`). */
  registered: string[];
  /** Nama kredensial yang dipakai (bukan nilainya). */
  credential?: string;
  error?: string;
}

export interface McpManagerOptions {
  /** Penyimpan kredensial (rahasia tool server). */
  credentials?: CredentialStore;
  logger?: Logger;
  /** Direktori konfigurasi; default `configDir()`. */
  configDir?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

interface McpEntry {
  client: McpClient;
  registered: string[];
}

export class McpManager {
  private readonly logger: Logger;
  private registry?: ToolRegistry;
  private readonly entries = new Map<string, McpEntry>();
  private readonly statuses = new Map<string, McpStatus>();
  private fileError?: string;

  constructor(private readonly opts: McpManagerOptions = {}) {
    this.logger = opts.logger ?? nullLogger;
  }

  /** Kesalahan pembacaan `plugins.json` (kosong bila tak ada masalah). */
  configFileError(): string | undefined {
    return this.fileError;
  }

  /** Hubungkan semua server aktif dan daftarkan tool-nya. */
  async start(registry: ToolRegistry): Promise<void> {
    this.registry = registry;
    const config = await loadPluginsConfig(this.opts.configDir ?? configDir());
    this.fileError = config.fileError;
    if (config.fileError) this.logger.warn("mcp.config_error", { error: config.fileError });

    for (const [name, error] of Object.entries(config.errors)) {
      this.statuses.set(name, {
        name,
        enabled: true,
        connected: false,
        tools: 0,
        registered: [],
        error,
      });
      this.logger.warn("mcp.server_config_error", { server: name, error });
    }

    for (const server of Object.values(config.servers)) {
      if (!server.enabled) {
        this.statuses.set(server.name, {
          name: server.name,
          transport: server.transport,
          enabled: false,
          connected: false,
          tools: 0,
          registered: [],
          ...(server.credential ? { credential: server.credential } : {}),
        });
        continue;
      }
      await this.connectOne(server, registry);
    }
  }

  private async connectOne(config: McpServerConfig, registry: ToolRegistry): Promise<void> {
    const status: McpStatus = {
      name: config.name,
      transport: config.transport,
      enabled: true,
      connected: false,
      tools: 0,
      registered: [],
      ...(config.credential ? { credential: config.credential } : {}),
    };
    this.statuses.set(config.name, status);

    try {
      const credential =
        this.opts.credentials && config.credential
          ? await this.opts.credentials.get(config.credential)
          : undefined;
      const client = await McpClient.connect(config, {
        ...(credential ? { credential } : {}),
        env: this.opts.env ?? process.env,
        ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
        // stderr server hanya untuk diagnostik; jangan pernah masuk log biasa.
        onDiagnostic: (text) => this.logger.debug("mcp.server_output", { server: config.name, detail: text }),
      });

      const infos = await client.listTools();
      const built = buildMcpTools({ server: config.name, config, client, tools: infos });
      const registered: string[] = [];
      for (const item of built.tools) {
        if (registry.register(item.tool)) registered.push(item.registryName);
        else this.logger.warn("mcp.tool_collision", { server: config.name, tool: item.registryName });
      }
      for (const skip of built.skipped) {
        this.logger.warn("mcp.tool_skipped", { server: config.name, tool: skip.name, reason: skip.reason });
      }

      this.entries.set(config.name, { client, registered });
      status.connected = true;
      status.tools = registered.length;
      status.registered = registered;
      this.logger.info("mcp.connected", { server: config.name, tools: registered.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      status.error = message;
      this.logger.warn("mcp.connect_failed", { server: config.name, error: message });
    }
  }

  /** Muat ulang konfigurasi: putuskan semua, lalu hubungkan ulang. */
  async reload(registry?: ToolRegistry): Promise<void> {
    const target = registry ?? this.registry;
    await this.stop();
    if (target) await this.start(target);
  }

  /** Putuskan semua server dan lepas tool-nya dari registry. */
  async stop(): Promise<void> {
    const entries = [...this.entries.entries()];
    this.entries.clear();
    this.statuses.clear();
    this.fileError = undefined;
    for (const [name, entry] of entries) {
      if (this.registry) for (const toolName of entry.registered) this.registry.unregister(toolName);
      await entry.client.close().catch(() => undefined);
      this.logger.info("mcp.disconnected", { server: name });
    }
  }

  status(): McpStatus[] {
    return [...this.statuses.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}