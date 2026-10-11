/**
 * Konversi Markdown → HTML yang didukung Telegram (`parse_mode: "HTML"`).
 *
 * Telegram tidak merender Markdown mentah, jadi keluaran model perlu diubah:
 * `**tebal**` → `<b>`, `_miring_` → `<i>`, `` `kode` `` → `<code>`, blok kode
 * berpagar → `<pre>`, dst. Semua teks di-escape agar aman, dan hasil akhirnya dipecah
 * menjadi beberapa pesan dengan tag tetap seimbang (Telegram menolak entitas
 * yang tidak seimbang / melebihi batas).
 *
 * Fungsi-fungsi di sini murni (tanpa I/O) sehingga mudah diuji.
 */

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

function isWordBoundaryBefore(text: string, index: number): boolean {
  if (index <= 0) return true;
  return !/[0-9A-Za-z]/.test(text[index - 1] ?? "");
}

function isWordBoundaryAfter(text: string, index: number): boolean {
  if (index >= text.length) return true;
  return !/[0-9A-Za-z]/.test(text[index] ?? "");
}

/** Cari penutup marker gaya yang bukan bagian dari deretan marker lebih panjang. */
function findClosing(text: string, marker: string, from: number): number {
  const ch = marker[0]!;
  let index = from;
  for (;;) {
    index = text.indexOf(marker, index);
    if (index === -1) return -1;
    const startsLonger = text[index - 1] === ch;
    const endsLonger = text[index + marker.length] === ch;
    const notSpaceBefore = (text[index - 1] ?? " ") !== " ";
    if (!startsLonger && !endsLonger && notSpaceBefore && isWordBoundaryAfter(text, index + marker.length)) {
      return index;
    }
    index += marker.length;
  }
}

const URL_RE = /^https?:\/\/[^\s<>()\]]+/;

/** Render gaya inline Markdown menjadi HTML Telegram. */
export function inlineTelegramHtml(text: string): string {
  let out = "";
  let buffer = "";
  const flush = (): void => {
    if (buffer) {
      out += escapeHtml(buffer);
      buffer = "";
    }
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i]!;

    if (c === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        flush();
        out += `<code>${escapeHtml(text.slice(i + 1, end))}</code>`;
        i = end + 1;
        continue;
      }
    }

    if ((c === "*" || c === "_") && text[i + 1] === c && isWordBoundaryBefore(text, i)) {
      const close = findClosing(text, c + c, i + 2);
      if (close > i + 2) {
        flush();
        out += `<b>${inlineTelegramHtml(text.slice(i + 2, close))}</b>`;
        i = close + 2;
        continue;
      }
    }

    if (c === "~" && text[i + 1] === "~" && isWordBoundaryBefore(text, i)) {
      const close = findClosing(text, "~~", i + 2);
      if (close > i + 2) {
        flush();
        out += `<s>${inlineTelegramHtml(text.slice(i + 2, close))}</s>`;
        i = close + 2;
        continue;
      }
    }

    if ((c === "*" || c === "_") && isWordBoundaryBefore(text, i) && text[i + 1] !== " ") {
      const close = findClosing(text, c, i + 1);
      if (close > i + 1) {
        flush();
        out += `<i>${inlineTelegramHtml(text.slice(i + 1, close))}</i>`;
        i = close + 1;
        continue;
      }
    }

    if (c === "[") {
      const link = /^\[([^\]]*)\]\(([^)\s]*)\)/.exec(text.slice(i));
      if (link) {
        flush();
        out += `<a href="${escapeAttr(link[2]!)}">${inlineTelegramHtml(link[1]!)}</a>`;
        i += link[0]!.length;
        continue;
      }
    }

    if (c === "h" && isWordBoundaryBefore(text, i)) {
      const url = URL_RE.exec(text.slice(i));
      if (url) {
        flush();
        out += `<a href="${escapeAttr(url[0]!)}">${escapeHtml(url[0]!)}</a>`;
        i += url[0]!.length;
        continue;
      }
    }

    buffer += c;
    i++;
  }

  flush();
  return out;
}

function isTableSeparator(line: string): boolean {
  return line.includes("|") && /^[\s|:-]+$/.test(line) && line.includes("-");
}

