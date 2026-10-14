import fs from "node:fs/promises";
import path from "node:path";
import type {
  ConfirmRequest,
  PathAccessRequest,
  SensitiveAccessRequest,
} from "../core/io.js";
import { configDir, type AgentConfig } from "../config/config.js";
import {
  describeUpdate,
  describeUpdateAvailable,
  describeUpdateSuccess,
  runUpdate,
  type UpdateOutcome,
} from "../cli/update.js";
import type { ServerMessage } from "./protocol.js";
import {
  TELEGRAM_MAX_ENTITIES,
  countHtmlEntities,
  htmlToPlainText,
  renderTelegramChunks,
} from "./telegram_markdown.js";
import { formatErrorMessage } from "../util/errors.js";

/**
 * Jembatan Telegram memakai Bot API lewat `fetch` (tanpa dependensi baru) dan
 * long polling `getUpdates` (tidak perlu URL publik). Bot dimulai bersama
 * server web dan berhenti saat server berhenti.
 */

/** Pengaturan efektif setelah digabung dengan variabel lingkungan. */
export interface TelegramSettings {
  token: string;
  apiBase: string;
  allowedChatIds: string[];
  /** true bila allowlist kosong (siapa pun boleh). */
  open: boolean;
}

const DEFAULT_API_BASE = "https://api.telegram.org";

/** Lokasi penyimpanan token bot (izin 600, terpisah dari config.json). */
export function telegramSecretPath(dir: string = configDir()): string {
  return path.join(dir, "telegram.json");
}

/**
 * Baca token bot dari penyimpanan aman. `undefined` bila belum ada. Token
 * disimpan di berkas sendiri dengan izin 600 agar tidak pernah masuk config.json
 * biasa (yang izinnya lebih longgar) atau log.
 */
export async function loadTelegramToken(dir: string = configDir()): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(telegramSecretPath(dir), "utf8");
    const parsed = JSON.parse(raw) as { token?: unknown };
    return typeof parsed.token === "string" && parsed.token.trim() ? parsed.token.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Simpan token bot ke berkas aman (izin 600). */
export async function saveTelegramToken(token: string, dir: string = configDir()): Promise<void> {
  const file = telegramSecretPath(dir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ token }, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.chmod(file, 0o600).catch(() => undefined);
}

/** Hapus token bot yang tersimpan. */
export async function clearTelegramToken(dir: string = configDir()): Promise<void> {
  await fs.rm(telegramSecretPath(dir), { force: true });
}

/**
 * Gabungkan konfigurasi dengan env dan token aman. Prioritas token:
 * `TELEGRAM_BOT_TOKEN` (env) → berkas aman `telegram.json` → `config.telegram.token`.
 * Mengembalikan undefined bila tidak ada token atau jembatan dinonaktifkan.
 */
export function resolveTelegramSettings(
  config: AgentConfig,
  env: NodeJS.ProcessEnv = process.env,
  secureToken?: string,
): TelegramSettings | undefined {
  const telegram = config.telegram;
  if (telegram?.enabled === false) return undefined;
  const token = (env.TELEGRAM_BOT_TOKEN ?? secureToken ?? telegram?.token ?? "").trim();
  if (!token) return undefined;
  const apiBase = (env.TELEGRAM_API_BASE ?? telegram?.apiBase ?? DEFAULT_API_BASE)
    .trim()
    .replace(/\/+$/, "");
  const allowedChatIds = (telegram?.allowedChatIds ?? []).map((id) => String(id).trim()).filter(Boolean);
  return { token, apiBase, allowedChatIds, open: allowedChatIds.length === 0 };
}

/** Samarkan token agar aman ditampilkan (mis. `1234:***`). */
export function maskToken(token: string): string {
  if (token.length <= 8) return "***";
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

/** Hapus kode ANSI agar tidak tampil sebagai sampah di Telegram. */
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/** Batas panjang satu pesan Telegram. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/** Potong teks menjadi beberapa bagian <= limit, mengutamakan batas baris. */
export function chunkText(text: string, limit = 4000): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed ? [trimmed] : [];
  const chunks: string[] = [];
  let rest = trimmed;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut <= 0) cut = rest.lastIndexOf(" ", limit);
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Format prompt konfirmasi untuk dikirim ke Telegram. */
export function formatConfirmPrompt(request: ConfirmRequest): string {
  const lines = [`🔐 Butuh konfirmasi (${request.kind}): ${request.title}`, request.detail];
  if (request.irreversible) lines.push("⚠️ Aksi ini tidak bisa dibatalkan.");
  if (request.diff) lines.push("", chunkText(stripAnsi(request.diff), 1500)[0] ?? "");
  lines.push("", "Balas: y = setuju · n = tolak · a = setuju semua");
  return lines.filter((line) => line !== "").join("\n");
}

