import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { configDir } from "../config/config.js";
import {
  MAX_KEY_LEN,
  MAX_VALUE_LEN,
  findFact,
  formatFacts,
  looksSecret,
  readFacts,
  removeFact,
  upsertFact,
  writeFacts,
} from "../memory/long_term.js";

const schema = z.object({
  action: z
    .enum(["add", "list", "forget"])
    .describe("add: simpan/perbarui fakta; list: tampilkan semua; forget: hapus berdasarkan key."),
  key: z
    .string()
    .min(1)
    .max(MAX_KEY_LEN)
    .optional()
    .describe("Label fakta singkat (mis. 'nama', 'hobi', 'bahasa'). Wajib untuk add/forget."),
  value: z
    .string()
    .min(1)
    .max(MAX_VALUE_LEN)
    .optional()
    .describe("Isi fakta (mis. 'Rydz', 'coding'). Wajib untuk add."),
});

function listContent(facts: Awaited<ReturnType<typeof readFacts>>): string {
  if (facts.length === 0) return "Belum ada memori jangka panjang yang tersimpan.";
  return `Memori jangka panjang (${facts.length} fakta):\n${formatFacts(facts, Number.MAX_SAFE_INTEGER)}`;
}

export const memoryTool: ToolDefinition<typeof schema> = {
  name: "memory",
  description:
    "Simpan/lihat/hapus fakta jangka panjang sederhana tentang pengguna " +
    "(nama, hobi, preferensi, bahasa, dsb.) yang tersimpan antar sesi. " +
    "Pakai saat pengguna menyebut info pribadi yang stabil atau memintamu mengingat sesuatu. " +
    "Jangan simpan kredensial/rahasia.",
  risk: "mutate",
  schema,
  summarize: (i) => (i.key ? `${i.action} ${i.key}` : i.action),
  async execute(input, ctx) {
    const dir = configDir();
    let facts = await readFacts(dir);

    if (input.action === "list") {
      return { content: listContent(facts), summary: `${facts.length} fakta` };
    }

    if (input.action === "add") {
      if (!input.key || !input.value) {
        return { ok: false, content: 'Aksi "add" butuh `key` dan `value`.' };
      }
      if (looksSecret(input.key) || looksSecret(input.value)) {
        return {
          ok: false,
          content:
            "Ditolak: jangan menyimpan kredensial/rahasia (sandi, token, API key) di memori.",
        };
      }
      facts = upsertFact(facts, input.key, input.value);
      await writeFacts(dir, facts);
      await ctx.refreshMemory?.();
      return {
        content: `Diingat: ${input.key.trim()} = ${input.value.trim()}. Total ${facts.length} fakta.`,
        summary: `ingat ${input.key.trim()}`,
      };
    }

    // action === "forget"
    if (!input.key) {
      return { ok: false, content: 'Aksi "forget" butuh `key`.' };
    }
    const existed = findFact(facts, input.key);
    if (!existed) {
      return { ok: false, content: `Tidak ada memori dengan key "${input.key.trim()}".` };
    }
    facts = removeFact(facts, input.key);
    await writeFacts(dir, facts);
    await ctx.refreshMemory?.();
    return {
      content: `Dilupakan: ${existed.key}. Sisa ${facts.length} fakta.`,
      summary: `lupakan ${existed.key}`,
    };
  },
};
