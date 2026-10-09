import type { ModelInfo } from "../core/types.js";

/** Label opsi ke-0 pada daftar model (input nama manual). */
export const CUSTOM_MODEL_LABEL = "Custom model (ketik manual)";

export type ModelChoice =
  | { kind: "model"; model: ModelInfo }
  | { kind: "custom" }
  | { kind: "invalid" };

/** Bersihkan nama model dari spasi tepi dan karakter kontrol (mis. Ctrl+D). */
export function cleanModelName(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

/**
 * Terjemahkan jawaban pengguna pada daftar model:
 * - `"0"`        → custom (nama model diketik manual),
 * - `"<nomor>"`  → model ke-n pada daftar (invalid bila di luar rentang),
 * - teks lain    → nama model apa adanya (model custom).
 */
export function resolveModelChoice(answer: string, models: ModelInfo[]): ModelChoice {
  const value = cleanModelName(answer);
  if (value === "0") return { kind: "custom" };
  if (/^\d+$/.test(value)) {
    const model = models[Number.parseInt(value, 10) - 1];
    return model ? { kind: "model", model } : { kind: "invalid" };
  }
  if (value) return { kind: "model", model: { id: value } };
  return { kind: "invalid" };
}
