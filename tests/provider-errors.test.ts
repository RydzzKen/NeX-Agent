import { describe, expect, it } from "vitest";
import { formatHttpError } from "../src/providers/errors.js";

describe("formatHttpError", () => {
  it("membuka sarang JSON 9Router dan menambah petunjuk 429", () => {
    const body = JSON.stringify({
      error: {
        message:
          '[429]: {"type":"error","error":{"type":"FreeUsageLimitError","message":"Rate limit exceeded. Please try again later."}}',
      },
    });
    const msg = formatHttpError("custom:9router", 429, body);
    expect(msg).toContain("HTTP 429");
    expect(msg).toContain("Rate limit exceeded");
    expect(msg).toContain("kuota/rate limit");
    // Petunjuk bahasa Indonesia lebih dulu daripada kutipan provider.
    expect(msg.indexOf("kuota/rate limit")).toBeLessThan(msg.indexOf("Rate limit exceeded"));
    expect(msg).toContain("pesan provider: Rate limit exceeded");
    // JSON bertingkat mentah tidak lagi ditampilkan
    expect(msg).not.toContain('{"type":"error"');
    expect(msg).not.toContain('\\"');
  });

  it("menangani bentuk error Gemini (Google)", () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        message: "Quota exceeded for quota metric 'Generate requests'",
        status: "RESOURCE_EXHAUSTED",
      },
    });
    const msg = formatHttpError("custom:gemini", 429, body);
    expect(msg).toContain("Quota exceeded");
    expect(msg).toContain("kuota/rate limit");
  });

  it("body teks biasa dikutip apa adanya dengan label, status tetap ada agar retry jalan", () => {
    const msg = formatHttpError("openai", 502, "Bad Gateway");
    expect(msg).toBe(
      "Provider openai gagal: HTTP 502 (server provider bermasalah; coba lagi sebentar lagi) — pesan provider: Bad Gateway",
    );
    expect(msg).toContain("502");
  });

  it("menandai kredensial ditolak (401/403)", () => {
    const msg = formatHttpError(
      "anthropic",
      401,
      JSON.stringify({ error: { message: "invalid api key" } }),
    );
    expect(msg).toContain("invalid api key");
    expect(msg).toContain("kredensial ditolak");
  });

  it("tetap memuat angka status 429 sehingga loop mengenalinya sebagai retryable", () => {
    const msg = formatHttpError("custom:9router", 429, "");
    expect(msg).toBe(
      "Provider custom:9router gagal: HTTP 429 (kuota/rate limit; coba lagi sebentar lagi atau ganti model)",
    );
    expect(/429/.test(msg)).toBe(true);
  });

  it("memangkas body panjang di batas kalimat agar tetap ringkas", () => {
    const body =
      "models/hermes is not found for API version v1main, or is not supported for generateContent. " +
      "Call ModelService.ListModels to see the list of available models and their supported methods.";
    const msg = formatHttpError(
      "custom:gemini",
      404,
      JSON.stringify({ error: { code: 404, message: body } }),
    );

    expect(msg).toBe(
      "Provider custom:gemini gagal: HTTP 404 (model atau endpoint tidak ditemukan) — " +
        "pesan provider: models/hermes is not found for API version v1main, or is not supported for generateContent.",
    );
    // Kalimat saran yang panjang tidak ikut ditampilkan.
    expect(msg).not.toContain("Call ModelService.ListModels");
  });

  it("memotong di akhir kata bila tidak ada batas kalimat yang cukup awal", () => {
    const body = `${"x".repeat(100)} ${"y".repeat(200)}`;
    const msg = formatHttpError("openai", 502, body);

    expect(msg).toBe(
      `Provider openai gagal: HTTP 502 (server provider bermasalah; coba lagi sebentar lagi) — pesan provider: ${"x".repeat(100)}…`,
    );
  });
});
