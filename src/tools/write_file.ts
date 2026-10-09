import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { ToolDeniedError } from "./errors.js";
import { readTextOrEmpty, writeText, fileExists } from "./fsutil.js";
import { renderDiff } from "../util/diff.js";

const schema = z.object({
  path: z.string().describe("Path file yang ditulis."),
  content: z.string().describe("Isi file lengkap (menimpa file lama bila ada)."),
});

export const writeFileTool: ToolDefinition<typeof schema> = {
  name: "write_file",
  description: "Tulis file baru atau timpa file yang ada. Menampilkan diff dan butuh persetujuan.",
  risk: "mutate",
  schema,
  summarize: (i) => i.path,
  mutatedPaths: (i) => [i.path],
  async execute(input, ctx) {
    const resolved = await ctx.resolvePath(input.path, "write");
    const oldText = (await fileExists(resolved.abs)) ? await readTextOrEmpty(resolved.abs) : "";
    const newText = input.content;

    if (oldText === newText) {
      return { content: `Tidak ada perubahan pada ${resolved.display}.`, summary: `${resolved.display} (tanpa perubahan)` };
    }

    const diff = renderDiff(oldText, newText, resolved.display);
    const existed = await fileExists(resolved.abs);
    const decision = await ctx.confirm(
      {
        kind: "write",
        title: existed ? `Timpa ${resolved.display}` : `Buat ${resolved.display}`,
        detail: existed ? "File akan ditimpa." : "File baru akan dibuat.",
        diff,
      },
      { allowAll: !resolved.outside },
    );
    if (decision === "no") throw new ToolDeniedError(`Pengguna menolak menulis ${resolved.display}`);

    await writeText(resolved.abs, newText);
    const lines = newText === "" ? 0 : newText.split("\n").length;
    return { content: `File ditulis: ${resolved.display} (${lines} baris).`, summary: `${resolved.display} ditulis` };
  },
};
