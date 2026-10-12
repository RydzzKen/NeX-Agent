import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { ToolInputError } from "./errors.js";
import { matchGlob, walkFiles } from "./fs_walk.js";

const schema = z.object({
  pattern: z.string().min(1).describe("Pola regex JavaScript yang dicari di isi berkas."),
  path: z.string().optional().describe("Direktori awal pencarian (default: workspace)."),
  glob: z.string().optional().describe("Batasi ke berkas yang cocok pola glob (mis. `*.ts`)."),
  ignoreCase: z.boolean().optional().describe("Abaikan besar-kecil huruf (default false)."),
  max: z.number().int().positive().optional().describe("Jumlah maksimum baris hasil (default 200)."),
});

const MAX_RESULTS = 200;
const MAX_FILE_BYTES = 2_000_000;

export const grepTool: ToolDefinition<typeof schema> = {
  name: "grep",
  description:
    "Cari pola regex di isi berkas secara rekursif. Read-only. Hasil berformat `path:baris: teks`. Contoh pola: `TODO|FIXME`.",
  risk: "read",
  schema,
  summarize: (i) => i.pattern,
  async execute(input, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(input.pattern, input.ignoreCase ? "i" : "");
    } catch (err) {
      throw new ToolInputError(`Pola regex tidak valid: ${(err as Error).message}`);
    }

    const resolved = await ctx.resolvePath(input.path ?? ".", "read");
    let stat;
    try {
      stat = await fs.stat(resolved.abs);
    } catch {
      throw new ToolInputError(`Path tidak ditemukan: ${resolved.display}`);
    }
    if (!stat.isDirectory()) throw new ToolInputError(`Bukan direktori: ${resolved.display}`);

    const max = input.max ?? MAX_RESULTS;
    const hits: string[] = [];
    let truncated = false;

    search: for await (const abs of walkFiles(resolved.abs, { signal: ctx.signal })) {
      if (ctx.signal.aborted) break;
      const rel = path.relative(resolved.abs, abs).split(path.sep).join("/");
      if (input.glob && !matchGlob(input.glob, rel)) continue;

      let fileStat;
      try {
        fileStat = await fs.stat(abs);
      } catch {
        continue;
      }
      if (!fileStat.isFile() || fileStat.size > MAX_FILE_BYTES) continue;

      let buf;
      try {
        buf = await fs.readFile(abs);
      } catch {
        continue;
      }
      if (buf.includes(0)) continue; // lewati berkas biner

      const fileLines = buf.toString("utf8").split("\n");
      for (let i = 0; i < fileLines.length; i++) {
        const line = fileLines[i]!;
        if (re.test(line)) {
          hits.push(`${rel}:${i + 1}: ${line}`);
          if (hits.length >= max) {
            truncated = true;
            break search;
          }
        }
      }
    }

    if (hits.length === 0) return { content: "(tidak ada kecocokan)", summary: "0 kecocokan" };
    const content = hits.join("\n") + (truncated ? `\n... (dipotong di ${max} hasil)` : "");
    return { content, summary: `${hits.length} kecocokan` };
  },
};