/** Format permintaan akses path di luar workspace. */
export function formatPathPrompt(request: PathAccessRequest): string {
  return [
    `📁 Izin akses ${request.access} di luar workspace:`,
    request.path,
    ...(request.reason ? [`Alasan: ${request.reason}`] : []),
    "",
    "Balas: y = izinkan · n = tolak",
  ].join("\n");
}

/** Format permintaan akses file/perintah sensitif. */
export function formatSensitivePrompt(request: SensitiveAccessRequest): string {
  return [
    `🔑 Akses ${request.kind} menyentuh data sensitif:`,
    request.detail,
    `Alasan: ${request.reason}`,
    "",
    "Balas: y = izinkan · n = tolak",
  ].join("\n");
}

const YES = new Set(["y", "ya", "yes", "yaa", "yaa", "setuju", "allow", "ok", "oke"]);
const NO = new Set(["n", "no", "tidak", "gak", "ga", "jangan", "deny", "tolak"]);
const ALL = new Set(["a", "all", "semua", "selalu"]);

export type ConfirmReply = "yes" | "no" | "all" | undefined;
export type BooleanReply = boolean | undefined;

/** Terjemahkan balasan teks menjadi keputusan konfirmasi. */
export function parseConfirmReply(text: string): ConfirmReply {
  const value = text.trim().toLowerCase();
  if (YES.has(value)) return "yes";
  if (NO.has(value)) return "no";
  if (ALL.has(value)) return "all";
  return undefined;
}

/** Terjemahkan balasan teks menjadi izin/tolak. */
export function parseBooleanReply(text: string): BooleanReply {
  const value = text.trim().toLowerCase();
  if (YES.has(value)) return true;
  if (NO.has(value)) return false;
  return undefined;
}

/** Satu update dari `getUpdates` (hanya bagian yang dipakai). */
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type?: string };
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
  };
}

/** Opsi pengiriman pesan (mis. mode parse HTML). */
export interface TelegramSendOptions {
  parseMode?: "HTML" | "MarkdownV2";
}

/** Bagian Bot API yang dipakai jembatan (memudahkan penggantian di tes). */
export interface TelegramClientLike {
  getMe(signal?: AbortSignal): Promise<{ id?: number; username?: string }>;
  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
  sendMessage(
    chatId: string,
    text: string,
    signal?: AbortSignal,
    options?: TelegramSendOptions,
  ): Promise<void>;
  sendChatAction(chatId: string, action: string, signal?: AbortSignal): Promise<void>;
  /** Daftarkan menu perintah (opsional; dipakai agar tombol "/" muncul). */
  setMyCommands?(commands: TelegramCommand[], signal?: AbortSignal): Promise<void>;
}

/** Satu entri menu perintah Telegram. */
export interface TelegramCommand {
  command: string;
  description: string;
}

/**
 * Daftar perintah yang didaftarkan lewat `setMyCommands` agar tombol "/" di
 * Telegram menampilkan menunya. Harus cocok dengan yang ditangani jembatan.
 */
export const TELEGRAM_COMMANDS: TelegramCommand[] = [
  { command: "start", description: "Mulai bot" },
  { command: "help", description: "Tampilkan bantuan" },
  { command: "new", description: "Mulai sesi baru" },
  { command: "clear", description: "Kosongkan riwayat sesi" },
  { command: "sessions", description: "Daftar sesi" },
  { command: "resume", description: "Lanjutkan sesi (nomor/id)" },
  { command: "rename", description: "Ganti judul sesi" },
  { command: "delete", description: "Hapus sesi ini" },
  { command: "plan", description: "Mode Plan (read-only)" },
  { command: "build", description: "Mode Build (eksekusi)" },
  { command: "mode", description: "Pindah mode (plan/build)" },
  { command: "allow_all", description: "Izinkan semua izin (on/off)" },
  { command: "stop", description: "Hentikan proses berjalan (sesi tetap tersimpan)" },
  { command: "interrupt", description: "Alias dari /stop" },
  { command: "status", description: "Status sesi & konfigurasi" },
  { command: "models", description: "Lihat/ganti model" },
  { command: "skills", description: "Daftar skill" },
  { command: "todos", description: "Daftar tugas" },
  { command: "usage", description: "Pemakaian token & biaya" },
  { command: "update", description: "Perbarui NeX-Agent dari repo git" },
  { command: "restart", description: "Jalankan ulang bot untuk menerapkan versi baru" },
];


/** Klien Bot API minimal. */
export class TelegramClient implements TelegramClientLike {
  private readonly apiBase: string;

