import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { completeLine, formatHint } from "../src/cli/complete.js";

const CMDS = ["/connect", "/models", "/mcp", "/provider", "/sessions", "/serve"];

describe("formatHint", () => {
  it("membatasi jumlah kandidat dan menandai sisanya", () => {
    const many = Array.from({ length: 9 }, (_, i) => `/c${i}`);
    const line = formatHint(many, 6);
    expect(line).toContain("/c0");
    expect(line).toContain("…(+3)");
    expect(line).not.toContain("/c6");
  });

  it("menggabungkan beberapa kandidat dalam satu baris", () => {
    const line = formatHint(["/sessions", "/serve"]);
    expect(line).toContain("/sessions");
    expect(line).toContain("/serve");
  });
});

describe("completeLine", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "nex-complete-"));
    await fs.writeFile(path.join(dir, "notes.txt"), "x");
    await fs.writeFile(path.join(dir, "readme.md"), "x");
    await fs.mkdir(path.join(dir, "src"));
    await fs.writeFile(path.join(dir, ".env"), "secret");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("melengkapi perintah slash dari token pertama", () => {
    const [hits, token] = completeLine("/se", CMDS, dir);
    expect(token).toBe("/se");
    expect(hits).toEqual(["/sessions", "/serve"]);
  });

  it("menampilkan semua perintah bila tidak ada yang cocok", () => {
    const [hits] = completeLine("/zzz", CMDS, dir);
    expect(hits).toEqual(CMDS);
  });

  it("melengkapi subperintah (/provider ha -> hapus)", () => {
    const [hits, token] = completeLine("/provider ha", CMDS, dir);
    expect(token).toBe("ha");
    expect(hits).toEqual(["hapus"]);
  });

  it("melengkapi path berkas pada argumen", () => {
    const [hits, token] = completeLine("/models not", CMDS, dir);
    expect(token).toBe("not");
    expect(hits).toContain("notes.txt");
  });

  it("menambahkan garis miring untuk direktori", () => {
    const [hits] = completeLine("/models s", CMDS, dir);
    expect(hits).toContain("src/");
  });

  it("menyembunyikan dotfile kecuali pengguna mengetik titik di depan", () => {
    const [all] = completeLine("/models ", CMDS, dir);
    expect(all).not.toContain(".env");
    const [dot] = completeLine("/models .e", CMDS, dir);
    expect(dot).toContain(".env");
  });
});
