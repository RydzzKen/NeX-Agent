import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/config.js";
import {
  chooseInterface,
  parseDefaultTarget,
  parseUi,
  readDefaultInterface,
  setDefaultInterface,
} from "../src/cli/default.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "nex-def-"));
  process.env.AGENT_CONFIG_DIR = dir;
});

afterEach(async () => {
  delete process.env.AGENT_CONFIG_DIR;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("antarmuka default: parsing", () => {
  it("parseUi menerima tui/cli/repl tanpa peduli huruf besar-kecil", () => {
    expect(parseUi("tui")).toBe("tui");
    expect(parseUi("TUI")).toBe("tui");
    expect(parseUi("cli")).toBe("cli");
    expect(parseUi("repl")).toBe("cli");
    expect(parseUi("web")).toBeNull();
  });

  it("parseDefaultTarget juga mengenali reset/none", () => {
    expect(parseDefaultTarget("reset")).toBe("reset");
    expect(parseDefaultTarget("none")).toBe("reset");
    expect(parseDefaultTarget("tui")).toBe("tui");
    expect(parseDefaultTarget("")).toBeNull();
  });

  it("chooseInterface: opsi eksplisit menang, --json memaksa cli", () => {
    expect(chooseInterface("tui", false, "cli")).toBe("tui");
    expect(chooseInterface("cli", false, "tui")).toBe("cli");
    expect(chooseInterface(undefined, false, "tui")).toBe("tui");
    expect(chooseInterface(undefined, false, "cli")).toBe("cli");
    // JSON selalu readline walau default tui.
    expect(chooseInterface(undefined, true, "tui")).toBe("cli");
    // Nilai --ui tak dikenal -> null (ditangani pemanggil sebagai error).
    expect(chooseInterface("web", false, "tui")).toBeNull();
  });
});

describe("antarmuka default: penyimpanan", () => {
  it("kosong berarti cli", async () => {
    expect(await readDefaultInterface()).toBe("cli");
  });

  it("set tui lalu dibaca kembali", async () => {
    expect(await setDefaultInterface("tui")).toBe("tui");
    expect(await readDefaultInterface()).toBe("tui");
    expect((await loadConfig()).defaultInterface).toBe("tui");
  });

  it("reset mengembalikan ke cli dan tidak menyisakan nilai", async () => {
    await setDefaultInterface("tui");
    expect(await setDefaultInterface("reset")).toBe("cli");
    expect(await readDefaultInterface()).toBe("cli");
    expect((await loadConfig()).defaultInterface).toBeUndefined();
  });

  it("tidak menghapus setelan lain", async () => {
    await setDefaultInterface("tui");
    const { saveConfig } = await import("../src/config/config.js");
    await saveConfig({ maxSteps: 7 });
    await setDefaultInterface("reset");
    const cfg = await loadConfig();
    expect(cfg.maxSteps).toBe(7);
    expect(cfg.defaultInterface).toBeUndefined();
  });
});