  constructor(
    private readonly token: string,
    apiBase = DEFAULT_API_BASE,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.apiBase = apiBase.replace(/\/+$/, "");
  }

  private url(method: string): string {
    return `${this.apiBase}/bot${this.token}/${method}`;
  }

  private async call(method: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetchFn(this.url(method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    const json = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; description?: string };
    if (!response.ok || json.ok === false) {
      throw new Error(`Telegram ${method} gagal: ${json.description ?? `HTTP ${response.status}`}`);
    }
    return json.result;
  }

  /** Identitas bot; dipakai untuk memverifikasi token. */
  async getMe(signal?: AbortSignal): Promise<{ id?: number; username?: string }> {
    const result = await this.call("getMe", {}, signal);
    return (result ?? {}) as { id?: number; username?: string };
  }

  /** Ambil update baru; `timeoutSec` = long polling. */
  async getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    const result = await this.call(
      "getUpdates",
      { offset, timeout: timeoutSec, allowed_updates: ["message"] },
      signal,
    );
    return Array.isArray(result) ? (result as TelegramUpdate[]) : [];
  }

  async sendMessage(
    chatId: string,
    text: string,
    signal?: AbortSignal,
    options?: TelegramSendOptions,
  ): Promise<void> {
    await this.call(
      "sendMessage",
      {
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
        ...(options?.parseMode ? { parse_mode: options.parseMode } : {}),
      },
      signal,
    );
  }

  async sendChatAction(chatId: string, action: string, signal?: AbortSignal): Promise<void> {
    await this.call("sendChatAction", { chat_id: chatId, action }, signal).catch(() => undefined);
  }

  /** Daftarkan daftar perintah agar tombol "/" muncul di klien Telegram. */
  async setMyCommands(commands: TelegramCommand[], signal?: AbortSignal): Promise<void> {
    await this.call("setMyCommands", { commands }, signal);
  }
}

/** Bagian WebApp yang dipakai jembatan; dibuat minimal agar mudah diuji. */
export interface TelegramAgent {
  send(text: string): Promise<void> | void;
  interrupt?(): void;
  /** Hentikan tugas berjalan dan tunggu sampai benar-benar selesai (opsional). */
  stopRunning?(): Promise<void>;
  newSession?(): Promise<void> | void;
  isBusy?(): boolean;
  resolveApproval(id: string, value: unknown): boolean;
  clearHistory?(): Promise<void> | void;
  setMode?(mode: "plan" | "build"): Promise<void> | void;
  allowAll?(): boolean;
  setAllowAll?(value: boolean): void;
  describeStatus?(): string;
  listSessions?(): Promise<Array<{ id: string; title: string; updatedAt?: string }>>;
  openSession?(id: string): Promise<{ id: string } | undefined>;
  renameCurrent?(title: string): Promise<void> | void;
  deleteCurrent?(): Promise<void> | void;
  listSkills?(): Array<{ name: string; description: string }>;
  listTodos?(): Array<{ content: string; status: string }>;
  listModels?(): Promise<string[]>;
  setModel?(name: string): Promise<void> | void;
  usageSummary?(range: string): Promise<string>;
}

export interface TelegramBridgeDeps {
  app: TelegramAgent;
  /** Berlangganan pesan server; kembalikan fungsi untuk berhenti berlangganan. */
  subscribe(sink: (message: ServerMessage) => void): () => void;
  log?: (message: string) => void;
  /** Klien kustom (untuk tes). */
  client?: TelegramClientLike;
  /** Jalankan pembaruan mandiri; dapat diganti di tes. `check` hanya memeriksa. */
  update?: (log: (line: string) => void, options?: { check?: boolean }) => Promise<UpdateOutcome>;
  /** Jalankan ulang proses bot agar versi baru terpakai (dipasok oleh worker). */
  restart?: () => void;
}

/** Parse perintah Telegram dari teks pesan (murni). */
export interface ParsedCommand {
  name: string;
  args: string;
  mention?: string;
}

const COMMAND_RE = /^\/([A-Za-z0-9_-]+)(?:@(\S+))?(?:\s+([\s\S]*))?$/;

/** Normalisasi alias perintah (mis. `allow-all`/`allowall` → `allow_all`). */
export function normalizeCommandName(name: string): string {
  const lower = name.toLowerCase().replace(/-/g, "_");
  if (lower === "allowall") return "allow_all";
  return lower;
}

/**
 * Kenali `/perintah [argumen]` (dengan dukungan `/perintah@BotName`). Mengembalikan
 * undefined bila teks bukan perintah (mis. `/usr/bin` yang punya lebih dari satu
 * garis miring) agar pesan biasa tetap diteruskan ke agen.
 */
