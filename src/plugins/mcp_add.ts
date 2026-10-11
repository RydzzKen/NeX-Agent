import path from "node:path";
import { configDir } from "../config/config.js";
import { hasMcpServer, McpConfigError, saveMcpServer, type RawMcpServer } from "./config.js";
import { MCP_PRESETS, type McpPreset } from "./presets.js";

/**
 * Perencana `/mcp add`. Menerima token perintah dan menghasilkan konfigurasi
 * server MCP. Tiga bentuk yang didukung:
 *
 *   /mcp add <preset> [nama]                                       → preset bawaan
 *   /mcp add [--name <nama>] <command> [args...]                   → server stdio
 *   /mcp add --url <url> [--name <nama>] [--transport http|sse]    → server jarak jauh
 *
 * Parsing murni (`planMcpAdd`) dipisah dari efek samping (`applyMcpAdd`) agar
 * mudah diuji. Nama server yang ditebak otomatis boleh bentrok (diberi akhiran
 * `-2`, `-3`, ...), sedangkan nama eksplisit menolak menimpa server yang ada.
 */

export type McpAddTransport = "stdio" | "http" | "sse";

export interface McpAddPlan {
  kind: "preset" | "server";
  /** Alias preset (hanya untuk `kind: "preset"`). */
  presetAlias?: string;
  /** Catatan/langkah lanjutan preset. */
  presetNote?: string;
  serverName: string;
  /** Nama diberikan eksplisit lewat `--name`/argumen; bentrok → error. */
  explicitName: boolean;
  server: RawMcpServer;
}

const TRANSPORTS: readonly McpAddTransport[] = ["stdio", "http", "sse"];

/** Buang prefiks `@`, versi `@x.y.z`, ekstensi berkas, lalu sanitasi. */
export function sanitizeServerName(raw: string): string {
  return raw
    .trim()
    .replace(/^@+/, "")
    .replace(/\.(mjs|cjs|js|ts|json)$/i, "")
    .replace(/@[^/@]*$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/-+$/, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 48)
    .replace(/-+$/, "");
}

function deriveNameFromCommand(command: string, args: string[]): string {
  const positional = args.filter((arg) => arg.trim() !== "" && !arg.startsWith("-"));
  const source = positional.length > 0 ? positional[positional.length - 1]! : path.basename(command);
  return sanitizeServerName(source);
}

const URL_HOST_NOISE = new Set(["mcp", "api", "www", "docs", "com", "io", "dev", "app", "net", "org", "co"]);

function deriveNameFromUrl(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return "";
  }
  const labels = host.split(".").filter(Boolean);
  const meaningful = labels.filter((label) => !URL_HOST_NOISE.has(label));
  return sanitizeServerName(meaningful.length > 0 ? meaningful.join("-") : host);
}

/**
 * Ubah token `/mcp add` menjadi rencana. Melempar `McpConfigError` bila
 * kombinasi token tidak valid.
 */
export function planMcpAdd(tokens: string[], presets: Record<string, McpPreset> = MCP_PRESETS): McpAddPlan {
  let name: string | undefined;
  let url: string | undefined;
  let transport: McpAddTransport | undefined;

  let i = 0;
  for (; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "--") {
      i++;
      break;
    }
    if (!token.startsWith("--")) break;

    const eq = token.indexOf("=");
    const flag = eq === -1 ? token : token.slice(0, eq);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = tokens[i + 1];
      if (next === undefined) throw new McpConfigError(`Opsi ${flag} butuh nilai.`);
      i++;
      return next;
    };

    switch (flag) {
      case "--name":
        name = value();
        break;
      case "--url":
        url = value();
        break;
      case "--transport": {
        const v = value();
        if (!TRANSPORTS.includes(v as McpAddTransport)) {
          throw new McpConfigError(`--transport harus ${TRANSPORTS.join("|")} (bukan "${v}").`);
        }
        transport = v as McpAddTransport;
        break;
      }
      case "--sse":
        transport = "sse";
        break;
      case "--http":
        transport = "http";
        break;
      default:
        throw new McpConfigError(`Opsi tidak dikenal: ${flag}. Lihat /mcp add.`);
    }
  }

  const rest = tokens.slice(i);
  const explicit = Boolean(name?.trim());

  if (url !== undefined && url.trim() !== "") {
    const resolved = transport ?? "http";
    if (resolved === "stdio") throw new McpConfigError("--url tidak cocok dengan --transport stdio.");
    const serverName = name?.trim() || deriveNameFromUrl(url);
    if (!serverName) throw new McpConfigError("Tidak bisa menebak nama dari URL; pakai --name <nama>.");
    return { kind: "server", serverName, explicitName: explicit, server: { transport: resolved, url: url.trim() } };
  }

  if (rest.length === 0) {
    throw new McpConfigError("Tidak ada command. Contoh: /mcp add npx @playwright/mcp@latest");
  }

  const alias = rest[0]!.toLowerCase();
  const preset = Object.prototype.hasOwnProperty.call(presets, alias) ? presets[alias] : undefined;
  if (preset && rest.length <= 2) {
    const serverName = name?.trim() || rest[1]?.trim() || preset.name;
    return {
      kind: "preset",
      presetAlias: preset.name,
      ...(preset.note ? { presetNote: preset.note } : {}),
      serverName,
      explicitName: true,
      server: preset.config,
    };
  }

  const command = rest[0]!;
  const args = rest.slice(1);
  if (transport !== undefined && transport !== "stdio") {
    throw new McpConfigError(`--transport ${transport} hanya untuk --url; command selalu stdio.`);
  }
  const serverName = name?.trim() || deriveNameFromCommand(command, args);
  if (!serverName) throw new McpConfigError("Tidak bisa menebak nama server; pakai --name <nama>.");
  return { kind: "server", serverName, explicitName: explicit, server: { transport: "stdio", command, args } };
}

async function uniqueServerName(base: string, dir: string): Promise<string> {
  const stem = base.slice(0, 46);
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem}-${n}`;
    if (!(await hasMcpServer(candidate, dir))) return candidate;
  }
  throw new McpConfigError(`Terlalu banyak server bernama mirip "${base}".`);
}

/** Tulis rencana ke `plugins.json`. Mengembalikan nama server final. */
export async function applyMcpAdd(plan: McpAddPlan, dir: string = configDir()): Promise<string> {
  let serverName = plan.serverName;
  if (await hasMcpServer(serverName, dir)) {
    if (plan.explicitName) {
      throw new McpConfigError(
        `Server "${serverName}" sudah ada di plugins.json. Hapus dulu: /mcp remove ${serverName}.`,
      );
    }
    serverName = await uniqueServerName(serverName, dir);
  }
  await saveMcpServer(serverName, plan.server, dir);
  return serverName;
}
