import { z } from "zod";
import type { ToolDefinition } from "./types.js";

const schema = z.object({
  query: z.string().describe("Kata kunci pencarian web."),
});

export const webSearchTool: ToolDefinition<typeof schema> = {
  name: "web_search",
  description: "Cari informasi di web. Mengembalikan daftar judul, URL, dan cuplikan.",
  risk: "read",
  schema,
  summarize: (i) => i.query,
  async execute(input, ctx) {
    if (!ctx.search) {
      return {
        ok: false,
        content:
          "web_search tidak dikonfigurasi. Setel fungsi pencarian lewat konfigurasi (mis. search provider) untuk mengaktifkannya.",
      };
    }
    try {
      const results = await ctx.search(input.query, ctx.signal);
      if (results.length === 0) return { content: `Tidak ada hasil untuk: ${input.query}` };
      const content = results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
        .join("\n");
      return { content, summary: `${results.length} hasil` };
    } catch (err) {
      return { ok: false, content: `Pencarian gagal: ${(err as Error).message}` };
    }
  },
};
