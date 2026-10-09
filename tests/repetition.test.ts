import { describe, expect, it } from "vitest";
import { RepetitionDetector, fingerprint } from "../src/core/repetition.js";

describe("RepetitionDetector", () => {
  it("mendeteksi tiga panggilan identik berturut-turut pada panggilan ketiga", () => {
    const detector = new RepetitionDetector();
    const sig = fingerprint("read_file", '{"path":"a"}', "isi");
    expect(detector.check(sig)).toBe(false);
    expect(detector.check(sig)).toBe(false);
    expect(detector.check(sig)).toBe(true);
  });

  it("mendeteksi pola bergantian ABABAB pada siklus ketiga", () => {
    const detector = new RepetitionDetector();
    const a = fingerprint("t", "1", "x");
    const b = fingerprint("t", "2", "y");
    const sequence = [a, b, a, b, a, b];
    const results = sequence.map((s) => detector.check(s));
    expect(results.slice(0, 5).every((r) => r === false)).toBe(true);
    expect(results[5]).toBe(true);
  });

  it("tidak menandai panggilan yang bervariasi", () => {
    const detector = new RepetitionDetector();
    for (let i = 0; i < 8; i++) {
      expect(detector.check(fingerprint("t", String(i), "r"))).toBe(false);
    }
  });
});
