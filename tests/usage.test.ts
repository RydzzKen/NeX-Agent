import { describe, expect, it } from "vitest";
import { cacheSavings, computeCost } from "../src/usage/cost.js";
import { UsageTracker } from "../src/usage/tracker.js";
import type { TokenUsage } from "../src/core/types.js";

const usage: TokenUsage = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 };

describe("usage", () => {
  it("menghitung biaya dari harga per juta token", () => {
    const cost = computeCost(usage, { input: 3, output: 15 });
    expect(cost).toBeCloseTo(18, 5);
  });

  it("mengembalikan undefined bila harga tidak diketahui", () => {
    expect(computeCost(usage, undefined)).toBeUndefined();
  });

  it("menghitung penghematan cache", () => {
    const saved = cacheSavings(
      { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 },
      { input: 3, output: 15, cacheRead: 0.3 },
    );
    expect(saved).toBeCloseTo(2.7, 5);
  });

  it("mengagregasi per model dan total", () => {
    const tracker = new UsageTracker();
    tracker.record("fake", "m1", { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 }, { input: 1, output: 2 });
    tracker.record("fake", "m1", { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 }, { input: 1, output: 2 });
    tracker.record("other", "m2", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, undefined);

    const totals = tracker.totals();
    expect(totals.calls).toBe(3);
    expect(totals.usage.input).toBe(2000);
    expect(totals.usage.output).toBe(1000);
    expect(totals.costKnown).toBe(true);
    expect(tracker.perModel()).toHaveLength(2);
    expect(tracker.perModel()[0]!.model).toBe("m1");
  });
});
