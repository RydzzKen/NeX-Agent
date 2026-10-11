import fs from "node:fs/promises";
import path from "node:path";
import type {
  ConfirmRequest,
  PathAccessRequest,
  SensitiveAccessRequest,
} from "../core/io.js";
import { configDir, type AgentConfig } from "../config/config.js";
import { describeUpdate, runUpdate, type UpdateOutcome } from "../cli/update.js";
import type { ServerMessage } from "./protocol.js";

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

/** Bagian Bot API yang dipakai jembatan (memudahkan penggantian di tes). */
export interface TelegramClientLike {
  getMe(signal?: AbortSignal): Promise<{ id?: number; username?: string }>;
  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
  sendMessage(chatId: string, text: string, signal?: AbortSignal): Promise<void>;
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
  { command: "new", description: "Mulai sesi baru" },
  { command: "update", description: "Perbarui NeX-Agent dari repo git" },
  { command: "interrupt", description: "Hentikan tugas yang berjalan" },
  { command: "help", description: "Tampilkan bantuan" },
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

  async sendMessage(chatId: string, text: string, signal?: AbortSignal): Promise<void> {
    await this.call("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true }, signal);
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
  newSession?(): Promise<void> | void;
  isBusy?(): boolean;
  resolveApproval(id: string, value: unknown): boolean;
}

export interface TelegramBridgeDeps {
  app: TelegramAgent;
  /** Berlangganan pesan server; kembalikan fungsi untuk berhenti berlangganan. */
  subscribe(sink: (message: ServerMessage) => void): () => void;
  log?: (message: string) => void;
  /** Klien kustom (untuk tes). */
  client?: TelegramClientLike;
  /** Jalankan pembaruan mandiri; dapat diganti di tes. */
  update?: (log: (line: string) => void) => Promise<UpdateOutcome>;
}

/** Parse perintah Telegram dari teks pesan (murni). */
export interface ParsedCommand {
  name: string;
  args: string;
  mention?: string;
}

const COMMAND_RE = /^\/([A-Za-z0-9_]+)(?:@(\S+))?(?:\s+([\s\S]*))?$/;

/**
 * Kenali `/perintah [argumen]` (dengan dukungan `/perintah@BotName`). Mengembalikan
 * undefined bila teks bukan perintah (mis. `/usr/bin` yang punya lebih dari satu
 * garis miring) agar pesan biasa tetap diteruskan ke agen.
 */
export function parseTelegramCommand(text: string, botUsername?: string): ParsedCommand | undefined {
  const match = COMMAND_RE.exec(text.trim());
  if (!match) return undefined;
  const name = (match[1] ?? "").toLowerCase();
  if (!name) return undefined;
  const mention = match[2];
  if (mention && botUsername && mention.toLowerCase() !== botUsername.toLowerCase()) return undefined;
  return { name, args: (match[3] ?? "").trim(), ...(mention ? { mention } : {}) };
}

const HELP_TEXT = [
  "NeX-Agent bot siap. Kirim pesan untuk memulai percakapan.",
  "",
  "Perintah:",
  "  /new — mulai sesi baru",
  "  /update — perbarui NeX-Agent dari repo git",
  "  /interrupt — hentikan tugas yang berjalan",
  "  /help — bantuan ini",
  "",
  "Saat agent meminta izin, balas y (setuju), n (tolak), atau a (setuju semua).",
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
      await this.handleCommand(chatId, parsed);
      return;
    }

    if (this.pending && this.pending.chatId === chatId) {
      if (await this.resolvePending(text)) return;
    }

    if (this.deps.app.isBusy?.()) {
      await this.safeSend(chatId, "Sesi sedang menjalankan tugas lain; coba lagi setelah selesai.");
      return;
    }

    this.activeChatId = chatId;
    void this.client.sendChatAction(chatId, "typing", this.abort.signal);
    try {
      await Promise.resolve(this.deps.app.send(text));
    } catch (err) {
      await this.safeSend(chatId, `Terjadi kesalahan: ${(err as Error).message}`);
    }
  }

  private async handleCommand(chatId: string, command: ParsedCommand): Promise<void> {
    switch (command.name) {
      case "start":
      case "help":
        await this.safeSend(chatId, HELP_TEXT);
        return;
      case "new":
        try {
          await this.deps.app.newSession?.();
          await this.safeSend(chatId, "Sesi baru dibuat.");
        } catch (err) {
          await this.safeSend(chatId, `Gagal membuat sesi: ${(err as Error).message}`);
        }
        return;
      case "interrupt":
      case "stop":
        this.deps.app.interrupt?.();
        await this.safeSend(chatId, "Permintaan henti dikirim.");
        return;
      case "update":
        await this.handleUpdateCommand(chatId);
        return;
      default:
        await this.safeSend(chatId, `Perintah tidak dikenal: /${command.name}. Ketik /help.`);
    }
  }

  /** `/update`: tarik versi terbaru dari repo lalu minta restart agar terpakai. */
  private async handleUpdateCommand(chatId: string): Promise<void> {
    await this.safeSend(chatId, "Memeriksa pembaruan dari repo git...");
    const update = this.deps.update ?? ((log: (line: string) => void) => runUpdate({ log }));
    let outcome: UpdateOutcome;
    try {
      outcome = await update(() => undefined);
    } catch (err) {
      await this.safeSend(chatId, `Gagal memperbarui: ${(err as Error).message}`);
      return;
    }
    await this.safeSend(chatId, describeUpdate(outcome));
    if (outcome.status === "updated") {
      await this.safeSend(
        chatId,
        "Bot ini masih menjalankan versi lama. Jalankan `nex-agent telegram restart` di terminal " +
          "(atau `/telegram restart` dari sesi chat) agar versi baru terpakai.",
      );
    }
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
    if (text.trim()) void this.safeSend(chatId, text);
  }

  private async safeSend(chatId: string, text: string): Promise<void> {
    for (const chunk of chunkText(text, TELEGRAM_MESSAGE_LIMIT - 96)) {
      try {
        await this.client.sendMessage(chatId, chunk, this.abort.signal);
      } catch (err) {
        if (!this.stopped) this.deps.log?.(`send error: ${(err as Error).message}`);
        return;
      }
    }
  }
}
