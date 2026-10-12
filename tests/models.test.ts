import { describe, expect, it } from "vitest";
import {
  cleanModelName,
  resolveModelChoice,
  validateFallbackModel,
} from "../src/cli/models.js";

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

describe("validateFallbackModel", () => {
  it("menerima model yang terdaftar di provider reguler", () => {
    expect(validateFallbackModel("gpt-4o", models, "openai")).toBe("gpt-4o");
  });

  it("menolak model tak terdaftar di provider reguler", () => {
    expect(validateFallbackModel("gemini-2", models, "google")).toBeUndefined();
  });

  it("provider custom selalu menerima walau tak terdaftar", () => {
    expect(validateFallbackModel("tes", models, "custom:9router")).toBe("tes");
    expect(validateFallbackModel("tes", [], "custom:9router")).toBe("tes");
  });

  it("daftar kosong diterima (tidak bisa divalidasi)", () => {
    expect(validateFallbackModel("x", [], "openai")).toBe("x");
  });

  it("nilai kosong mengembalikan undefined", () => {
    expect(validateFallbackModel(undefined, models, "openai")).toBeUndefined();
    expect(validateFallbackModel("", models, "openai")).toBeUndefined();
  });
});
