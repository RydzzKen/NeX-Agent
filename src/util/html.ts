/**
 * Utilitas HTML ringan tanpa dependensi eksternal.
 *
 * Dipakai tool `web_fetch` (ubah halaman → teks terbaca) dan parser hasil
 * DuckDuckGo HTML (`web_search`). Semua fungsi murni (tanpa I/O) sehingga
 * mudah diuji.
 */

/** Elemen yang isinya tidak ditampilkan sebagai teks halaman. */
const SKIP_TAGS = ["script", "style", "noscript", "template", "svg", "head"] as const;

/** Elemen yang menutup baris saat dikonversi ke teks. */
const BLOCK_CLOSE =
  /<\/(address|article|aside|blockquote|div|dl|dd|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)>/gi;

function codePoint(value: number): string {
  if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff) return "";
  try {
    return String.fromCodePoint(value);
  } catch {
    return "";
  }
}

/** Dekode entitas HTML umum (named, desimal, dan heksadesimal). */
export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => codePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => codePoint(Number.parseInt(dec, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

/** Buang seluruh tag HTML, menyisakan teks mentah. */
export function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

/** Rapikan spasi/baris agar teks hasil konversi enak dibaca. */
function tidyText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Ubah markup HTML menjadi teks terbaca (mirip Markdown sederhana).
 * Heading diberi penanda `#`, item daftar diberi `- `, dan blok dipisah baris.
 */
export function htmlToText(html: string): string {
  let text = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of SKIP_TAGS) {
    text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
    text = text.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi"), " ");
  }
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<hr\s*\/?>/gi, "\n\n");
  for (let level = 1; level <= 6; level++) {
    text = text.replace(new RegExp(`<h${level}\\b[^>]*>`, "gi"), `\n\n${"#".repeat(level)} `);
  }
  text = text.replace(/<li\b[^>]*>/gi, "\n- ");
  text = text.replace(BLOCK_CLOSE, "\n");
  text = stripTags(text);
  text = decodeEntities(text);
  return tidyText(text);
}

/** Ambil `<title>` halaman sebagai teks bersih, bila ada. */
export function extractTitle(html: string): string | undefined {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return undefined;
  const title = tidyText(decodeEntities(stripTags(match[1] ?? ""))).replace(/\n+/g, " ").trim();
  return title || undefined;
}
