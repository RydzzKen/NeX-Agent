import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDir } from "../config/config.js";

/**
 * Pembaruan mandiri (`/update` di chat, `nex-agent update` di terminal) dan
 * penghapusan (`nex-agent uninstall`).
 *
 * `update` menarik sumber terbaru dari repo git lalu memasang ulang dependensi
 * dan membangun ulang. `uninstall` melepas perintah dari PATH (dan, dengan
 * `--purge`, menghapus config serta sumber terpasang).
 */

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  /** Dipanggil per baris keluaran (untuk umpan balik langsung). */
  onLine?: (line: string) => void;
}

export interface CommandRunner {
  run(cmd: string, args: string[], options?: RunOptions): Promise<CommandResult>;
}

function emitLines(prefix: string, chunk: string, onLine?: (line: string) => void): string {
  if (!onLine) return prefix + chunk;
  const joined = prefix + chunk;
  let rest = joined;
  let idx = rest.indexOf("\n");
  while (idx >= 0) {
    onLine(rest.slice(0, idx));
    rest = rest.slice(idx + 1);
    idx = rest.indexOf("\n");
  }
  return rest;
}

/** Runner bawaan: menjalankan proses dan meneruskan keluaran baris demi baris. */
export const nodeRunner: CommandRunner = {
  run(cmd, args, options = {}) {
    return new Promise<CommandResult>((resolve) => {
      let child;
      try {
        child = spawn(cmd, args, {
          ...(options.cwd ? { cwd: options.cwd } : {}),
          env: { ...process.env, NPM_CONFIG_MINIMUM_RELEASE_AGE: "0" },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        resolve({ code: 127, stdout: "", stderr: (err as Error).message });
        return;
      }
      let stdout = "";
      let stderr = "";
      let outRest = "";
      let errRest = "";
      child.stdout?.on("data", (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        outRest = emitLines(outRest, text, options.onLine);
      });
      child.stderr?.on("data", (data: Buffer) => {
        const text = data.toString();
        stderr += text;
        errRest = emitLines(errRest, text, options.onLine);
      });
      child.on("error", (err) => {
        resolve({ code: 127, stdout, stderr: stderr + err.message });
      });
      child.on("close", (code) => {
        if (errRest) options.onLine?.(errRest);
        if (outRest) options.onLine?.(outRest);
        resolve({ code: code ?? 0, stdout, stderr });
      });
    });
  },
};

/** Direktori sumber (root paket) dari lokasi modul ini berada. */
export function resolveSourceDir(moduleUrl: string = import.meta.url): string {
  let dir = path.dirname(fileURLToPath(moduleUrl));
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(fileURLToPath(moduleUrl));
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readVersion(dir: string): Promise<string | undefined> {
  try {
    const raw = await fsp.readFile(path.join(dir, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/** Versi `package.json` pada satu revisi git (mis. `FETCH_HEAD`). */
async function readVersionAt(
  runner: CommandRunner,
  cwd: string,
  rev: string,
): Promise<string | undefined> {
  try {
    const res = await runner.run("git", ["show", `${rev}:package.json`], { cwd });
    if (res.code !== 0) return undefined;
    const parsed = JSON.parse(res.stdout) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

export type UpdateStatus = "updated" | "available" | "latest" | "no-git" | "dirty" | "not-ff" | "error";

export interface UpdateOutcome {
  status: UpdateStatus;
  branch?: string;
  from?: string;
  to?: string;
  /** Versi aplikasi saat ini (dibaca dari package.json lokal). */
  version?: string;
  /** Versi pada commit yang tersedia di remote (untuk status "available"). */
  nextVersion?: string;
  message?: string;
  /** Update memakai stash untuk menyimpan perubahan lokal sementara. */
  stashed?: boolean;
  /** Perubahan lokal bentrok saat dipulihkan dari stash (perlu diselesaikan manual). */
  stashConflict?: boolean;
}

function shortRev(rev?: string): string {
  return rev ? rev.slice(0, 7) : "?";
}

/** Ringkasan satu baris hasil update untuk ditampilkan. */
export function describeUpdate(outcome: UpdateOutcome): string {
  switch (outcome.status) {
    case "latest":
      return `Sudah versi terbaru${outcome.version ? ` (v${outcome.version})` : ""}.`;
    case "available":
      return `Versi terbaru tersedia (${shortRev(outcome.from)} → ${shortRev(outcome.to)}).`;
    case "updated":
      return `Berhasil diperbarui${outcome.version ? ` ke v${outcome.version}` : ""} (${shortRev(outcome.from)} → ${shortRev(outcome.to)}).`;
    case "no-git":
    case "dirty":
    case "not-ff":
      return outcome.message ?? "Update tidak bisa dilanjutkan.";
    case "error":
      return `Gagal memperbarui: ${outcome.message ?? "kesalahan tak diketahui."}`;
  }
}

/**
 * Ringkasan ringkas pembaruan yang tersedia, dipakai untuk prompt konfirmasi
 * sebelum menerapkan update.
 */
export function describeUpdateAvailable(outcome: UpdateOutcome): string {
  const now = outcome.version ? `v${outcome.version}` : shortRev(outcome.from);
  const next = outcome.nextVersion ? `v${outcome.nextVersion}` : shortRev(outcome.to);
  return `Versi Terbaru tersedia: sekarang ${now} → terbaru ${next}`;
}

/**
 * Pesan sukses setelah update diterapkan. Dipakai chat & Telegram; penanda
 * `[SUKSES]` diberi warna oleh pemanggil (terminal) sedangkan Telegram memakai
 * teks polos.
 */
export function describeUpdateSuccess(outcome: UpdateOutcome): string {
  const version = outcome.version ? `v${outcome.version}` : shortRev(outcome.to);
  return `Ter-update ke ${version}. Jalankan '/restart' untuk menerapkan.`;
}

export interface UpdateOptions {
  /** Direktori sumber; default dideteksi otomatis. */
  cwd?: string;
  /** Hanya periksa, jangan ubah apa pun. */
  check?: boolean;
  /** Saat ada perubahan lokal, simpan sementara ke stash lalu pulihkan setelahnya. */
  stash?: boolean;
  runner?: CommandRunner;
  log?: (line: string) => void;
}

function pnpmInstallArgs(major: number, frozen: boolean): string[] {
  const args = ["install"];
  if (frozen) args.push("--frozen-lockfile");
  if (major >= 12) args.push("--trust-lockfile");
  return args;
}

async function pnpmMajor(runner: CommandRunner, cwd: string): Promise<number> {
  const res = await runner.run("pnpm", ["-v"], { cwd });
  if (res.code !== 0) return 0;
  const major = Number.parseInt(res.stdout.trim().replace(/^v/, "").split(".")[0] ?? "", 10);
  return Number.isInteger(major) ? major : 0;
}

/**
 * Perbarui NeX-Agent dari repo git: fetch → (opsional) fast-forward → install →
 * build. Mengembalikan status terperinci untuk ditampilkan pemanggil.
 */
export async function runUpdate(options: UpdateOptions = {}): Promise<UpdateOutcome> {
  const runner = options.runner ?? nodeRunner;
  const log = options.log ?? (() => undefined);
  const cwd = options.cwd ?? resolveSourceDir();

  if (!(await pathExists(path.join(cwd, ".git")))) {
    return {
      status: "no-git",
      message: "Sumber bukan checkout git, jadi update otomatis tidak tersedia. Pasang ulang lewat install.sh.",
    };
  }

  const branchRes = await runner.run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  const branch = branchRes.stdout.trim() && branchRes.stdout.trim() !== "HEAD" ? branchRes.stdout.trim() : "main";

  log(`Mengambil pembaruan dari origin/${branch}...`);
  const fetch = await runner.run("git", ["fetch", "origin", branch], { cwd });
  if (fetch.code !== 0) {
    return { status: "error", branch, message: fetch.stderr.trim() || "git fetch gagal." };
  }

  const localRes = await runner.run("git", ["rev-parse", "HEAD"], { cwd });
  const remoteRes = await runner.run("git", ["rev-parse", "FETCH_HEAD"], { cwd });
  const from = localRes.stdout.trim();
  const to = remoteRes.stdout.trim();
  if (!from || !to) return { status: "error", branch, message: "Tidak bisa membaca revisi git." };

  if (from === to) {
    return { status: "latest", branch, from, to, version: await readVersion(cwd) };
  }

  const behindRes = await runner.run("git", ["rev-list", "--count", `HEAD..${to}`], { cwd });
  const behind = Number.parseInt(behindRes.stdout.trim(), 10);
  if (behindRes.code === 0 && Number.isFinite(behind) && behind === 0) {
    // Remote adalah leluhur HEAD: lokal sudah memuat (atau lebih baru dari) remote.
    return { status: "latest", branch, from, to, version: await readVersion(cwd) };
  }

  if (options.check) {
    return {
      status: "available",
      branch,
      from,
      to,
      version: await readVersion(cwd),
      nextVersion: await readVersionAt(runner, cwd, to),
    };
  }

  const dirty = await runner.run("git", ["status", "--porcelain"], { cwd });
  const isDirty = dirty.stdout.trim().length > 0;
  if (isDirty && !options.stash) {
    return {
      status: "dirty",
      branch,
      from,
      to,
      message:
        "Ada perubahan lokal yang belum di-commit; update dibatalkan agar tidak hilang. " +
        "Commit dulu, atau jalankan '/update --stash' untuk menyimpannya sementara.",
    };
  }

  let stashed = false;
  if (isDirty) {
    log("Menyimpan perubahan lokal ke stash...");
    const stash = await runner.run(
      "git",
      ["stash", "push", "--include-untracked", "-m", "nex-agent auto-stash sebelum update"],
      { cwd },
    );
    if (stash.code !== 0) {
      return {
        status: "dirty",
        branch,
        from,
        to,
        message: stash.stderr.trim() || "Gagal menyimpan perubahan lokal ke stash.",
      };
    }
    stashed = true;
  }

  /** Pulihkan stash (bila dipakai) dan tandai konflik pada hasil. */
  const finish = async (outcome: UpdateOutcome): Promise<UpdateOutcome> => {
    if (!stashed) return outcome;
    log("Memulihkan perubahan lokal dari stash...");
    const pop = await runner.run("git", ["stash", "pop"], { cwd });
    if (pop.code !== 0) {
      return {
        ...outcome,
        stashed: true,
        stashConflict: true,
        message:
          (outcome.message ? `${outcome.message} ` : "") +
          "Perubahan lokal bentrok saat dipulihkan (git stash pop); selesaikan konflik lalu commit.",
      };
    }
    return { ...outcome, stashed: true };
  };

  log("Menerapkan pembaruan (fast-forward)...");
  const merge = await runner.run("git", ["merge", "--ff-only", to], { cwd });
  if (merge.code !== 0) {
    return finish({
      status: "not-ff",
      branch,
      from,
      to,
      message: merge.stderr.trim() || "Tidak bisa fast-forward (riwayat bercabang).",
    });
  }

  const major = await pnpmMajor(runner, cwd);
  log("Memasang dependensi...");
  let install = await runner.run("pnpm", pnpmInstallArgs(major, true), { cwd, onLine: log });
  if (install.code !== 0) {
    install = await runner.run("pnpm", pnpmInstallArgs(major, false), { cwd, onLine: log });
  }
  if (install.code !== 0) {
    return finish({ status: "error", branch, from, to, message: "pnpm install gagal." });
  }

  log("Membangun...");
  const build = await runner.run("pnpm", ["build"], { cwd, onLine: log });
  if (build.code !== 0) {
    return finish({ status: "error", branch, from, to, message: "pnpm build gagal." });
  }

  return finish({ status: "updated", branch, from, to, version: await readVersion(cwd) });
}

/** Baris pembuka penanda PATH yang ditulis install.sh. */
export const RC_MARKER_START = "# >>> nex-agent >>>";
export const RC_MARKER_END = "# <<< nex-agent <<<";

/** Hapus blok penanda PATH nex-agent dari isi file rc (fungsi murni). */
export function stripRcMarker(text: string): { text: string; changed: boolean } {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === RC_MARKER_START);
  const end = lines.findIndex((line) => line.trim() === RC_MARKER_END);
  if (start === -1 || end === -1 || end < start) return { text, changed: false };
  const kept = [...lines.slice(0, start), ...lines.slice(end + 1)];
  const cleaned = kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "");
  return { text: cleaned, changed: true };
}

/** Apakah isi launcher menunjuk ke `dist/index.js` milik sumber ini (murni). */
export function isOwnedLauncher(content: string, srcDir: string): boolean {
  return content.includes(path.join(srcDir, "dist", "index.js"));
}

async function launcherBelongsTo(file: string, srcDir: string): Promise<boolean> {
  try {
    const stat = await fsp.lstat(file);
    if (stat.isSymbolicLink()) {
      const target = await fsp.readlink(file);
      const abs = path.resolve(path.dirname(file), target);
      return abs === path.join(srcDir, "dist", "index.js") || abs.startsWith(srcDir + path.sep);
    }
    return isOwnedLauncher(await fsp.readFile(file, "utf8"), srcDir);
  } catch {
    return false;
  }
}

/** Kandidat direktori perintah yang mungkin dipakai installer. */
export function defaultBinDirs(home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = new Set<string>();
  if (env.NEX_AGENT_BIN_DIR) dirs.add(env.NEX_AGENT_BIN_DIR);
  if (env.PREFIX && env.PREFIX.includes("com.termux")) dirs.add(path.join(env.PREFIX, "bin"));
  dirs.add(path.join(home, ".local", "bin"));
  return [...dirs];
}

export interface UninstallOptions {
  /** Hapus juga config (~/.config/agent) dan sumber terpasang. */
  purge?: boolean;
  dir?: string;
  home?: string;
  binDirs?: string[];
  log?: (line: string) => void;
}

export interface UninstallResult {
  removedCommands: string[];
  removedRcMarkers: string[];
  purgedConfig?: string;
  purgedSource?: string;
}

/**
 * Lepas NeX-Agent: hapus launcher `nex-agent`/`agent` yang menunjuk ke sumber ini
 * dan bersihkan entri PATH. Dengan `purge`, hapus juga config dan sumber terpasang
 * (tidak pernah menyentuh checkout pengembangan yang sedang dipakai).
 */
export async function runUninstall(options: UninstallOptions = {}): Promise<UninstallResult> {
  const srcDir = options.dir ?? resolveSourceDir();
  const home = options.home ?? os.homedir();
  const log = options.log ?? (() => undefined);
  const result: UninstallResult = { removedCommands: [], removedRcMarkers: [] };

  for (const dir of options.binDirs ?? defaultBinDirs(home)) {
    for (const name of ["nex-agent", "agent"]) {
      const file = path.join(dir, name);
      if (await launcherBelongsTo(file, srcDir)) {
        await fsp.rm(file, { force: true });
        result.removedCommands.push(file);
        log(`Menghapus perintah ${file}`);
      }
    }
  }

  for (const rc of [path.join(home, ".bashrc"), path.join(home, ".zshrc")]) {
    try {
      const text = await fsp.readFile(rc, "utf8");
      const stripped = stripRcMarker(text);
      if (stripped.changed) {
        await fsp.writeFile(rc, stripped.text, "utf8");
        result.removedRcMarkers.push(rc);
        log(`Membersihkan PATH di ${rc}`);
      }
    } catch {
      // file rc tidak ada — lewati
    }
  }

  if (options.purge) {
    const cfg = configDir();
    if (await pathExists(cfg)) {
      await fsp.rm(cfg, { recursive: true, force: true });
      result.purgedConfig = cfg;
      log(`Menghapus config ${cfg}`);
    }
    const installed = path.join(home, ".local", "share", "nex-agent");
    if (await pathExists(installed) && path.resolve(installed) !== path.resolve(srcDir)) {
      await fsp.rm(installed, { recursive: true, force: true });
      result.purgedSource = installed;
      log(`Menghapus sumber terpasang ${installed}`);
    }
  }

  return result;
}
