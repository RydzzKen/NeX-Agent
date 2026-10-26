import { color, colorEnabled, truecolorSupported } from "../../util/color.js";
import { truncateTo, visibleWidth } from "../../util/ansi.js";

/**
 * Tema TUI NeX-Agent.
 *
 * Palet mengikuti `TUI.md`; chrome lama ("bulan") tetap diekspor sementara
 * sampai layar baru selesai dibangun, supaya perubahan bisa bertahap tanpa
 * memutus renderer yang sedang berjalan.
 */

export type Rgb = [number, number, number];

// ---------------------------------------------------------------------------
// Palet baru
// ---------------------------------------------------------------------------

export interface ThemePalette {
  bg: string;
  panel: string;
  border: string;
  text: string;
  muted: string;
  dim: string;
  build: string;
  plan: string;
  success: string;
  error: string;
  diffAddBg: string;
  diffDelBg: string;
  tool: string;
  tip: string;
}

/** Palet `opencode` — sumber: TUI.md. */
export const PALETTE: ThemePalette = {
  bg: "#0a0a0a",
  panel: "#141414",
  border: "#2a2a2a",
  text: "#eeeeee",
  muted: "#808080",
  dim: "#6b6b6b",
  build: "#5c9cf5",
  plan: "#f5a742",
  success: "#7fd88f",
  error: "#e06c75",
  diffAddBg: "#10231a",
  diffDelBg: "#2a1512",
  tool: "#9d7cd8",
  tip: "#e5a14d",
};

export type ThemeName = "opencode" | "mint";

export const THEME_NAMES: readonly ThemeName[] = ["opencode", "mint"] as const;

const MINT: ThemePalette = {
  ...PALETTE,
  // Aksen build versi mint; plan tetap hangat agar dua mode tetap kontras.
  build: "#7fd8b0",
};

const THEMES: Record<ThemeName, ThemePalette> = {
  opencode: PALETTE,
  mint: MINT,
};

export function themePalette(name: ThemeName): ThemePalette {
  return THEMES[name];
}

export function isThemeName(value: string): value is ThemeName {
  return (THEME_NAMES as readonly string[]).includes(value);
}

/** Aksen sesuai mode; mode tak dikenal memakai aksen build. */
export function modeAccent(mode: string, palette: ThemePalette = PALETTE): string {
  return mode.trim().toLowerCase() === "plan" ? palette.plan : palette.build;
}

// ---------------------------------------------------------------------------
// Warna + fallback truecolor → 256 → 16 → tanpa warna
// ---------------------------------------------------------------------------

export type ColorLevel = 0 | 1 | 2 | 3;

/**
 * Deteksi kemampuan warna. `level` bisa dipaksa lewat parameter untuk tes.
 * NO_COLOR selalu menang; FORCE_COLOR bisa menaikkan level.
 */
export function detectColorLevel(env: NodeJS.ProcessEnv = process.env): ColorLevel {
  if (env.NO_COLOR !== undefined) return 0;
  if (env.FORCE_COLOR === "0") return 0;
  if (env.FORCE_COLOR === "true") return 1;

  const forced = Number(env.FORCE_COLOR);
  if (Number.isFinite(forced) && forced > 0) {
    if (forced >= 3) return 3;
    if (forced >= 2) return 2;
    return 1;
  }

  if (!colorEnabled()) return 0;

  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") return 3;
  const term = env.TERM ?? "";
  if (term.includes("256color") || term.includes("direct")) return 2;
  return 1;
}

function parseHex(hex: string): Rgb | undefined {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return undefined;
  let value = match[1]!;
  if (value.length === 3) {
    value = value
      .split("")
      .map((ch) => ch + ch)
      .join("");
  }
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;

function nearestLevel(value: number): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < CUBE_LEVELS.length; i += 1) {
    const distance = Math.abs(value - CUBE_LEVELS[i]!);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/** Indeks xterm-256 terdekat untuk sebuah warna RGB. */
export function rgbTo256(r: number, g: number, b: number): number {
  const ri = nearestLevel(r);
  const gi = nearestLevel(g);
  const bi = nearestLevel(b);
  const cube = 16 + 36 * ri + 6 * gi + bi;
  const cubeDistance =
    (r - CUBE_LEVELS[ri]!) ** 2 +
    (g - CUBE_LEVELS[gi]!) ** 2 +
    (b - CUBE_LEVELS[bi]!) ** 2;

  let grayIndex = 232;
  let grayDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 24; i += 1) {
    const level = 8 + i * 10;
    const distance = (r - level) ** 2 + (g - level) ** 2 + (b - level) ** 2;
    if (distance < grayDistance) {
      grayDistance = distance;
      grayIndex = 232 + i;
    }
  }

  return grayDistance < cubeDistance ? grayIndex : cube;
}

