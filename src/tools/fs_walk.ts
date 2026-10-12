import fs from "node:fs/promises";
import path from "node:path";

/**
 * Nama direktori/file yang selalu dilewati saat menelusuri workspace
 * (`list_dir`, `glob`, `grep`). Dibuat sentral agar semua tool konsisten.
 */
export const SEARCH_SKIP = new Set(["node_modules", ".git", "dist", "coverage", ".DS_Store"]);

export interface WalkOptions {
  /** Batas jumlah berkas yang ditelusuri (default 20.000) agar tidak menggantung. */
  maxFiles?: number;
  signal?: AbortSignal;
}

/**
 * Telusuri berkas di `root` secara rekursif dan hasilkan path **absolut**
 * (hanya berkas, bukan direktori). Direktori umum yang tidak relevan dilewati
 * (`SEARCH_SKIP`). Berhenti lebih awal saat dibatalkan atau mencapai `maxFiles`.
 */
export async function* walkFiles(root: string, opts: WalkOptions = {}): AsyncGenerator<string> {
  const maxFiles = opts.maxFiles ?? 20_000;
  const stack: string[] = [root];
  let count = 0;

  while (stack.length > 0) {
    if (opts.signal?.aborted) return;
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (opts.signal?.aborted) return;
      if (SEARCH_SKIP.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        count++;
        if (count > maxFiles) return;
        yield abs;
      }
    }
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Ubah pola glob sederhana menjadi RegExp (dipisah `/`).
 *
 * Didukung: `*` (satu segmen), `**` (lintas segmen), `?` (satu karakter),
 * `{a,b}` (alternatif literal), `[abc]` (kelas karakter). Pola tanpa `/`
 * dicocokkan ke nama dasar berkas (lihat `matchGlob`).
 */
export function globToRegExp(pattern: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
          continue;
        }
        re += ".*";
        i += 2;
        continue;
      }
      re += "[^/]*";
      i += 1;
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    if (c === "{") {
      const end = pattern.indexOf("}", i + 1);
      if (end !== -1) {
        const alts = pattern.slice(i + 1, end).split(",").map(escapeRegExp);
        re += `(?:${alts.join("|")})`;
        i = end + 1;
        continue;
      }
    }
    if (c === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end !== -1) {
        re += pattern.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    re += escapeRegExp(c);
    i += 1;
  }
  re += "$";
  return new RegExp(re);
}

/**
 * Cocokkan path relatif (dengan pemisah `/`) terhadap pola glob. Pola tanpa `/`
 * dicocokkan ke nama dasar saja, sehingga `*.ts` mengenai berkas `.ts` di
 * kedalaman mana pun.
 */
export function matchGlob(pattern: string, relPath: string): boolean {
  const target = pattern.includes("/") ? relPath : path.posix.basename(relPath);
  return globToRegExp(pattern).test(target);
}
