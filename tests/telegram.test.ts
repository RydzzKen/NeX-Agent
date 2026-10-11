import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ServerMessage } from "../src/server/protocol.js";
import {
  TelegramBridge,
  TelegramClient,
  chunkText,
  clearTelegramToken,
  formatConfirmPrompt,
  formatPathPrompt,
  formatSensitivePrompt,
  loadTelegramToken,
  maskToken,
  parseBooleanReply,
  parseConfirmReply,
  resolveTelegramSettings,
  saveTelegramToken,
  stripAnsi,
  telegramSecretPath,
  type TelegramAgent,
  type TelegramClientLike,
  type TelegramSettings,
  type TelegramUpdate,
} from "../src/server/telegram.js";

function until(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  return new Promise<void>((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("timeout menunggu kondisi"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

class FakeClient implements TelegramClientLike {
  readonly sends: Array<{ chatId: string; text: string }> = [];
  readonly actions: Array<{ chatId: string; action: string }> = [];
  private queue: TelegramUpdate[][] = [];
  private waiters: Array<() => void> = [];

  push(updates: TelegramUpdate[]): void {
    this.queue.push(updates);
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  async getMe(): Promise<{ id: number; username: string }> {
    return { id: 1, username: "test_bot" };
  }

  async getUpdates(_offset: number, _timeout: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    const next = this.queue.shift();
    if (next) return next;
    await new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      this.waiters.push(resolve);
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    if (signal?.aborted) throw new Error("aborted");
    return this.queue.shift() ?? [];
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    this.sends.push({ chatId, text });
  }

  async sendChatAction(chatId: string, action: string): Promise<void> {
    this.actions.push({ chatId, action });
  }
}

interface Harness {
  bridge: TelegramBridge;
  client: FakeClient;
  sentPrompts: string[];
  resolutions: Array<{ id: string; value: unknown }>;
  emit(message: ServerMessage): void;
}

function harness(options: {
  settings?: Partial<TelegramSettings>;
  send?: TelegramAgent["send"];
  busy?: boolean;
} = {}): Harness {
  const client = new FakeClient();
  const sentPrompts: string[] = [];
  const resolutions: Array<{ id: string; value: unknown }> = [];
  let sink: ((message: ServerMessage) => void) | undefined;

  const defaultSend: TelegramAgent["send"] = async (text) => {
    sentPrompts.push(text);
    sink?.({ type: "busy", on: true });
    sink?.({ type: "text", chunk: `balas:${text}` });
    sink?.({ type: "textEnd" });
    sink?.({ type: "busy", on: false });
  };

  const app: TelegramAgent = {
    send: options.send ?? defaultSend,
    newSession: async () => {},
    interrupt: () => {},
    isBusy: () => Boolean(options.busy),
    resolveApproval: (id, value) => {
      resolutions.push({ id, value });
      return true;
    },
  };

  const bridge = new TelegramBridge(
    { token: "t", apiBase: "https://api.telegram.test", allowedChatIds: [], open: true, ...options.settings },
    {
      app,
      subscribe: (fn) => {
        sink = fn;
        return () => {
          sink = undefined;
        };
      },
      client,
      log: () => {},
    },
  );

  return {
    bridge,
    client,
    sentPrompts,
    resolutions,
    emit: (message) => sink?.(message),
  };
}

function message(updateId: number, chatId: number, text: string): TelegramUpdate {
  return { update_id: updateId, message: { message_id: updateId, chat: { id: chatId }, text } };
}

describe("resolveTelegramSettings", () => {
  it("memakai token config dan allowlist", () => {
    const settings = resolveTelegramSettings({ telegram: { token: "cfg", allowedChatIds: [1, 2] } }, {});
    expect(settings?.token).toBe("cfg");
    expect(settings?.open).toBe(false);
    expect(settings?.allowedChatIds).toEqual(["1", "2"]);
  });

  it("env menimpa token dan apiBase", () => {
    const settings = resolveTelegramSettings(
      { telegram: { token: "cfg", apiBase: "https://api.telegram.org" } },
      { TELEGRAM_BOT_TOKEN: "env", TELEGRAM_API_BASE: "http://localhost:8081/" },
    );
    expect(settings?.token).toBe("env");
    expect(settings?.apiBase).toBe("http://localhost:8081");
    expect(settings?.open).toBe(true);
  });

  it("undefined bila token tidak ada atau dinonaktifkan", () => {
    expect(resolveTelegramSettings({}, {})).toBeUndefined();
    expect(resolveTelegramSettings({ telegram: { enabled: false, token: "x" } }, {})).toBeUndefined();
  });

  it("prioritas token: env > berkas aman > config", () => {
    const config = { telegram: { token: "cfg" } };
    expect(resolveTelegramSettings(config, {}, "sec")?.token).toBe("sec");
    expect(resolveTelegramSettings(config, { TELEGRAM_BOT_TOKEN: "env" }, "sec")?.token).toBe("env");
  });
});

describe("penyimpanan token aman", () => {
  it("menyimpan dan menghapus token di berkas berizin 600", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nex-tg-"));
    try {
      expect(await loadTelegramToken(dir)).toBeUndefined();
      await saveTelegramToken("123:abc", dir);
      expect(await loadTelegramToken(dir)).toBe("123:abc");
      const mode = (await fs.stat(telegramSecretPath(dir))).mode & 0o777;
      expect(mode).toBe(0o600);
      await clearTelegramToken(dir);
      expect(await loadTelegramToken(dir)).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("util telegram", () => {
  it("maskToken menyamarkan token tanpa membocorkannya", () => {
    expect(maskToken("1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZ")).toMatch(/^1234…WXYZ$/);
    expect(maskToken("short")).toBe("***");
  });

  it("stripAnsi menyingkirkan kode warna", () => {
    expect(stripAnsi("\u001b[31mmerah\u001b[0m")).toBe("merah");
  });

  it("chunkText memotong tanpa melewati batas", () => {
    expect(chunkText("hello")).toEqual(["hello"]);
    expect(chunkText("   ")).toEqual([]);
    const parts = chunkText("a".repeat(95), 20);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 20)).toBe(true);
    expect(parts.join("")).toBe("a".repeat(95));
  });

  it("parseConfirmReply dan parseBooleanReply", () => {
    expect(parseConfirmReply(" y ")).toBe("yes");
    expect(parseConfirmReply("TIDAK")).toBe("no");
    expect(parseConfirmReply("a")).toBe("all");
    expect(parseConfirmReply("entah")).toBeUndefined();
    expect(parseBooleanReply("ya")).toBe(true);
    expect(parseBooleanReply("n")).toBe(false);
    expect(parseBooleanReply("?")).toBeUndefined();
  });

  it("format prompt menyertakan instruksi dan membuang ANSI", () => {
    const confirm = formatConfirmPrompt({
      kind: "write",
      title: "Tulis x",
      detail: "ke x",
      diff: "\u001b[32m+baru\u001b[0m",
    });
    expect(confirm).not.toContain("\u001b");
    expect(confirm).toContain("Balas: y");
    expect(formatPathPrompt({ path: "/etc/hosts", access: "read", outsideWorkspace: true })).toContain(
      "/etc/hosts",
    );
    expect(formatSensitivePrompt({ kind: "path", detail: ".env", reason: "rahasia" })).toContain(".env");
  });
});

describe("TelegramClient", () => {
  it("memanggil endpoint yang benar dan melempar saat ok:false", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: [{ update_id: 7 }] }),
      } as unknown as Response;
    }) as typeof fetch;

    const client = new TelegramClient("123:abc", "https://api.telegram.test/", fakeFetch);
    const updates = await client.getUpdates(5, 25);
    expect(updates).toEqual([{ update_id: 7 }]);
    expect(calls[0]!.url).toBe("https://api.telegram.test/bot123:abc/getUpdates");
    expect(calls[0]!.body).toMatchObject({ offset: 5, timeout: 25 });

    const failFetch = (async () =>
      ({
        ok: false,
        status: 401,
        json: async () => ({ ok: false, description: "Unauthorized" }),
      }) as unknown as Response) as typeof fetch;
    const bad = new TelegramClient("x", "https://api.telegram.test", failFetch);
    await expect(bad.sendMessage("1", "hi")).rejects.toThrow("Unauthorized");
  });
});

describe("TelegramBridge", () => {
  it("meneruskan pesan dan mengirim balasan model ke chat", async () => {
    const h = harness();
    h.client.push([message(1, 42, "halo")]);
    await until(() => h.client.sends.some((s) => s.text === "balas:halo"));
    expect(h.sentPrompts).toContain("halo");
    expect(h.client.sends.find((s) => s.text === "balas:halo")?.chatId).toBe("42");
    await h.bridge.stop();
  });

  it("menolak chat di luar allowlist dengan memberi tahu chat id", async () => {
    const h = harness({ settings: { allowedChatIds: ["1"], open: false } });
    h.client.push([message(1, 99, "halo")]);
    await until(() => h.client.sends.some((s) => s.text.includes("Akses ditolak")));
    expect(h.client.sends[0]!.text).toContain("99");
    expect(h.sentPrompts).toEqual([]);
    await h.bridge.stop();
  });

  it("meneruskan approval dan menyelesaikannya dari balasan teks", async () => {
    const h = harness({
      send: async () => {
        h.emit({ type: "busy", on: true });
        h.emit({
          type: "confirm",
          id: "req_1",
          request: { kind: "shell", title: "Jalankan ls", detail: "ls -la" },
        });
      },
    });
    h.client.push([message(1, 42, "kerjakan")]);
    await until(() => h.client.sends.some((s) => s.text.includes("Butuh konfirmasi")));
    expect(h.client.sends.find((s) => s.text.includes("Butuh konfirmasi"))?.text).toContain("Balas: y");

    h.client.push([message(2, 42, "y")]);
    await until(() => h.resolutions.length > 0);
    expect(h.resolutions[0]).toEqual({ id: "req_1", value: "yes" });
    expect(h.sentPrompts).toEqual([]);
    await h.bridge.stop();
  });

  it("menangani permintaan akses path dengan balasan boolean", async () => {
    const h = harness({
      send: async () => {
        h.emit({ type: "busy", on: true });
        h.emit({
          type: "pathAccess",
          id: "req_2",
          request: { path: "/etc/hosts", access: "read", outsideWorkspace: true },
        });
      },
    });
    h.client.push([message(1, 7, "baca")]);
    await until(() => h.client.sends.some((s) => s.text.includes("Izin akses")));
    h.client.push([message(2, 7, "n")]);
    await until(() => h.resolutions.length > 0);
    expect(h.resolutions[0]).toEqual({ id: "req_2", value: false });
    await h.bridge.stop();
  });

  it("menjawab /help tanpa memanggil model", async () => {
    const h = harness();
    h.client.push([message(1, 5, "/help")]);
    await until(() => h.client.sends.some((s) => s.text.includes("NeX-Agent bot siap")));
    expect(h.sentPrompts).toEqual([]);
    await h.bridge.stop();
  });

  it("berhenti dengan aman", async () => {
    const h = harness();
    expect(h.bridge.active).toBe(true);
    await h.bridge.stop();
    expect(h.bridge.active).toBe(false);
  });

  it("menolak pesan saat sesi sedang sibuk tanpa menjalankan model", async () => {
    const h = harness({ busy: true });
    h.client.push([message(1, 42, "halo")]);
    await until(() => h.client.sends.some((s) => s.text.includes("sedang menjalankan tugas lain")));
    expect(h.sentPrompts).toEqual([]);
    await h.bridge.stop();
  });
});
