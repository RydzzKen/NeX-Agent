import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LONG_TEXT_CHARS,
  Typewriter,
  charDelayMs,
  safeCut,
  tailDelayMs,
} from "../src/cli/typewriter.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("charDelayMs: kecepatan adaptif", () => {
  it("memakai jeda dasar untuk teks pendek", () => {
    expect(charDelayMs(100, 0, { baseDelayMs: 12 })).toBe(12);
  });

  it("mempercepat teks yang melewati ambang panjang", () => {
    const speed = { baseDelayMs: 10, longTextChars: 1000, minDelayMs: 0.1 };
    // 2× ambang → jeda separuh.
    expect(charDelayMs(2000, 0, speed)).toBeCloseTo(5);
  });

  it("ambang bawaan setara 1500 kata", () => {
    expect(LONG_TEXT_CHARS).toBe(9000);
  });

  it("mempercepat saat antrean menumpuk", () => {
    const speed = { baseDelayMs: 12, maxBacklogChars: 100, minDelayMs: 0.1 };
    expect(charDelayMs(50, 200, speed)).toBeCloseTo(6);
  });

  it("tidak pernah lebih cepat dari batas minimum", () => {
    expect(charDelayMs(1_000_000, 0, { minDelayMs: 0.5 })).toBe(0.5);
    expect(charDelayMs(1, 1_000_000, { minDelayMs: 0.25 })).toBe(0.25);
  });
});

describe("tailDelayMs: menuntaskan sisa antrean", () => {
  it("membatasi total waktu ekor", () => {
    expect(tailDelayMs(1000, { maxTailMs: 1000, baseDelayMs: 12 })).toBeCloseTo(1);
  });

  it("tetap memakai jeda dasar bila ekor pendek", () => {
    expect(tailDelayMs(10, { maxTailMs: 1000, baseDelayMs: 12 })).toBe(12);
  });

  it("antrean kosong memakai jeda dasar", () => {
    expect(tailDelayMs(0, { baseDelayMs: 7 })).toBe(7);
  });
});

describe("safeCut: potongan aman untuk ANSI & emoji", () => {
  const red = "\u001b[31m";
  const reset = "\u001b[0m";

  it("tidak pernah memotong urutan escape ANSI", () => {
    const text = `${red}halo${reset}`;
    const cut = safeCut(text, 2);
    expect(text.slice(0, cut)).toBe(`${red}ha`);
    // Urutan escape tidak dihitung sebagai karakter tampilan.
    expect(safeCut(`${red}${reset}x`, 1)).toBe(red.length + reset.length + 1);
  });

  it("tidak memotong pasangan surrogate (emoji)", () => {
    const text = "😀a";
    expect(safeCut(text, 1)).toBe(2);
    expect(text.slice(0, 2)).toBe("😀");
  });

  it("minimal satu karakter agar selalu ada kemajuan", () => {
    expect(safeCut("abc", 0)).toBe(1);
  });
});

describe("Typewriter", () => {
  it("menguras antrean bertahap dan hasil akhirnya utuh", async () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const tw = new Typewriter((c) => out.push(c), { baseDelayMs: 10, tickMs: 10 });

    tw.push("halo");
    expect(out.join("")).toBe("h");

    await vi.advanceTimersByTimeAsync(100);
    expect(out.join("")).toBe("halo");
    expect(tw.pending).toBe(0);
  });

  it("menyambung beberapa push tanpa menghilangkan karakter", async () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const tw = new Typewriter((c) => out.push(c), { baseDelayMs: 5, tickMs: 5 });

    tw.push("satu ");
    tw.push("dua ");
    tw.push("tiga");
    await vi.advanceTimersByTimeAsync(500);

    expect(out.join("")).toBe("satu dua tiga");
  });

  it("end() mempercepat sisa agar selesai dalam batas ekor", async () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const tw = new Typewriter((c) => out.push(c), {
      baseDelayMs: 10,
      tickMs: 10,
      maxTailMs: 100,
    });

    tw.push("x".repeat(1000));
    const partial = out.join("").length;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(50);

    const done = tw.end();
    await vi.advanceTimersByTimeAsync(200);
    await done;

    expect(out.join("")).toHaveLength(1000);
  });

  it("end() langsung selesai bila antrean kosong", async () => {
    const out: string[] = [];
    const tw = new Typewriter((c) => out.push(c));
    await expect(tw.end()).resolves.toBeUndefined();
    expect(out).toEqual([]);
  });

  it("flush() menulis semua sisa seketika", () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const tw = new Typewriter((c) => out.push(c), { baseDelayMs: 50, tickMs: 50 });

    tw.push("abcdef");
    expect(out.join("")).toBe("a");
    tw.flush();

    expect(out.join("")).toBe("abcdef");
    expect(tw.pending).toBe(0);
  });

  it("teks sangat besar dilewati animasinya", () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const tw = new Typewriter((c) => out.push(c), { baseDelayMs: 10, tickMs: 10 });

    const big = "y".repeat(60_000);
    tw.push(big);
    expect(out.join("")).toBe(big);
  });
});
