import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { configDir } from "../config/config.js";
import { CredentialStore } from "../config/credentials.js";
import { MEMORY_FILE } from "../memory/long_term.js";
import { discoverSkills } from "../memory/skills.js";
import { loadPluginsConfig } from "../plugins/config.js";
import { SessionStore } from "../sessions/store.js";
import { color } from "../util/color.js";

/**
 * Pemeriksaan lingkungan & konfigurasi NeX-Agent (`nex-agent doctor`).
 *
 * Semua pemeriksaan bersifat *offline* dan read-only: tidak memanggil jaringan
 * dan tidak pernah mencetak nilai rahasia (hanya nama berkas & izinnya).
 */

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorResult {
  /** True bila tidak ada pemeriksaan yang berstatus "fail". */
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  /** Direktori konfigurasi (default `configDir()`). */
  configDir?: string;
  /** Direktori kerja yang diperiksa skill-nya (default `process.cwd()`). */
  workspace?: string;
  /** Variabel lingkungan (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Versi Node untuk diuji (default `process.versions.node`). */
  nodeVersion?: string;
}

const MIN_NODE_MAJOR = 20;
const SECRET_FILES = ["credentials.json", MEMORY_FILE];

function mode(modeBits: number): string {
  return `0o${(modeBits & 0o777).toString(8).padStart(3, "0")}`;
}

async function checkNode(version: string): Promise<DoctorCheck> {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (!Number.isFinite(major)) {
    return { id: "node", label: "Node.js", status: "warn", detail: `versi tidak dikenal: ${version}` };
  }
  if (major < MIN_NODE_MAJOR) {
    return {
      id: "node",
      label: "Node.js",
      status: "fail",
      detail: `v${version} terlalu tua (butuh >= ${MIN_NODE_MAJOR})`,
    };
  }
  return { id: "node", label: "Node.js", status: "ok", detail: `v${version}` };
}

async function checkConfigDir(dir: string): Promise<DoctorCheck> {
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.access(dir, constants.W_OK);
    return { id: "config-dir", label: "Direktori config", status: "ok", detail: `${dir} (dapat ditulis)` };
  } catch (err) {
    return {
      id: "config-dir",
      label: "Direktori config",
      status: "fail",
      detail: `${dir} tidak dapat ditulis: ${(err as Error).message}`,
    };
  }
}

async function checkConfigJson(dir: string): Promise<DoctorCheck> {
  const file = path.join(dir, "config.json");
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { id: "config-json", label: "config.json", status: "ok", detail: "belum ada (dibuat saat dipakai)" };
    }
    return { id: "config-json", label: "config.json", status: "fail", detail: (err as Error).message };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { id: "config-json", label: "config.json", status: "fail", detail: "harus berupa objek JSON" };
    }
    return { id: "config-json", label: "config.json", status: "ok", detail: "valid" };
  } catch (err) {
    return { id: "config-json", label: "config.json", status: "fail", detail: `JSON tidak valid: ${(err as Error).message}` };
  }
}

async function checkSecrets(dir: string): Promise<DoctorCheck> {
  const lax: string[] = [];
  let found = 0;
  for (const name of SECRET_FILES) {
    try {
      const stat = await fs.stat(path.join(dir, name));
      found++;
      if ((stat.mode & 0o077) !== 0) lax.push(`${name} (${mode(stat.mode)})`);
    } catch {
      // Berkas belum ada — tidak apa-apa.
    }
  }
  if (lax.length > 0) {
    return {
      id: "secrets",
      label: "Izin berkas rahasia",
      status: "warn",
      detail: `terlalu longgar, seharusnya 600: ${lax.join(", ")}`,
    };
  }
  return {
    id: "secrets",
    label: "Izin berkas rahasia",
    status: "ok",
    detail: found === 0 ? "belum ada berkas rahasia" : `${found} berkas berizin 600`,
  };
}

function envHasKey(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name];
  return typeof value === "string" && value.trim().length > 0;
}

