import { describe, expect, it } from "vitest";
import { cleanModelName, resolveModelChoice } from "../src/cli/models.js";

const models = [{ id: "gpt-4o" }, { id: "claude-3" }];

describe("resolveModelChoice", () => {
  it("0 berarti custom (nama manual)", () => {
    expect(resolveModelChoice("0", models)).toEqual({ kind: "custom" });
  });

  it("nomor memilih model dari daftar", () => {
    expect(resolveModelChoice("2", models)).toEqual({ kind: "model", model: { id: "claude-3" } });
  });

  it("nomor di luar rentang dianggap tidak valid", () => {
    expect(resolveModelChoice("99", models)).toEqual({ kind: "invalid" });
  });

  it("nama langsung dianggap model custom", () => {
    expect(resolveModelChoice("  my-model  ", models)).toEqual({
      kind: "model",
      model: { id: "my-model" },
    });
  });

  it("jawaban kosong tidak valid", () => {
    expect(resolveModelChoice("   ", models)).toEqual({ kind: "invalid" });
  });

  it("jawaban EOF (Ctrl+D) tidak dianggap nama model", () => {
    expect(resolveModelChoice("\u0004", models)).toEqual({ kind: "invalid" });
    expect(cleanModelName("\u0004my-model\u0004")).toBe("my-model");
  });
});
