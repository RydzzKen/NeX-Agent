import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * Memori jangka panjang sederhana: fakta stabil tentang **pengguna**
 * (nama, hobi, preferensi, dsb.) yang tersimpan antar sesi.
 *
 * Disimpan sebagai berkas JSON kecil di direktori konfigurasi global dan
 * disuntikkan ke system prompt. Sengaja sederhana (key → value) dan murni
 * sebisa mungkin agar mudah diuji. Jangan pernah menyimpan kredensial/rahasia.
 */

export const MEMORY_FILE = "memory.json";
export const MAX_FACTS = 200;
export const MAX_KEY_LEN = 64;
export const MAX_VALUE_LEN = 500;
/** Batas karakter saat menyuntik ke system prompt (hemat token tiap giliran). */
export const MEMORY_PROMPT_MAX_CHARS = 4000;

const factSchema = z.object({
  key: z.string().min(1),
  value: z.string().min(1),
  updatedAt: z.string().min(1),
});

const storeSchema = z.object({
  facts: z.array(factSchema),
});

export type MemoryFact = z.infer<typeof factSchema>;

export function memoryFilePath(configDir: string): string {
  return path.join(configDir, MEMORY_FILE);
}

/** Baca fakta dari disk; berkas hilang/rusak → daftar kosong (bukan error). */
export async function readFacts(configDir: string): Promise<MemoryFact[]> {
  let raw: string;
  try {
    raw = await fs.readFile(memoryFilePath(configDir), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = storeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.facts.slice(0, MAX_FACTS) : [];
  } catch {
    return [];
  }
}

/** Tulis fakta ke disk (mode 600; informasi pribadi). */
export async function writeFacts(configDir: string, facts: MemoryFact[]): Promise<void> {
  await fs.mkdir(configDir, { recursive: true });
  const data = { facts: facts.slice(0, MAX_FACTS) };
  await fs.writeFile(memoryFilePath(configDir), JSON.stringify(data, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

function sameKey(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Simpan/perbarui fakta berdasarkan key (tidak peduli huruf besar-kecil). */
export function upsertFact(
  facts: MemoryFact[],
  key: string,
  value: string,
  now: string = new Date().toISOString(),
): MemoryFact[] {
  const trimmedKey = key.trim();
  const trimmedValue = value.trim();
  const index = facts.findIndex((f) => sameKey(f.key, trimmedKey));
  if (index >= 0) {
    const next = [...facts];
    next[index] = { key: trimmedKey, value: trimmedValue, updatedAt: now };
    return next;
  }
  return [...facts, { key: trimmedKey, value: trimmedValue, updatedAt: now }];
}

/** Hapus fakta berdasarkan key; mengembalikan daftar baru. */
export function removeFact(facts: MemoryFact[], key: string): MemoryFact[] {
  return facts.filter((f) => !sameKey(f.key, key));
}

/** Cari satu fakta berdasarkan key. */
export function findFact(facts: MemoryFact[], key: string): MemoryFact | undefined {
  return facts.find((f) => sameKey(f.key, key));
}

/** Render fakta menjadi daftar markdown, dibatasi `maxChars`. */
export function formatFacts(facts: MemoryFact[], maxChars: number = MEMORY_PROMPT_MAX_CHARS): string {
  const lines: string[] = [];
  let total = 0;
  for (const fact of facts) {
    const line = `- ${fact.key}: ${fact.value}`;
    if (total + line.length + 1 > maxChars) break;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join("\n");
}

/** Pola yang dianggap rahasia — ditolak agar tidak masuk memori. */
const SECRET_PATTERN =
  /(password|passwd|kata\s*sandi|secret|token|api[\s_-]?key|kredensial|credential|private[\s_-]?key|seed\s*phrase|otp|pin\b)/i;

/** True bila teks menyerupai kredensial/rahasia. */
export function looksSecret(text: string): boolean {
  return SECRET_PATTERN.test(text);
}
