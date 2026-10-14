import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderDoctor, runDoctor, type DoctorResult } from "../src/cli/doctor.js";

let configDir: string;
let workspace: string;

beforeEach(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "nex-doc-cfg-"));
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nex-doc-ws-"));
});

afterEach(async () => {
  await fs.rm(configDir, { recursive: true, force: true });
  await fs.rm(workspace, { recursive: true, force: true });
});

function find(result: DoctorResult, id: string) {
  const check = result.checks.find((c) => c.id === id);
  if (!check) throw new Error(`pemeriksaan tidak ditemukan: ${id}`);
  return check;
}

describe("runDoctor", () => {
  it("lulus pada lingkungan kosong (tanpa provider = peringatan, bukan gagal)", async () => {
    const result = await runDoctor({ configDir, workspace, env: {}, nodeVersion: "24.2.0" });
    expect(result.ok).toBe(true);
    expect(find(result, "node").status).toBe("ok");
    expect(find(result, "config-dir").status).toBe("ok");
    expect(find(result, "config-json").status).toBe("ok");
    expect(find(result, "providers").status).toBe("warn");
  });

  it("gagal bila Node terlalu tua", async () => {
    const result = await runDoctor({ configDir, workspace, env: {}, nodeVersion: "18.20.0" });
    expect(find(result, "node").status).toBe("fail");
    expect(result.ok).toBe(false);
  });

  it("gagal bila config.json bukan JSON valid", async () => {
    await fs.writeFile(path.join(configDir, "config.json"), "{ bukan json", "utf8");
    const result = await runDoctor({ configDir, workspace, env: {}, nodeVersion: "24.0.0" });
    expect(find(result, "config-json").status).toBe("fail");
    expect(result.ok).toBe(false);
  });

  it("memperingatkan bila izin credentials.json terlalu longgar", async () => {
    const file = path.join(configDir, "credentials.json");
    await fs.writeFile(file, "{}", { encoding: "utf8", mode: 0o644 });
    await fs.chmod(file, 0o644);
    const result = await runDoctor({ configDir, workspace, env: {}, nodeVersion: "24.0.0" });
    expect(find(result, "secrets").status).toBe("warn");
  });

  it("menerima izin 600 pada berkas rahasia", async () => {
    const file = path.join(configDir, "credentials.json");
    await fs.writeFile(file, "{}", { encoding: "utf8", mode: 0o600 });
    await fs.chmod(file, 0o600);
    const result = await runDoctor({ configDir, workspace, env: {}, nodeVersion: "24.0.0" });
    expect(find(result, "secrets").status).toBe("ok");
  });

  it("mendeteksi provider dari kredensial tersimpan", async () => {
    await fs.writeFile(
      path.join(configDir, "credentials.json"),
      JSON.stringify({ anthropic: { apiKey: "x" } }),
      { encoding: "utf8", mode: 0o600 },
    );
    const result = await runDoctor({ configDir, workspace, env: {}, nodeVersion: "24.0.0" });
    expect(find(result, "providers").status).toBe("ok");
    expect(find(result, "providers").detail).toContain("anthropic");
  });

  it("gagal bila plugins.json rusak dan memperingatkan server tidak valid", async () => {
    await fs.writeFile(path.join(configDir, "plugins.json"), "{ rusak", "utf8");
    const broken = await runDoctor({ configDir, workspace, env: {}, nodeVersion: "24.0.0" });
    expect(find(broken, "plugins").status).toBe("fail");

    await fs.writeFile(
      path.join(configDir, "plugins.json"),
      JSON.stringify({ mcp: { jelek: { transport: "stdio" } } }),
      "utf8",
    );
    const invalid = await runDoctor({ configDir, workspace, env: {}, nodeVersion: "24.0.0" });
    expect(find(invalid, "plugins").status).toBe("warn");
  });

  it("menghitung skill dan sesi yang terdeteksi", async () => {
    await fs.mkdir(path.join(workspace, "skills", "ringkas"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, "skills", "ringkas", "SKILL.md"),
      "---\nname: ringkas\ndescription: meringkas\n---\n\nisi\n",
      "utf8",
    );
    const sessionsDir = path.join(configDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(path.join(sessionsDir, "ses_1.json"), "{}", "utf8");

    const result = await runDoctor({ configDir, workspace, env: {}, nodeVersion: "24.0.0" });
    expect(find(result, "skills").detail).toContain("1 skill");
    expect(find(result, "sessions").detail).toContain("1 sesi");
  });
});

describe("renderDoctor", () => {
  it("meringkas jumlah status dan menandai kegagalan", () => {
    const result: DoctorResult = {
      ok: false,
      checks: [
        { id: "a", label: "Satu", status: "ok", detail: "baik" },
        { id: "b", label: "Dua", status: "warn", detail: "hati-hati" },
        { id: "c", label: "Tiga", status: "fail", detail: "rusak" },
      ],
    };
    const text = renderDoctor(result);
    expect(text).toContain("Satu");
    expect(text).toContain("3 pemeriksaan");
    expect(text).not.toContain("0 ok");
    expect(text).toContain("1 ok");
    expect(text).toContain("1 gagal");
  });
});
