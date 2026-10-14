/**
 * Pemformatan pesan error yang seragam dan ramah dibaca.
 *
 * Banyak sumber (provider HTTP, MCP, tool pihak ketiga) membalas error sebagai
 * JSON — kadang bersarang, mis.
 *
 *   {"error":{"message":"[429]: {\"type\":\"error\",\"error\":{\"message\":\"Rate limit\"}}"}}
 *
 * Alih-alih menampilkan JSON mentah, helper ini menelusuri struktur tersebut
 * untuk mengambil pesan yang benar-benar berarti, lalu merapikannya menjadi
 * satu baris. Dipakai di provider, MCP, loop tool, Web, dan Telegram agar
 * perilakunya konsisten.
 */

/** Ambil pesan paling bermakna dari nilai error apa pun (string/objek/JSON). */
export function extractErrorMessage(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || value == null) return undefined;

  if (typeof value === "string") {
    const stripped = value.replace(/^\[\d{3}\]:\s*/, "").trim();
    if (stripped.startsWith("{") || stripped.startsWith("[")) {
      try {
        const inner = extractErrorMessage(JSON.parse(stripped), depth + 1);
        if (inner) return inner;
      } catch {
        // Bukan JSON valid — pakai teks apa adanya di bawah.
      }
    }
    return stripped || undefined;
  }

  if (typeof value === "number" || typeof value === "boolean") return String(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const inner = extractErrorMessage(item, depth + 1);
      if (inner) return inner;
    }
    return undefined;
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.message === "string") return extractErrorMessage(obj.message, depth + 1);
    if ("error" in obj && obj.error !== undefined) {
      const inner = extractErrorMessage(obj.error, depth + 1);
      if (inner) return inner;
    }
    for (const key of ["detail", "reason", "description", "error_description", "msg"]) {
      const inner = extractErrorMessage(obj[key], depth + 1);
      if (inner) return inner;
    }
  }
  return undefined;
}

export interface FormatErrorOptions {
  /** Pesan bila tidak ada teks bermakna yang bisa diambil. */
  fallback?: string;
  /** Batas panjang pesan akhir (default 400). */
  max?: number;
}

/**
 * Ubah nilai error apa pun menjadi satu baris bersih. Error dengan pesan yang
 * berupa JSON bertingkat akan dibuka sehingga hanya pesan intinya yang tampil.
 */
export function formatErrorMessage(value: unknown, options: FormatErrorOptions = {}): string {
  const { fallback = "Terjadi kesalahan.", max = 400 } = options;

  const source = value instanceof Error ? value.message : value;
  const extracted = extractErrorMessage(source);
  const raw = extracted ?? (source === undefined || source === null ? "" : String(source));
  const text = raw.replace(/\s+/g, " ").trim();

  if (!text) return fallback;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
