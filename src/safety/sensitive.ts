import path from "node:path";

/** Nama file yang selalu dianggap sensitif (berisi rahasia/kredensial). */
const SENSITIVE_BASENAMES = new Set([
  ".git-credentials",
  ".netrc",
  "_netrc",
  ".npmrc",
  ".pypirc",
  ".htpasswd",
  "credentials.json",
  "credentials.yaml",
  "credentials.yml",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
  "service-account.json",
]);

/** Segmen direktori yang isinya dianggap sensitif. */
const SENSITIVE_SEGMENTS = new Set([".ssh", ".aws", ".gnupg"]);

/** Suffix `.env` yang aman dibaca (contoh, bukan rahasia). */
const SAFE_ENV_SUFFIXES = new Set(["example", "sample", "template", "dist"]);

/**
 * True bila path menunjuk ke file yang lazim menyimpan rahasia (.env,
 * kredensial, private key). Dipakai untuk memaksa konfirmasi meski
 * allow-all/--yes aktif.
 */
export function isSensitivePath(target: string): boolean {
  const normalized = target.replace(/\\/g, "/");
  const base = path.posix.basename(normalized).toLowerCase();
  const segments = normalized.toLowerCase().split("/").filter(Boolean);

  if (segments.some((segment) => SENSITIVE_SEGMENTS.has(segment))) return true;
  if (SENSITIVE_BASENAMES.has(base)) return true;

  if (base === ".env" || base.startsWith(".env.")) {
    const suffix = base.slice(".env.".length);
    if (base === ".env" || !SAFE_ENV_SUFFIXES.has(suffix)) return true;
  }

  if (/^id_(rsa|dsa|ecdsa|ed25519)$/.test(base)) return true;
  if (/\.(pem|key|p12|pfx|keystore|jks)$/.test(base)) return true;
  return false;
}

/**
 * Deteksi sederhana: apakah sebuah perintah shell menyentuh file sensitif?
 * Heuristik berbasis token; arahnya sengaja "aman" (lebih baik bertanya).
 */
export function commandTouchesSensitive(command: string): boolean {
  const tokens = command.split(/[\s;&|()<>`"'=]+/).filter(Boolean);
  return tokens.some((token) => isSensitivePath(token.replace(/^~(?=\/)/, process.env.HOME ?? "~")));
}