export function parseTelegramCommand(text: string, botUsername?: string): ParsedCommand | undefined {
  const match = COMMAND_RE.exec(text.trim());
  if (!match) return undefined;
  const name = normalizeCommandName(match[1] ?? "");
  if (!name) return undefined;
  const mention = match[2];
  if (mention && botUsername && mention.toLowerCase() !== botUsername.toLowerCase()) return undefined;
  return { name, args: (match[3] ?? "").trim(), ...(mention ? { mention } : {}) };
}

const HELP_TEXT = [
  "NeX-Agent bot siap. Kirim pesan biasa untuk memulai percakapan.",
  "",
  "Sesi:",
  "  /new — mulai sesi baru",
  "  /clear — kosongkan riwayat sesi ini",
  "  /sessions — daftar sesi (lalu /resume <nomor>)",
  "  /resume <nomor|id> — lanjutkan sesi",
  "  /rename <judul> — ganti judul sesi",
  "  /delete — hapus sesi ini",
  "",
  "Kontrol:",
  "  /plan · /build — pindah mode (read-only / eksekusi)",
  "  /allow-all [on|off] — izinkan semua izin (tanpa argumen = balik)",
  "  /stop — hentikan proses yang berjalan (sesi tetap tersimpan)",
  "  /status — workspace, mode, model, provider",
  "",
  "Info lain:",
  "  /models [nomor|nama] — lihat/ganti model",
  "  /skills — skill yang tersedia",
  "  /todos — daftar tugas",
  "  /usage [today|week|all] — pemakaian token & biaya",
  "  /update — perbarui NeX-Agent dari repo git",
  "  /restart — jalankan ulang bot untuk menerapkan versi baru",
  "  /help — bantuan ini",
  "",
  "Saat agent meminta izin, balas y (setuju), n (tolak), atau a (setuju semua).",
  "Catatan: /connect, /provider, /mcp, /permissions, /skill, dan /undo hanya di chat/terminal.",
].join("\n");

interface PendingApproval {
  id: string;
  kind: "confirm" | "path" | "sensitive";
  chatId: string;
}

/**
 * Jembatan dua arah antara satu sesi WebApp dan chat Telegram. Percakapan
 * berbagi sesi yang sama dengan web (sesuai pilihan), dan prompt persetujuan
 * diteruskan ke Telegram untuk dijawab `y`/`n`/`a`.
 */
export class TelegramBridge {
  private readonly client: TelegramClientLike;
  private offset = 0;
  private stopped = false;
  private readonly abort = new AbortController();
  private unsubscribe: (() => void) | undefined;
  private activeChatId: string | undefined;
  private botUsername: string | undefined;
  private textBuffer = "";
  private pending: PendingApproval | undefined;
  /** Chat yang sedang menunggu konfirmasi y/N sebelum menjalankan update. */
  private updateAsk: string | undefined;
  private sessionCache: Array<{ id: string; title: string; updatedAt?: string }> = [];
  private modelCache: string[] = [];
  private readonly polling: Promise<void>;

  constructor(
    private readonly settings: TelegramSettings,
    private readonly deps: TelegramBridgeDeps,
  ) {
    this.client = deps.client ?? new TelegramClient(settings.token, settings.apiBase);
    this.unsubscribe = deps.subscribe((message) => this.onServerMessage(message));
    this.polling = this.poll();
  }

  /** Apakah jembatan masih aktif (menerima pesan). */
  get active(): boolean {
    return !this.stopped;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe?.();
    this.abort.abort();
    await this.polling.catch(() => undefined);
  }

  /** Cek token, ambil identitas bot, dan daftarkan menu perintah. */
  async verify(): Promise<{ username?: string }> {
    const me = await this.client.getMe(this.abort.signal);
    this.botUsername = me.username;
    await this.registerCommands();
    return { ...(me.username ? { username: me.username } : {}) };
  }

  /** Daftarkan menu perintah agar tombol "/" muncul di klien Telegram. */
  async registerCommands(): Promise<void> {
    if (!this.client.setMyCommands) return;
    try {
      await this.client.setMyCommands(TELEGRAM_COMMANDS, this.abort.signal);
    } catch (err) {
      this.deps.log?.(`setMyCommands gagal: ${(err as Error).message}`);
    }
  }

