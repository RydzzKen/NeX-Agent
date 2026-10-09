import { Command } from "commander";
import path from "node:path";
import { configDir, sessionsDir } from "./config/config.js";
import { SessionStore } from "./sessions/store.js";
import { UsageStore, type UsageRange } from "./usage/store.js";
import { renderCrossSession } from "./cli/usage.js";
import { ChatApp, ConfigError, type CliOptions } from "./cli/app.js";
import type { Mode } from "./core/types.js";

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseMode(value: string): Mode {
  if (value !== "plan" && value !== "build") {
    throw new Error(`Mode tidak valid: ${value} (gunakan plan atau build)`);
  }
  return value;
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("agent")
    .description("AI Agent CLI — loop agentik, mode Plan/Build, multi-provider")
    .version("0.1.0", "-v, --version", "tampilkan versi")
    .argument("[goal]", "tujuan tugas; kosong untuk mode chat interaktif")
    .option("--mode <mode>", "mode awal: plan atau build")
    .option("--model <model>", "model yang dipakai")
    .option("--provider <provider>", "provider yang dipakai")
    .option("--max-steps <n>", "batas langkah", (v) => Number.parseInt(v, 10))
    .option("--max-cost <n>", "anggaran biaya (USD)", (v) => Number.parseFloat(v))
    .option("--yes", "setujui semua kategori konfirmasi (bukan yang diblokir)")
    .option("--allow-all", "izinkan semua permintaan izin untuk sesi ini")
    .option("--resume <id>", "lanjutkan sesi")
    .option("--continue", "lanjutkan sesi terakhir di workspace ini")
    .option("--cwd <path>", "direktori kerja")
    .option("--allow-path <path>", "setujui path sebelum sesi (bisa diulang)", collect, [])
    .option("--no-thinking", "sembunyikan thinking")
    .option("--no-markdown", "jangan render markdown pada jawaban")
    .option("--no-skills", "jangan muat skill dari SKILL.md")
    .option("--debug", "log debug")
    .option("--json", "keluaran JSON per baris")
    .action(async (goal: string | undefined, options: Record<string, unknown>) => {
      const opts: CliOptions = {
        ...(goal ? { goal } : {}),
        ...(options.mode ? { mode: parseMode(options.mode as string) } : {}),
        ...(options.model ? { model: options.model as string } : {}),
        ...(options.provider ? { provider: options.provider as string } : {}),
        ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps as number } : {}),
        ...(options.maxCost !== undefined ? { maxCost: options.maxCost as number } : {}),
        ...(options.yes ? { yes: true } : {}),
        ...(options.allowAll ? { allowAll: true } : {}),
        ...(options.resume ? { resume: options.resume as string } : {}),
        ...(options.continue ? { continue: true } : {}),
        ...(options.cwd ? { cwd: options.cwd as string } : {}),
        ...(Array.isArray(options.allowPath) && options.allowPath.length
          ? { allowPath: options.allowPath as string[] }
          : {}),
        thinking: options.thinking !== false,
        ...(options.markdown === false ? { markdown: false } : {}),
        ...(options.skills === false ? { skills: false } : {}),
        ...(options.debug ? { debug: true } : {}),
        ...(options.json ? { json: true } : {}),
      };

      const app = await ChatApp.create(opts);
      const code = goal ? await app.runGoal(goal) : await app.runRepl();
      process.exitCode = code;
    });

  program
    .command("usage")
    .description("rekap pemakaian lintas sesi")
    .argument("[range]", "today | week | all", "today")
    .action(async (range: string) => {
      const store = new UsageStore(path.join(configDir(), "usage.jsonl"));
      const summary = await store.aggregate(range as UsageRange);
      process.stdout.write(renderCrossSession(summary, range as UsageRange) + "\n");
    });

  program
    .command("logs")
    .description("tampilkan jejak sesi")
    .argument("<id>", "ID sesi")
    .action(async (id: string) => {
      const store = new SessionStore(sessionsDir());
      const record = await store.load(id);
      if (!record) {
        process.stderr.write(`Sesi tidak ditemukan: ${id}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(
        [
          `Sesi      ${record.id}`,
          `Judul     ${record.title}`,
          `Workspace ${record.workspace}`,
          `Model     ${record.providerId} / ${record.model}`,
          `Mode      ${record.mode}`,
          `Dibuat    ${record.createdAt}`,
          `Diperbarui ${record.updatedAt}`,
          `Biaya     ~$${record.cost.toFixed(4)}`,
          `Pesan     ${record.history.length}`,
          "",
        ].join("\n"),
      );
      for (const message of record.history) {
        const preview = message.content.replace(/\s+/g, " ").slice(0, 100);
        process.stdout.write(`  [${message.role}] ${preview}\n`);
      }
    });

  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    process.stderr.write(`Error konfigurasi: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});
