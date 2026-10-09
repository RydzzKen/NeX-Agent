import { describe, expect, it } from "vitest";
import { ContextManager, estimateTokens, trimToolResult } from "../src/core/context.js";
import type { NeutralMessage } from "../src/core/types.js";

describe("context", () => {
  it("memangkas hasil tool yang melebihi batas dengan penanda", () => {
    const long = "a".repeat(25_000);
    const trimmed = trimToolResult(long, 100);
    expect(trimmed.length).toBeGreaterThan(100);
    expect(trimmed).toContain("dipangkas");
    expect(trimmed.startsWith("a".repeat(100))).toBe(true);
  });

  it("tidak mengubah hasil pendek", () => {
    expect(trimToolResult("pendek")).toBe("pendek");
  });

  it("memperkirakan token dan memberi peringatan di 85%", () => {
    const messages: NeutralMessage[] = [{ role: "user", content: "x".repeat(4000) }];
    expect(estimateTokens("abcd")).toBe(1);
    const manager = new ContextManager(1000);
    const report = manager.measure(messages);
    expect(report.warn).toBe(true);
    expect(report.percent).toBeGreaterThan(0.85);
  });
});
