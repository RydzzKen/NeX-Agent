import { describe, expect, it } from "vitest";
import type { SessionRecord } from "../src/sessions/store.js";
import { searchSessions } from "../src/sessions/search.js";

function record(
  id: string,
  history: SessionRecord["history"],
  extra: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    id,
    title: id,
    workspace: "/w",
    providerId: "p",
    model: "m",
    mode: "build",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cost: 0,
    history,
    ...extra,
  };
}

describe("searchSessions", () => {
  it("menemukan kecocokan tanpa peduli huruf besar/kecil", () => {
    const hits = searchSessions([record("s1", [{ role: "user", content: "Ada BUG di sini" }])], "bug");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.matches[0]!.snippet).toContain("BUG");
    expect(hits[0]!.matches[0]!.role).toBe("user");
  });

  it("mengembalikan array kosong untuk query kosong", () => {
    expect(searchSessions([record("s1", [{ role: "user", content: "apa saja" }])], "   ")).toEqual([]);
  });

  it("membatasi jumlah kecocokan per sesi dan tetap mencatat total", () => {
    const history = Array.from({ length: 5 }, () => ({
      role: "user" as const,
      content: "kata penting",
    }));
    const hits = searchSessions([record("s1", history)], "penting", { maxPerSession: 2 });
    expect(hits[0]!.matches).toHaveLength(2);
    expect(hits[0]!.count).toBe(5);
  });

  it("memotong cuplikan dengan elipsis di kedua sisi", () => {
    const long = `awal ${"x".repeat(300)} target ${"y".repeat(300)}`;
    const hits = searchSessions([record("s1", [{ role: "assistant", content: long }])], "target", {
      snippetLength: 40,
    });
    const snippet = hits[0]!.matches[0]!.snippet;
    expect(snippet).toContain("target");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(42);
  });

  it("hanya mengembalikan sesi yang punya kecocokan, sesuai urutan masukan", () => {
    const hits = searchSessions(
      [
        record("s1", [{ role: "user", content: "nope" }]),
        record("s2", [{ role: "user", content: "yes" }]),
      ],
      "yes",
    );
    expect(hits.map((h) => h.session.id)).toEqual(["s2"]);
  });
});
