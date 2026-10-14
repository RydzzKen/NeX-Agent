import { describe, expect, it } from "vitest";
import { extractErrorMessage, formatErrorMessage } from "../src/util/errors.js";

describe("extractErrorMessage", () => {
  it("mengambil `message` dari objek", () => {
    expect(extractErrorMessage({ message: "Boom" })).toBe("Boom");
  });

  it("menelusuri `error` bersarang", () => {
    expect(extractErrorMessage({ error: { error: { message: "dalam" } } })).toBe("dalam");
  });

  it("mendukung key alternatif seperti detail/description", () => {
    expect(extractErrorMessage({ code: -32000, detail: "server mati" })).toBe("server mati");
    expect(extractErrorMessage({ error_description: "token kedaluwarsa" })).toBe("token kedaluwarsa");
  });

  it("membuka string yang berisi JSON", () => {
    expect(extractErrorMessage('{"error":{"message":"nested"}}')).toBe("nested");
  });

  it("mengembalikan undefined untuk nilai kosong", () => {
    expect(extractErrorMessage(undefined)).toBeUndefined();
    expect(extractErrorMessage(null)).toBeUndefined();
    expect(extractErrorMessage("")).toBeUndefined();
  });
});

describe("formatErrorMessage", () => {
  it("membuka JSON 9Router bersarang tanpa sisa JSON mentah", () => {
    const raw = JSON.stringify({
      error: {
        message:
          '[429]: {"type":"error","error":{"message":"Rate limit exceeded"}}',
      },
    });
    const msg = formatErrorMessage(new Error(raw));
    expect(msg).toBe("Rate limit exceeded");
    expect(msg).not.toContain("{");
    expect(msg).not.toContain("\\");
  });

  it("menerima objek biasa (bukan Error)", () => {
    expect(formatErrorMessage({ error: { message: "Boom" } })).toBe("Boom");
  });

  it("memakai fallback untuk nilai kosong", () => {
    expect(formatErrorMessage("")).toBe("Terjadi kesalahan.");
    expect(formatErrorMessage(undefined, { fallback: "kosong" })).toBe("kosong");
    expect(formatErrorMessage(null, { fallback: "kosong" })).toBe("kosong");
  });

  it("merapikan spasi dan newline menjadi satu baris", () => {
    expect(formatErrorMessage("baris satu\n\n   baris dua")).toBe("baris satu baris dua");
  });

  it("memotong pesan yang sangat panjang", () => {
    const msg = formatErrorMessage("x".repeat(1000), { max: 10 });
    expect(msg.length).toBeLessThanOrEqual(10);
    expect(msg.endsWith("…")).toBe(true);
  });

  it("tidak mengubah teks biasa", () => {
    expect(formatErrorMessage("File tidak ditemukan")).toBe("File tidak ditemukan");
  });
});
