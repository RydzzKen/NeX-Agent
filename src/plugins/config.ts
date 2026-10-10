import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ProviderCredentials } from "../providers/provider.js";
import { configDir } from "../config/config.js";

/**
 * Konfigurasi plugin MCP (`plugins.json` di direktori konfigurasi).
 *
 * File ini hanya berisi *referensi* rahasia, bukan nilai rahasia: nilai nyata
 * diambil dari `CredentialStore` (`credentials.json`, izin 600) atau variabel
 * lingkungan lewat template `${apiKey}`, `${baseURL}`, `${VAR_LINGKUNGAN}`.
 * Kredensial tidak pernah ditulis ke sini, ke log, atau ke layar.
 */

export type McpTransport = "stdio" | "http" | "sse";

export interface McpToolOverride {
  /** Paksa klasifikasi risiko untuk satu tool (menang atas heuristik). */
  risk?: "read" | "mutate";
  enabled?: boolean;
}

export interface McpServerConfig {
  /** Nama server (unik, kunci di berkas). */
  name: string;
  transport: McpTransport;
  /** Transport stdio: perintah untuk dijalankan (mis. `npx -y ...`). */
  command?: string;
  args: string[];
  env: Record<string, string>;
  /** Transport http/sse: endpoint dasar. */
  url?: string;
  headers: Record<string, string>;
  /** Kunci di CredentialStore yang menyediakan `${apiKey}`/`${baseURL}`. */
  credential?: string;
  enabled: boolean;
  /**
   * Baseline klasifikasi risiko default `read`. Tool dengan nama yang jelas
   * mutating tetap naik ke `mutate` (perlu persetujuan) kecuali ditimpa per
   * tool lewat `tools`.
   */
  risk?: "read" | "mutate";
  tools: Record<string, McpToolOverride>;
  /** Timeout initialize & panggilan tool (ms). Default 60.000. */
  timeoutMs?: number;
}

export interface PluginsConfig {
  servers: Record<string, McpServerConfig>;
  /** Kesalahan per nama server (konfigurasi tidak valid untuk server itu). */
  errors: Record<string, string>;
  /** Gagal membaca atau mengurai berkas itu sendiri. */
  fileError?: string;
}

/** Salah konfigurasi plugin MCP (nama rahasia hilang, skema salah, ...). */
export class McpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpConfigError";
  }
}

const SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,48}$/;

// Skema beras (record of unknown) agar satu server rusak tidak mematikan yang lain.
const fileSchema = z.object({ mcp: z.record(z.unknown()).default({}) });

export const mcpServerSchema = z
  .object({
    transport: z.enum(["stdio", "http", "sse"]).default("stdio"),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string()).default({}),
    url: z.string().min(1).optional(),
    headers: z.record(z.string()).default({}),
    credential: z.string().min(1).optional(),
    enabled: z.boolean().default(true),
    risk: z.enum(["read", "mutate"]).optional(),
    tools: z
      .record(
        z.object({
          risk: z.enum(["read", "mutate"]).optional(),
          enabled: z.boolean().default(true),
        }),
      )
      .default({}),
    timeoutMs: z.number().int().positive().max(300_000).optional(),
  })
  .superRefine((value, ctx) => {
    const needsCommand = value.transport === "stdio";
    if (needsCommand && !value.command) {
      ctx.addIssue({
        code: "custom",
        message: "transport stdio memerlukan `command`",
        path: ["command"],
      });
    }
    if (!needsCommand && !value.url) {
      ctx.addIssue({
        code: "custom",
        message: `transport ${value.transport} memerlukan \`url\``,
        path: ["url"],
      });
    }
  });

export type RawMcpServer = z.input<typeof mcpServerSchema>;

/** Ringkas isu Zod menjadi satu baris (dipakai pesan error konfigurasi & MCP). */
export function formatZodIssues(error: z.ZodError): string {
  return error.issues.map((iss) => `${iss.path.join(".") || "(root)"}: ${iss.message}`).join("; ");
}

/** Muat `plugins.json`. Berkas hilang → konfigurasi kosong; rusak → `fileError`. */
export async function loadPluginsConfig(dir: string = configDir()): Promise<PluginsConfig> {
  const result: PluginsConfig = { servers: {}, errors: {} };

  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, "plugins.json"), "utf8");
  } catch {
    return result;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    result.fileError = `plugins.json bukan JSON valid: ${(err as Error).message}`;
    return result;
  }

  const fileParsed = fileSchema.safeParse(json);
  if (!fileParsed.success) {
    result.fileError = formatZodIssues(fileParsed.error);
    return result;
  }

  for (const [name, entry] of Object.entries(fileParsed.data.mcp)) {
    if (!SERVER_NAME_RE.test(name)) {
      result.errors[name] = `nama server tidak valid (${SERVER_NAME_RE.source})`;
      continue;
    }
    const parsed = mcpServerSchema.safeParse(entry);
    if (!parsed.success) {
      result.errors[name] = formatZodIssues(parsed.error);
      continue;
    }
    result.servers[name] = { name, ...parsed.data };
  }
  return result;
}

const TEMPLATE_RE = /\$\{([A-Za-z0-9_]+)\}/g;

function lookupSecret(
  name: string,
  targetKey: string,
  ctx: { credential?: ProviderCredentials; env?: NodeJS.ProcessEnv },
): string {
  if (name === "apiKey" && ctx.credential?.apiKey) return ctx.credential.apiKey;
  if (name === "baseURL" && ctx.credential?.baseURL) return ctx.credential.baseURL;
  const fromEnv = ctx.env?.[name];
  if (fromEnv) return fromEnv;
  const hint =
    name === "apiKey" || name === "baseURL"
      ? "Setel kredensialnya dulu lewat `/mcp key <nama>`."
      : `Setel variabel lingkungan \`${name}\`, atau gunakan template \${apiKey}/\${baseURL} dari CredentialStore.`;
  throw new McpConfigError(`Variabel rahasia \${${name}} pada "${targetKey}" tidak tersedia. ${hint}`);
}

/**
 * Ganti semua template `${nama}` pada peta nilai. `${apiKey}`/`${baseURL}`
 * berasal dari kredensial; nama lain dari variabel lingkungan. Template yang
 * tidak bisa dipenuhi membuat konfigurasi gagal (jangan kirim nilai kosong).
 */
export function resolveTemplates(
  values: Record<string, string>,
  ctx: { credential?: ProviderCredentials; env?: NodeJS.ProcessEnv },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(values)) {
    let expanded = "";
    let last = 0;
    for (const match of raw.matchAll(TEMPLATE_RE)) {
      expanded += raw.slice(last, match.index);
      expanded += lookupSecret(match[1]!, key, ctx);
      last = match.index + match[0].length;
    }
    expanded += raw.slice(last);
    out[key] = expanded;
  }
  return out;
}