/**
 * Pemformatan error HTTP provider yang seragam dan ramah dibaca.
 *
 * Banyak gateway (mis. 9Router) membungkus pesan dari provider upstream menjadi
 * JSON bersarang, contoh:
 *
 *   {"error":{"message":"[429]: {\"type\":\"error\",\"error\":{...}}"}}
 *
 * Google/Gemini memakai bentuk `{"error":{"code":429,"message":"Quota ..."}}`.
 * Helper ini menelusuri sarang tersebut untuk mengambil pesan yang berarti
 * (lewat `extractErrorMessage`), lalu menambahkan petunjuk singkat berdasarkan
 * status HTTP. Pesan akhir tetap memuat `HTTP <status>` agar deteksi retry di
 * `core/loop.ts` (429/50x) tetap bekerja.
 */

import { extractErrorMessage } from "../util/errors.js";

/** Petunjuk singkat (bahasa Indonesia) untuk kode status HTTP umum. */
function statusHint(status: number): string | undefined {
  if (status === 429) return "kuota/rate limit; coba lagi sebentar lagi atau ganti model";
  if (status === 401 || status === 403) return "kredensial ditolak; cek /connect atau API key";
  if (status === 404) return "model atau endpoint tidak ditemukan";
  if (status === 400) return "permintaan ditolak provider; cek nama model/parameter";
  if (status >= 500) return "server provider bermasalah; coba lagi sebentar lagi";
  return undefined;
}

/**
 * Batas panjang detail body provider yang ditampilkan. Body dari gateway bisa
 * memuat kalimat saran yang panjang (mis. "Call ModelService.ListModels …"),
 * dan pesan ini muncul di terminal — jadi dipangkas agar tetap terbaca.
 */
const MAX_DETAIL = 160;

/**
 * Pangkas detail body provider: berhenti di akhir kalimat bila ada (selama tidak
 * terlalu awal), jika tidak di akhir kata. Bedanya dengan potong-mentah: kalimat
 * terakhir tetap utuh, bukan terbelah di tengah kata.
 */
function trimDetail(text: string, max = MAX_DETAIL): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  if (/[.!?]$/.test(cut)) return cut;
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (sentence >= max / 2) return cut.slice(0, sentence + 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Susun pesan error provider dengan kalimat kita (Indonesia) lebih dulu:
 *   `Provider <id> gagal: HTTP <status> (<petunjuk>) — pesan provider: <pesan>`
 *
 * Petunjuk status ditulis sendiri, dalam bahasa Indonesia. Pesan mentah dari
 * provider dikutip apa adanya dan diberi label "pesan provider" karena
 * umumnya berbahasa Inggris dan tidak boleh kita terjemahkan seenaknya.
 * Pesan akhir tetap memuat `HTTP <status>` agar deteksi retry di `core/loop.ts`
 * (429/50x) tetap bekerja.
 */
export function formatHttpError(id: string, status: number, body: string): string {
  const trimmed = body.trim();
  const detail = trimmed ? extractErrorMessage(trimmed) : undefined;
  const message = trimDetail((detail ?? "").replace(/\s+/g, " ").trim());
  const hint = statusHint(status);
  const parts = [`Provider ${id} gagal: HTTP ${status}`];
  if (hint) parts.push(`(${hint})`);
  if (message) parts.push(`— pesan provider: ${message}`);
  return parts.join(" ");
}
