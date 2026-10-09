import fs from "node:fs/promises";
import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { ToolInputError } from "./errors.js";

const schema = z.object({
  path: z.string().describe("Path file (relatif workspace atau absolut)."),
  offset: z.number().int().positive().optional().describe("Baris awal (1-based)."),
  limit: z.number().int().positive().optional().describe("Jumlah baris maksimum (default 2000)."),
});

export const readFileTool: ToolDefinition<typeof schema> = {
  name: "read_file",
  description: "Baca isi file teks. Mengembalikan konten dengan nomor baris.",
  risk: "read",
  schema,
  summarize: (i) => i.path,
  async execute(input, ctx) {
    const resolved = await ctx.resolvePath(input.path, "read");
    let stat;
    try {
      stat = await fs.stat(resolved.abs);
    } catch {
      throw new ToolInputError(`File tidak ditemukan: ${resolved.display}`);
    }
    if (stat.isDirectory()) {
      throw new ToolInputError(`Path adalah direktori, gunakan list_dir: ${resolved.display}`);
    }
    if (stat.size > 5_000_000) {
      throw new ToolInputError(`File terlalu besar (${stat.size} byte): ${resolved.display}`);
    }

    const raw = await fs.readFile(resolved.abs, "utf8");
    const lines = raw.split("\n");
    const offset = (input.offset ?? 1) - 1;
    const limit = input.limit ?? 2000;
    const slice = lines.slice(offset, offset + limit);
    const numbered = slice
      .map((line, i) => `${String(offset + i + 1).padStart(6)}  ${line}`)
      .join("\n");
    const truncated = offset + limit < lines.length;
    const content = truncated
      ? `${numbered}\n... dipotong pada baris ${offset + limit} dari ${lines.length}`
      : numbered;
    return { content, summary: `${resolved.display} (${slice.length} baris)` };
  },
};