async function checkProviders(
  dir: string,
  env: NodeJS.ProcessEnv,
  defaultProvider?: string,
): Promise<DoctorCheck> {
  const stored = await new CredentialStore(dir).list();
  const envProviders = ["anthropic", "openai"].filter((k) =>
    envHasKey(env, k === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"),
  );
  const known = new Set([...stored, ...envProviders]);
  if (known.size === 0) {
    return {
      id: "providers",
      label: "Provider",
      status: "warn",
      detail: "belum ada provider terkonfigurasi — jalankan /connect atau set API key",
    };
  }
  if (defaultProvider && !known.has(defaultProvider)) {
    return {
      id: "providers",
      label: "Provider",
      status: "warn",
      detail: `default "${defaultProvider}" belum punya kredensial (tersedia: ${[...known].join(", ")})`,
    };
  }
  return {
    id: "providers",
    label: "Provider",
    status: "ok",
    detail: `${known.size} tersedia (${[...known].join(", ")})`,
  };
}

async function checkPlugins(dir: string): Promise<DoctorCheck> {
  const config = await loadPluginsConfig(dir);
  if (config.fileError) {
    return { id: "plugins", label: "plugins.json", status: "fail", detail: config.fileError };
  }
  const names = Object.keys(config.servers);
  const invalid = Object.keys(config.errors);
  if (invalid.length > 0) {
    return {
      id: "plugins",
      label: "plugins.json",
      status: "warn",
      detail: `${invalid.length} server tidak valid: ${invalid.join(", ")}`,
    };
  }
  return {
    id: "plugins",
    label: "plugins.json",
    status: "ok",
    detail: names.length === 0 ? "belum ada server MCP" : `${names.length} server MCP`,
  };
}

async function checkSkills(dir: string, workspace: string): Promise<DoctorCheck> {
  const skills = await discoverSkills({ workspaceRoot: workspace, globalConfigDir: dir });
  return {
    id: "skills",
    label: "Skill",
    status: "ok",
    detail: skills.length === 0 ? "belum ada skill terdeteksi" : `${skills.length} skill terdeteksi`,
  };
}

async function checkSessions(dir: string): Promise<DoctorCheck> {
  const store = new SessionStore(path.join(dir, "sessions"));
  const sessions = await store.list();
  return {
    id: "sessions",
    label: "Sesi",
    status: "ok",
    detail: sessions.length === 0 ? "belum ada sesi tersimpan" : `${sessions.length} sesi tersimpan`,
  };
}

/** Jalankan semua pemeriksaan dan kumpulkan hasilnya. */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const dir = options.configDir ?? configDir();
  const workspace = options.workspace ?? process.cwd();
  const env = options.env ?? process.env;
  const nodeVersion = options.nodeVersion ?? process.versions.node;

  const configCheck = await checkConfigJson(dir);
  let defaultProvider: string | undefined;
  try {
    const cfg = JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf8")) as {
      defaultProvider?: string;
    };
    if (typeof cfg.defaultProvider === "string") defaultProvider = cfg.defaultProvider;
  } catch {
    // config.json hilang/rusak sudah dilaporkan oleh configCheck.
  }

  const checks = [
    await checkNode(nodeVersion),
    await checkConfigDir(dir),
    configCheck,
    await checkSecrets(dir),
    await checkProviders(dir, env, defaultProvider),
    await checkPlugins(dir),
    await checkSkills(dir, workspace),
    await checkSessions(dir),
  ];

  return { ok: checks.every((c) => c.status !== "fail"), checks };
}

const ICON: Record<DoctorStatus, string> = { ok: "✔", warn: "⚠", fail: "✖" };

function paint(status: DoctorStatus, text: string): string {
  if (status === "ok") return color.green(text);
  if (status === "warn") return color.yellow(text);
  return color.red(text);
}

/** Render hasil `runDoctor` menjadi teks siap cetak. */
export function renderDoctor(result: DoctorResult): string {
  const lines = [color.bold("NeX-Agent doctor"), ""];
  for (const check of result.checks) {
    const icon = paint(check.status, ICON[check.status]);
    lines.push(`  ${icon} ${check.label.padEnd(20)} ${color.dim(check.detail)}`);
  }
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const check of result.checks) counts[check.status]++;
  lines.push("");
  const summary = `${result.checks.length} pemeriksaan · ${counts.ok} ok · ${counts.warn} peringatan · ${counts.fail} gagal`;
  lines.push(result.ok ? color.brightGreen(summary) : color.red(summary));
  return lines.join("\n");
}
