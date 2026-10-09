import { z } from "zod";
import type { ToolDefinition } from "./types.js";

const schema = z.object({
  name: z
    .string()
    .min(1)
    .describe("Nama skill persis seperti yang terdaftar di daftar skill system prompt."),
});

export const skillTool: ToolDefinition<typeof schema> = {
  name: "skill",
  description:
    "Muat instruksi lengkap sebuah skill berdasarkan namanya. Gunakan saat tugas cocok dengan skill yang terdaftar di system prompt. Mengembalikan isi SKILL.md beserta folder referensinya.",
  risk: "read",
  schema,
  summarize: (input) => `skill ${input.name}`,
  async execute(input, ctx) {
    const skills = ctx.skills ?? [];
    if (skills.length === 0) {
      return { content: "Tidak ada skill yang tersedia pada sesi ini.", ok: false };
    }
    const skill = skills.find((s) => s.name === input.name);
    if (!skill) {
      const names = skills.map((s) => s.name).join(", ");
      return {
        content: `Skill tidak ditemukan: ${input.name}. Skill yang tersedia: ${names}.`,
        ok: false,
      };
    }
    return {
      content: [
        `# Skill: ${skill.name}`,
        skill.description,
        "",
        `Folder referensi: ${skill.dir}`,
        "",
        skill.body,
      ].join("\n"),
      summary: skill.name,
    };
  },
};
