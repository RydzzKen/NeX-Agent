/**
 * Deteksi apakah sebuah host/URL menunjuk ke jaringan lokal/privat.
 *
 * Dipakai untuk memperingatkan pengguna saat provider menunjuk ke alamat LAN
 * (mis. server model lokal seperti 9router) — kasus paling umum dari sesi yang
 * "tiba-tiba" terhubung ke host yang tidak diharapkan karena konfigurasi lama
 * terbawa. Fungsi ini murni dan tidak menyentuh jaringan.
 */

/** Rentang IPv4 privat: 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16. */
function isPrivateIPv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * True bila `input` (URL lengkap, `host:port`, atau host mentah) menunjuk ke
 * loopback, alamat privat, link-local, atau domain `.local`.
 */
export function isPrivateHost(input: string | undefined): boolean {
  if (!input) return false;
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return false;

  let host: string;
  try {
    host = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`).hostname;
  } catch {
    return false;
  }
  host = host.replace(/^\[|\]$/g, "");

  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1") return true;
  // IPv6 link-local (fe80::/10) dan unique-local (fc00::/7).
  if (host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb")) return true;
  if (host.startsWith("fc") || host.startsWith("fd")) return true;

  return isPrivateIPv4(host);
}
