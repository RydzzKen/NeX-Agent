import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { ToolDeniedError } from "./errors.js";
import { detectSkillSourceKind, installSkillViaSkillui } from "../memory/skillui.js";

const schema = z.object({
  source: z
    .string()
    .min(1)
    .describe("URL situs (https://...), URL git repo, atau path folder lokal."),
  kind: z
    .enum(["url", "repo", "dir"])
    .optional()
    .describe("Jenis sumber: situs, git repo, atau folder. Ditebak otomatis bila kosong."),
  name: z.string().min(1).max(64).optional().describe("Nama skill (opsional; default dari judul SkillUI)."),
  ultra: z
    .boolean()
    .optional()
    .describe("Mode ultra SkillUI: screenshot + animasi via Playwright (lebih berat)."),
  overwrite: z.boolean().optional().describe("Timpa skill bernama sama (default: false)."),
  timeoutMs: z.number().int().positive().optional().describe("Timeout ms (default 300000)."),
});

export const skillInstallTool: ToolDefinition<typeof schema> = {
  name: "skill_install",
  description:
    "Pasang skill eksternal memakai SkillUI: menyalin sistem desain (warna, font, komponen) " +
    "dari situs, git repo, atau folder lokal menjadi skill di skills/<nama>/SKILL.md, lalu " +
    "langsung aktif. Pakai saat pengguna minta 'buat/pasang skill dari <situs>'. " +
    "Butuh Node 18+ dan mengunduh paket `skillui` lewat npx.",
  risk: "mutate",
  schema,
  summarize: (input) => `skillui ${input.source}`,
  async execute(input, ctx) {
    const kind = input.kind ?? detectSkillSourceKind(input.source);
    const flag = kind === "url" ? "--url" : kind === "repo" ? "--repo" : "--dir";

    const decision = await ctx.confirm(
      {
        kind: "shell",
        title: "Pasang skill via SkillUI",
        detail: `npx skillui ${flag} ${input.source}${input.ultra ? " --mode ultra" : ""}`,
        irreversible: true,
      },
      { allowAll: true },
    );
    if (decision === "no") throw new ToolDeniedError(`Pengguna menolak memasang skill dari ${input.source}`);

    const result = await installSkillViaSkillui({
      workspaceRoot: ctx.workspace.root,
      source: input.source,
      kind,
      name: input.name,
      ultra: input.ultra,
      overwrite: input.overwrite,
      timeoutMs: input.timeoutMs,
      signal: ctx.signal,
    });

    if (!result.ok) {
      return { ok: false, content: [result.error, result.output].filter(Boolean).join("\n\n") };
    }

    if (ctx.registerSkill) await ctx.registerSkill(result.skill);
    const note = ctx.registerSkill
      ? "Skill langsung aktif untuk sesi ini."
      : "Skill akan termuat pada giliran berikutnya.";
    return {
      content: `Skill "${result.slug}" terpasang di skills/${result.slug}/SKILL.md. ${note}\n${result.skill.description}`,
      summary: `skill ${result.slug}`,
    };
  },
};
