import type { RawMcpServer } from "./config.js";

/**
 * Preset server MCP siap pakai untuk `/mcp add <preset>`.
 *
 * Preset hanya menulis *referensi* rahasia (template `${apiKey}`), bukan
 * nilainya: token tetap tersimpan di `CredentialStore` lewat `/mcp key <nama>`.
 * Ini menjaga janji "kredensial tidak pernah ditulis ke `plugins.json`".
 *
 * Logika penambahan (parsing token + menulis berkas) ada di `mcp_add.ts` agar
 * file ini murni berisi data preset.
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
  github: {
    name: "github",
    description: "Kelola repo/issue/PR GitHub (HTTP, read-only, butuh PAT)",
    note:
      "Setel token dulu: /mcp key github (Personal Access Token dari github.com/settings/tokens). " +
      'Default read-only (header X-MCP-Readonly: "true"). Untuk izin tulis, hapus header itu dari plugins.json.',
    config: {
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "Bearer ${apiKey}", "X-MCP-Readonly": "true" },
      credential: "github",
      risk: "read",
    },
  },
  "cloudflare-docs": {
    name: "cloudflare-docs",
    description: "Dokumentasi Cloudflare terbaru (HTTP, read-only, tanpa token)",
    config: {
      transport: "http",
      url: "https://docs.mcp.cloudflare.com/mcp",
      risk: "read",
    },
  },
  fetch: {
    name: "fetch",
    description: "Ambil halaman web & ubah ke Markdown (butuh uv/uvx + Python)",
    note:
      "Butuh `uv` (https://docs.astral.sh/uv). Alternatif Docker: " +
      "/mcp add --name fetch docker run -i --rm mcp/fetch",
    config: {
      transport: "stdio",
      command: "uvx",
      args: ["mcp-server-fetch"],
      risk: "read",
    },
  },
  filesystem: {
    name: "filesystem",
    description: "Akses folder via filesystem MCP (baca/tulis, perlu persetujuan)",
    note:
      "Default membuka folder kerja saat ini ('.'). Folder lain: " +
      "/mcp remove filesystem lalu /mcp add --name fs npx -y @modelcontextprotocol/server-filesystem /path/anda",
    config: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
      risk: "mutate",
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
