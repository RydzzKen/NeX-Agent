import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { plainTodoLines } from "../util/todos.js";

const schema = z.object({
  todos: z
    .array(
      z.object({
        content: z.string().describe("Deskripsi tugas, mis. 'Baca src/index.ts'."),
        status: z
          .enum(["pending", "in_progress", "completed", "cancelled"])
          .optional()
          .describe("Status tugas; default 'pending'."),
      }),
    )
    .min(1)
    .describe(
      "Daftar tugas LENGKAP dan terbaru (bukan tambahan). Kirim ulang seluruh daftar setiap kali memperbarui status.",
    ),
});

export const todoWriteTool: ToolDefinition<typeof schema> = {
  name: "todo_write",
  description:
    "Buat/perbarui daftar tugas (checklist) untuk tugas berlapis. Kirim seluruh daftar setiap kali; gunakan status pending, in_progress, completed, cancelled.",
  risk: "read",
  control: true,
  schema,
  summarize: (input) => {
    const total = input.todos.length;
    const done = input.todos.filter((t) => t.status === "completed").length;
    return `todos ${done}/${total}`;
  },
  async execute(input, ctx) {
    const items = ctx.todos.replace(input.todos);
    const counts = ctx.todos.counts();
    const content = [
      `Daftar tugas diperbarui (${counts.completed}/${counts.total} selesai, ${counts.inProgress} berjalan):`,
      ...plainTodoLines(items),
    ].join("\n");
    return { content, summary: `${counts.completed}/${counts.total} selesai`, todos: items };
  },
};
