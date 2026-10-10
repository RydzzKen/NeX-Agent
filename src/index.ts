import { Command } from "commander";
import path from "node:path";
import { configDir, loadConfig, sessionsDir } from "./config/config.js";
import { SessionStore } from "./sessions/store.js";
import { UsageStore, type UsageRange } from "./usage/store.js";
import { renderCrossSession } from "./cli/usage.js";
import { ChatApp, ConfigError, type CliOptions } from "./cli/app.js";
import { createWebServer, isLoopbackHost, reachableUrl } from "./server/server.js";
import { ServerConfigError } from "./server/webapp.js";
import { qrLines } from "./util/qr.js";
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

  program
    .command("serve")
    .description("jalankan server web (chat + terminal di browser)")
    .option("--host <host>", "alamat bind (default: config atau 127.0.0.1)")
    .option("--lan", "bind ke 0.0.0.0 agar bisa dibuka dari LAN + tampilkan QR")
    .option("--no-qr", "jangan tampilkan kode QR")
    .option("--port <port>", "port (0 = acak)", (v) => Number.parseInt(v, 10))
    .option("--token <token>", "token akses (default: dibuat otomatis)")
    .option("--cwd <path>", "direktori kerja")
    .option("--mode <mode>", "mode awal: plan atau build")
    .option("--model <model>", "model yang dipakai")
    .option("--provider <provider>", "provider yang dipakai")
    .option("--max-steps <n>", "batas langkah", (v) => Number.parseInt(v, 10))
    .option("--max-cost <n>", "anggaran biaya (USD)", (v) => Number.parseFloat(v))
    .option("--yes", "setujui semua kategori konfirmasi")
    .option("--allow-all", "izinkan semua permintaan izin untuk sesi ini")
    .option("--no-skills", "jangan muat skill dari SKILL.md")
    .option("--debug", "log debug")
    .action(async (_options: Record<string, unknown>, command: Command) => {
      // Opsi seperti --model/--cwd juga didefinisikan pada perintah induk, jadi
      // gabungkan opsi global agar `agent serve --model m` tetap terbaca.
      const merged = command.optsWithGlobals() as Record<string, unknown>;
      const config = await loadConfig();
      const host = merged.lan
        ? "0.0.0.0"
        : ((merged.host as string | undefined) ?? config.webHost ?? "127.0.0.1");
      const port = (merged.port as number | undefined) ?? config.webPort ?? 0;

      const handle = await createWebServer({
        host,
        port,
        ...(merged.token ? { token: merged.token as string } : {}),
        ...(merged.cwd ? { cwd: merged.cwd as string } : {}),
        ...(merged.mode ? { mode: parseMode(merged.mode as string) } : {}),
        ...(merged.model ? { model: merged.model as string } : {}),
        ...(merged.provider ? { provider: merged.provider as string } : {}),
        ...(merged.maxSteps !== undefined ? { maxSteps: merged.maxSteps as number } : {}),
        ...(merged.maxCost !== undefined ? { maxCost: merged.maxCost as number } : {}),
        ...(merged.yes ? { yes: true } : {}),
        ...(merged.allowAll ? { allowAll: true } : {}),
        ...(merged.skills === false ? { skills: false } : {}),
        ...(merged.debug ? { debug: true } : {}),
      });

      const local = isLoopbackHost(handle.host);
      process.stdout.write("NeX-Agent web berjalan:\n");
      for (const url of handle.urls) process.stdout.write(`  ${url}\n`);
      process.stdout.write(`  terminal: ${handle.backend}\n`);
      if (!local) {
        process.stdout.write(
          "  ⚠ Server terikat ke jaringan — siapa pun yang punya token bisa menjalankan shell.\n",
        );
        const target = reachableUrl(handle.urls) ?? handle.url;
        if (merged.qr !== false) {
          process.stdout.write(`\n  Pindai kode QR untuk membuka di perangkat lain:\n\n`);
          process.stdout.write(qrLines(target).map((line) => `  ${line}`).join("\n") + "\n\n");
        }
      } else {
        process.stdout.write(
          "  (hanya loopback — tambahkan --lan untuk akses dari HP/LAN + kode QR)\n",
        );
      }
      process.stdout.write("  Tekan Ctrl+C untuk berhenti.\n");

      const shutdown = (): void => {
        void handle.close().then(() => process.exit(0));
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });

  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError || err instanceof ServerConfigError) {
    process.stderr.write(`Error konfigurasi: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});
