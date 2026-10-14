import { describe, expect, it } from "vitest";
import {
  decodeOtherKeys,
  decodeSgrMouse,
  highlightColumns,
  isCtrlTab,
  isOtherKeysPartial,
  isPrintableText,
  isSgrMousePartial,
  normalizeKey,
  sliceByColumns,
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

describe("ansi: mouse SGR (roda)", () => {
  it("mendeteksi roda naik dan turun", () => {
    const up = decodeSgrMouse("\u001b[<64;10;5M");
    expect(up?.wheelUp).toBe(true);
    expect(up?.wheelDown).toBe(false);
    expect(up?.button).toBe(64);
    expect(up?.x).toBe(10);
    expect(up?.y).toBe(5);
    expect(up?.press).toBe(true);

    const down = decodeSgrMouse("\u001b[<65;10;5M");
    expect(down?.wheelDown).toBe(true);
    expect(down?.wheelUp).toBe(false);
  });

  it("mengabaikan urutan yang bukan mouse atau bukan roda", () => {
    expect(decodeSgrMouse("\u001b[A")).toBeNull();
    expect(decodeSgrMouse("\u001b[<0;10;5M")?.wheelUp).toBe(false);
    expect(decodeSgrMouse("\u001b[<0;10;5M")?.wheelDown).toBe(false);
  });

  it("menandai fragmen mouse yang terpecah", () => {
    expect(isSgrMousePartial("\u001b[<")).toBe(true);
    expect(isSgrMousePartial("\u001b[<64;10;5")).toBe(true);
    expect(isSgrMousePartial("\u001b[<64;10;5M")).toBe(false);
    expect(isSgrMousePartial("6")).toBe(false);
    expect(isSgrMousePartial("\u001b[A")).toBe(false);
  });

  it("mengenali tekan/seret/lepas tombol kiri", () => {
    const press = decodeSgrMouse("\u001b[<0;3;4M");
    expect(press?.left).toBe(true);
    expect(press?.motion).toBe(false);
    expect(press?.press).toBe(true);

    const drag = decodeSgrMouse("\u001b[<32;3;4M");
    expect(drag?.left).toBe(true);
    expect(drag?.motion).toBe(true);
    expect(drag?.press).toBe(true);

    const release = decodeSgrMouse("\u001b[<0;3;4m");
    expect(release?.left).toBe(true);
    expect(release?.motion).toBe(false);
    expect(release?.press).toBe(false);

    // Klik kanan (kode 2) bukan tombol kiri.
    expect(decodeSgrMouse("\u001b[<2;3;4M")?.left).toBe(false);
    // Roda bukan tombol kiri maupun gerak.
    expect(decodeSgrMouse("\u001b[<64;3;4M")?.left).toBe(false);
    expect(decodeSgrMouse("\u001b[<64;3;4M")?.motion).toBe(false);
  });
});

describe("ansi: potong & sorot kolom", () => {
  it("sliceByColumns mengambil rentang kolom inklusif", () => {
    expect(sliceByColumns("hello world", 0, 4)).toBe("hello");
    expect(sliceByColumns("hello world", 6, 10)).toBe("world");
    expect(sliceByColumns("hello", 2, 2)).toBe("l");
    expect(sliceByColumns("hello", 4, 1)).toBe("");
    // Escape ANSI tidak dihitung sebagai kolom.
    expect(sliceByColumns("\u001b[31mabc\u001b[0mdef", 2, 4)).toBe("cde");
  });

  it("sliceByColumns menghitung karakter lebar (CJK) sebagai 2 kolom", () => {
    // "あい" = 4 kolom; "xあ" → kolom 0 = x, 1..2 = あ.
    expect(sliceByColumns("xあy", 1, 2)).toBe("あ");
    expect(sliceByColumns("xあy", 0, 0)).toBe("x");
    expect(sliceByColumns("xあy", 3, 3)).toBe("y");
  });

  it("highlightColumns membungkus rentang kolom dengan video terbalik", () => {
    expect(highlightColumns("abcdef", 1, 3)).toBe("a\u001b[7mbcd\u001b[27mef");
    expect(highlightColumns("abcdef", 0, 5)).toBe("\u001b[7mabcdef\u001b[27m");
    expect(highlightColumns("abcdef", 2, 2)).toBe("ab\u001b[7mc\u001b[27mdef");
    // Rentang di luar teks tidak mengubah apa pun.
    expect(highlightColumns("abc", 5, 9)).toBe("abc");
  });

  it("highlightColumns mempertahankan warna dan menghitung escape bukan kolom", () => {
    const out = highlightColumns("\u001b[31mabc\u001b[0m", 1, 1);
    expect(out).toBe("\u001b[31ma\u001b[7mb\u001b[27mc\u001b[0m");
  });
});
