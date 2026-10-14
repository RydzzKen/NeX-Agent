import type { NeutralMessage } from "../core/types.js";
import type { SessionRecord } from "./store.js";

/** Satu kecocokan di dalam satu pesan sesi. */
export interface SearchMatch {
  /** Indeks pesan dalam riwayat sesi. */
  index: number;
  role: NeutralMessage["role"];
  /** Cuplikan satu baris di sekitar kecocokan. */
  snippet: string;
}

/** Semua kecocokan di dalam satu sesi. */
export interface SearchHit {
  session: SessionRecord;
  matches: SearchMatch[];
  /** Jumlah pesan yang mengandung kecocokan (bisa lebih besar dari `matches`). */
  count: number;
}

export interface SearchOptions {
  /** Maksimum kecocokan yang ditampilkan per sesi (default 3). */
  maxPerSession?: number;
  /** Panjang maksimum cuplikan dalam karakter (default 120). */
  snippetLength?: number;
}

function makeSnippet(clean: string, at: number, length: number): string {
  let start = Math.max(0, at - Math.floor(length / 3));
  let end = Math.min(clean.length, start + length);
  start = Math.max(0, end - length);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < clean.length ? "…" : "";
  return `${prefix}${clean.slice(start, end)}${suffix}`;
}

/**
 * Cari `query` (tanpa peduli huruf besar/kecil) di seluruh riwayat sesi.
 *
 * Murni dan tanpa efek samping agar mudah diuji. Urutan sesi dipertahankan
 * (pemanggil biasanya sudah mengurutkan terbaru lebih dulu).
 */
export function searchSessions(
  sessions: SessionRecord[],
  query: string,
  options: SearchOptions = {},
): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const maxPerSession = options.maxPerSession ?? 3;
  const snippetLength = options.snippetLength ?? 120;

  const hits: SearchHit[] = [];
  for (const session of sessions) {
    const matches: SearchMatch[] = [];
    let count = 0;
    session.history.forEach((message, index) => {
      const clean = message.content.replace(/\s+/g, " ").trim();
      const at = clean.toLowerCase().indexOf(needle);
      if (at === -1) return;
      count++;
      if (matches.length < maxPerSession) {
        matches.push({ index, role: message.role, snippet: makeSnippet(clean, at, snippetLength) });
      }
    });
    if (count > 0) hits.push({ session, matches, count });
  }
  return hits;
}
