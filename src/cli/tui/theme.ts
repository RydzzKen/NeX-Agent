import { colorEnabled } from "../../util/color.js";
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
    (r - CUBE_LEVELS[ri]!) ** 2 + (g - CUBE_LEVELS[gi]!) ** 2 + (b - CUBE_LEVELS[bi]!) ** 2;

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
