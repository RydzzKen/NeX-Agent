import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { configDir } from "../config/config.js";

/**
 * Pengelolaan bot Telegram sebagai **daemon** terpisah dari proses chat.
 *
 * Tujuan: bot tetap hidup walau sesi chat ditutup (Ctrl+C), dan otomatis
 * dijalankan ulang bila worker-nya berhenti tak terduga. Proses yang dilacak di
 * pidfile adalah sebuah *supervisor* yang men-spawn worker `telegram run` dan
 * me-restart-nya dengan backoff. Tidak ada dependensi baru.
 */

/** Error pengelolaan daemon (ditampilkan sebagai pesan, bukan crash). */
export class TelegramDaemonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramDaemonError";
  }
}

export type KillFn = typeof process.kill;
export type SleepFn = (ms: number) => Promise<void>;
export type SpawnFn = typeof spawn;

/** Lokasi pidfile daemon bot. */
export function telegramPidPath(dir: string = configDir()): string {
  return path.join(dir, "telegram.pid");
}

/** Lokasi berkas log daemon bot. */
export function telegramLogPath(dir: string = configDir()): string {
  return path.join(dir, "telegram.log");
}

/** Apakah proses dengan pid tersebut masih hidup. */
export function isProcessAlive(pid: number, killFn: KillFn = process.kill): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    killFn(pid, 0);
    return true;
  } catch (err) {
    // EPERM = ada tapi milik pengguna lain → tetap anggap hidup.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readPid(file: string): Promise<number | undefined> {
  try {
    const raw = (await fs.readFile(file, "utf8")).trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function writePid(file: string, pid: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, String(pid), { encoding: "utf8", mode: 0o600 });
  await fs.chmod(file, 0o600).catch(() => undefined);
}

async function clearPid(file: string): Promise<void> {
  await fs.rm(file, { force: true });
}

export interface DaemonStatus {
  running: boolean;
  pid?: number;
}

/** Status daemon bot (membaca pidfile, memverifikasi prosesnya masih hidup). */
export async function telegramDaemonStatus(
  dir: string = configDir(),
  killFn: KillFn = process.kill,
): Promise<DaemonStatus> {
  const file = telegramPidPath(dir);
  const pid = await readPid(file);
  if (pid && isProcessAlive(pid, killFn)) return { running: true, pid };
  if (pid) await clearPid(file);
  return { running: false };
}

export interface StartDaemonOptions {
  dir?: string;
  execPath?: string;
  entry?: string;
  spawnFn?: SpawnFn;
  env?: NodeJS.ProcessEnv;
}

export interface StartedDaemon {
  pid: number;
  logFile: string;
}

/**
 * Jalankan bot sebagai daemon (detached) yang tetap hidup setelah proses pemanggil
 * keluar. `workerArgs` diteruskan ke worker, mis. `["--cwd", "/path", "--mode", "build"]`.
 */
export async function startTelegramDaemon(
  workerArgs: string[] = [],
  options: StartDaemonOptions = {},
): Promise<StartedDaemon> {
  const dir = options.dir ?? configDir();
  const status = await telegramDaemonStatus(dir);
  if (status.running) {
    throw new TelegramDaemonError(`Bot Telegram sudah berjalan (pid ${status.pid}).`);
  }
  const logFile = telegramLogPath(dir);
  await fs.mkdir(path.dirname(logFile), { recursive: true });
  const out = await fs.open(logFile, "a");
  try {
    const spawnFn = options.spawnFn ?? spawn;
    const child = spawnFn(
      options.execPath ?? process.execPath,
      [options.entry ?? process.argv[1] ?? "", "telegram", "supervise", ...workerArgs],
      {
        detached: true,
        stdio: ["ignore", out.fd, out.fd],
        env: options.env ?? process.env,
      },
    );
    const pid = child.pid;
    child.unref();
    if (!pid) throw new TelegramDaemonError("Gagal menjalankan bot Telegram (pid kosong).");
    await writePid(telegramPidPath(dir), pid);
    return { pid, logFile };
  } finally {
    await out.close();
  }
}

export interface StopDaemonOptions {
  dir?: string;
  killFn?: KillFn;
  sleepFn?: SleepFn;
}

/** Kirim sinyal ke seluruh process-group daemon (POSIX); no-op di Windows. */
function signalGroup(pid: number, signal: NodeJS.Signals, killFn: KillFn): void {
  if (process.platform === "win32") return;
  try {
    killFn(-pid, signal);
  } catch {
    // tidak ada grup / tidak diizinkan
  }
}

/** Apakah masih ada proses di process-group daemon (POSIX). */
function groupAlive(pid: number, killFn: KillFn): boolean {
  if (process.platform === "win32") return false;
  try {
    killFn(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Hentikan daemon bot (SIGTERM ke supervisor, lalu SIGKILL bila bandel). Juga
 * menyapu worker yang mungkin tertinggal di process-group yang sama. true bila
 * ada yang benar-benar dihentikan.
 */
export async function stopTelegramDaemon(options: StopDaemonOptions = {}): Promise<boolean> {
  const dir = options.dir ?? configDir();
  const killFn = options.killFn ?? process.kill;
  const sleepFn = options.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const file = telegramPidPath(dir);
  const pid = await readPid(file);
  if (!pid) {
    await clearPid(file);
    return false;
  }
  const anyAlive = isProcessAlive(pid, killFn) || groupAlive(pid, killFn);
  try {
    killFn(pid, "SIGTERM");
  } catch {
    // proses mungkin sudah mati di antara cek dan kill
  }
  for (let i = 0; i < 30 && isProcessAlive(pid, killFn); i++) await sleepFn(100);
  if (isProcessAlive(pid, killFn)) {
    try {
      killFn(pid, "SIGKILL");
    } catch {
      // abaikan
    }
  }
  // Sapu worker yatim (bila supervisor sudah mati lebih dulu).
  signalGroup(pid, "SIGTERM", killFn);
  for (let i = 0; i < 10 && groupAlive(pid, killFn); i++) await sleepFn(100);
  if (groupAlive(pid, killFn)) signalGroup(pid, "SIGKILL", killFn);
  await clearPid(file);
  return anyAlive;
}

/** Hentikan lalu jalankan ulang daemon. */
export async function restartTelegramDaemon(
  workerArgs: string[] = [],
  options: StartDaemonOptions & StopDaemonOptions = {},
): Promise<StartedDaemon> {
  await stopTelegramDaemon(options);
  return startTelegramDaemon(workerArgs, options);
}

/** Ambil beberapa baris terakhir log daemon (untuk `/telegram logs`). */
export async function tailTelegramLog(lines = 20, dir: string = configDir()): Promise<string[]> {
  try {
    const raw = await fs.readFile(telegramLogPath(dir), "utf8");
    return raw.replace(/\n+$/, "").split("\n").slice(-lines);
  } catch {
    return [];
  }
}

export interface SupervisorOptions {
  /** Path ke executable Node (biasanya `process.execPath`). */
  execPath: string;
  /** Path ke entry point CLI (biasanya `process.argv[1]`). */
  entry: string;
  /** Argumen setelah entry untuk worker, mis. `["telegram", "run"]`. */
  args: string[];
  spawnFn?: SpawnFn;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Bila worker bertahan selama ini, backoff direset ke awal. */
  healthyMs?: number;
  log?: (message: string) => void;
}

export interface SupervisorHandle {
  /** Selesai saat supervisor berhenti; berisi kode keluar worker terakhir/fatal. */
  readonly done: Promise<number>;
  stop(): void;
}

/**
 * Supervisor: menjalankan worker bot dan me-restart-nya dengan backoff bila
 * berhenti tak terduga. Berhenti total bila worker keluar dengan kode `2`
 * (error konfigurasi, mis. token tidak valid) agar tidak restart selamanya.
 */
export function runTelegramSupervisor(options: SupervisorOptions): SupervisorHandle {
  const spawnFn = options.spawnFn ?? spawn;
  const base = options.baseDelayMs ?? 1000;
  const max = options.maxDelayMs ?? 30_000;
  const healthy = options.healthyMs ?? 60_000;
  const log = options.log ?? (() => undefined);

  let stopping = false;
  let child: ChildProcess | undefined;
  let childSettled = false;
  let startedAt = 0;
  let delay = base;
  let timer: NodeJS.Timeout | undefined;
  let finished = false;
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve;
  });

  const onSignal = (): void => stop();

  const finish = (code: number): void => {
    if (finished) return;
    finished = true;
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
    resolveDone(code);
  };

  const scheduleRestart = (): void => {
    if (stopping) {
      finish(0);
      return;
    }
    if (Date.now() - startedAt >= healthy) delay = base;
    log(`worker berhenti; restart dalam ${Math.round(delay / 1000)} detik.`);
    timer = setTimeout(launch, delay);
    delay = Math.min(delay * 2, max);
  };

  function launch(): void {
    if (stopping) {
      finish(0);
      return;
    }
    startedAt = Date.now();
    childSettled = false;
    const proc = spawnFn(options.execPath, [options.entry, ...options.args], { stdio: "inherit" });
    child = proc;
    const settle = (code: number): void => {
      if (childSettled) return;
      childSettled = true;
      child = undefined;
      if (stopping) {
        finish(code);
        return;
      }
      if (code === 2) {
        log("worker berhenti karena error konfigurasi; supervisor tidak me-restart.");
        finish(2);
        return;
      }
      scheduleRestart();
    };
    proc.on("error", (err) => {
      log(`gagal menjalankan worker: ${(err as Error).message}`);
      settle(1);
    });
    proc.on("exit", (code) => settle(code ?? 0));
  }

  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    if (timer) clearTimeout(timer);
    if (child && child.pid !== undefined) {
      try {
        child.kill("SIGTERM");
      } catch {
        // abaikan
      }
    } else {
      finish(0);
    }
  };

  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  launch();
  return { done, stop };
}
