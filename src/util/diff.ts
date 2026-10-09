import { createTwoFilesPatch, diffLines } from "diff";
import { color } from "./color.js";

export interface DiffStats {
  added: number;
  removed: number;
}

/** Statistik jumlah baris ditambah/dihapus. */
export function diffStats(oldText: string, newText: string): DiffStats {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(oldText, newText)) {
    if (part.added) added += part.count ?? 0;
    else if (part.removed) removed += part.count ?? 0;
  }
  return { added, removed };
}

/** Patch unified tanpa warna. */
export function unifiedDiff(oldText: string, newText: string, filePath: string): string {
  return createTwoFilesPatch(filePath, filePath, oldText, newText, "", "", { context: 3 });
}

/** Warnai patch unified: hapus merah, tambah hijau, konteks netral. */
export function colorizeDiff(patch: string): string {
  return patch
    .split("\n")
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---")) return color.bold(line);
      if (line.startsWith("@@")) return color.cyan(line);
      if (line.startsWith("+")) return color.green(line);
      if (line.startsWith("-")) return color.red(line);
      return line;
    })
    .join("\n");
}

/** Patch unified berwarna dengan header ringkasan. */
export function renderDiff(oldText: string, newText: string, filePath: string): string {
  const patch = unifiedDiff(oldText, newText, filePath);
  const stats = diffStats(oldText, newText);
  const header = color.bold(`${filePath}  (+${stats.added} -${stats.removed})`);
  return `${header}\n${colorizeDiff(patch)}`;
}