  private async poll(): Promise<void> {
    while (!this.stopped) {
      try {
        const updates = await this.client.getUpdates(this.offset, 25, this.abort.signal);
        for (const update of updates) {
          this.offset = update.update_id + 1;
          const text = update.message?.text;
          const chatId = update.message?.chat.id;
          if (text === undefined || chatId === undefined) continue;
          void this.handleText(String(chatId), text);
        }
      } catch (err) {
        if (this.stopped) return;
        this.deps.log?.(`poll error: ${(err as Error).message}`);
        await this.sleep(3000);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.abort.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  private allowed(chatId: string): boolean {
    if (this.settings.open) return true;
    return this.settings.allowedChatIds.includes(chatId);
  }

  private async handleText(chatId: string, text: string): Promise<void> {
    if (!this.allowed(chatId)) {
      await this.safeSend(
        chatId,
        `Akses ditolak. Chat ID kamu: ${chatId}. Minta admin menambahkan ke telegram.allowedChatIds.`,
      );
      return;
    }

    const parsed = parseTelegramCommand(text, this.botUsername);
    if (parsed) {
      this.updateAsk = undefined;
      await this.handleCommand(chatId, parsed);
      return;
    }

    if (this.updateAsk === chatId) {
      this.updateAsk = undefined;
      const answer = text.trim().toLowerCase();
      if (answer === "y" || answer === "ya" || answer === "yes") {
        await this.performUpdate(chatId);
      } else {
        await this.safeSend(chatId, "Update dibatalkan.");
      }
      return;
    }

    if (this.pending && this.pending.chatId === chatId) {
      if (await this.resolvePending(text)) return;
    }

    if (this.deps.app.isBusy?.()) {
      await this.safeSend(
        chatId,
        "Sesi sedang menjalankan tugas lain. Ketik /stop untuk menghentikannya, atau tunggu sampai selesai.",
      );
      return;
    }

    this.activeChatId = chatId;
    void this.client.sendChatAction(chatId, "typing", this.abort.signal);
    try {
      await Promise.resolve(this.deps.app.send(text));
    } catch (err) {
      await this.safeSend(chatId, `Terjadi kesalahan: ${formatErrorMessage(err)}`);
    }
  }

  private async handleCommand(chatId: string, command: ParsedCommand): Promise<void> {
    const app = this.deps.app;
    switch (command.name) {
      case "start":
      case "help":
        await this.safeSend(chatId, HELP_TEXT);
        return;
      case "new":
        await this.run(chatId, "Membuat sesi baru...", async () => {
          await app.newSession?.();
          return "Sesi baru dibuat.";
        });
        return;
      case "clear":
        await this.run(chatId, "Mengosongkan riwayat...", async () => {
          if (!app.clearHistory) return "Fitur clear tidak tersedia.";
          await app.clearHistory();
          return "Riwayat sesi dikosongkan.";
        });
        return;
      case "stop":
      case "interrupt":
        if (app.isBusy && !app.isBusy()) {
          await this.safeSend(chatId, "Tidak ada proses yang sedang berjalan.");
          return;
        }
        this.pending = undefined;
        if (app.stopRunning) await app.stopRunning();
        else app.interrupt?.();
        await this.safeSend(
          chatId,
          "Proses dihentikan. Sesi & konteks tetap tersimpan — lanjutkan kapan saja dengan pesan berikutnya.",
        );
        return;
      case "plan":
      case "build":
        await app.setMode?.(command.name === "plan" ? "plan" : "build");
        await this.safeSend(chatId, `Mode: ${command.name}.`);
        return;
      case "mode":
        await this.commandMode(chatId, command.args);
        return;
      case "allow_all":
        await this.commandAllowAll(chatId, command.args);
        return;
      case "status":
        await this.safeSend(chatId, app.describeStatus?.() ?? "Status tidak tersedia.");
        return;
      case "sessions":
        await this.commandSessions(chatId);
        return;
      case "resume":
        await this.commandResume(chatId, command.args);
        return;
      case "rename":
        await this.commandRename(chatId, command.args);
        return;
      case "delete":
        await this.commandDelete(chatId);
        return;
      case "skills":
        await this.commandSkills(chatId);
        return;
      case "todos":
        await this.commandTodos(chatId);
        return;
      case "models":
        await this.commandModels(chatId, command.args);
        return;
      case "usage":
        await this.commandUsage(chatId, command.args);
        return;
      case "update":
        await this.handleUpdateCommand(chatId, command.args);
        return;
      case "restart":
        await this.commandRestart(chatId);
        return;
      default:
        await this.safeSend(chatId, `Perintah /${command.name} belum tersedia di Telegram. Ketik /help.`);
    }
  }

  /** Jalankan aksi dengan pesan "sedang..." lalu kirim hasilnya (tangani error). */
  private async run(
    chatId: string,
    pending: string,
    action: () => Promise<string | undefined>,
  ): Promise<void> {
    await this.safeSend(chatId, pending);
    try {
      const message = await action();
      if (message) await this.safeSend(chatId, message);
    } catch (err) {
      await this.safeSend(chatId, `Gagal: ${formatErrorMessage(err)}`);
    }
  }

  private async commandMode(chatId: string, args: string): Promise<void> {
    const mode = args.trim().toLowerCase();
    if (mode !== "plan" && mode !== "build") {
      await this.safeSend(chatId, "Pakai: /mode plan atau /mode build.");
      return;
    }
    await this.deps.app.setMode?.(mode);
    await this.safeSend(chatId, `Mode: ${mode}.`);
  }

  private async commandAllowAll(chatId: string, args: string): Promise<void> {
    const app = this.deps.app;
    if (!app.setAllowAll) {
      await this.safeSend(chatId, "Fitur allow-all tidak tersedia.");
      return;
    }
    const arg = args.trim().toLowerCase();
    const current = app.allowAll?.() ?? false;
    const on = arg === "" ? !current : arg === "on" || arg === "ya" || arg === "true";
    app.setAllowAll(on);

    // Bila sedang menunggu izin, sekalian jawab agar loop tidak macet menunggu.
    let note = "";
    const pending = this.pending;
    if (on && pending && pending.chatId === chatId) {
      if (pending.kind === "sensitive") {
        note = " Untuk file sensitif, jawab manual y/n.";
      } else {
        this.pending = undefined;
        app.resolveApproval(pending.id, pending.kind === "confirm" ? "all" : true);
        note = " Izin yang menggantung disetujui; tugas dilanjutkan.";
      }
    }

    await this.safeSend(
      chatId,
      on
        ? `Allow-all AKTIF untuk sesi ini (mode Plan tetap read-only).${note}`
        : "Allow-all nonaktif.",
    );
  }

  private async commandSessions(chatId: string): Promise<void> {
    const sessions = (await this.deps.app.listSessions?.()) ?? [];
    this.sessionCache = sessions;
    if (sessions.length === 0) {
      await this.safeSend(chatId, "Belum ada sesi tersimpan.");
      return;
    }
    const lines = ["Sesi tersimpan:", ""];
    sessions.forEach((s, i) => {
      const when = s.updatedAt ? s.updatedAt.slice(0, 16).replace("T", " ") : "-";
      lines.push(`  ${String(i + 1).padStart(2)}. ${s.title}  (${when})`);
    });
    lines.push("", "Lanjutkan dengan /resume <nomor>.");
    await this.safeSend(chatId, lines.join("\n"));
  }

  private async commandResume(chatId: string, args: string): Promise<void> {
    const arg = args.trim();
    if (!arg) {
      await this.commandSessions(chatId);
      return;
    }
    const app = this.deps.app;
    if (!app.openSession) {
      await this.safeSend(chatId, "Fitur resume tidak tersedia.");
      return;
    }
    let id = arg;
    const index = Number.parseInt(arg, 10);
    if (Number.isInteger(index) && String(index) === arg && index >= 1) {
      if (this.sessionCache.length === 0) this.sessionCache = (await app.listSessions?.()) ?? [];
      const target = this.sessionCache[index - 1];
      if (!target) {
        await this.safeSend(chatId, `Nomor sesi tidak ada (1–${this.sessionCache.length}). Ketik /sessions.`);
        return;
      }
      id = target.id;
    }
    await this.run(chatId, "Membuka sesi...", async () => {
      const ok = await app.openSession?.(id);
      return ok ? "Sesi dilanjutkan." : `Sesi tidak ditemukan: ${arg}`;
    });
  }

  private async commandRename(chatId: string, args: string): Promise<void> {
    const title = args.trim();
    if (!title) {
      await this.safeSend(chatId, "Pakai: /rename <judul baru>.");
      return;
    }
    if (!this.deps.app.renameCurrent) {
      await this.safeSend(chatId, "Fitur rename tidak tersedia.");
      return;
    }
    await this.run(chatId, "Mengganti judul...", async () => {
      await this.deps.app.renameCurrent?.(title);
      return `Judul sesi: ${title}`;
    });
  }

  private async commandDelete(chatId: string): Promise<void> {
    if (!this.deps.app.deleteCurrent) {
      await this.safeSend(chatId, "Fitur delete tidak tersedia.");
      return;
    }
    await this.run(chatId, "Menghapus sesi ini...", async () => {
      await this.deps.app.deleteCurrent?.();
      return "Sesi dihapus.";
    });
  }

  private async commandSkills(chatId: string): Promise<void> {
    const skills = this.deps.app.listSkills?.() ?? [];
    if (skills.length === 0) {
      await this.safeSend(chatId, "Tidak ada skill yang dimuat.");
      return;
    }
    const lines = ["Skill tersedia:", ""];
    for (const s of skills) lines.push(`  • ${s.name}${s.description ? ` — ${s.description}` : ""}`);
    await this.safeSend(chatId, lines.join("\n"));
  }

  private async commandTodos(chatId: string): Promise<void> {
    const todos = this.deps.app.listTodos?.() ?? [];
    if (todos.length === 0) {
      await this.safeSend(chatId, "Belum ada tugas (todo).");
      return;
    }
    const mark: Record<string, string> = {
      pending: "•",
      in_progress: "▸",
      completed: "✔",
      cancelled: "✘",
    };
    const lines = ["Daftar tugas:", ""];
    for (const t of todos) lines.push(`  ${mark[t.status] ?? "•"} ${t.content}`);
    await this.safeSend(chatId, lines.join("\n"));
  }

  private async commandModels(chatId: string, args: string): Promise<void> {
    const app = this.deps.app;
    if (!app.listModels) {
      await this.safeSend(chatId, "Fitur models tidak tersedia.");
      return;
    }
    const arg = args.trim();
    if (arg && app.setModel) {
      let name = arg;
      const index = Number.parseInt(arg, 10);
      if (Number.isInteger(index) && String(index) === arg && index >= 1) {
        if (this.modelCache.length === 0) this.modelCache = await app.listModels();
        const target = this.modelCache[index - 1];
        if (!target) {
          await this.safeSend(chatId, `Nomor model tidak ada. Ketik /models untuk melihat daftar.`);
          return;
        }
        name = target;
      }
      await this.run(chatId, "Mengganti model...", async () => {
        await app.setModel?.(name);
        return `Model: ${name}`;
      });
      return;
    }
    if (arg) {
      await this.safeSend(chatId, "Fitur ganti model tidak tersedia.");
      return;
    }
    const models = await app.listModels();
    this.modelCache = models;
    if (models.length === 0) {
      await this.safeSend(chatId, "Provider tidak mengembalikan model.");
      return;
    }
    const lines = ["Model tersedia:", ""];
    models.forEach((m, i) => lines.push(`  ${String(i + 1).padStart(3)}. ${m}`));
    lines.push("", "Ganti dengan /models <nomor> atau /models <nama>.");
    await this.safeSend(chatId, lines.join("\n"));
  }

  private async commandUsage(chatId: string, args: string): Promise<void> {
    const app = this.deps.app;
    if (!app.usageSummary) {
      await this.safeSend(chatId, "Fitur usage tidak tersedia.");
      return;
    }
    const range = ["today", "week", "all"].includes(args.trim()) ? args.trim() : "today";
    await this.run(chatId, "Menghitung pemakaian...", async () => {
      const summary = await app.usageSummary?.(range);
      return summary ? stripAnsi(summary) : "Tidak ada data pemakaian.";
    });
  }


  /**
   * `/update [y]`: periksa pembaruan, minta konfirmasi `(y/N)`, lalu terapkan.
   * Tanpa konfirmasi (mis. `/update y`) langsung menjalankan pembaruan.
   */
  private async handleUpdateCommand(chatId: string, args = ""): Promise<void> {
    const arg = args.trim().toLowerCase();
    if (arg === "y" || arg === "ya" || arg === "yes" || arg === "--yes") {
      this.updateAsk = undefined;
      await this.performUpdate(chatId);
      return;
    }

    await this.safeSend(chatId, "Memeriksa pembaruan dari repo git...");
    let check: UpdateOutcome;
    try {
      check = await this.depsUpdate()(() => undefined, { check: true });
    } catch (err) {
      await this.safeSend(chatId, `Gagal memeriksa pembaruan: ${formatErrorMessage(err)}`);
      return;
    }
    if (check.status !== "available") {
      await this.safeSend(chatId, describeUpdate(check));
      return;
    }
    this.updateAsk = chatId;
    await this.safeSend(chatId, `${describeUpdateAvailable(check)}\n\nUpdate Sekarang? (y/N)`);
  }

  /** Tarik versi terbaru lalu bangun ulang; beri tahu bila perlu `/restart`. */
  private async performUpdate(chatId: string): Promise<void> {
    await this.safeSend(chatId, "Menerapkan pembaruan...");
    let outcome: UpdateOutcome;
    try {
      outcome = await this.depsUpdate()(() => undefined);
    } catch (err) {
      await this.safeSend(chatId, `Gagal memperbarui: ${formatErrorMessage(err)}`);
      return;
    }
    if (outcome.status === "updated") {
      await this.safeSend(chatId, `[SUKSES] ${describeUpdateSuccess(outcome)}`);
      return;
    }
    await this.safeSend(chatId, describeUpdate(outcome));
  }

  private depsUpdate(): (
    log: (line: string) => void,
    options?: { check?: boolean },
  ) => Promise<UpdateOutcome> {
    return (
      this.deps.update ??
      ((log, options) => runUpdate({ log, ...(options?.check ? { check: true } : {}) }))
    );
  }

  /** `/restart`: jalankan ulang proses bot agar versi baru terpakai. */
  private async commandRestart(chatId: string): Promise<void> {
    if (!this.deps.restart) {
      await this.safeSend(
        chatId,
        "Restart otomatis tidak tersedia di mode ini. Hentikan lalu jalankan lagi botnya.",
      );
      return;
    }
    await this.safeSend(chatId, "Menjalankan ulang bot untuk menerapkan versi baru...");
    this.deps.restart();
  }

  private async resolvePending(text: string): Promise<boolean> {
    const pending = this.pending;
    if (!pending) return false;
    if (pending.kind === "confirm") {
      const decision = parseConfirmReply(text);
      if (!decision) {
        await this.safeSend(pending.chatId, "Balas y (setuju), n (tolak), atau a (setuju semua).");
        return true;
      }
      this.pending = undefined;
      this.deps.app.resolveApproval(pending.id, decision);
      return true;
    }
    const allow = parseBooleanReply(text);
    if (allow === undefined) {
      await this.safeSend(pending.chatId, "Balas y (izinkan) atau n (tolak).");
      return true;
    }
    this.pending = undefined;
    this.deps.app.resolveApproval(pending.id, allow);
    return true;
  }

  private onServerMessage(message: ServerMessage): void {
    const chatId = this.activeChatId;
    switch (message.type) {
      case "busy":
        if (message.on) break;
        if (this.activeChatId) this.flushText(this.activeChatId);
        this.activeChatId = undefined;
        this.pending = undefined;
        break;
      case "text":
        if (chatId) this.textBuffer += message.chunk;
        break;
      case "textEnd":
        if (chatId) this.flushText(chatId);
        break;
      case "info":
      case "warn":
      case "error":
        if (chatId) void this.safeSend(chatId, message.message);
        break;
      case "summary":
        if (chatId && message.message) void this.safeSend(chatId, message.message);
        break;
      case "confirm":
        if (chatId) this.askApproval(chatId, message.id, "confirm", formatConfirmPrompt(message.request));
        break;
      case "pathAccess":
        if (chatId) this.askApproval(chatId, message.id, "path", formatPathPrompt(message.request));
        break;
      case "sensitiveAccess":
        if (chatId) this.askApproval(chatId, message.id, "sensitive", formatSensitivePrompt(message.request));
        break;
      default:
        break;
    }
  }

  private askApproval(
    chatId: string,
    id: string,
    kind: PendingApproval["kind"],
    text: string,
  ): void {
    this.pending = { id, kind, chatId };
    void this.safeSend(chatId, text);
  }

  private flushText(chatId: string): void {
    const text = this.textBuffer;
    this.textBuffer = "";
    if (text.trim()) void this.safeSend(chatId, text, { markdown: true });
  }

  /** Kirim teks polos; `markdown` mengaktifkan render Markdown → HTML Telegram. */
  private async safeSend(
    chatId: string,
    text: string,
    options: { markdown?: boolean } = {},
  ): Promise<void> {
    const limit = TELEGRAM_MESSAGE_LIMIT - 96;
    if (options.markdown) {
      for (const chunk of renderTelegramChunks(text, limit)) {
        // Terlalu banyak entitas per pesan ditolak Telegram; kirim polos saja.
        if (countHtmlEntities(chunk) > TELEGRAM_MAX_ENTITIES) {
          await this.sendPlain(chatId, htmlToPlainText(chunk), limit);
          continue;
        }
        try {
          await this.client.sendMessage(chatId, chunk, this.abort.signal, { parseMode: "HTML" });
        } catch (err) {
          if (this.stopped) return;
          this.deps.log?.(`send html error: ${(err as Error).message}`);
          // Fallback: teks polos supaya pesan tidak hilang.
          await this.sendPlain(chatId, htmlToPlainText(chunk), limit);
        }
      }
      return;
    }
    await this.sendPlain(chatId, text, limit);
  }

  private async sendPlain(chatId: string, text: string, limit: number): Promise<void> {
    for (const chunk of chunkText(text, limit)) {
      try {
        await this.client.sendMessage(chatId, chunk, this.abort.signal);
      } catch (err) {
        if (!this.stopped) this.deps.log?.(`send error: ${(err as Error).message}`);
        return;
      }
    }
  }
}
