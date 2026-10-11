import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ServerMessage } from "../src/server/protocol.js";
import {
  TelegramBridge,
  TelegramClient,
  TELEGRAM_COMMANDS,
  chunkText,
  clearTelegramToken,
  formatConfirmPrompt,
  formatPathPrompt,
  formatSensitivePrompt,
  loadTelegramToken,
  maskToken,
  parseBooleanReply,
  parseConfirmReply,
  parseTelegramCommand,
  resolveTelegramSettings,
  saveTelegramToken,
  stripAnsi,
  telegramSecretPath,
  type TelegramAgent,
  type TelegramClientLike,
  type TelegramCommand,
  type TelegramSettings,
  type TelegramUpdate,
} from "../src/server/telegram.js";
import type { UpdateOutcome } from "../src/cli/update.js";

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
  readonly commands: TelegramCommand[][] = [];
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

  async setMyCommands(commands: TelegramCommand[]): Promise<void> {
    this.commands.push(commands);
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
  newSessions: () => number;
  state: {
    mode: string;
    allowAll: boolean;
    title: string;
    model: string;
    cleared: number;
    deleted: number;
  };
  emit(message: ServerMessage): void;
}

function harness(options: {
  settings?: Partial<TelegramSettings>;
  send?: TelegramAgent["send"];
  busy?: boolean;
  update?: (log: (line: string) => void) => Promise<UpdateOutcome>;
} = {}): Harness {
  const client = new FakeClient();
  const sentPrompts: string[] = [];
  const resolutions: Array<{ id: string; value: unknown }> = [];
  let sessionCount = 0;
  let sink: ((message: ServerMessage) => void) | undefined;
  const state = { mode: "build", allowAll: false, title: "awal", model: "model-a", cleared: 0, deleted: 0 };

  const defaultSend: TelegramAgent["send"] = async (text) => {
    sentPrompts.push(text);
    sink?.({ type: "busy", on: true });
    sink?.({ type: "text", chunk: `balas:${text}` });
    sink?.({ type: "textEnd" });
    sink?.({ type: "busy", on: false });
  };

  const app: TelegramAgent = {
    send: options.send ?? defaultSend,
    newSession: async () => {
      sessionCount += 1;
    },
    interrupt: () => {},
    isBusy: () => Boolean(options.busy),
    resolveApproval: (id, value) => {
      resolutions.push({ id, value });
      return true;
    },
    clearHistory: async () => {
      state.cleared += 1;
    },
    setMode: (mode) => {
      state.mode = mode;
    },
    allowAll: () => state.allowAll,
    setAllowAll: (value) => {
      state.allowAll = value;
    },
    describeStatus: () => `mode=${state.mode} allow-all=${state.allowAll ? "ON" : "off"}`,
    listSessions: async () => [
      { id: "s1", title: "pertama", updatedAt: "2026-01-01T10:00:00Z" },
      { id: "s2", title: "kedua", updatedAt: "2026-01-02T10:00:00Z" },
    ],
    openSession: async (id) => (id === "s1" || id === "s2" ? { id } : undefined),
    renameCurrent: async (title) => {
      state.title = title;
    },
    deleteCurrent: async () => {
      state.deleted += 1;
    },
    listSkills: () => [{ name: "alpha", description: "skill contoh" }],
    listTodos: () => [
      { content: "cuci tangan", status: "completed" },
      { content: "masak", status: "pending" },
    ],
    listModels: async () => ["model-a", "model-b"],
    setModel: async (name) => {
      state.model = name;
    },
    usageSummary: async (range) => `rekap ${range}`,
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
      ...(options.update ? { update: options.update } : {}),
    },
  );

  return {
    bridge,
    client,
    sentPrompts,
    resolutions,
    newSessions: () => sessionCount,
    state,
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

  it("mendaftarkan menu perintah lewat setMyCommands saat verify", async () => {
    const h = harness();
    await h.bridge.verify();
    expect(h.client.commands).toHaveLength(1);
    const names = h.client.commands[0]!.map((c) => c.command);
    expect(names).toContain("update");
    expect(names).toContain("new");
    expect(names).toContain("interrupt");
    await h.bridge.stop();
  });

  it("menerima perintah dengan sufiks @botname", async () => {
    const h = harness();
    h.client.push([message(1, 5, "/new@test_bot")]);
    await until(() => h.newSessions() === 1);
    expect(h.sentPrompts).toEqual([]);
    await h.bridge.stop();
  });

  it("membalas petunjuk untuk perintah tak dikenal tanpa memanggil model", async () => {
    const h = harness();
    h.client.push([message(1, 5, "/apalah")]);
    await until(() => h.client.sends.some((s) => s.text.includes("belum tersedia di Telegram")));
    expect(h.sentPrompts).toEqual([]);
    await h.bridge.stop();
  });

  it("meneruskan teks yang berawalan garis miring tapi bukan perintah", async () => {
    const h = harness();
    h.client.push([message(1, 5, "/usr/bin/env adalah path")]);
    await until(() => h.sentPrompts.length > 0);
    expect(h.sentPrompts[0]).toContain("/usr/bin/env");
    await h.bridge.stop();
  });

  it("/update menjalankan pembaruan lalu meminta restart saat ada versi baru", async () => {
    let called = false;
    const h = harness({
      update: async () => {
        called = true;
        return { status: "updated", version: "0.2.0", from: "aaaaaaa", to: "bbbbbbb" };
      },
    });
    h.client.push([message(1, 5, "/update")]);
    await until(() => h.client.sends.some((s) => s.text.includes("Berhasil diperbarui")));
    expect(called).toBe(true);
    expect(h.client.sends.some((s) => s.text.includes("telegram restart"))).toBe(true);
    expect(h.sentPrompts).toEqual([]);
    await h.bridge.stop();
  });

  it("/update melaporkan sudah versi terbaru tanpa menyuruh restart", async () => {
    const h = harness({ update: async () => ({ status: "latest", version: "0.2.0" }) });
    h.client.push([message(1, 5, "/update")]);
    await until(() => h.client.sends.some((s) => s.text.includes("Sudah versi terbaru")));
    expect(h.client.sends.some((s) => s.text.includes("restart"))).toBe(false);
    await h.bridge.stop();
  });

  async function runCommand(h: Harness, text: string, expectText: string): Promise<void> {
    h.client.push([message(1, 5, text)]);
    await until(() => h.client.sends.some((s) => s.text.includes(expectText)));
  }

  it("/allow-all membalik status dan menerima on/off", async () => {
    const h = harness();
    await runCommand(h, "/allow-all", "AKTIF");
    expect(h.state.allowAll).toBe(true);
    await runCommand(h, "/allow-all off", "nonaktif");
    expect(h.state.allowAll).toBe(false);
    await h.bridge.stop();
  });

  it("/plan dan /mode mengganti mode", async () => {
    const h = harness();
    await runCommand(h, "/plan", "Mode: plan");
    expect(h.state.mode).toBe("plan");
    await runCommand(h, "/mode build", "Mode: build");
    expect(h.state.mode).toBe("build");
    await h.bridge.stop();
  });

  it("/status mengirim ringkasan dari app", async () => {
    const h = harness();
    await runCommand(h, "/status", "allow-all=off");
    await h.bridge.stop();
  });

  it("/sessions lalu /resume <nomor> membuka sesi", async () => {
    const h = harness();
    await runCommand(h, "/sessions", "kedua");
    await runCommand(h, "/resume 2", "Sesi dilanjutkan");
    await h.bridge.stop();
  });

  it("/models tanpa argumen menampilkan daftar, dengan nomor mengganti model", async () => {
    const h = harness();
    await runCommand(h, "/models", "model-b");
    await runCommand(h, "/models 2", "Model: model-b");
    expect(h.state.model).toBe("model-b");
    await h.bridge.stop();
  });

  it("/skills, /todos, /usage, /clear, /rename, /delete bekerja", async () => {
    const h = harness();
    await runCommand(h, "/skills", "alpha");
    await runCommand(h, "/todos", "masak");
    await runCommand(h, "/usage week", "rekap week");
    await runCommand(h, "/clear", "Riwayat sesi dikosongkan");
    expect(h.state.cleared).toBe(1);
    await runCommand(h, "/rename Judul Baru", "Judul Baru");
    expect(h.state.title).toBe("Judul Baru");
    await runCommand(h, "/delete", "Sesi dihapus");
    expect(h.state.deleted).toBe(1);
    await h.bridge.stop();
  });
});

