import fs from "node:fs/promises";
import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { ToolDeniedError, ToolInputError } from "./errors.js";
import { writeText, countOccurrences } from "./fsutil.js";
import { renderDiff } from "../util/diff.js";

const schema = z.object({
  path: z.string().describe("Path file yang diedit."),
  oldString: z.string().describe("Teks yang dicari. Harus cocok persis dan unik."),
  newString: z.string().describe("Teks pengganti."),
  replaceAll: z.boolean().optional().describe("Ganti semua kemunculan (default: hanya yang unik)."),
});

export const editFileTool: ToolDefinition<typeof schema> = {
  name: "edit_file",
  description:
    "Ganti sebagian isi file. oldString harus cocok persis; bila muncul lebih dari sekali dan replaceAll tidak diset, ditolak.",
  risk: "mutate",
  schema,
  summarize: (i) => i.path,
  mutatedPaths: (i) => [i.path],
  async execute(input, ctx) {
    const resolved = await ctx.resolvePath(input.path, "write");
    let oldText: string;
    try {
      oldText = await fs.readFile(resolved.abs, "utf8");
    } catch {
      throw new ToolInputError(`File tidak ditemukan: ${resolved.display}`);
    }

    const occurrences = countOccurrences(oldText, input.oldString);
    if (occurrences === 0) {
      throw new ToolInputError(`oldString tidak ditemukan di ${resolved.display}.`);
    }
    if (occurrences > 1 && !input.replaceAll) {
      throw new ToolInputError(
        `oldString cocok ${occurrences} kali di ${resolved.display}; perjelas konteks atau set replaceAll=true.`,
      );
    }

    const newText = input.replaceAll
      ? oldText.split(input.oldString).join(input.newString)
      : oldText.replace(input.oldString, input.newString);

    if (oldText === newText) {
      return { content: `Tidak ada perubahan pada ${resolved.display}.`, summary: `${resolved.display} (tanpa perubahan)` };
    }

    const diff = renderDiff(oldText, newText, resolved.display);
    const decision = await ctx.confirm(
      {
        kind: "write",
        title: `Edit ${resolved.display}`,
        detail: `${occurrences} penggantian.`,
        diff,
      },
      { allowAll: !resolved.outside },
    );
    if (decision === "no") throw new ToolDeniedError(`Pengguna menolak mengedit ${resolved.display}`);

    await writeText(resolved.abs, newText);
    return {
      content: `File diedit: ${resolved.display} (${occurrences} penggantian).`,
      summary: `${resolved.display} diedit`,
    };
  },
};