/** Tabel ANSI 16 warna standar (xterm). */
const ANSI16_RGB: readonly Rgb[] = [
  [0, 0, 0],
  [128, 0, 0],
  [0, 128, 0],
  [128, 128, 0],
  [0, 0, 128],
  [128, 0, 128],
  [0, 128, 128],
  [192, 192, 192],
  [128, 128, 128],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [0, 0, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
];

function rgbTo16(r: number, g: number, b: number): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < ANSI16_RGB.length; i += 1) {
    const [cr, cg, cb] = ANSI16_RGB[i]!;
    const distance = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

function ansi16Code(index: number, background: boolean): string {
  const base = index < 8 ? 30 + index : 90 + (index - 8);
  return String(background ? base + 10 : base);
}

function colorCode(hex: string, background: boolean, level: ColorLevel): string | undefined {
  const rgb = parseHex(hex);
  if (!rgb) return undefined;
  const prefix = background ? "48" : "38";
  if (level === 3) return `${prefix};2;${rgb.join(";")}`;
  if (level === 2) return `${prefix};5;${rgbTo256(...rgb)}`;
  if (level === 1) return ansi16Code(rgbTo16(...rgb), background);
  return undefined;
}

/**
 * Warnai teks dengan foreground/background opsional. Penutup hanya melepas
 * warna yang dipasang (`39`/`49`), bukan reset penuh, agar bisa disarangkan.
 */
export function style(
  text: string,
  fgHex?: string | null,
  bgHex?: string | null,
  level: ColorLevel = detectColorLevel(),
): string {
  if (level === 0 || text.length === 0) return text;
  const fgCode = fgHex ? colorCode(fgHex, false, level) : undefined;
  const bgCode = bgHex ? colorCode(bgHex, true, level) : undefined;
  if (!fgCode && !bgCode) return text;

  const open = [fgCode, bgCode].filter((code): code is string => Boolean(code)).join(";");
  const close = [fgCode ? "39" : "", bgCode ? "49" : ""].filter(Boolean).join(";");
  return `\u001b[${open}m${text}\u001b[${close}m`;
}

export function fg(hex: string, text: string, level: ColorLevel = detectColorLevel()): string {
  return style(text, hex, undefined, level);
}

export function bg(hex: string, text: string, level: ColorLevel = detectColorLevel()): string {
  return style(text, undefined, hex, level);
}

// ---------------------------------------------------------------------------
// Logo
// ---------------------------------------------------------------------------

export interface LogoOptions {
  /** Lebar terminal; `< 60` memakai logo satu baris. */
  cols: number;
  level?: ColorLevel;
  palette?: ThemePalette;
}

const NEX_BLOCK = [
  ["█▄ █ █▀▀ ", "▀▄▀"],
  ["█ ▀█ ██▄ ", "█ █"],
] as const;

/**
 * Logo `NeX` blok besar: "Ne" redup, "X" terang, lalu "A G E N T".
 * Terminal sempit memakai satu baris `NeX-Agent`.
 */
export function logoNeX(opts: LogoOptions): string[] {
  const palette = opts.palette ?? PALETTE;
  const level = opts.level ?? detectColorLevel();
  const cols = Math.max(1, Math.floor(opts.cols));

  const compactLine = fg(palette.dim, "NeX", level) + fg(palette.text, "-Agent", level);
  if (cols < 60) return [truncateTo(compactLine, cols)];

  const lines = NEX_BLOCK.map(([ne, x]) => fg(palette.dim, ne, level) + fg(palette.text, x, level));
  if (visibleWidth(lines[0]!) > cols) return [truncateTo(compactLine, cols)];

  return [...lines, fg(palette.muted, "A G E N T", level)];
}

/** Spinner dengan aksen mode; simbol dipilih bergiliran. */
export function spinnerFrame(
  tick: number,
  symbols: string[],
  accent: string,
  level: ColorLevel = detectColorLevel(),
): string {
  const count = Math.max(1, symbols.length);
  const symbol = symbols[tick % count] ?? symbols[0] ?? "⠋";
  return fg(accent, symbol, level);
}

// ---------------------------------------------------------------------------
// Chrome lama ("bulan") — dipertahankan sementara untuk renderer lama.
// ---------------------------------------------------------------------------

/** Ramp bulan persis seperti logo awal: hitam (35) → abu (175). */
export const MOON_RAMP: Rgb[] = [
  [35, 35, 35],
  [70, 70, 70],
  [105, 105, 105],
  [140, 140, 140],
  [175, 175, 175],
];

/** Abu terang untuk wordmark (logo awal memakai 200). */
export const WORD_GRAY = 200;

/** Nilai abu logo untuk t dalam [0,1]: 35 + t * 140. */
export function moonGray(t: number): number {
  const cl = Math.max(0, Math.min(1, t));
  return Math.round(35 + cl * 140);
}

function useTruecolor(): boolean {
  return colorEnabled() && truecolorSupported;
}

/**
 * Warnai teks dengan abu RGB; bila truecolor tidak tersedia, pakai ANSI dasar
 * yang paling dekat (tetap monokrom, bukan warna-warni).
 */
export function styleRgb(r: number, g: number, b: number, s: string): string {
  if (!useTruecolor()) {
    const v = Math.round((r + g + b) / 3);
    if (v < 70) return color.dim(s);
    if (v < 130) return color.gray(s);
    return color.bold(s);
  }
  const cl = (x: number) => Math.max(0, Math.min(255, Math.round(x)));
  return `\u001b[38;2;${cl(r)};${cl(g)};${cl(b)}m${s}\u001b[0m`;
}

/** Warnai satu karakter dengan nilai abu logo (35..175). */
export function moonAccent(s: string, t = 1): string {
  const v = moonGray(t);
  return styleRgb(v, v, v, s);
}

/**
 * Banner logo bulan sabit + wordmark, mengikuti geometri `logo.js`
 * (lingkaran besar dipotong lingkaran kecil, digambar pada grid karakter).
 *
 * @param cols lebar terminal (dipakai sebagai batas atas)
 * @param rows tinggi banner dalam baris (default 8)
 */
export function logoBanner(cols: number, rows = 8): string[] {
  const word = "NeX-Agent";
  const H = Math.max(5, Math.min(rows, 20));
  // Rasio asli: 40 kolom × 21 baris untuk bidang logis 19.5 × 20.
  const width = Math.min(cols, Math.max(word.length, Math.round(H * 1.955)));

  // Terminal terlalu sempit: pakai versi satu baris.
  if (cols < word.length + 6 || width < 12) {
    return [" " + moonAccent("◐", 0.85) + " " + styleRgb(WORD_GRAY, WORD_GRAY, WORD_GRAY, word)];
  }

  // Ruang koordinat logo awal (px = x/2, 21 baris). Bulan sabit membentang
  // di kotak [1,19] × [1,19]: lingkaran besar (10,10,r9) dipotong (13.5,8,r7.5).
  const LO = 1;
  const HI = 19;
  const span = HI - LO;
  const inCrescent = (lx: number, ly: number): boolean =>
    Math.hypot(lx - 10, ly - 10) <= 9 && Math.hypot(lx - 13.5, ly - 8) > 7.5;

  // Supersampling 4x4 per sel + karakter bayangan agar bentuk tetap halus.
  const S = 4;
  const SHADES = ["", "░", "▒", "▓", "█"];
  const lines: string[] = [];
  for (let y = 0; y < H; y++) {
    let line = "";
    for (let x = 0; x < width; x++) {
      let hits = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const lx = LO + ((x + (sx + 0.5) / S) / width) * span;
          const ly = LO + ((y + (sy + 0.5) / S) / H) * span;
          if (inCrescent(lx, ly)) hits += 1;
        }
      }
      if (hits === 0) {
        line += " ";
        continue;
      }
      const cov = hits / (S * S);
      const shade = SHADES[Math.min(SHADES.length - 1, Math.max(1, Math.ceil(cov * 4)))]!;
      const cx = LO + ((x + 0.5) / width) * span;
      const cy = LO + ((y + 0.5) / H) * span;
      const v = moonGray((cx + cy) / 30); // gradasi asli: t = (px + y) / 30
      line += styleRgb(v, v, v, shade);
    }
    lines.push(line.replace(/[ ]+$/, ""));
  }
  const pad = Math.max(0, Math.floor((width - word.length) / 2));
  lines.push(" ".repeat(pad) + styleRgb(WORD_GRAY, WORD_GRAY, WORD_GRAY, word));
  return lines;
}

/** Divider chrome: gradasi abu simetris (gelap di tepi, terang di tengah). */
export function gradientDivider(cols: number): string {
  if (cols <= 0) return "";
  let out = "";
  for (let i = 0; i < cols; i++) {
    const t = cols <= 1 ? 1 : 1 - Math.abs((2 * i) / (cols - 1) - 1);
    const v = Math.round(45 + t * 105); // 45..150: cukup redup agar tidak berisik
    out += styleRgb(v, v, v, "─");
  }
  return out;
}

/** Spinner chrome dengan kilau ramp bulan yang bergerak. */
export function spinnerTick(tick: number, symbols: string[]): string {
  const n = Math.max(1, symbols.length);
  const sym = symbols[tick % n] ?? symbols[0] ?? "⠋";
  const frac = Math.max(0, Math.min(1, (tick % n) / Math.max(1, n - 1)));
  const v = moonGray(0.55 + 0.45 * frac); // bias ke sisi terang agar tetap terlihat
  return styleRgb(v, v, v, sym);
}