describe("parseTelegramCommand", () => {
  it("mengenali perintah dasar dan argumen", () => {
    expect(parseTelegramCommand("/new")).toEqual({ name: "new", args: "" });
    expect(parseTelegramCommand("  /Update --check ")).toEqual({ name: "update", args: "--check" });
    expect(parseTelegramCommand("/allow-all")).toEqual({ name: "allow_all", args: "" });
    expect(parseTelegramCommand("/allow_all off")).toEqual({ name: "allow_all", args: "off" });
  });

  it("menghormati sufiks @botname", () => {
    expect(parseTelegramCommand("/new@test_bot", "test_bot")).toEqual({
      name: "new",
      args: "",
      mention: "test_bot",
    });
    expect(parseTelegramCommand("/new@other", "test_bot")).toBeUndefined();
    expect(parseTelegramCommand("/new@other")).toEqual({ name: "new", args: "", mention: "other" });
  });

  it("bukan perintah bila bukan pola perintah", () => {
    expect(parseTelegramCommand("halo")).toBeUndefined();
    expect(parseTelegramCommand("/usr/bin/env")).toBeUndefined();
    expect(parseTelegramCommand("/")).toBeUndefined();
  });

  it("menu perintah berisi nama yang valid untuk Telegram", () => {
    for (const cmd of TELEGRAM_COMMANDS) {
      expect(cmd.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(cmd.description.length).toBeGreaterThanOrEqual(3);
      expect(cmd.description.length).toBeLessThanOrEqual(256);
    }
  });
});
