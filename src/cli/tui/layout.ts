import { stripAnsi, truncateTo, visibleWidth, wrapAnsi } from "../../util/ansi.js";
import {
  detectColorLevel,
  fg,
  modeAccent,
  PALETTE,
  type ColorLevel,
  type ThemePalette,
} from "./theme.js";

/** Tingkat layout berdasarkan lebar terminal. */
export type LayoutTier = "wide" | "medium" | "narrow";

export interface LayoutMetrics {
  tier: LayoutTier;
  /** Padding kiri/kanan layar. */
  paddingX: number;
  sidebar: boolean;
  sidebarWidth: number;
  compactLogo: boolean;
  hideTip: boolean;
  hideHeader: boolean;
  showProvider: boolean;
  menuRows: number;
  menuDescriptions: boolean;
  diffStacked: boolean;
  diffLineNumbers: boolean;
}

export function layoutTier(cols: number): LayoutTier {
  if (cols >= 100) return "wide";
  if (cols >= 60) return "medium";
  return "narrow";
}

/** Lebar sidebar proporsional; 0 saat sidebar disembunyikan. */
export function sidebarWidth(cols: number): number {
  if (cols < 100) return 0;
  return Math.min(28, Math.max(18, Math.round(cols * 0.22)));
}

export function layoutMetrics(cols: number, rows: number): LayoutMetrics {
  const width = Math.max(1, Math.floor(cols));
  const height = Math.max(1, Math.floor(rows));
  const tier = layoutTier(width);
  const narrow = tier === "narrow";

  return {
    tier,
    paddingX: narrow ? 1 : 2,
    sidebar: tier === "wide",
    sidebarWidth: sidebarWidth(width),
    compactLogo: narrow,
    hideTip: height < 20,
    hideHeader: height < 20,
    showProvider: !narrow,
    menuRows: narrow ? 5 : 6,
    menuDescriptions: !narrow,
    diffStacked: narrow,
    diffLineNumbers: !narrow,
  };
}

/** Lebar isi setelah padding dan sidebar (bila ada). */
export function contentWidth(cols: number, metrics: LayoutMetrics): number {
  const width = Math.max(1, Math.floor(cols));
  const inner = Math.max(0, width - metrics.paddingX * 2);
  if (!metrics.sidebar) return inner;
  return Math.max(0, inner - metrics.sidebarWidth - 1);
}

/** Potong tanpa padding; aman untuk teks ber-ANSI dan karakter lebar. */
export function clipLine(text: string, width: number): string {
  const w = Math.max(0, Math.floor(width));
  if (w === 0) return "";
  return visibleWidth(text) > w ? truncateTo(text, w) : text;
}

/** Potong lalu padding hingga tepat `width` kolom. */
export function fitLine(text: string, width: number): string {
  const w = Math.max(0, Math.floor(width));
  if (w === 0) return "";
  const clipped = clipLine(text, w);
  return clipped + " ".repeat(Math.max(0, w - visibleWidth(clipped)));
}

/** Pusatkan teks dalam `width` kolom. */
export function centerLine(text: string, width: number): string {
  const w = Math.max(0, Math.floor(width));
  if (w === 0) return "";
  const clipped = clipLine(text, w);
  const pad = Math.max(0, w - visibleWidth(clipped));
  const left = Math.floor(pad / 2);
  return " ".repeat(left) + clipped + " ".repeat(pad - left);
}

/** Ratakan kiri dan kanan dalam satu baris (mis. nama plugin + status). */
export function alignSides(left: string, right: string, width: number): string {
  const w = Math.max(1, Math.floor(width));
  const rightWidth = visibleWidth(right);
  if (rightWidth >= w) return fitLine(right, w);
  const leftText = clipLine(left, w - rightWidth - 1);
  const gap = Math.max(1, w - visibleWidth(leftText) - rightWidth);
  return fitLine(leftText + " ".repeat(gap) + right, w);
}

function takeStart(text: string, max: number): string {
  if (max <= 0) return "";
  let out = "";
  let width = 0;
  for (const ch of stripAnsi(text)) {
    const w = visibleWidth(ch);
    if (width + w > max) break;
    out += ch;
    width += w;
  }
  return out;
}

function takeEnd(text: string, max: number): string {
  if (max <= 0) return "";
  const chars = [...stripAnsi(text)];
  let out = "";
  let width = 0;
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const ch = chars[i]!;
    const w = visibleWidth(ch);
    if (width + w > max) break;
    out = ch + out;
    width += w;
  }
  return out;
}

/** Potong di tengah dengan elipsis, mis. path folder yang panjang. */
export function truncateMiddle(text: string, width: number): string {
  const w = Math.max(0, Math.floor(width));
  if (w === 0) return "";
  const plain = stripAnsi(text);
  if (visibleWidth(plain) <= w) return text;
  if (w === 1) return "…";

  const budget = w - 1;
  const leftWidth = Math.ceil(budget / 2);
  const rightWidth = budget - leftWidth;
  let left = takeStart(plain, leftWidth);
  let right = takeEnd(plain, rightWidth);

  // Karakter lebar bisa membuat satu sisi memakai lebih sedikit kolom dari
  // jatahnya. Isi sisa anggaran dari sisi lain tanpa melewati total.
  right = takeEnd(plain, budget - visibleWidth(left));
  left = takeStart(plain, budget - visibleWidth(right));

  return `${left}…${right}`;
}

