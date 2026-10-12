import { z } from "zod";
import type { ToolDefinition } from "./types.js";

export const taskSchema = z.object({
  /** Tugas untuk sesi anak (sampai 4000 karakter). */
  prompt: z
    .string()
    .min(1, "prompt wajib diisi")
    .max(4000, "prompt terlalu panjang (maks 4000 karakter)"),
  /** Batas langkah sesi anak (1-50; default 12). */
  maxSteps: z.number().int().min(1).max(50).optional(),
  /** Anggaran biaya sesi anak (USD). */
  maxCost: z.number().positive("maxCost harus positif").optional(),
  /** True = hanya tool baca & mode Plan; satu-satunya cara di mode Plan. */
  readOnly: z.boolean().optional(),
});

export type TaskInput = z.infer<typeof taskSchema>;

function clip(text: string, n: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

export const taskTool: ToolDefinition<typeof taskSchema> = {
  name: "task",
  description:
    "Jalankan pekerjaan terpisah di sesi anak (subagent). Sesi anak punya konteks kosong, " +
    "anggaran sendiri (pemakaiannya ditambahkan ke sesi ini), dan kembali dengan ringkasan " +
    "teks — cocok untuk eksplorasi/perangkuman paralel tanpa mengotori konteks utama. " +
    "Di mode Plan hanya diizinkan dengan readOnly: true. Subagent tidak bisa memanggil " +
    "task lagi (kedalaman 1).",
  risk: "mutate",
  riskFor: (input) => (input.readOnly === true ? "read" : "mutate"),
  schema: taskSchema,
  summarize: (input) => `${input.readOnly === true ? "baca" : "delegasikan"}: ${clip(input.prompt, 60)}`,
  execute: async (input, ctx) => {
    if (!ctx.task) {
      return { content: "Tool task tidak tersedia di sesi ini.", ok: false };
    }
    const result = await ctx.task(
      {
        prompt: input.prompt,
        maxSteps: input.maxSteps,
        maxCost: input.maxCost,
        readOnly: input.readOnly,
      },
      ctx.signal,
    );
    const status =
      result.status === "ok" ? "" : `\n[subagent berhenti: ${result.stopReason}]`;
    return {
      content: `${result.summary}${status}`,
      ok: true,
      summary: `${result.steps} langkah${input.readOnly === true ? " (baca)" : ""}`,
    };
  },
};