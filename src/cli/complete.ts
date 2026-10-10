import fs from "node:fs";
import path from "node:path";

/**
 * Logika autocomplete untuk REPL (Tab):
 * - token pertama → lengkapi perintah slash (`/se` → `/sessions`, `/serve`);
 * - token kedua untuk perintah yang punya subperintah (`/mcp re` → `reload`);
 * - selain itu → lengkapi path berkas/direktori relatif terhadap `cwd`.
 *
 * Murni (sinkron) supaya mudah diuji dan dipakai langsung sebagai `completer`
 * readline.
 */

/** Subperintah yang bisa dilengkapi untuk sebuah perintah. */
export const SUBCOMMANDS: Record<string, string[]> = {
  "/mcp": ["reload", "key"],
  "/provider": ["use", "edit", "hapus"],
  "/sessions": ["clear"],
  "/delete": ["all"],
  "/skill": ["off"],
};

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
 * Kembalikan `[kandidat, token]` seperti yang diharapkan `readline.completer`.
 * Bila tidak ada kandidat, kembalikan daftar kosong agar Tab tidak "memaksa".
 */
export function completeLine(input: string, commands: string[], cwd: string): [string[], string] {
  const left = input.replace(/^\s+/, "");

  // Token pertama: perintah slash.
  if (left.startsWith("/") && !left.includes(" ")) {
    const hits = commands.filter((c) => c.startsWith(left));
    return [hits.length ? hits : commands, left];
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
