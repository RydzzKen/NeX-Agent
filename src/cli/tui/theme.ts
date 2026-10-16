import { color, colorEnabled, truecolorSupported } from "../../util/color.js";

/**
 * Tema "bulan" TUI: mengikuti logo awal (gradasi hitam → abu, tanpa warna lain).
 *
 * Warna semantik konten (mode/model/view/thinking) tetap bervariasi seperti
 * semula; yang memakai ramp bulan hanyalah chrome: banner, divider, spinner,
 * motif status, dan judul overlay.
 */

export type Rgb = [number, number, number];

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
