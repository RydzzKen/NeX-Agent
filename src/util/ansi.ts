/**
 * Utilitas ANSI/terminal murni (tanpa I/O): hitung lebar tampilan, bungkus
 * teks ber-pewarna, dan normalisasi keypress. Dipakai TUI dan ikut teruji.
 */

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Lebar tampilan satu karakter (wide = 2, sisanya 1). */
function charWidth(ch: string): number {
  const code = ch.codePointAt(0)!;
  if (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (0x2e80 <= code && code <= 0xa4cf && code !== 0x303f) ||
      (0xac00 <= code && code <= 0xd7a3) ||
      (0xf900 <= code && code <= 0xfaff) ||
      (0xfe10 <= code && code <= 0xfe19) ||
      (0xfe30 <= code && code <= 0xfe6f) ||
      (0xff00 <= code && code <= 0xff60) ||
      (0xffe0 <= code && code <= 0xffe6) ||
      (0x20000 <= code && code <= 0x2fffd))
  ) {
    return 2;
  }
  return 1;
}

/** Lebar tampilan teks, mengabaikan urutan escape ANSI. */
export function visibleWidth(text: string): number {
  let width = 0;
  for (const ch of stripAnsi(text)) width += charWidth(ch);
  return width;
}

/** Buang semua urutan escape ANSI. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

export interface WrappedLine {
  /** Baris asli (mungkin tidak di-bungkus bila muat). */
  raw: string;
  /** Potongan yang ditampilkan (pewarna dipertahankan). */
  line: string;
}

const RESET_RE = /\[0m$|\[39m$|\[22m$|\[24m$|\[23m$|\[29m$/;

/**
 * Bungkus teks (termasuk pewarna ANSI) agar ≤ `width` kolom. Urutan escape
 * tidak dihitung sebagai karakter. Baris kosong dipertahankan.
 */
export function wrapAnsi(text: string, width: number): WrappedLine[] {
  if (width < 1) width = 1;
  const lines: WrappedLine[] = [];
  for (const raw of text.split("\n")) {
    if (raw.length === 0) {
      lines.push({ raw, line: "" });
      continue;
    }
    lines.push(...wrapSingle(raw, width));
  }
  return lines;
}

function wrapSingle(raw: string, width: number): WrappedLine[] {
  const out: WrappedLine[] = [];
  let current = "";
  let currentWidth = 0;
  let openAnsi = "";

  const push = (): void => {
    out.push({ raw, line: current + (openAnsi ? "\u001b[0m" : "") });
    current = openAnsi;
    currentWidth = 0;
  };

  for (let i = 0; i < raw.length; ) {
    if (raw[i] === "\u001b") {
      const match = /\u001b\[[0-9;?]*[ -/]*[@-~]/.exec(raw.slice(i));
      if (!match) break;
      const seq = match[0];
      current += seq;
      if (seq.endsWith("m")) {
        if (RESET_RE.test(seq)) openAnsi = "";
        else openAnsi = seq;
      }
      i += seq.length;
      continue;
    }
    const ch = raw[i]!;
    const w = ch === "\t" ? 4 : charWidth(ch);
    if (currentWidth + w > width && currentWidth > 0) push();
    current += ch;
    currentWidth += w;
    i += 1;
  }
  if (current.length > 0 || out.length === 0) out.push({ raw, line: current + (openAnsi ? "\u001b[0m" : "") });
  return out;
}

/** Semantik tombol yang dikenali TUI. */
export interface Key {
  /** Nama tombol (bila dikenali readline): tab, return, esc, up, left, … */
  name?: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  /** Urutan mentah dari terminal. */
  sequence: string;
}

/** Key bertanda Ctrl+Tab (urutan bervariasi antar terminal). */
const CTRL_TAB_SEQUENCES = new Set([
  "\u001b[27;5;9~",
  "\u001b[9;5~",
  "\u001b[1;5I",
  "\u001b[1;5z",
]);

/**
 * Normalisasi hasil event keypress ke bentuk `Key` dengan penanganan Ctrl+Tab
 * (readline memberi `name: undefined` untuk urutan semacam itu).
 */
export function normalizeKey(key: {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}): Key {
  const ctrl = key.ctrl === true;
  const meta = key.meta === true;
  const shift = key.shift === true;
  const sequence = key.sequence ?? "";
  // readline memberi `name: "undefined"` (string) untuk urutan escape yang tak
  // dikenali — perlakukan sebagai tanpa nama agar pemetaan di bawah aktif.
  let name = key.name;
  if (name === "undefined" || name === "") name = undefined;
  if (!name && CTRL_TAB_SEQUENCES.has(sequence)) name = "tab";
  if (!name && ctrl && sequence === "\t") name = "tab";
  return { name, ctrl, meta, shift, sequence };
}

/** True bila key merupakan Ctrl+Tab (apa pun bagaimana terminal mengirimnya). */
export function isCtrlTab(key: Key): boolean {
  // Cek urutan mentah lebih dulu: readline kadang memberi `name` yang aneh
  // ("undefined") sehingga pengecekan berbasis nama saja tidak cukup.
  if (CTRL_TAB_SEQUENCES.has(key.sequence)) return true;
  return key.name === "tab" && key.ctrl;
}

/** Awalan urutan `modifyOtherKeys` xterm: `CSI 27 ; <mod> ; <kode> ~`. */
export const OTHER_KEYS_PREFIX = "\u001b[27;";

/** True bila urutan adalah fragmen `modifyOtherKeys` yang belum lengkap. */
export function isOtherKeysPartial(sequence: string): boolean {
  return sequence.startsWith(OTHER_KEYS_PREFIX) && !sequence.endsWith("~");
}

/**
 * Terjemahkan urutan lengkap `CSI 27 ; <mod> ; <kode> ~` (format
 * `modifyOtherKeys` xterm) menjadi `Key`. Mengembalikan `null` bila bukan
 * polanya. Kode 9 (Tab) dipetakan ke `tab`; kode lain dibiarkan tanpa nama
 * dengan urutan mentah (non-cetak) agar tidak bocor ke baris input.
 */
export function decodeOtherKeys(sequence: string): Key | null {
  const match = /^\u001b\[27;(\d+);(\d+)~$/.exec(sequence);
  if (!match) return null;
  const bits = Number(match[1]) - 1;
  const code = Number(match[2]);
  return {
    name: code === 9 ? "tab" : undefined,
    ctrl: (bits & 4) !== 0,
    shift: (bits & 1) !== 0,
    meta: (bits & 2) !== 0,
    sequence,
  };
}

/**
 * True bila teks hanya berisi karakter yang dapat dicetak (bukan kontrol/escape).
 * Dipakai untuk membedakan input pengguna dari urutan tombol khusus.
 */
export function isPrintableText(text: string): boolean {
  if (text.length === 0) return false;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** Potong teks ke maksimum kolom tampilan, sisipkan "…". */
export function truncateTo(text: string, max: number): string {
  if (visibleWidth(text) <= max) return text;
  let out = "";
  let w = 0;
  for (let i = 0; i < text.length; ) {
    if (text[i] === "\u001b") {
      const match = /\u001b\[[0-9;?]*[ -/]*[@-~]/.exec(text.slice(i));
      if (!match) break;
      out += match[0];
      i += match[0].length;
      continue;
    }
    const ch = text[i]!;
    const cw = charWidth(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
    i += 1;
  }
  return out + "…";
}