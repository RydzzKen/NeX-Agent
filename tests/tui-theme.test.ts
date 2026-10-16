import { afterEach, describe, expect, it } from "vitest";
import { colorEnabled, setColorEnabled } from "../src/util/color.js";
import { stripAnsi, truncateTo, visibleWidth } from "../src/util/ansi.js";
import { gradientDivider, logoBanner, moonGray, MOON_RAMP, spinnerTick } from "../src/cli/tui/theme.js";

describe("tema TUI (bulan)", () => {
  const prev = colorEnabled();
  afterEach(() => setColorEnabled(prev));

  it("ramp bulan murni grayscale sesuai logo awal (35 → 175)", () => {
    for (const [r, g, b] of MOON_RAMP) {
      expect(r).toBe(g);
      expect(g).toBe(b);
    }
    expect(moonGray(0)).toBe(35);
    expect(moonGray(0.5)).toBe(105);
    expect(moonGray(1)).toBe(175);
    expect(moonGray(-1)).toBe(35);
    expect(moonGray(9)).toBe(175);
  });

  it("banner memuat bulan sabit dan wordmark tanpa melebihi lebar terminal", () => {
    const lines = logoBanner(60, 8);
    expect(lines.length).toBeGreaterThan(6);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(60);
    }
    // Bentuk bulan sabit (bukan kotak penuh): ada baris dengan blok menjorok ke kiri.
    const indents = lines
      .slice(0, -1)
      .map((l) => /^ */.exec(stripAnsi(l))?.[0].length ?? 0);
    expect(Math.min(...indents)).toBe(0);
    expect(Math.max(...indents)).toBeGreaterThan(0);
    expect(stripAnsi(lines[lines.length - 1]!)).toContain("NeX-Agent");
  });

  it("banner menyusut jadi satu baris di terminal sempit", () => {
    const lines = logoBanner(14, 8);
    expect(lines).toHaveLength(1);
    expect(stripAnsi(lines[0]!)).toContain("NeX-Agent");
  });

  it("tanpa warna: tidak ada escape ANSI sama sekali", () => {
    setColorEnabled(false);
    const frame = [...logoBanner(60, 8), gradientDivider(20), spinnerTick(3, ["⠋", "⠙"])].join("\n");
    expect(frame).not.toContain("\u001b[");
  });

  it("warna chrome selalu grayscale (tak ada warna semantik yang bocor)", () => {
    setColorEnabled(true);
    const frame = [...logoBanner(40, 6), gradientDivider(10), spinnerTick(2, ["⠋", "⠙"])].join("");
    const params = [...frame.matchAll(/\u001b\[([0-9;]+)m/g)].map((m) => m[1]!);
    expect(params.length).toBeGreaterThan(0);
    for (const p of params) {
      if (p.startsWith("38;2;")) {
        const [, r, g, b] = p.split(";").map(Number) as [number, number, number, number];
        expect(r).toBe(g);
        expect(g).toBe(b);
      } else {
        // Hanya dim (2), bold (1), gray (90), dan kode reset/penutupnya.
        expect(["0", "1", "2", "22", "39", "90"]).toContain(p);
      }
    }
  });

  it("divider selebar terminal dan aman dipotong", () => {
    expect(visibleWidth(gradientDivider(40))).toBe(40);
    expect(visibleWidth(truncateTo(gradientDivider(80), 20))).toBe(20);
    expect(gradientDivider(0)).toBe("");
  });
});
