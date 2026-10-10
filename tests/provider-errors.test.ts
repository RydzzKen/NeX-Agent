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

  it("body teks biasa ditampilkan apa adanya, status tetap ada agar retry jalan", () => {
    const msg = formatHttpError("openai", 502, "Bad Gateway");
    expect(msg).toBe(
      "Provider openai gagal: HTTP 502 — Bad Gateway (server provider bermasalah; coba lagi sebentar lagi)",
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
});
