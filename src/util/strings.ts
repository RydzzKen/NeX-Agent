/**
 * Nilai string non-kosong pertama.
 *
 * Berbeda dengan `??`, operator ini melewati string kosong. Berguna saat
 * menggabungkan preferensi bertingkat (opsi → sesi → config) karena sesi baru
 * menyimpan nilai default `""` yang seharusnya tidak menutupi config.
 */
export function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value) return value;
  }
  return undefined;
}
