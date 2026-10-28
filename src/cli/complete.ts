import fs from "node:fs";
import path from "node:path";

/**
 * Logika autocomplete untuk REPL (Tab):
 * - token pertama → lengkapi perintah slash (`/se` → `/sessions`, `/web`);
 * - token kedua untuk perintah yang punya subperintah (`/mcp re` → `reload`);
 * - selain itu → lengkapi path berkas/direktori relatif terhadap `cwd`.
 *
 * Murni (sinkron) supaya mudah diuji dan dipakai langsung sebagai `completer`
 * readline.
 */

/** Subperintah yang bisa dilengkapi untuk sebuah perintah. */
export const SUBCOMMANDS: Record<string, string[]> = {
  "/mcp": ["add", "remove", "reload", "key", "presets"],
  "/provider": ["use", "edit", "hapus"],
  "/sessions": ["clear"],
  "/delete": ["all"],
  "/details": ["panel"],
  "/mode": ["plan", "build"],
  "/skill": ["off"],
  "/skills": ["install"],
  "/telegram": [
    "start",
    "stop",
    "restart",
    "status",
    "logs",
    "token",
    "allow",
    "deny",
    "on",
    "off",
  ],
  "/web": ["lan", "stop"],
};

const AT_IGNORED = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  "target",
  "vendor",
]);

/** Nilai fuzzy: makin tinggi makin cocok; -1 = tidak cocok. */
function fuzzyScore(text: string, query: string): number {
  if (!query) return 1;
  const hay = text.toLowerCase();
  const q = query.toLowerCase();
  if (hay === q) return 10_000;
  if (hay.startsWith(q)) return 5_000 - hay.length;
  const idx = hay.indexOf(q);
  if (idx >= 0) return 3_000 - idx - hay.length;
  let ti = 0;
  let last = -2;
  let score = 0;
  for (const ch of q) {
    const found = hay.indexOf(ch, ti);
    if (found < 0) return -1;
    score += found === last + 1 ? 4 : 1;
    last = found;
    ti = found + 1;
  }
  return score - hay.length * 0.01;
}

/** Kumpulkan file relatif (batas kedalaman + jumlah) untuk pencarian `@`. */
function listFiles(root: string, max = 4000): string[] {
  const out: string[] = [];
  const stack: Array<{ dir: string; rel: string; depth: number }> = [
    { dir: root, rel: "", depth: 0 },
  ];
  while (stack.length > 0 && out.length < max) {
    const item = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(item.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const rel = item.rel ? `${item.rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (AT_IGNORED.has(entry.name) || item.depth >= 8) continue;
        stack.push({ dir: path.join(item.dir, entry.name), rel, depth: item.depth + 1 });
      } else if (entry.isFile()) {
        out.push(rel);
        if (out.length >= max) break;
      }
    }
  }
  return out;
}

/**
 * Cari file untuk token `@...` dengan fuzzy match pada path relatif.
 * Mengembalikan kandidat berawalan `@` siap dipakai sebagai pengganti token.
 */
export function completeAt(input: string, cwd: string, max = 30): [string[], string] {
  const token = input.replace(/^\s+/, "");
  if (!token.startsWith("@")) return [[], token];
  const query = token.slice(1).replace(/^\.\//, "");
  const files = listFiles(cwd);
  const scored = files
    .map((file) => ({ file, score: fuzzyScore(file, query) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, max)
    .map((entry) => `@${entry.file}`);
  return [scored, token];
}

function completePath(token: string, cwd: string): [string[], string] {
  const dirPart = token.includes("/") ? token.slice(0, token.lastIndexOf("/")) : ".";
  const basePart = token.slice(token.lastIndexOf("/") + 1);
  const absDir = path.resolve(cwd, dirPart === "." ? "" : dirPart);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return [[], token];
  }
  const hits: string[] = [];
  for (const entry of entries) {
    // Sembunyikan dotfile kecuali pengguna memang mengetik titik di depan.
    if (entry.name.startsWith(".") && !basePart.startsWith(".")) continue;
    if (!entry.name.startsWith(basePart)) continue;
    const rel = dirPart === "." ? entry.name : `${dirPart}/${entry.name}`;
    hits.push(entry.isDirectory() ? `${rel}/` : rel);
  }
  hits.sort();
  return [hits, token];
}

/**
 * Format satu baris petunjuk "dropdown" dari kandidat, dibatasi `max` agar
 * tidak memenuhi layar. Murni agar mudah diuji.
 */
/**
 * Format petunjuk "dropdown" vertikal / kotak ke bawah dengan tema gelap (mirip Z-Agent/Hermes).
 * Menyusun kandidat dalam beberapa baris agar tampil seperti popup menu ke bawah.
 */
export function formatHint(hits: string[], max = 12): string {
  const shown = hits.slice(0, max);
  const rows: string[] = [];
  const cols = 3; // 3 kolom per baris
  for (let i = 0; i < shown.length; i += cols) {
    const chunk = shown.slice(i, i + cols);
    const padded = chunk.map((h) => h.padEnd(16)).join(" ");
    rows.push(`  \u001b[40m\u001b[97m ${padded} \u001b[0m`);
  }
  if (hits.length > max) {
    rows.push(`  \u001b[40m\u001b[90m …(+${hits.length - max} lainnya) \u001b[0m`);
  }
  return "\n" + rows.join("\n");
}

/**
 * Kembalikan `[kandidat, token]` seperti yang diharapkan `readline.completer`.
 * Bila tidak ada kandidat, kembalikan daftar kosong agar Tab tidak "memaksa".
 */
export function completeLine(input: string, commands: string[], cwd: string): [string[], string] {
  const left = input.replace(/^\s+/, "");

  // Pencarian file fuzzy: `@src/tui` / `@screen`.
  if (left.startsWith("@")) return completeAt(left, cwd);

  // Token pertama: perintah slash. Prefix dulu, lalu kecocokan di tengah.
  if (left.startsWith("/") && !left.includes(" ")) {
    const bare = left.slice(1);
    const prefix = commands.filter((c) => c.startsWith(left));
    const contains = commands.filter((c) => !prefix.includes(c) && c.slice(1).includes(bare));
    return [[...prefix, ...contains], left];
  }

  // Token kedua untuk perintah yang punya subperintah.
  const match = /^(\S+)\s+(\S*)$/.exec(left);
  if (match) {
    const cmd = match[1]!;
    const partial = match[2] ?? "";
    const options = SUBCOMMANDS[cmd];
    if (options && !partial.includes("/")) {
      const hits = options.filter((o) => o.startsWith(partial));
      if (hits.length) return [hits, partial];
    }
  }

  // Sisanya: path berkas/direktori.
  const token = input.slice(input.lastIndexOf(" ") + 1);
  return completePath(token, cwd);
}
