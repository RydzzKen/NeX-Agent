import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { ToolInputError } from "./errors.js";

const schema = z.object({
  path: z.string().optional().describe("Direktori yang didaftar (default: workspace)."),
  depth: z.number().int().min(1).max(3).optional().describe("Kedalaman maksimum (default 1)."),
});

const MAX_ENTRIES = 500;
const ALWAYS_SKIP = new Set(["node_modules", ".git", "dist", "coverage", ".DS_Store"]);

async function walk(dir: string, base: string, depth: number, maxDepth: number, out: string[]): Promise<void> {
  if (out.length >= MAX_ENTRIES) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= MAX_ENTRIES) return;
    if (ALWAYS_SKIP.has(entry.name)) continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(`${rel}/`);
      if (depth < maxDepth) await walk(path.join(dir, entry.name), rel, depth + 1, maxDepth, out);
    } else {
      out.push(rel);
    }
  }
}

export const listDirTool: ToolDefinition<typeof schema> = {
  name: "list_dir",
  description: "Daftar isi direktori. Direktori diberi akhiran '/'.",
  risk: "read",
  schema,
  summarize: (i) => i.path ?? ".",
  async execute(input, ctx) {
    const resolved = await ctx.resolvePath(input.path ?? ".", "read");
    let stat;
    try {
      stat = await fs.stat(resolved.abs);
    } catch {
      throw new ToolInputError(`Direktori tidak ditemukan: ${resolved.display}`);
    }
    if (!stat.isDirectory()) throw new ToolInputError(`Bukan direktori: ${resolved.display}`);

    const out: string[] = [];
    await walk(resolved.abs, "", 1, input.depth ?? 1, out);
    const truncated = out.length >= MAX_ENTRIES;
    const content = out.join("\n") + (truncated ? `\n... (dipotong di ${MAX_ENTRIES} entri)` : "");
    return { content, summary: `${resolved.display} (${out.length} entri)` };
  },
};
