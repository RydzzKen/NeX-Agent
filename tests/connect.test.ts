import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildConnectMenu,
  defaultBaseURL,
  describeProvider,
  providerRefFromArgs,
  resolveProviderKey,
  runConnect,
  type ConnectPick,
} from "../src/cli/connect.js";
import type { PrompterLike } from "../src/cli/prompt.js";
import type { PickRequest } from "../src/cli/render.js";
import { CredentialStore } from "../src/config/credentials.js";

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

describe("resolveProviderKey", () => {
  const saved = ["anthropic", "custom:9router", "custom:zzz"];

  it("mengembalikan id persis bila tersimpan", () => {
    expect(resolveProviderKey("custom:9router", saved)).toBe("custom:9router");
    expect(resolveProviderKey("anthropic", saved)).toBe("anthropic");
  });

  it("mengubah nama singkat custom menjadi id lengkap", () => {
    expect(resolveProviderKey("9router", saved)).toBe("custom:9router");
    expect(resolveProviderKey("zzz", saved)).toBe("custom:zzz");
  });

  it("mengenali provider bawaan walau belum tersimpan", () => {
    expect(resolveProviderKey("openai", [])).toBe("openai");
  });

  it("mengembalikan undefined untuk yang tak dikenal atau kosong", () => {
    expect(resolveProviderKey("tidak-ada", saved)).toBeUndefined();
    expect(resolveProviderKey("custom:tidak-ada", saved)).toBeUndefined();
    expect(resolveProviderKey("   ", saved)).toBeUndefined();
  });

  it("mencocokkan nama custom yang mengandung spasi", () => {
    expect(resolveProviderKey("9router local", ["custom:9router local"])).toBe("custom:9router local");
  });
});

describe("providerRefFromArgs", () => {
  it("menggabungkan nama provider berspasi", () => {
    expect(providerRefFromArgs(["9router", "local"])).toBe("9router local");
  });

  it("membuang kutip tepi (ganda atau tunggal)", () => {
    expect(providerRefFromArgs(['"9router', 'local"'])).toBe("9router local");
    expect(providerRefFromArgs(["'9router", "local'"])).toBe("9router local");
  });

  it("merapikan spasi tepi dan aman untuk input kosong", () => {
    expect(providerRefFromArgs(["  x  "])).toBe("x");
    expect(providerRefFromArgs([])).toBe("");
  });
});

describe("CredentialStore + nama singkat", () => {
  it("hapus lewat nama singkat mengenai id tersimpan", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nex-cred-"));
    try {
      const store = new CredentialStore(dir);
      await store.set("custom:9router", { baseURL: "http://localhost:20128/v1", apiKey: "k" });

      const saved = await store.list();
      const key = resolveProviderKey("9router", saved);
      expect(key).toBe("custom:9router");
      if (!key) throw new Error("key tak terduga");
      expect(await store.get(key)).toBeDefined();
      expect(await store.delete(key)).toBe(true);
      expect(await store.list()).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runConnect dengan pemilih (TUI)", () => {
  /** Prompter yang gagal bila dipakai — membuktikan jalur pilih tak memakai nomor. */
  const prompter = {
    question: async () => {
      throw new Error("prompter tak seharusnya dipakai pada jalur pilih");
    },
  } as unknown as PrompterLike;

  it("memakai item terpilih dari pick tanpa meminta nomor", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nex-connect-"));
    try {
      const store = new CredentialStore(dir);
      await store.set("custom:9router", { baseURL: "http://localhost:20128/v1", apiKey: "k" });
      let title = "";
      const pick: ConnectPick = async <T>(req: PickRequest<T>): Promise<T | null> => {
        title = req.title;
        const target = req.items.find(
          (it) => (it.value as { key?: string }).key === "custom:9router",
        );
        return target ? target.value : null;
      };
      const result = await runConnect(prompter, store, undefined, pick);
      expect(title).toBe("Pilih provider");
      expect(result?.providerKey).toBe("custom:9router");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("membatalkan (undefined) saat pick mengembalikan null", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nex-connect-"));
    try {
      const store = new CredentialStore(dir);
      const pick: ConnectPick = async () => null;
      const result = await runConnect(prompter, store, undefined, pick);
      expect(result).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
