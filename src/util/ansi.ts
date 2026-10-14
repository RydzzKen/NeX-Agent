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

/** Awalan urutan mouse SGR xterm (mode 1006): `ESC [ <`. */
export const SGR_MOUSE_PREFIX = "\u001b[<";

export interface SgrMouseEvent {
  /** Kode tombol xterm (bit mask; roda = bit 64, gerak = bit 32). */
  button: number;
  /** Roda digulir ke atas. */
  wheelUp: boolean;
  /** Roda digulir ke bawah. */
  wheelDown: boolean;
  /** Tombol kiri ditekan/dilepas (bukan roda). */
  left: boolean;
  /** Event gerak saat tombol ditahan (butuh mode 1002/1003). */
  motion: boolean;
  /** Kolom/baris (1-based). */
  x: number;
  y: number;
  /** True = tombol ditekan; false = dilepas. */
  press: boolean;
}

/** True bila urutan adalah fragmen mouse SGR yang belum lengkap. */
export function isSgrMousePartial(sequence: string): boolean {
  return sequence.startsWith(SGR_MOUSE_PREFIX) && !/[Mm]$/.test(sequence);
}

/**
 * Terjemahkan urutan lengkap mouse SGR xterm (`CSI < b ; x ; y M|m`) menjadi
 * event. Mengembalikan `null` bila bukan polanya. Roda (bit 64) dipetakan ke
 * `wheelUp` (kode genap) / `wheelDown` (kode ganjil).
 */
export function decodeSgrMouse(sequence: string): SgrMouseEvent | null {
  const match = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(sequence);
  if (!match) return null;
  const button = Number(match[1]);
  const isWheel = (button & 64) === 64;
  const isMotion = (button & 32) === 32;
  return {
    button,
    wheelUp: isWheel && (button & 1) === 0,
    wheelDown: isWheel && (button & 1) === 1,
    left: !isWheel && (button & 3) === 0,
    motion: isMotion,
    x: Number(match[2]),
    y: Number(match[3]),
    press: match[4] === "M",
  };
}

/**
 * Ambil potongan teks tampilan pada rentang kolom `[from, to]` (inklusif,
 * 0-based). Escape ANSI dibuang; karakter lebar (CJK) dihitung 2 kolom.
 */
export function sliceByColumns(text: string, from: number, to: number): string {
  if (to < from) return "";
  const plain = stripAnsi(text);
  let out = "";
  let col = 0;
  for (const ch of plain) {
    const w = ch === "\t" ? 4 : charWidth(ch);
    const startCol = col;
    const endCol = col + w - 1;
    col += w;
    if (endCol < from) continue;
    if (startCol > to) break;
    out += ch;
  }
  return out;
}

/**
 * Bungkus rentang kolom `[from, to]` (inklusif) dengan video terbalik
 * (`\u001b[7m`/`\u001b[27m`) sambil mempertahankan warna/atribut lain. Escape
 * ANSI tidak dihitung sebagai kolom. Dipakai untuk menyorot seleksi mouse.
 */
export function highlightColumns(text: string, from: number, to: number): string {
  if (to < from) return text;
  let out = "";
  let col = 0;
  let on = false;
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\u001b") {
      const match = /^\u001b\[[0-9;?]*[ -/]*[@-~]/.exec(text.slice(i));
      if (!match) break;
      out += match[0];
      i += match[0].length;
      continue;
    }
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    const w = ch === "\t" ? 4 : charWidth(ch);
    const startCol = col;
    const endCol = col + w - 1;
    const selected = endCol >= from && startCol <= to;
    if (selected && !on) {
      out += "\u001b[7m";
      on = true;
    } else if (!selected && on) {
      out += "\u001b[27m";
      on = false;
    }
    out += ch;
    col += w;
    i += ch.length;
  }
  if (on) out += "\u001b[27m";
  return out;
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