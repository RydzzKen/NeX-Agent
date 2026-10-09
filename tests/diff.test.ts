import { describe, expect, it } from "vitest";
import { diffStats, unifiedDiff } from "../src/util/diff.js";

describe("diff", () => {
  it("menghitung baris ditambah dan dihapus", () => {
    const before = "a\nb\nc\n";
    const after = "a\nB\nc\nd\n";
    const stats = diffStats(before, after);
    expect(stats.removed).toBe(1);
    expect(stats.added).toBe(2);
  });

  it("menghasilkan patch unified dengan penanda", () => {
    const patch = unifiedDiff("a\n", "b\n", "file.txt");
    expect(patch).toContain("--- file.txt");
    expect(patch).toContain("+++ file.txt");
    expect(patch).toContain("-a");
    expect(patch).toContain("+b");
  });

  it("file baru seluruhnya berupa baris tambahan", () => {
    const patch = unifiedDiff("", "x\ny\n", "baru.txt");
    const added = patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"));
    expect(added).toHaveLength(2);
  });
});