function splitRow(row: string): string[] {
  return row
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isBlockStart(line: string): boolean {
  return (
    /^\s*```/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    /^\s*([-*_])(\s*\1){2,}\s*$/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*([-*+]|\d+[.)])\s+/.test(line)
  );
}

/** Render tabel Markdown sebagai blok `<pre>` yang rata. */
function renderTableBlock(rows: string[]): string {
  const parsed = rows.filter((row) => !isTableSeparator(row)).map(splitRow);
  if (parsed.length === 0) return "";
  const columns = Math.max(...parsed.map((row) => row.length));
  const widths = new Array<number>(columns).fill(3);
  for (const row of parsed) {
    for (let c = 0; c < columns; c++) {
      widths[c] = Math.max(widths[c]!, [...(row[c] ?? "")].length);
    }
  }
  const format = (row: string[]): string =>
    widths.map((w, c) => (row[c] ?? "").padEnd(w)).join(" │ ");
  const header = format(parsed[0]!);
  const separator = widths.map((w) => "─".repeat(w)).join("─┼─");
  const body = parsed.slice(1).map(format);
  return `<pre>${escapeHtml([header, separator, ...body].join("\n"))}</pre>`;
}

/** Render daftar Markdown dengan format inline. */
function renderListBlock(items: string[]): string {
  return items
    .map((item) => {
      const match = /^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/.exec(item);
      if (!match) return inlineTelegramHtml(item);
      const depth = Math.floor(match[1]!.length / 2);
      const indent = "  ".repeat(depth);
      const isOrdered = /^\d/.test(match[2]!);
      const marker = isOrdered ? match[2]!.replace(/[.)]$/, ".") : "•";
      return `${indent}${marker} ${inlineTelegramHtml(match[4]!)}`;
    })
    .join("\n");
}

/** Ubah seluruh dokumen Markdown menjadi HTML Telegram (satu string). */
export function renderTelegramHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  const push = (block: string): void => {
    if (block.trim()) blocks.push(block);
  };
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      const lang = fence[1]!.trim().split(/\s+/)[0] ?? "";
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) {
        code.push(lines[i]!);
        i++;
      }
      if (i < lines.length) i++;
      const cls = lang ? ` class="language-${escapeAttr(lang)}"` : "";
      push(`<pre><code${cls}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      push(`<b>${inlineTelegramHtml(heading[2]!)}</b>`);
      i++;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      push("———");
      i++;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const rows: string[] = [line, lines[i + 1]!];
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
        rows.push(lines[i]!);
        i++;
      }
      push(renderTableBlock(rows));
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) {
        quote.push(lines[i]!.replace(/^\s*>\s?/, ""));
        i++;
      }
      push(`<blockquote>${quote.map((q) => inlineTelegramHtml(q)).join("\n")}</blockquote>`);
      continue;
    }

    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]!)) {
        items.push(lines[i]!);
        i++;
      }
      push(renderListBlock(items));
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    const paragraph: string[] = [line];
    i++;
    while (i < lines.length && lines[i]!.trim() !== "" && !isBlockStart(lines[i]!)) {
      paragraph.push(lines[i]!);
      i++;
    }
    push(paragraph.map((p) => inlineTelegramHtml(p)).join("\n"));
  }

  return blocks.join("\n\n");
}

function tagName(tag: string): string {
  const match = /^<\/?([a-zA-Z0-9-]+)/.exec(tag);
  return match ? match[1]!.toLowerCase() : "";
}

/**
 * Pecah HTML menjadi beberapa potongan ≤ `limit` dengan tag tetap seimbang:
 * setiap potongan menutup tag yang masih terbuka lalu membukanya lagi di
 * potongan berikutnya. Potongan dipecah pada spasi/baris terdekat bila mungkin.
 */
export function chunkTelegramHtml(html: string, limit: number): string[] {
  if (html.length <= limit) return html ? [html] : [];

  const tokens = html.match(/<[^>]+>|[^<]+/g) ?? [];
  const chunks: string[] = [];
  let stack: string[] = [];
  let current = "";

  const closeAll = (): string =>
    [...stack]
      .reverse()
      .map((tag) => `</${tagName(tag)}>`)
      .join("");

  const flush = (): void => {
    const body = (current + closeAll()).replace(/\s+$/, "");
    if (body) chunks.push(body);
    current = stack.join("");
  };

  for (const token of tokens) {
    if (token.startsWith("<")) {
      if (token.startsWith("</")) {
        const name = tagName(token);
        for (let k = stack.length - 1; k >= 0; k--) {
          if (tagName(stack[k]!) === name) {
            stack.splice(k, 1);
            break;
          }
        }
      } else {
        stack.push(token);
      }
      current += token;
      if (current.length + closeAll().length > limit) flush();
      continue;
    }

    let text = token;
    while (text.length > 0) {
      const room = limit - current.length - closeAll().length;
      if (room <= 0) {
        flush();
        continue;
      }
      if (text.length <= room) {
        current += text;
        text = "";
        break;
      }
      const newline = text.lastIndexOf("\n", room);
      const space = text.lastIndexOf(" ", room);
      let cut = Math.max(newline, space);
      if (cut <= 0) cut = room;
      current += text.slice(0, cut).replace(/\s+$/, "");
      text = text.slice(cut).replace(/^\s+/, "");
      flush();
    }
  }

  flush();
  return chunks;
}

/** Batas "aman" jumlah tag per pesan (Telegram membatasi 100 entitas). */
export const TELEGRAM_MAX_ENTITIES = 90;

/** Ubah HTML Telegram kembali menjadi teks polos (untuk fallback aman). */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Berapa banyak tag/entitas pembuka dalam sekumpulan HTML. */
export function countHtmlEntities(html: string): number {
  return (html.match(/<[a-z][a-z0-9-]*(\s|>)/gi) ?? []).length;
}

/** Render Markdown lalu pecah menjadi pesan-pesan HTML ≤ `limit`. */
export function renderTelegramChunks(markdown: string, limit: number): string[] {
  const html = renderTelegramHtml(markdown);
  return chunkTelegramHtml(html, limit);
}
