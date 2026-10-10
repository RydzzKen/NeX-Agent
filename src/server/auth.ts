import crypto from "node:crypto";

/** Token acak kuat untuk mengakses server web (tidak pernah ditulis ke log). */
export function generateToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** Perbandingan waktu-konstan agar token tidak bisa ditebak lewat timing. */
export function tokenMatches(expected: string, provided: string | undefined | null): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Ambil token dari header `Authorization: Bearer` atau query `?token=`. */
export function extractToken(header: string | undefined, url: URL): string | undefined {
  const fromQuery = url.searchParams.get("token");
  if (fromQuery) return fromQuery;
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1];
  }
  return undefined;
}
