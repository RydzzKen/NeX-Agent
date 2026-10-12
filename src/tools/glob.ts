import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { ToolInputError } from "./errors.js";
import { matchGlob, walkFiles } from "./fs_walk.js";

const schema = z.object({
  pattern: z.string().min(1).describe("Pola glob, mis. `src/**/*.ts` atau `*.json`."),
  path: z.string().optional().describe("Direktori awal pencarian (default: workspace)."),
  max: z.number().int().positive().optional().describe("Jumlah maksimum hasil (default 200)."),
});

const MAX_RESULTS = 200;

export const globTool: ToolDefinition<typeof schema> = {
  name: "glob",
  description:
    "Cari berkas berdasarkan pola glob (`*`, `**`, `?`, `{a,b}`). Read-only. Contoh: `src/**/*.ts`. Pola tanpa `/` dicocokkan ke nama berkas di kedalaman mana pun.",
  risk: "read",
  schema,
  summarize: (i) => i.pattern,
  async execute(input, ctx) {
    const resolved = await ctx.resolvePath(input.path ?? ".", "read");
    let stat;
    try {
      stat = await fs.stat(resolved.abs);
    } catch {
      throw new ToolInputError(`Path tidak ditemukan: ${resolved.display}`);
    }
    if (!stat.isDirectory()) throw new ToolInputError(`Bukan direktori: ${resolved.display}`);

    const max = input.max ?? MAX_RESULTS;
    const matches: string[] = [];
    for await (const abs of walkFiles(resolved.abs, { signal: ctx.signal })) {
      const rel = path.relative(resolved.abs, abs).split(path.sep).join("/");
      if (matchGlob(input.pattern, rel)) matches.push(rel);
      if (matches.length > max) break;
    }

    const truncated = matches.length > max;
    const shown = matches.slice(0, max).sort((a, b) => a.localeCompare(b));
    if (shown.length === 0) {
      return { content: `(tidak ada berkas cocok pola "${input.pattern}")`, summary: "0 berkas" };
    }
    const content = shown.join("\n") + (truncated ? `\n... (dipotong di ${max} hasil)` : "");
    return { content, summary: `${shown.length} berkas` };
  },
};
