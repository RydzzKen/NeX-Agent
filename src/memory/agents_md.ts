import fs from "node:fs/promises";
import path from "node:path";

export interface MemoryLoadOptions {
  workspaceRoot: string;
  globalConfigDir: string;
  /** File yang sedang dikerjakan; memicu pemuatan AGENTS.md subfolder. */
  targetPaths?: string[];
}

export interface LoadedMemory {
  content: string;
  files: string[];
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Muat AGENTS.md dengan urutan: global, workspace, lalu subfolder dari file
 * yang dikerjakan. Semua yang ada digabung (F-? §5).
 */
export async function loadAgentsMd(opts: MemoryLoadOptions): Promise<LoadedMemory> {
  const candidates: string[] = [];
  candidates.push(path.join(opts.globalConfigDir, "AGENTS.md"));
  candidates.push(path.join(opts.workspaceRoot, "AGENTS.md"));

  for (const target of opts.targetPaths ?? []) {
    const abs = path.resolve(opts.workspaceRoot, target);
    let dir = path.dirname(abs);
    const seen = new Set<string>();
    while (dir.startsWith(opts.workspaceRoot) && dir !== opts.workspaceRoot) {
      if (!seen.has(dir)) {
        seen.add(dir);
        candidates.push(path.join(dir, "AGENTS.md"));
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  const files: string[] = [];
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const content = await readIfExists(candidate);
    if (content === null) continue;
    files.push(candidate);
    parts.push(`<!-- ${candidate} -->\n${content.trim()}`);
  }

  return { content: parts.join("\n\n"), files };
}
