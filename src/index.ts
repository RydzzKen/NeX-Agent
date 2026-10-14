import { Command } from "commander";
import path from "node:path";
import { configDir, loadConfig, sessionsDir } from "./config/config.js";
import { SessionStore } from "./sessions/store.js";
import { UsageStore, type UsageRange } from "./usage/store.js";
import { renderCrossSession } from "./cli/usage.js";
import { ChatApp, ConfigError, type CliOptions } from "./cli/app.js";
import { renderDoctor, runDoctor } from "./cli/doctor.js";
import { describeUpdate, describeUpdateSuccess, runUninstall, runUpdate } from "./cli/update.js";
import { createWebServer, isLoopbackHost, reachableUrl } from "./server/server.js";
import { ServerConfigError } from "./server/webapp.js";
import { TelegramError, startTelegramServer, type TelegramServerOptions } from "./server/telegram_server.js";
import { loadTelegramToken, resolveTelegramSettings } from "./server/telegram.js";
import {
  TelegramDaemonError,
  startTelegramDaemon,
  stopTelegramDaemon,
  restartTelegramDaemon,
  telegramDaemonStatus,
  tailTelegramLog,
  telegramLogPath,
  runTelegramSupervisor,
} from "./server/telegram_daemon.js";
import { qrLines } from "./util/qr.js";
import { color } from "./util/color.js";
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

/** Argumen CLI yang diteruskan ke worker bot Telegram (daemon/supervisor). */
function telegramWorkerArgs(merged: Record<string, unknown>): string[] {
  const args: string[] = [];
  if (merged.cwd) args.push("--cwd", String(merged.cwd));
  if (merged.mode) {
    parseMode(String(merged.mode));
    args.push("--mode", String(merged.mode));
  }
  if (merged.model) args.push("--model", String(merged.model));
  if (merged.provider) args.push("--provider", String(merged.provider));
  if (merged.maxSteps !== undefined) args.push("--max-steps", String(merged.maxSteps));
  if (merged.maxCost !== undefined) args.push("--max-cost", String(merged.maxCost));
  if (merged.yes) args.push("--yes");
  if (merged.allowAll) args.push("--allow-all");
  if (merged.skills === false) args.push("--no-skills");
  if (merged.debug) args.push("--debug");
  return args;
}

