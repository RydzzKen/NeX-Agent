import { configDir } from "../config/config.js";
import { hasMcpServer, isValidMcpServerName, McpConfigError, saveMcpServer, type RawMcpServer } from "./config.js";

/**
 * Preset server MCP siap pakai untuk `/mcp add <preset>`.
 *
 * Preset hanya menulis *referensi* rahasia (template `${apiKey}`), bukan
 * nilainya: token tetap tersimpan di `CredentialStore` lewat `/mcp key <nama>`.
 * Ini menjaga janji "kredensial tidak pernah ditulis ke `plugins.json`".
 */

export interface McpPreset {
  /** Nama default server di `plugins.json`. */
  name: string;
  /** Deskripsi satu baris untuk daftar `/mcp add`. */
  description: string;
  /** Langkah lanjutan opsional (mis. perintah menyiapkan kredensial). */
  note?: string;
  config: RawMcpServer;
}

export const MCP_PRESETS: Record<string, McpPreset> = {
  context7: {
    name: "context7",
    description: "Dokumentasi library & API terbaru (HTTP, read-only, ringan)",
    note:
      "Tanpa API key tetap jalan dengan limit rendah. Untuk limit lebih tinggi: /mcp key context7, " +
      'lalu tambahkan headers { CONTEXT7_API_KEY: "${apiKey}" } + credential "context7".',
    config: {
      transport: "http",
      url: "https://mcp.context7.com/mcp",
      risk: "read",
    },
  },
  playwright: {
    name: "playwright",
    description: "Otomasi browser via Playwright MCP (headless)",
    note:
      "Berat: butuh Node + Chromium (`npx playwright install chromium`). " +
      "Semua aksi halaman = mutate (perlu persetujuan). Tidak cocok untuk Termux.",
    config: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest", "--headless"],
      risk: "mutate",
    },
  },
  supabase: {
    name: "supabase",
    description: "Kelola project Supabase (butuh Personal Access Token)",
    note: "Setel token dulu: /mcp key supabase (token dari dashboard Supabase).",
    config: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@supabase/mcp-server-supabase@latest"],
      env: { SUPABASE_ACCESS_TOKEN: "${apiKey}" },
      credential: "supabase",
      risk: "read",
    },
  },
};

/** Cari preset berdasarkan alias (tidak peduli huruf besar-kecil/spasi). */
export function findMcpPreset(alias: string): McpPreset | undefined {
  return MCP_PRESETS[alias.trim().toLowerCase()];
}

/** Semua preset, terurut berdasarkan nama. */
export function listMcpPresets(): McpPreset[] {
  return Object.values(MCP_PRESETS).sort((a, b) => a.name.localeCompare(b.name));
}

export interface AddedMcpPreset {
  serverName: string;
  preset: McpPreset;
}

/**
 * Tulis preset ke `plugins.json`. Gagal bila alias tidak dikenal, nama tidak
 * valid, atau nama sudah dipakai (agar tidak menimpa konfigurasi pengguna).
 */
export async function addMcpPreset(
  alias: string,
  name?: string,
  dir: string = configDir(),
): Promise<AddedMcpPreset> {
  const preset = findMcpPreset(alias);
  if (!preset) {
    const known = listMcpPresets()
      .map((item) => item.name)
      .join(", ");
    throw new McpConfigError(`Preset tidak dikenal: ${alias}. Tersedia: ${known}.`);
  }

  const serverName = name?.trim() || preset.name;
  if (!isValidMcpServerName(serverName)) {
    throw new McpConfigError(`Nama server tidak valid: ${serverName}.`);
  }
  if (await hasMcpServer(serverName, dir)) {
    throw new McpConfigError(
      `Server "${serverName}" sudah ada di plugins.json. Hapus dulu: /mcp remove ${serverName}.`,
    );
  }

  await saveMcpServer(serverName, preset.config, dir);
  return { serverName, preset };
}
