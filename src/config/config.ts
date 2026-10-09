import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function configDir(): string {
  return process.env.AGENT_CONFIG_DIR ?? path.join(os.homedir(), ".config", "agent");
}

export function sessionsDir(): string {
  return path.join(configDir(), "sessions");
}

export function logsDir(): string {
  return path.join(configDir(), "logs");
}

export interface AgentConfig {
  /** Batas langkah default bila tidak diberikan lewat flag. */
  maxSteps?: number;
  /** Anggaran default per tugas (USD). */
  maxCost?: number;
  /** Tampilkan thinking (default true). */
  thinking?: boolean;
  /** Render markdown pada jawaban model (default true). */
  markdown?: boolean;
  /** Provider default. */
  defaultProvider?: string;
  /** Model terakhir per workspace (key = path absolut root). */
  models?: Record<string, string>;
  /** URL layanan pencarian web opsional. */
  searchUrl?: string;
}

async function readConfig(): Promise<AgentConfig> {
  try {
    const raw = await fs.readFile(path.join(configDir(), "config.json"), "utf8");
    return JSON.parse(raw) as AgentConfig;
  } catch {
    return {};
  }
}

export async function loadConfig(): Promise<AgentConfig> {
  return readConfig();
}

export async function saveConfig(patch: Partial<AgentConfig>): Promise<AgentConfig> {
  const current = await readConfig();
  const merged: AgentConfig = { ...current, ...patch, models: { ...current.models, ...patch.models } };
  await fs.mkdir(configDir(), { recursive: true });
  await fs.writeFile(path.join(configDir(), "config.json"), JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

export async function rememberModel(workspaceRoot: string, model: string): Promise<void> {
  await saveConfig({ models: { [workspaceRoot]: model } });
}
