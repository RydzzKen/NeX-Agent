import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * Permukaan perintah CLI hanya bisa diperiksa dari luar proses (index.ts
 * langsung menjalankan commander). Karena itu tes ini menjalankan CLI apa
 * adanya lewat tsx, dan hanya dengan `--help` yang tidak menyentuh config,
 * provider, atau jaringan.
 */
const run = promisify(execFile);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "src", "index.ts");

async function runCli(args: string[]): Promise<string> {
  const { stdout } = await run(process.execPath, ["--import", "tsx", entry, ...args], {
    cwd: root,
    env: { ...process.env, NO_COLOR: "1" },
  });
  return stdout;
}

describe("subcommand antarmuka", () => {
  it("`cli` terdaftar bersama `tui` di daftar perintah", async () => {
    const help = await runCli(["--help"]);
    expect(help).toContain("cli [options] [goal]");
    expect(help).toMatch(/antarmuka CLI readline/);
    expect(help).toMatch(/tui \[options\]/);
  }, 30_000);

  it("`cli --help` memuat seluruh opsi sesi dan --json", async () => {
    const help = await runCli(["cli", "--help"]);
    expect(help).toContain("Usage: agent cli [options] [goal]");
    for (const flag of [
      "--mode",
      "--model",
      "--provider",
      "--max-steps",
      "--max-cost",
      "--yes",
      "--allow-all",
      "--resume",
      "--continue",
      "--cwd",
      "--allow-path",
      "--no-thinking",
      "--no-markdown",
      "--no-typewriter",
      "--no-skills",
      "--debug",
      "--json",
    ]) {
      expect(help, `opsi ${flag} hilang`).toContain(flag);
    }
  }, 30_000);
});
