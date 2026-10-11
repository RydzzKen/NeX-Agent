import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { ToolDeniedError } from "./errors.js";
import { fileExists, readTextOrEmpty, writeText } from "./fsutil.js";
import { renderDiff } from "../util/diff.js";
import type { Skill } from "../memory/skills.js";

/** Slug nama skill yang aman dipakai sebagai nama folder. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

const schema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .describe("Slug skill: huruf, angka, '-', '_' (mis. 'laporan-bulanan')."),
  description: z
    .string()
    .min(1)
    .max(500)
    .describe("Deskripsi singkat kapan skill ini harus dipakai."),
  body: z.string().min(1).describe("Isi instruksi skill dalam format markdown."),
  overwrite: z
    .boolean()
    .optional()
    .describe("Timpa bila skill dengan nama sama sudah ada (default: false)."),
});

/** Susun isi SKILL.md dengan frontmatter sederhana (name + description). */
export function renderSkillFile(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trim()}\n`;
}

export const skillWriteTool: ToolDefinition<typeof schema> = {
  name: "skill_write",
  description:
    "Buat atau perbarui skill untuk dirimu sendiri di dalam workspace " +
    "(skills/<nama>/SKILL.md). Pakai saat menemukan prosedur yang layak diulang. " +
    "Skill langsung didaftarkan untuk sesi ini.",
  risk: "mutate",
  schema,
  summarize: (i) => `skill ${i.name}`,
  mutatedPaths: (i) => [`skills/${i.name}/SKILL.md`],
  async execute(input, ctx) {
    const name = input.name.trim();
    if (!NAME_PATTERN.test(name)) {
      return {
        ok: false,
        content: `Nama skill tidak valid: "${input.name}". Gunakan huruf/angka, '-', '_', tanpa spasi.`,
      };
    }

    const file = path.join(ctx.workspace.root, "skills", name, "SKILL.md");
    const display = path.relative(ctx.workspace.root, file) || file;
    const existed = await fileExists(file);
    if (existed && !input.overwrite) {
      return {
        ok: false,
        content: `Skill "${name}" sudah ada (${display}). Set overwrite=true bila memang ingin menimpanya.`,
      };
    }

    const description = input.description.trim();
    const body = input.body.trim();
    const oldText = existed ? await readTextOrEmpty(file) : "";
    const newText = renderSkillFile(name, description, body);

    const decision = await ctx.confirm(
      {
        kind: "write",
        title: existed ? `Timpa skill ${name}` : `Buat skill ${name}`,
        detail: `Simpan ke ${display}.`,
        diff: renderDiff(oldText, newText, display),
      },
      { allowAll: true },
    );
    if (decision === "no") throw new ToolDeniedError(`Pengguna menolak menulis ${display}`);

    await writeText(file, newText);

    const skill: Skill = { name, description, path: file, dir: path.dirname(file), body };
    if (ctx.registerSkill) await ctx.registerSkill(skill);

    const note = ctx.registerSkill
      ? "Skill didaftarkan dan langsung tersedia pada sesi ini."
      : "Skill akan termuat pada giliran berikutnya.";
    return { content: `Skill ditulis: ${display}. ${note}`, summary: `skill ${name} disimpan` };
  },
};
