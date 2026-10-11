import { loadConfig } from "../config/config.js";
import { WebApp, type WebAppOptions } from "./webapp.js";
import type { ServerMessage } from "./protocol.js";
import {
  TelegramBridge,
  loadTelegramToken,
  resolveTelegramSettings,
  type TelegramSettings,
} from "./telegram.js";

/** Error konfigurasi bot Telegram (ditampilkan sebagai pesan, bukan crash). */
export class TelegramError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramError";
  }
}

export interface TelegramServerOptions extends WebAppOptions {
  /** Pengaturan siap pakai; bila kosong diambil dari config/env/token aman. */
  settings?: TelegramSettings;
  log?: (message: string) => void;
}

export interface TelegramServerHandle {
  username?: string;
  open: boolean;
  allowedChatIds: string[];
  isActive(): boolean;
  close(): Promise<void>;
}

/**
 * Jalankan bot Telegram sebagai server mandiri (tanpa server web). Bot memakai
 * satu sesi `WebApp` headless sendiri dan berjalan selama proses hidup.
 */
export async function startTelegramServer(opts: TelegramServerOptions): Promise<TelegramServerHandle> {
  const settings =
    opts.settings ?? resolveTelegramSettings(await loadConfig(), process.env, await loadTelegramToken());
  if (!settings) {
    throw new TelegramError(
      "Token bot Telegram belum diatur. Jalankan /telegram token <TOKEN> atau set TELEGRAM_BOT_TOKEN.",
    );
  }

  const sinks = new Set<(message: ServerMessage) => void>();
  const app = await WebApp.create(opts, (message) => {
    for (const fn of sinks) fn(message);
  });

  const bridge = new TelegramBridge(settings, {
    app,
    subscribe: (fn) => {
      sinks.add(fn);
      return () => {
        sinks.delete(fn);
      };
    },
    ...(opts.log ? { log: opts.log } : {}),
    // Keluar dengan kode 0; supervisor daemon akan menjalankan worker baru
    // sehingga dist/ terbaru hasil update termuat.
    restart: () => {
      setTimeout(() => process.exit(0), 200);
    },
  });

  let username: string | undefined;
  try {
    username = (await bridge.verify()).username;
  } catch (err) {
    await bridge.stop();
    await app.close();
    throw new TelegramError(`Token bot tidak valid: ${(err as Error).message}`);
  }

  return {
    ...(username ? { username } : {}),
    open: settings.open,
    allowedChatIds: settings.allowedChatIds,
    isActive: () => bridge.active,
    async close() {
      await bridge.stop();
      await app.close();
    },
  };
}
