import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatResumePreview } from "../src/cli/resume_preview.js";
import { setColorEnabled } from "../src/util/color.js";
import type { NeutralMessage } from "../src/core/types.js";

function turn(role: NeutralMessage["role"], content: string): NeutralMessage {
  return { role, content };
}

describe("formatResumePreview", () => {
  beforeEach(() => setColorEnabled(false));
  afterEach(() => setColorEnabled(false));

  it("mengembalikan string kosong bila tidak ada giliran percakapan", () => {
    expect(formatResumePreview([])).toBe("");
    expect(formatResumePreview([turn("system", "kamu adalah agen")])).toBe("");
    expect(formatResumePreview([turn("assistant", "   ")])).toBe("");
  });

  it("meniru tampilan chat: pesan user berprefiks mode, jawaban asisten polos", () => {
    const out = formatResumePreview(
      [turn("user", "halo"), turn("assistant", "hai, ada yang bisa dibantu?")],
      { mode: "build" },
    );
    expect(out).toContain("[build] › halo");
    expect(out).toContain("hai, ada yang bisa dibantu?");
    // Tanpa label peran apa pun.
    expect(out).not.toContain("kamu");
    expect(out).not.toContain("asisten");
  });

  it("memakai mode sesi pada prefiks prompt", () => {
    const out = formatResumePreview([turn("user", "baca file a")], { mode: "plan" });
    expect(out).toContain("[plan] › baca file a");
  });

  it("menyembunyikan pesan tool dan hanya menyisakan giliran percakapan", () => {
    const out = formatResumePreview([
      turn("user", "baca file a"),
      turn("tool", "isi file a yang sangat panjang"),
      turn("assistant", "sudah dibaca"),
    ]);
    expect(out).not.toContain("isi file a");
    expect(out).toContain("baca file a");
    expect(out).toContain("sudah dibaca");
  });

  it("hanya menampilkan sejumlah giliran terakhir dan memberi tahu sisanya", () => {
    const history: NeutralMessage[] = [];
    for (let i = 1; i <= 5; i++) history.push(turn("user", `pesan ${i}`));
    const out = formatResumePreview(history, { maxMessages: 2 });
    expect(out).toContain("pesan 4");
    expect(out).toContain("pesan 5");
    expect(out).not.toContain("pesan 3");
    expect(out).toContain("…(3 pesan sebelumnya tidak ditampilkan)");
  });

  it("memotong pesan yang panjang menjadi beberapa baris dengan elipsis", () => {
    const long = ["baris satu", "baris dua", "baris tiga", "baris empat"].join("\n");
    const out = formatResumePreview([turn("user", long)], { maxLines: 2 });
    expect(out).toContain("baris satu");
    expect(out).toContain("baris dua");
    expect(out).not.toContain("baris tiga");
    expect(out).toContain("…");
  });

  it("memotong baris yang terlalu panjang", () => {
    const out = formatResumePreview([turn("assistant", "a".repeat(50))], { maxLineLength: 10 });
    expect(out).toContain(`${"a".repeat(9)}…`);
  });

  it("menyelaraskan baris lanjutan pesan user dengan isi prompt", () => {
    const out = formatResumePreview([turn("user", "baris satu\nbaris dua")], { mode: "build" });
    // "  " + "[build] › " = 12 karakter sebelum "baris dua".
    expect(out).toContain("            baris dua");
  });
});
