import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_FACTS,
  findFact,
  formatFacts,
  looksSecret,
  memoryFilePath,
  readFacts,
  removeFact,
  upsertFact,
  writeFacts,
  type MemoryFact,
} from "../src/memory/long_term.js";

function fact(key: string, value: string): MemoryFact {
  return { key, value, updatedAt: "2026-01-01T00:00:00.000Z" };
}

describe("upsertFact", () => {
  it("menambah fakta baru", () => {
    const facts = upsertFact([], "nama", "Rydz", "T1");
    expect(facts).toEqual([{ key: "nama", value: "Rydz", updatedAt: "T1" }]);
  });

  it("memperbarui fakta dengan key sama (tanpa peduli huruf besar-kecil)", () => {
    const before = [fact("Nama", "Lama")];
    const after = upsertFact(before, "nama", "Baru", "T2");
    expect(after).toHaveLength(1);
    expect(after[0]).toEqual({ key: "nama", value: "Baru", updatedAt: "T2" });
  });

  it("memangkas spasi key dan value", () => {
    expect(upsertFact([], "  hobi  ", "  coding  ")[0]).toMatchObject({ key: "hobi", value: "coding" });
  });
});

describe("removeFact & findFact", () => {
  const facts = [fact("nama", "Rydz"), fact("hobi", "coding")];

  it("menghapus berdasarkan key tanpa peduli huruf besar-kecil", () => {
    expect(removeFact(facts, "NAMA").map((f) => f.key)).toEqual(["hobi"]);
  });

  it("mencari fakta", () => {
    expect(findFact(facts, "Hobi")?.value).toBe("coding");
    expect(findFact(facts, "tiada")).toBeUndefined();
  });
});

describe("formatFacts", () => {
  it("merender daftar markdown dan menghormati batas karakter", () => {
    const facts = [fact("a", "1"), fact("b", "2"), fact("c", "3")];
    expect(formatFacts(facts)).toBe("- a: 1\n- b: 2\n- c: 3");
    expect(formatFacts(facts, 8)).toBe("- a: 1");
  });

  it("mengembalikan kosong bila tidak ada fakta", () => {
    expect(formatFacts([])).toBe("");
  });
});

describe("looksSecret", () => {
  it("mendeteksi kata kunci rahasia", () => {
    expect(looksSecret("API key rahasia")).toBe(true);
    expect(looksSecret("password")).toBe(true);
    expect(looksSecret("token")).toBe(true);
  });

  it("meloloskan fakta biasa", () => {
    expect(looksSecret("hobi saya coding")).toBe(false);
    expect(looksSecret("Rydz")).toBe(false);
  });
});

describe("readFacts/writeFacts", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "nex-memory-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("menyimpan lalu membaca kembali", async () => {
    await writeFacts(dir, [fact("nama", "Rydz")]);
    expect(await readFacts(dir)).toEqual([fact("nama", "Rydz")]);
  });

  it("menulis berkas dengan izin 600", async () => {
    await writeFacts(dir, [fact("nama", "Rydz")]);
    const stat = await fs.stat(memoryFilePath(dir));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("berkas hilang atau rusak → daftar kosong", async () => {
    expect(await readFacts(dir)).toEqual([]);
    await fs.writeFile(memoryFilePath(dir), "{bukan json", "utf8");
    expect(await readFacts(dir)).toEqual([]);
    await fs.writeFile(memoryFilePath(dir), JSON.stringify({ facts: [{ key: 1 }] }), "utf8");
    expect(await readFacts(dir)).toEqual([]);
  });

  it("membatasi jumlah fakta", async () => {
    const many = Array.from({ length: MAX_FACTS + 20 }, (_, i) => fact(`k${i}`, `v${i}`));
    await writeFacts(dir, many);
    expect(await readFacts(dir)).toHaveLength(MAX_FACTS);
  });
});