/** Opsi `startTelegramServer` dari opsi CLI (mode `telegram run`). */
function telegramServerOptions(merged: Record<string, unknown>): TelegramServerOptions {
  return {
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
    log: (message: string) => process.stderr.write(`[telegram] ${message}\n`),
  };
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("agent")
    .description("AI Agent CLI — loop agentik, mode Plan/Build, multi-provider")
    .version("1.8.0", "-v, --version", "tampilkan versi")
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
    .command("doctor")
    .description("periksa konfigurasi & lingkungan NeX-Agent (offline, read-only)")
    .option("--cwd <path>", "direktori kerja yang diperiksa")
    .action(async (_options: Record<string, unknown>, command: Command) => {
      const merged = command.optsWithGlobals() as Record<string, unknown>;
      const result = await runDoctor({
        ...(merged.cwd ? { workspace: path.resolve(String(merged.cwd)) } : {}),
      });
      process.stdout.write(`${renderDoctor(result)}\n`);
      if (!result.ok) process.exitCode = 1;
    });

  program
    .command("web")
    .alias("serve")
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

  program
    .command("telegram [action]")
    .description("jalankan/kelola bot Telegram (daemon latar belakang)")
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
    .action(async (action: string | undefined, _options: Record<string, unknown>, command: Command) => {
      const merged = command.optsWithGlobals() as Record<string, unknown>;
      const act = action ?? "start";

      if (act === "start" || act === "stop" || act === "restart" || act === "status" || act === "logs") {
        if (act === "start" || act === "restart") {
          // Cek token lebih dulu agar tidak men-spawn supervisor yang langsung mati.
          const settings = resolveTelegramSettings(await loadConfig(), process.env, await loadTelegramToken());
          if (!settings) {
            throw new TelegramError(
              "Token bot Telegram belum diatur. Jalankan /telegram token <TOKEN> atau set TELEGRAM_BOT_TOKEN.",
            );
          }
        }
        if (act === "start") {
          const started = await startTelegramDaemon(telegramWorkerArgs(merged));
          process.stdout.write(`Bot Telegram aktif di latar belakang (pid ${started.pid}).\n`);
          process.stdout.write(`  log: ${started.logFile}\n`);
          process.stdout.write("  Hentikan dengan: agent telegram stop\n");
        } else if (act === "stop") {
          const stopped = await stopTelegramDaemon();
          process.stdout.write(stopped ? "Bot Telegram dihentikan.\n" : "Bot Telegram tidak sedang berjalan.\n");
        } else if (act === "restart") {
          const started = await restartTelegramDaemon(telegramWorkerArgs(merged));
          process.stdout.write(`Bot Telegram dijalankan ulang (pid ${started.pid}).\n  log: ${started.logFile}\n`);
        } else if (act === "status") {
          const status = await telegramDaemonStatus();
          process.stdout.write(
            status.running ? `Bot Telegram berjalan (pid ${status.pid}).\n` : "Bot Telegram tidak berjalan.\n",
          );
          process.stdout.write(`  log: ${telegramLogPath()}\n`);
        } else {
          const lines = await tailTelegramLog(30);
          if (lines.length === 0) {
            process.stdout.write(`Belum ada log. (${telegramLogPath()})\n`);
          } else {
            process.stdout.write(`Log Telegram terakhir (${telegramLogPath()}):\n`);
            for (const line of lines) process.stdout.write(`  ${line}\n`);
          }
        }
        return;
      }

      if (act === "supervise") {
        // Mode internal: dipanggil daemon. Menjaga worker tetap hidup & restart otomatis.
        const supervisor = runTelegramSupervisor({
          execPath: process.execPath,
          entry: process.argv[1] ?? "",
          args: ["telegram", "run", ...process.argv.slice(4)],
          log: (message: string) => process.stderr.write(`[telegram] ${message}\n`),
        });
        process.exitCode = await supervisor.done;
        return;
      }

      if (act === "run") {
        // Mode foreground (dipakai oleh supervisor/systemd), berhenti saat Ctrl+C.
        const handle = await startTelegramServer(telegramServerOptions(merged));
        process.stdout.write("NeX-Agent Telegram berjalan (foreground):\n");
        process.stdout.write(`  bot    : @${handle.username ?? "?"}\n`);
        process.stdout.write(
          `  akses  : ${handle.open ? "TERBUKA untuk siapa pun" : handle.allowedChatIds.join(", ")}\n`,
        );
        process.stdout.write("  Tekan Ctrl+C untuk berhenti.\n");
        const shutdown = (): void => {
          void handle.close().then(() => process.exit(0));
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
        return;
      }

      throw new TelegramDaemonError(
        `Aksi tidak dikenal: ${act}. Pakai start|stop|restart|status|logs|run.`,
      );
    });

  program
    .command("update")
    .description("perbarui NeX-Agent dari repo git lalu bangun ulang")
    .option("--check", "hanya periksa, jangan ubah apa pun")
    .option("--stash", "simpan perubahan lokal sementara (stash) sebelum update, pulihkan setelahnya")
    .action(async (_options: Record<string, unknown>, command: Command) => {
      const merged = command.optsWithGlobals() as Record<string, unknown>;
      const outcome = await runUpdate({
        ...(merged.check ? { check: true } : {}),
        ...(merged.stash ? { stash: true } : {}),
        log: (line: string) => process.stdout.write(`${line}\n`),
      });
      process.stdout.write(
        outcome.status === "updated"
          ? `${color.brightGreen("[SUKSES]")} ${describeUpdateSuccess(outcome)}\n`
          : `${describeUpdate(outcome)}\n`,
      );
      if (outcome.stashConflict) {
        process.stderr.write(
          "Perubahan lokal bentrok saat dipulihkan; selesaikan konflik lalu commit (git status).\n",
        );
      }
      if (outcome.status === "error" || outcome.status === "dirty" || outcome.status === "not-ff" || outcome.status === "no-git") {
        process.exitCode = 1;
      }
    });

  program
    .command("uninstall")
    .description("lepas NeX-Agent (hapus perintah nex-agent/agent dari PATH)")
    .option("--purge", "hapus juga config dan sumber terpasang")
    .option("--yes", "konfirmasi tindakan destruktif (wajib untuk --purge)")
    .action(async (_options: Record<string, unknown>, command: Command) => {
      const merged = command.optsWithGlobals() as Record<string, unknown>;
      const purge = Boolean(merged.purge);
      if (purge && !merged.yes) {
        process.stderr.write(
          "--purge menghapus config (~/.config/agent) dan sumber terpasang. Tambahkan --yes untuk konfirmasi.\n",
        );
        process.exitCode = 1;
        return;
      }
      const result = await runUninstall({
        purge,
        log: (line: string) => process.stdout.write(`${line}\n`),
      });
      if (result.removedCommands.length === 0) {
        process.stdout.write("Tidak menemukan perintah nex-agent/agent yang terpasang.\n");
      } else {
        process.stdout.write(`Selesai. ${result.removedCommands.length} perintah dihapus.\n`);
      }
      if (result.removedRcMarkers.length > 0) {
        process.stdout.write(`Entri PATH dibersihkan di: ${result.removedRcMarkers.join(", ")}\n`);
      }
      if (purge) {
        process.stdout.write("Config dan sumber terpasang (bila ada) sudah dihapus.\n");
      } else {
        process.stdout.write("Config (~/.config/agent) tidak dihapus; pakai `uninstall --purge --yes` untuk itu.\n");
      }
    });

  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  if (
    err instanceof ConfigError ||
    err instanceof ServerConfigError ||
    err instanceof TelegramError ||
    err instanceof TelegramDaemonError
  ) {
    process.stderr.write(`Error konfigurasi: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});
