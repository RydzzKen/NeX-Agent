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
 * Susun pesan error provider:
 *   `Provider <id> gagal: HTTP <status> — <pesan> (<petunjuk>)`
 */
export function formatHttpError(id: string, status: number, body: string): string {
  const trimmed = body.trim();
  const detail = trimmed ? extractErrorMessage(trimmed) : undefined;
  const message = (detail ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  const hint = statusHint(status);
  const parts = [`Provider ${id} gagal: HTTP ${status}`];
  if (message) parts.push(`— ${message}`);
  if (hint) parts.push(`(${hint})`);
  return parts.join(" ");
}
