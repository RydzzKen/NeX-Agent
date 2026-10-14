import fs from "node:fs/promises";
import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { ToolDeniedError, ToolInputError } from "./errors.js";
import { writeText, countOccurrences } from "./fsutil.js";
import { renderDiff } from "../util/diff.js";

const editSchema = z.object({
  oldString: z.string().describe("Teks yang dicari; harus cocok persis."),
  newString: z.string().describe("Teks pengganti."),
  replaceAll: z.boolean().optional().describe("Ganti semua kemunculan (default: hanya yang unik)."),
});

const filePatchSchema = z.object({
  path: z.string().describe("Path file yang diedit."),
  edits: z.array(editSchema).min(1).describe("Edit berurutan untuk file ini."),
});

const schema = z.object({
  patches: z
    .array(filePatchSchema)
    .min(1)
    .describe("Daftar file yang diedit; tiap file memuat satu atau lebih edit berurutan."),
});

interface PreparedFile {
  display: string;
  abs: string;
  before: string;
  after: string;
  replacements: number;
  outside: boolean;
}

/**
 * Terapkan beberapa edit ke beberapa file dalam satu langkah.
 *
 * Atomik di tingkat validasi: semua path diresolusi dan semua `oldString`
 * dicek lebih dulu di memori. Bila ada satu saja yang gagal (file hilang,
 * teks tidak ketemu, atau ambigu), **tidak ada** file yang ditulis. Setelah
 * semua valid, satu konfirmasi menampilkan diff gabungan, lalu file ditulis.
 */
export const applyPatchTool: ToolDefinition<typeof schema> = {
  name: "apply_patch",
  description:
    "Terapkan beberapa edit (oldString→newString) ke satu atau banyak file sekaligus, atomik: bila satu edit gagal, tidak ada file yang diubah. Lebih efisien daripada memanggil edit_file berulang kali.",
  risk: "mutate",
  schema,
  summarize: (i) =>
    i.patches.length === 1 ? i.patches[0]!.path : `${i.patches.length} file`,
  mutatedPaths: (i) => i.patches.map((p) => p.path),
  async execute(input, ctx) {
    // Kelompokkan per path agar beberapa patch untuk file yang sama bekerja
    // pada teks yang sudah terakumulasi (bukan snapshot lama).
    const work = new Map<string, PreparedFile>();
    const problems: string[] = [];

    for (const patch of input.patches) {
      const resolved = await ctx.resolvePath(patch.path, "write");
      let entry = work.get(resolved.display);
      if (!entry) {
        let before: string;
        try {
          before = await fs.readFile(resolved.abs, "utf8");
        } catch {
          problems.push(`File tidak ditemukan: ${resolved.display}`);
          continue;
        }
        entry = {
          display: resolved.display,
          abs: resolved.abs,
          before,
          after: before,
          replacements: 0,
          outside: resolved.outside,
        };
        work.set(resolved.display, entry);
      }

      let failed = false;
      for (const [i, edit] of patch.edits.entries()) {
        const label = `${resolved.display} edit #${i + 1}`;
        if (edit.oldString === "") {
          problems.push(`${label}: oldString kosong.`);
          failed = true;
          break;
        }
        const occurrences = countOccurrences(entry.after, edit.oldString);
        if (occurrences === 0) {
          problems.push(`${label}: oldString tidak ditemukan.`);
          failed = true;
          break;
        }
        if (occurrences > 1 && !edit.replaceAll) {
          problems.push(
            `${label}: oldString cocok ${occurrences} kali; perjelas konteks atau set replaceAll=true.`,
          );
          failed = true;
          break;
        }
        entry.after = edit.replaceAll
          ? entry.after.split(edit.oldString).join(edit.newString)
          : entry.after.replace(edit.oldString, edit.newString);
        entry.replacements += edit.replaceAll ? occurrences : 1;
      }
      if (failed) continue;
    }

    if (problems.length > 0) {
      throw new ToolInputError(
        `Patch dibatalkan (tidak ada file yang diubah):\n- ${problems.join("\n- ")}`,
      );
    }

    const prepared = [...work.values()].filter((p) => p.before !== p.after);
    if (prepared.length === 0) {
      return {
        content: "Tidak ada perubahan yang perlu diterapkan.",
        summary: "tanpa perubahan",
      };
    }

    const total = prepared.reduce((n, p) => n + p.replacements, 0);
    const diff = prepared.map((p) => renderDiff(p.before, p.after, p.display)).join("\n");
    const decision = await ctx.confirm(
      {
        kind: "write",
        title: prepared.length === 1 ? `Patch ${prepared[0]!.display}` : `Patch ${prepared.length} file`,
        detail: `${total} penggantian di ${prepared.length} file.`,
        diff,
      },
      { allowAll: prepared.every((p) => !p.outside) },
    );
    if (decision === "no") {
      throw new ToolDeniedError(
        `Pengguna menolak patch (${prepared.map((p) => p.display).join(", ")})`,
      );
    }

    for (const p of prepared) await writeText(p.abs, p.after);

    return {
      content: `Patch diterapkan: ${prepared.length} file, ${total} penggantian (${prepared
        .map((p) => p.display)
        .join(", ")}).`,
      summary: `${prepared.length} file (${total} penggantian)`,
    };
  },
};