/** Jarak atas untuk memusatkan blok vertikal. */
export function centerPad(rows: number, contentRows: number): number {
  return Math.max(0, Math.floor((Math.max(0, rows) - Math.max(0, contentRows)) / 2));
}

/** Bungkus teks menjadi baris tanpa melebihi `width`. */
export function wrapLine(text: string, width: number): string[] {
  return wrapAnsi(text, Math.max(1, Math.floor(width))).map((line) => line.line);
}

export interface PromptMeta {
  mode: string;
  model: string;
  provider: string;
}

export interface PromptMetaOptions {
  showProvider?: boolean;
  palette?: ThemePalette;
  level?: ColorLevel;
}

/** Baris meta prompt: badge mode, model, lalu provider (disembunyikan di sempit). */
export function formatPromptMeta(
  meta: PromptMeta,
  width: number,
  opts: PromptMetaOptions = {},
): string {
  const palette = opts.palette ?? PALETTE;
  const level = opts.level ?? detectColorLevel();
  const mode = (meta.mode.trim() || "build").toLowerCase();
  const parts = [fg(modeAccent(mode, palette), mode, level)];

  const model = meta.model.trim();
  if (model) parts.push(fg(palette.muted, model, level));

  const provider = meta.provider.trim();
  if ((opts.showProvider ?? true) && provider) {
    parts.push(fg(palette.dim, provider, level));
  }

  return clipLine(parts.join("  "), width);
}

export interface HeaderOptions {
  palette?: ThemePalette;
  level?: ColorLevel;
}

/** Header sesi: judul di kiri, persentase konteks di kanan. */
export function formatHeader(
  title: string,
  contextPercent: number,
  width: number,
  opts: HeaderOptions = {},
): string {
  const palette = opts.palette ?? PALETTE;
  const level = opts.level ?? detectColorLevel();
  const w = Math.max(1, Math.floor(width));
  const percent = Math.max(0, Math.min(100, Math.round(contextPercent)));
  const rightPlain = `${percent}%`;
  const right = fg(palette.muted, rightPlain, level);
  const rightWidth = visibleWidth(rightPlain);

  if (rightWidth >= w) return fitLine(right, w);

  const leftMax = w - rightWidth - 1;
  const leftText = clipLine(title.trim(), leftMax);
  const left = fg(palette.text, leftText, level);
  const spaces = Math.max(1, w - visibleWidth(leftText) - rightWidth);
  return fitLine(left + " ".repeat(spaces) + right, w);
}

export interface FooterInfo {
  folder: string;
  branch: string;
  version: string;
}

export interface FooterOptions {
  compact?: boolean;
  paddingX?: number;
  palette?: ThemePalette;
  level?: ColorLevel;
}

/**
 * Footer: folder:branch di kiri, versi di kanan. Di terminal sempit folder
 * dipotong di tengah dan versi dipendekkan menjadi `v…`.
 */
export function formatFooter(info: FooterInfo, cols: number, opts: FooterOptions = {}): string {
  const palette = opts.palette ?? PALETTE;
  const level = opts.level ?? detectColorLevel();
  const compact = opts.compact ?? cols < 60;
  const paddingX = Math.max(0, Math.floor(opts.paddingX ?? (compact ? 1 : 2)));
  const width = Math.max(1, Math.floor(cols) - paddingX * 2);

  const folder = info.folder.trim();
  const branch = info.branch.trim();
  const version = info.version.trim();
  const versionText = version ? (version.startsWith("v") ? version : `v${version}`) : "";
  const rightPlain = compact ? versionText : `NeX-Agent${versionText ? ` ${versionText}` : ""}`;

  if (!rightPlain) {
    const leftPlain = [folder, branch].filter(Boolean).join(":");
    return fitLine(fg(palette.muted, clipLine(leftPlain, width), level), width);
  }

  const right = fg(palette.dim, rightPlain, level);
  const rightWidth = visibleWidth(rightPlain);
  if (rightWidth >= width) return fitLine(right, width);

  const leftMax = width - rightWidth - 1;
  const branchPart = branch ? `:${branch}` : "";
  let leftPlain: string;
  if (folder && branch) {
    const folderBudget = Math.max(0, leftMax - visibleWidth(branchPart));
    const folderText =
      visibleWidth(folder) > folderBudget ? truncateMiddle(folder, folderBudget) : folder;
    leftPlain = folderText ? `${folderText}${branchPart}` : truncateMiddle(branch, leftMax);
  } else {
    leftPlain = truncateMiddle([folder, branch].filter(Boolean).join(":"), leftMax);
  }

  const left = fg(palette.muted, leftPlain, level);
  const spaces = Math.max(1, width - visibleWidth(leftPlain) - rightWidth);
  return fitLine(left + " ".repeat(spaces) + right, width);
}
