import { describe, expect, it } from "vitest";
import { buildConnectMenu, defaultBaseURL, describeProvider } from "../src/cli/connect.js";

describe("buildConnectMenu", () => {
  it("memuat provider bawaan, custom tersimpan (tanpa duplikat), dan opsi custom baru", () => {
    const keys = buildConnectMenu(["custom:9router", "anthropic", "custom:zzz"]).map((m) => m.key);
    expect(keys).toContain("anthropic");
    expect(keys).toContain("openai");
    expect(keys).toContain("custom:9router");
    expect(keys).toContain("custom:zzz");
    expect(keys[keys.length - 1]).toBe("custom");
    // Bawaan yang sudah tersimpan tidak diduplikasi.
    expect(keys.filter((k) => k === "anthropic")).toHaveLength(1);
    // Custom diurutkan.
    expect(keys.filter((k) => k.startsWith("custom:") && k !== "custom")).toEqual([
      "custom:9router",
      "custom:zzz",
    ]);
  });
});

describe("describeProvider", () => {
  it("menandai aktif, default, dan status kunci tanpa membocorkan nilai", () => {
    const line = describeProvider({
      key: "custom:9router",
      baseURL: "http://localhost:20128/v1",
      hasApiKey: true,
      active: true,
      isDefault: true,
    });
    expect(line).toContain("*");
    expect(line).toContain("custom:9router");
    expect(line).toContain("http://localhost:20128/v1");
    expect(line).toContain("(default)");
    expect(line).toContain("api key ok");
  });

  it("menandai provider tanpa api key", () => {
    const line = describeProvider({
      key: "custom:x",
      baseURL: "",
      hasApiKey: false,
      active: false,
      isDefault: false,
    });
    expect(line).toContain("tanpa api key");
  });
});

describe("defaultBaseURL", () => {
  it("mengembalikan basis bawaan untuk provider builtin", () => {
    expect(defaultBaseURL("openai")).toContain("openai.com");
    expect(defaultBaseURL("custom:9router")).toBeUndefined();
  });
});
