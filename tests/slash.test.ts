import { describe, expect, it } from "vitest";
import { BUSY_SAFE_COMMANDS, isBusySafeSlash, slashCommand } from "../src/cli/slash.js";

describe("kebijakan slash saat sibuk", () => {
  it("mengambil token perintah dari baris (termasuk argumen)", () => {
    expect(slashCommand("/diff")).toBe("/diff");
    expect(slashCommand("  /usage  today ")).toBe("/usage");
    expect(slashCommand("")).toBe("");
  });

  it("perintah baca/tampil diizinkan saat sibuk", () => {
    for (const cmd of ["/help", "/usage", "/todos", "/diff", "/search", "/permissions", "/thinking", "/markdown"]) {
      expect(isBusySafeSlash(cmd)).toBe(true);
    }
    // Argumen tidak mengubah klasifikasi.
    expect(isBusySafeSlash("/usage today")).toBe(true);
  });

  it("perintah yang mengubah state ditahan (tidak aman-sibuk)", () => {
    for (const cmd of ["/models", "/provider", "/connect", "/sessions", "/resume", "/new", "/clear", "/delete", "/undo", "/plan", "/build", "/mcp", "/skill", "/exit"]) {
      expect(isBusySafeSlash(cmd)).toBe(false);
    }
    // Subperintah mutasi dibatasi meski token ada di allowlist.
    expect(isBusySafeSlash("/skills install x")).toBe(false);
    expect(isBusySafeSlash("/memory add k v")).toBe(false);
    expect(isBusySafeSlash("/memory clear")).toBe(false);
    expect(isBusySafeSlash("/permissions revoke /tmp")).toBe(false);
  });

  it("baris biasa (bukan slash) tidak dianggap aman-sibuk", () => {
    expect(isBusySafeSlash("tolong perbaiki bug")).toBe(false);
    expect(isBusySafeSlash("models")).toBe(false);
  });

  it("allowlist hanya berisi perintah yang dikenal", () => {
    for (const cmd of BUSY_SAFE_COMMANDS) expect(cmd.startsWith("/")).toBe(true);
  });
});
