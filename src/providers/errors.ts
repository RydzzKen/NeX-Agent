/**
 * Pemformatan error HTTP provider yang seragam dan ramah dibaca.
 *
 * Banyak gateway (mis. 9Router) membungkus pesan dari provider upstream menjadi
 * JSON bersarang, contoh:
 *
 *   {"error":{"message":"[429]: {\"type\":\"error\",\"error\":{...}}"}}
 *
 * Google/Gemini memakai bentuk `{"error":{"code":429,"message":"Quota ..."}}`.
 * Helper ini menelusuri sarang tersebut untuk mengambil pesan yang berarti,
 * lalu menambahkan petunjuk singkat berdasarkan status HTTP. Pesan akhir tetap
 * memuat `HTTP <status>` agar deteksi retry di `core/loop.ts` (429/50x) tetap
 * bekerja.
 */

/** Ambil pesan paling bermakna dari struktur error JSON apa pun. */
function extractMessage(value: unknown, depth = 0): string | undefined {
  if (depth > 5 || value == null) return undefined;

  if (typeof value === "string") {
    const stripped = value.replace(/^\[\d{3}\]:\s*/, "").trim();
    if (stripped.startsWith("{") || stripped.startsWith("[")) {
      try {
        const inner = extractMessage(JSON.parse(stripped), depth + 1);
        if (inner) return inner;
      } catch {
        /* bukan JSON valid; pakai teks apa adanya di bawah */
      }
    }
    return stripped || undefined;
  }

  if (typeof value === "object") {
    if (Array.isArray(value)) {
      for (const item of value) {
        const inner = extractMessage(item, depth + 1);
        if (inner) return inner;
      }
      return undefined;
    }
    const obj = value as Record<string, unknown>;
    if (typeof obj.message === "string") return extractMessage(obj.message, depth + 1);
    if ("error" in obj) {
      const inner = extractMessage(obj.error, depth + 1);
      if (inner) return inner;
    }
    for (const key of ["detail", "reason", "description"]) {
      const inner = extractMessage(obj[key], depth + 1);
      if (inner) return inner;
    }
  }
  return undefined;
}

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
  let detail: string | undefined;
  const trimmed = body.trim();
  if (trimmed) {
    try {
      detail = extractMessage(JSON.parse(trimmed));
    } catch {
      detail = trimmed;
    }
  }
  const message = (detail ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  const hint = statusHint(status);
  const parts = [`Provider ${id} gagal: HTTP ${status}`];
  if (message) parts.push(`— ${message}`);
  if (hint) parts.push(`(${hint})`);
  return parts.join(" ");
}
