import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readSkillFile, type Skill } from "./skills.js";

/**
 * Pembungkus SkillUI (https://skillui.vercel.app, paket npm `skillui`).
 *
 * SkillUI menyalin sistem desain dari situs/repo/folder (warna, tipografi,
 * spasi, komponen) menjadi folder berisi `SKILL.md`. Fungsi di sini menjalankan
 * SkillUI ke folder sementara, menemukan `SKILL.md` yang dihasilkan, lalu
 * menyalinnya ke `skills/<nama>/` agar langsung dibaca skill loader.
 *
 * Parsing/penebakan (`detectSkillSourceKind`, `buildSkilluiArgs`,
 * `slugifySkillName`, `findSkillDocFile`) murni dan bisa diuji tanpa jaringan.
 */

export type SkillSourceKind = "url" | "repo" | "dir";

const MAX_OUTPUT = 20_000;
const DEFAULT_TIMEOUT = 300_000;

/** Tebak jenis sumber: URL biasa, URL git repo, atau folder lokal. */
export function detectSkillSourceKind(source: string): SkillSourceKind {
  const value = source.trim();
  if (/^git@/i.test(value) || /\.git\/?$/i.test(value)) return "repo";
  if (/^https?:\/\/(www\.)?(github|gitlab|bitbucket)\.com\/[^/]+\/[^/?#]+\/?$/i.test(value)) {
    return "repo";
  }
  if (/^https?:\/\//i.test(value)) return "url";
  return "dir";
}

/** Nama slug yang aman dipakai sebagai nama folder skill. */
export function slugifySkillName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-{2,}/g, "-")
    .replace(/[.-]+$/, "")
    .slice(0, 64);
}

export interface SkilluiPlan {
  kind: SkillSourceKind;
  source: string;
  /** Folder keluaran SkillUI. */
  out: string;
  name?: string;
  ultra?: boolean;
}

/** Susun argumen `npx -y skillui@latest ...` (tanpa shell, aman dari injeksi). */
export function buildSkilluiArgs(plan: SkilluiPlan): string[] {
  const flag = plan.kind === "url" ? "--url" : plan.kind === "repo" ? "--repo" : "--dir";
  const args = ["-y", "skillui@latest", flag, plan.source, "--out", plan.out, "--format", "both"];
  if (plan.name) args.push("--name", plan.name);
  if (plan.ultra) args.push("--mode", "ultra");
  return args;
}

/** Perintah npx untuk platform saat ini. */
export function npxCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "npx.cmd" : "npx";
}

export interface SkillInstallArgs {
  source?: string;
  name?: string;
  ultra: boolean;
  overwrite: boolean;
}

/** Parse token `/skills install <sumber> [--name <n>] [--ultra] [--overwrite]`. */
export function parseSkillInstallTokens(tokens: string[]): SkillInstallArgs {
  const nameIndex = tokens.indexOf("--name");
  const name = nameIndex >= 0 ? tokens[nameIndex + 1] : undefined;
  const source = tokens.find(
    (token, i) => !token.startsWith("--") && !(nameIndex >= 0 && i === nameIndex + 1),
  );
  const args: SkillInstallArgs = {
    ultra: tokens.includes("--ultra"),
    overwrite: tokens.includes("--overwrite"),
  };
  if (source) args.source = source;
  if (name) args.name = name;
  return args;
}

/**
 * Cari `SKILL.md` di dalam pohon folder keluaran, memilih yang paling dangkal.
 */
export async function findSkillDocFile(root: string, depth = 0): Promise<string | undefined> {
  if (depth > 8) return undefined;
  let entries: Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const direct = entries.find((entry) => entry.isFile() && /^skill\.md$/i.test(entry.name));
  if (direct) return path.join(root, direct.name);
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const dir of dirs) {
    const found = await findSkillDocFile(path.join(root, dir), depth + 1);
    if (found) return found;
  }
  return undefined;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

