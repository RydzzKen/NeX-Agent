import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionStore, deriveTitle, selectSession, type SessionRecord } from "../src/sessions/store.js";

describe("deriveTitle", () => {
  it("memakai pesan pertama sebagai nama sesi", () => {
    expect(deriveTitle("Perbaiki bug login di halaman utama")).toBe(
      "Perbaiki bug login di halaman utama",
    );
  });

  it("mengambil kalimat pertama dan menyingkat bila panjang", () => {
    const long = `Refactor modul auth. ${"detail ".repeat(20)}`;
    const title = deriveTitle(long);
    expect(title).toBe("Refactor modul auth.");
    expect(deriveTitle(`A${"b".repeat(200)}`)).toMatch(/\.\.\.$/);
  });

  it("membuang blok kode dan markdown ringan", () => {
    const message = "# Judul\n```ts\nconst x = 1;\n```\nBuat endpoint baru";
    expect(deriveTitle(message)).toBe("Judul Buat endpoint baru");
  });

  it("menangani pesan kosong", () => {
    expect(deriveTitle("   ")).toBe("(kosong)");
  });
});

function record(id: string, workspace: string, updatedAt: string, title = id): SessionRecord {
  return {
    id,
    title,
    workspace,
    providerId: "fake",
    model: "m",
    mode: "build",
    createdAt: updatedAt,
    updatedAt,
    cost: 0,
    history: [],
  };
}

describe("SessionStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "nex-sessions-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("mengurutkan sesi terbaru lebih dulu dan memfilter per workspace", async () => {
    const store = new SessionStore(dir);
    await store.save(record("a", "/ws", "2026-01-01T00:00:00.000Z"));
    await store.save(record("b", "/ws", "2026-03-01T00:00:00.000Z"));
    await store.save(record("c", "/ws", "2026-02-01T00:00:00.000Z"));
    await store.save(record("d", "/lain", "2026-04-01T00:00:00.000Z"));

    const list = await store.listForWorkspace("/ws");
    // Urutan inilah yang dipakai /sessions dan /resume <nomor>.
    expect(list.map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect((await store.lastForWorkspace("/ws"))?.id).toBe("b");
  });

  it("deleteMany menghapus beberapa sesi dan mengembalikan jumlah yang terhapus", async () => {
    const store = new SessionStore(dir);
    await store.save(record("a", "/ws", "2026-01-01T00:00:00.000Z"));
    await store.save(record("b", "/ws", "2026-01-02T00:00:00.000Z"));

    const removed = await store.deleteMany(["a", "tidak-ada"]);
    expect(removed).toBe(1);
    expect(await store.load("a")).toBeUndefined();
    expect(await store.load("b")).toBeDefined();
  });
});

describe("selectSession", () => {
  const sessions = [record("b", "/ws", "2026-03-01"), record("c", "/ws", "2026-02-01")];

  it("memilih berdasarkan nomor urut (1-based)", () => {
    expect(selectSession(sessions, "1")?.id).toBe("b");
    expect(selectSession(sessions, "2")?.id).toBe("c");
  });

  it("memilih berdasarkan id", () => {
    expect(selectSession(sessions, "c")?.id).toBe("c");
  });

  it("mengembalikan undefined untuk nomor di luar rentang atau kosong", () => {
    expect(selectSession(sessions, "3")).toBeUndefined();
    expect(selectSession(sessions, "0")).toBeUndefined();
    expect(selectSession(sessions, undefined)).toBeUndefined();
  });
});
