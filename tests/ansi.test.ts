import { describe, expect, it } from "vitest";
import {
  decodeOtherKeys,
  isCtrlTab,
  isOtherKeysPartial,
  isPrintableText,
  normalizeKey,
  stripAnsi,
  truncateTo,
  visibleWidth,
  wrapAnsi,
} from "../src/util/ansi.js";

const RED = "\u001b[31m";
const RESET = "\u001b[39m";

describe("ansi: visibleWidth & stripAnsi", () => {
  it("menghitung lebar teks ASCII", () => {
    expect(visibleWidth("halo")).toBe(4);
  });

  it("mengabaikan urutan escape ANSI", () => {
    expect(visibleWidth(`${RED}halo${RESET}`)).toBe(4);
    expect(stripAnsi(`${RED}halo${RESET}`)).toBe("halo");
  });

  it("menghitung karakter lebar ganda (CJK) sebagai 2", () => {
    expect(visibleWidth("漢")).toBe(2);
    expect(visibleWidth("漢字")).toBe(4);
  });
});

describe("ansi: wrapAnsi", () => {
  it("membungkus teks ke lebar maksimum", () => {
    const lines = wrapAnsi("abcdef", 3);
    expect(lines.map((l) => l.line)).toEqual(["abc", "def"]);
  });

  it("mempertahankan pewarna dan menutupnya di akhir potongan", () => {
    const lines = wrapAnsi(`${RED}abcd${RESET}`, 2);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.line).toBe(`${RED}ab\u001b[0m`);
    // potongan kedua membuka ulang warna lalu di-reset di akhir.
    expect(lines[1]!.line.startsWith(RED)).toBe(true);
    expect(lines[1]!.line.endsWith(RESET)).toBe(true);
  });

  it("mempertahankan baris kosong", () => {
    const lines = wrapAnsi("a\n\nb", 10);
    expect(lines.map((l) => l.line)).toEqual(["a", "", "b"]);
  });
});

describe("ansi: truncateTo", () => {
  it("membiarkan teks yang muat", () => {
    expect(truncateTo("abc", 5)).toBe("abc");
  });

  it("memotong dan menyisipkan elipsis", () => {
    const out = truncateTo("abcdefgh", 4);
    expect(visibleWidth(out)).toBe(4);
    expect(out.endsWith("…")).toBe(true);
  });

  it("menghitung lebar tampilan saat memotong teks ber-pewarna", () => {
    const out = truncateTo(`${RED}abcdef${RESET}`, 4);
    expect(stripAnsi(out)).toBe("abc…");
  });
});

describe("ansi: isPrintableText", () => {
  it("menerima huruf, angka, dan simbol", () => {
    expect(isPrintableText("a")).toBe(true);
    expect(isPrintableText("A")).toBe(true);
    expect(isPrintableText("/")).toBe(true);
    expect(isPrintableText(" ")).toBe(true);
    expect(isPrintableText("a1/~")).toBe(true);
  });

  it("menolak teks kosong dan karakter kontrol/escape", () => {
    expect(isPrintableText("")).toBe(false);
    expect(isPrintableText("\u001b[A")).toBe(false);
    expect(isPrintableText("\r")).toBe(false);
    expect(isPrintableText("\t")).toBe(false);
    expect(isPrintableText("\u007f")).toBe(false);
  });
});

describe("ansi: normalisasi key", () => {
  it("menandai Ctrl+Tab dari urutan terminal umum", () => {
    const key = normalizeKey({ sequence: "\u001b[27;5;9~" });
    expect(key.name).toBe("tab");
    expect(isCtrlTab(key)).toBe(true);
  });

  it("mengenali Ctrl+Tab dari flag ctrl + sequence tab", () => {
    const key = normalizeKey({ ctrl: true, sequence: "\t" });
    expect(isCtrlTab(key)).toBe(true);
  });

  it("bukan Ctrl+Tab untuk tab biasa", () => {
    const key = normalizeKey({ name: "tab", sequence: "\t" });
    expect(isCtrlTab(key)).toBe(false);
  });

  it("meneruskan key biasa apa adanya", () => {
    const key = normalizeKey({ name: "up", sequence: "\u001b[A" });
    expect(key.name).toBe("up");
    expect(key.sequence).toBe("\u001b[A");
    expect(key.ctrl).toBe(false);
  });

  it("mengenali Ctrl+Tab walau readline memberi name 'undefined' (string)", () => {
    // Bentuk nyata dari readline untuk urutan CSI yang tak dikenali.
    const key = normalizeKey({ name: "undefined", ctrl: true, sequence: "\u001b[9;5~" });
    expect(key.name).toBe("tab");
    expect(isCtrlTab(key)).toBe(true);
  });

  it("isCtrlTab berdasar urutan mentah walau name bukan 'tab'", () => {
    expect(isCtrlTab(normalizeKey({ sequence: "\u001b[1;5I" }))).toBe(true);
    expect(isCtrlTab(normalizeKey({ sequence: "\u001b[1;5z" }))).toBe(true);
    expect(isCtrlTab(normalizeKey({ sequence: "\u001b[27;5;9~" }))).toBe(true);
  });

  it("decodeOtherKeys memetakan CSI 27;5;9~ ke Ctrl+Tab", () => {
    const key = decodeOtherKeys("\u001b[27;5;9~");
    expect(key?.name).toBe("tab");
    expect(key?.ctrl).toBe(true);
    expect(key?.shift).toBe(false);
    expect(isOtherKeysPartial("\u001b[27;5;9~")).toBe(false);
  });

  it("isOtherKeysPartial menandai fragmen yang terpecah", () => {
    expect(isOtherKeysPartial("\u001b[27;5;")).toBe(true);
    expect(isOtherKeysPartial("\u001b[27;5;9")).toBe(true);
    expect(isOtherKeysPartial("9")).toBe(false);
    expect(isOtherKeysPartial("\u001b[A")).toBe(false);
  });

  it("decodeOtherKeys mengabaikan kode non-Tab tanpa bocor ke input", () => {
    // Kode 13 (Enter) tetap non-cetak agar tidak diketik sebagai teks.
    const key = decodeOtherKeys("\u001b[27;5;13~");
    expect(key).not.toBeNull();
    expect(key?.name).toBeUndefined();
    expect(isPrintableText(key!.sequence)).toBe(false);
  });

  it("Shift+Tab bukan Ctrl+Tab", () => {
    expect(isCtrlTab(normalizeKey({ name: "tab", shift: true, sequence: "\u001b[Z" }))).toBe(false);
  });
});