function runProcess(
  file: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd: opts.cwd, env: process.env, shell: false });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;

    const cap = (s: string): string =>
      s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + "\n...(dipotong)" : s;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, opts.timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      child.kill("SIGTERM");
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString();
    });
    child.on("error", (err) => {
      cleanup();
      resolve({ code: -1, stdout: cap(stdout), stderr: cap(`${stderr}\n${err.message}`), timedOut, aborted });
    });
    child.on("close", (code) => {
      cleanup();
      resolve({ code, stdout: cap(stdout), stderr: cap(stderr), timedOut, aborted });
    });
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export interface SkillInstallOptions {
  workspaceRoot: string;
  source: string;
  kind?: SkillSourceKind;
  name?: string;
  ultra?: boolean;
  overwrite?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Ganti perintah SkillUI (dipakai tes). */
  command?: string;
}

export type SkillInstallResult =
  | { ok: true; slug: string; dir: string; skill: Skill }
  | { ok: false; error: string; output?: string };

/**
 * Jalankan SkillUI lalu pasang hasilnya ke `skills/<slug>/`. Tidak ada efek
 * samping di luar workspace (folder sementara selalu dibersihkan).
 */
export async function installSkillViaSkillui(opts: SkillInstallOptions): Promise<SkillInstallResult> {
  const source = opts.source.trim();
  if (!source) return { ok: false, error: "Sumber kosong." };

  const kind = opts.kind ?? detectSkillSourceKind(source);
  if (kind === "dir") {
    const abs = path.resolve(opts.workspaceRoot, source);
    if (!(await exists(abs))) return { ok: false, error: `Folder tidak ditemukan: ${source}` };
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "nex-skillui-"));
  try {
    const plan: SkilluiPlan = { kind, source, out: tmp };
    if (opts.name) plan.name = opts.name;
    if (opts.ultra) plan.ultra = true;
    const result = await runProcess(opts.command ?? npxCommand(), buildSkilluiArgs(plan), {
      cwd: opts.workspaceRoot,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT,
      signal: opts.signal,
    });
    const output = [result.stdout, result.stderr].filter((s) => s.trim()).join("\n").trim();

    if (result.timedOut) return { ok: false, error: "SkillUI kehabisan waktu.", output };
    if (result.aborted) return { ok: false, error: "Pemasangan skill dibatalkan.", output };
    if (result.code !== 0) {
      return { ok: false, error: `SkillUI gagal (exit ${result.code ?? "?"}).`, output };
    }

    const docFile = await findSkillDocFile(tmp);
    if (!docFile) return { ok: false, error: "SkillUI selesai tetapi tidak menghasilkan SKILL.md.", output };

    const sourceDir = path.dirname(docFile);
    const meta = await readSkillFile(docFile, path.basename(sourceDir));
    const slug = slugifySkillName(opts.name?.trim() || meta?.name || path.basename(sourceDir));
    if (!slug) {
      return { ok: false, error: "Nama skill hasil tidak valid. Set `name` secara eksplisit.", output };
    }

    const skillsRoot = path.join(opts.workspaceRoot, "skills");
    const destDir = path.join(skillsRoot, slug);
    if (await exists(destDir)) {
      if (!opts.overwrite) {
        return {
          ok: false,
          error: `Skill "${slug}" sudah ada (skills/${slug}). Set overwrite=true untuk menimpa.`,
          output,
        };
      }
      await fs.rm(destDir, { recursive: true, force: true });
    }
    await fs.mkdir(skillsRoot, { recursive: true });
    await fs.cp(sourceDir, destDir, { recursive: true });

    const installed = await readSkillFile(path.join(destDir, path.basename(docFile)), slug);
    if (!installed) return { ok: false, error: `Gagal membaca SKILL.md hasil di ${destDir}.`, output };
    return { ok: true, slug, dir: destDir, skill: installed };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
