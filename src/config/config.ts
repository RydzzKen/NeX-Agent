import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WebSearchProvider } from "../util/websearch.js";

export function configDir(): string {
  return process.env.AGENT_CONFIG_DIR ?? path.join(os.homedir(), ".config", "agent");
}

export function sessionsDir(): string {
  return path.join(configDir(), "sessions");
}

export function logsDir(): string {
  return path.join(configDir(), "logs");
}

/** Pengaturan jembatan Telegram (bot). */
export interface TelegramConfig {
  /** Token bot dari BotFather. Tidak pernah dicetak (disamarkan sebagai ***). */
  token?: string;
  /** Base URL Bot API; default https://api.telegram.org (bisa diarahkan ke proxy lokal). */
  apiBase?: string;
  /** Daftar chat id yang boleh memakai bot. Kosong = terbuka untuk siapa pun. */
  allowedChatIds?: Array<string | number>;
  /** Aktifkan jembatan saat server berjalan (default true bila token tersedia). */
  enabled?: boolean;
}

/** Antarmuka interaktif default saat `agent` dijalankan tanpa tujuan. */
export type DefaultInterface = "cli" | "tui";

export interface AgentConfig {
  /** Batas langkah default bila tidak diberikan lewat flag. */
  maxSteps?: number;
  /** Anggaran default per tugas (USD). */
  maxCost?: number;
  /** Tampilkan thinking (default true). */
  thinking?: boolean;
  /** Render markdown pada jawaban model (default true). */
  markdown?: boolean;
  /** Animasi mengetik pada jawaban model (default true). */
  typewriter?: boolean;
  /** Muat skill dari SKILL.md (default true). */
  skills?: boolean;
  /** Provider default. */
  defaultProvider?: string;
  /** Tema TUI: "opencode" (default) atau "mint". */
  theme?: "opencode" | "mint";
  /**
   * Antarmuka default saat `agent` dijalankan tanpa tujuan: "cli" (readline)
   * atau "tui" (layar penuh). Kosong = "cli".
   */
  defaultInterface?: DefaultInterface;
  /**
   * Keybind TUI yang dapat diubah, mis. `{ "mode": "tab", "details": "ctrl+o" }`.
   * Nilai memakai nama tombol readline (`tab`, `ctrl+g`, `shift+tab`, `f2`).
   */
  tuiKeybinds?: { mode?: string; details?: string };
  /** Model terakhir per workspace (key = path absolut root). */
  models?: Record<string, string>;
  /**
   * Nama model custom (non-bawaan) yang pernah dipilih pengguna, disimpan
   * sebagai riwayat supaya bisa dipilih ulang dari `/models` tanpa ketik ulang.
   */
  recentCustomModels?: string[];
  /**
   * Model fallback global (pilihan terakhir lintas workspace). Dipakai bila
   * workspace belum punya model sendiri, sehingga pindah folder tidak perlu
   * memilih model ulang. Hanya dipakai bila valid untuk provider aktif.
   */
  defaultModel?: string;
  /**
   * Tampilkan diff sebagai preview walau konfirmasi disetujui otomatis
   * (allow-all/--yes). Default aktif; matikan lewat `/diff-auto off`.
   */
  showDiffOnAutoApprove?: boolean;
  /** URL layanan pencarian web opsional. */
  searchUrl?: string;
  /** Backend pencarian: "duckduckgo" (default), "searxng", atau "brave". */
  searchProvider?: WebSearchProvider;
  /** Host bind server web (`nex-agent serve`). Default 127.0.0.1. */
  webHost?: string;
  /** Port server web. Kosong/0 = port acak. */
  webPort?: number;
  /** Jembatan Telegram yang aktif otomatis saat server web berjalan. */
  telegram?: TelegramConfig;
}

async function readConfig(): Promise<AgentConfig> {
  try {
    const raw = await fs.readFile(path.join(configDir(), "config.json"), "utf8");
    return JSON.parse(raw) as AgentConfig;
  } catch {
    return {};
  }
}

export async function loadConfig(): Promise<AgentConfig> {
  return readConfig();
}

export async function saveConfig(patch: Partial<AgentConfig>): Promise<AgentConfig> {
  const current = await readConfig();
  const merged: AgentConfig = { ...current, ...patch, models: { ...current.models, ...patch.models } };
  await fs.mkdir(configDir(), { recursive: true });
  await fs.writeFile(path.join(configDir(), "config.json"), JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

/**
 * Ingat model untuk sebuah workspace, sekaligus jadikan model global terakhir
 * (defaultModel) agar pindah folder tidak memaksa memilih ulang.
 */
export async function rememberModel(workspaceRoot: string, model: string): Promise<void> {
  await saveConfig({ models: { [workspaceRoot]: model }, defaultModel: model });
}

/** Jumlah maksimum nama custom model yang disimpan sebagai riwayat. */
const MAX_RECENT_CUSTOM_MODELS = 20;

/**
 * Catat nama model custom (non-bawaan) yang dipilih pengguna agar bisa dipilih
 * ulang dari `/models`. Dedupe (case-insensitive) dan simpan yang terbaru dulu.
 */
export async function rememberCustomModel(name: string): Promise<void> {
  const clean = name.trim();
  if (!clean) return;
  const current = await readConfig();
  const prev = current.recentCustomModels ?? [];
  const next = [clean, ...prev.filter((m) => m.toLowerCase() !== clean.toLowerCase())].slice(
    0,
    MAX_RECENT_CUSTOM_MODELS,
  );
  await saveConfig({ recentCustomModels: next });
}

/** Daftar nama custom model yang pernah dipakai (terbaru dulu). */
export async function listRecentCustomModels(): Promise<string[]> {
  const config = await readConfig();
  return config.recentCustomModels ?? [];
}

/** Hapus semua riwayat custom model. */
export async function clearRecentCustomModels(): Promise<void> {
  await saveConfig({ recentCustomModels: [] });
}
