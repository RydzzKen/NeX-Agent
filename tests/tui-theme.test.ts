import { afterEach, describe, expect, it } from "vitest";
import { colorEnabled, setColorEnabled } from "../src/util/color.js";
import { visibleWidth } from "../src/util/ansi.js";
import {
  bg,
  detectColorLevel,
  fg,
  logoNeX,
  PALETTE,
  style,
  themePalette,
  THEME_NAMES,
} from "../src/cli/tui/theme.js";

describe("tema TUI (opencode)", () => {
  const prev = colorEnabled();
  afterEach(() => setColorEnabled(prev));

  it("palet mengikuti TUI.md dan punya varian mint", () => {
    expect(PALETTE.bg).toBe("#0a0a0a");
    expect(PALETTE.panel).toBe("#141414");
    expect(PALETTE.border).toBe("#2a2a2a");
    expect(PALETTE.text).toBe("#eeeeee");
    expect(PALETTE.muted).toBe("#808080");
    expect(PALETTE.dim).toBe("#6b6b6b");
    expect(PALETTE.build).toBe("#5c9cf5");
    expect(PALETTE.plan).toBe("#f5a742");
    expect(PALETTE.success).toBe("#7fd88f");
    expect(PALETTE.error).toBe("#e06c75");
    expect(PALETTE.diffAddBg).toBe("#10231a");
    expect(PALETTE.diffDelBg).toBe("#2a1512");
    expect(PALETTE.tool).toBe("#9d7cd8");
    expect(PALETTE.tip).toBe("#e5a14d");

    expect(THEME_NAMES).toEqual(["opencode", "mint"]);
    expect(themePalette("opencode")).toBe(PALETTE);
    expect(themePalette("mint").build).toBe("#7fd8b0");
    expect(themePalette("mint").plan).toBe(PALETTE.plan);
  });

  it("truecolor memakai RGB dan hanya menutup warna yang dipasang", () => {
    const f = fg(PALETTE.build, "x", 3);
    expect(f).toBe("\u001b[38;2;92;156;245mx\u001b[39m");

    const b = bg(PALETTE.diffAddBg, "x", 3);
    expect(b).toBe("\u001b[48;2;16;35;26mx\u001b[49m");

    const both = style("x", PALETTE.text, PALETTE.bg, 3);
    expect(both).toContain("38;2;238;238;238");
    expect(both).toContain("48;2;10;10;10");
    expect(both.endsWith("\u001b[39;49m")).toBe(true);
  });

  it("fallback 256 memakai kode 38/48;5", () => {
    expect(fg(PALETTE.build, "x", 2)).toMatch(/^\u001b\[38;5;\d+mx\u001b\[39m$/);
    expect(bg(PALETTE.diffAddBg, "x", 2)).toMatch(/^\u001b\[48;5;\d+mx\u001b\[49m$/);
  });

  it("fallback 16 memetakan hitam dan putih ke kode dasar", () => {
    expect(fg("#000000", "x", 1)).toBe("\u001b[30mx\u001b[39m");
    expect(bg("#000000", "x", 1)).toBe("\u001b[40mx\u001b[49m");
    expect(fg("#ffffff", "x", 1)).toBe("\u001b[97mx\u001b[39m");
    expect(bg("#ffffff", "x", 1)).toBe("\u001b[107mx\u001b[49m");
  });

  it("tanpa warna atau hex tidak valid: teks dikembalikan apa adanya", () => {
    expect(fg(PALETTE.build, "x", 0)).toBe("x");
    expect(bg(PALETTE.build, "x", 0)).toBe("x");
    expect(style("x", PALETTE.text, PALETTE.bg, 0)).toBe("x");
    expect(fg("bukan-warna", "x", 3)).toBe("x");
    expect(bg("#12", "x", 3)).toBe("x");
  });

  it("deteksi level menghormati NO_COLOR/FORCE_COLOR dan TERM", () => {
    setColorEnabled(true);
    expect(detectColorLevel({ NO_COLOR: "1", FORCE_COLOR: "3" })).toBe(0);
    expect(detectColorLevel({ FORCE_COLOR: "0" })).toBe(0);
    expect(detectColorLevel({ FORCE_COLOR: "3" })).toBe(3);
    expect(detectColorLevel({ FORCE_COLOR: "2" })).toBe(2);
    expect(detectColorLevel({ FORCE_COLOR: "1" })).toBe(1);
    expect(detectColorLevel({ FORCE_COLOR: "true" })).toBe(1);
    expect(detectColorLevel({ COLORTERM: "truecolor" })).toBe(3);
    expect(detectColorLevel({ COLORTERM: "24bit" })).toBe(3);
    expect(detectColorLevel({ TERM: "xterm-256color" })).toBe(2);
    expect(detectColorLevel({ TERM: "xterm" })).toBe(1);

    setColorEnabled(false);
    expect(detectColorLevel({ TERM: "xterm-256color" })).toBe(0);
  });

  it("logo blok: Ne redup, X terang, dan AGENT di bawahnya", () => {
    const lines = logoNeX({ cols: 120, level: 0 });
    expect(lines).toEqual(["█▄ █ █▀▀ ▀▄▀", "█ ▀█ ██▄ █ █", "A G E N T"]);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(120);

    const styled = logoNeX({ cols: 120, level: 3 });
    expect(styled[0]).toContain("\u001b[38;2;107;107;107m");
    expect(styled[0]).toContain("\u001b[38;2;238;238;238m");
    expect(styled[2]).toContain("\u001b[38;2;128;128;128m");
  });

  it("logo menyusut jadi satu baris di terminal sempit", () => {
    expect(logoNeX({ cols: 59, level: 0 })).toEqual(["NeX-Agent"]);
    expect(logoNeX({ cols: 10, level: 0 })).toEqual(["NeX-Agent"]);
    expect(logoNeX({ cols: 4, level: 0 })).toEqual(["NeX…"]);
  });

  it("logo tidak pernah melebihi lebar terminal", () => {
    for (const cols of [1, 4, 10, 45, 59, 60, 120]) {
      for (const line of logoNeX({ cols, level: 3 })) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(cols);
      }
    }
  });
});
