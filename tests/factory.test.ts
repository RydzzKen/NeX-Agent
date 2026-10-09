import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialStore } from "../src/config/credentials.js";
import { createProvider, customKey } from "../src/providers/factory.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nex-factory-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("provider factory & credential store", () => {
  it("menyimpan kredensial dengan izin 600 dan menghapusnya", async () => {
    const store = new CredentialStore(root);
    await store.set("anthropic", { apiKey: "secret" });
    expect(await store.get("anthropic")).toEqual({ apiKey: "secret" });
    expect(await store.list()).toContain("anthropic");

    const mode = (await fs.stat(path.join(root, "credentials.json"))).mode & 0o777;
    expect(mode).toBe(0o600);

    expect(await store.delete("anthropic")).toBe(true);
    expect(await store.get("anthropic")).toBeUndefined();
  });

  it("membangun adapter untuk provider bawaan dan custom", async () => {
    const store = new CredentialStore(root);
    await store.set("anthropic", { apiKey: "k" });
    await store.set("openai", { apiKey: "k" });
    await store.set(customKey("9router"), { baseURL: "http://localhost:20128/v1" });

    expect((await createProvider("anthropic", store))?.id).toBe("anthropic");
    expect((await createProvider("openai", store))?.id).toBe("openai");
    expect((await createProvider(customKey("9router"), store))?.id).toBe("custom:9router");
    expect(await createProvider("tidak-ada", store)).toBeUndefined();
  });
});
