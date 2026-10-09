import { color } from "./color.js";

/**
 * Renderer Markdown minimal untuk terminal.
 *
 * Mendukung: heading, paragraf, daftar (berurut/tak berurut, bersarang),
 * blockquote, blok kode berkutip, tabel, garis pemisah, serta gaya inline
 * (bold, italic, coret, `kode`, dan tautan). Tanpa dependensi eksternal dan
 * sadar-lebar: paragraf dibungkus sesuai lebar terminal bila diminta.
 *
 * Fungsi ini murni (tanpa I/O) dan menghormati `util/color` sehingga bisa
 * diuji dengan warna dimatikan.
 */

export interface MarkdownOptions {
  /** Lebar target dalam kolom. Default: lebar terminal atau 80. */
  width?: number;
}

interface Style {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: boolean;
  dim?: boolean;
  /** Pewarnaan tambahan yang dibungkus paling luar (mis. heading). */
  accent?: (s: string) => string;
}

interface Run {
  text: string;
  style: Style;
}

function renderRun(run: Run): string {
  let s = run.text;
  const st = run.style;
  if (st.code) s = color.cyan(s);
  if (st.link) s = color.blue(color.underline(s));
  if (st.bold) s = color.bold(s);
  if (st.italic) s = color.italic(s);
  if (st.strike) s = color.strike(s);
  if (st.dim) s = color.dim(s);
  if (st.accent) s = st.accent(s);
  return s;
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

/** Ubah satu baris teks menjadi deretan run bergaya. */
function parseInline(text: string, style: Style): Run[] {
  const runs: Run[] = [];
  let buffer = "";
  const flush = (): void => {
    if (buffer) {
      runs.push({ text: buffer, style });
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
        runs.push({ text: text.slice(i + 1, end), style: { ...style, code: true } });
        i = end + 1;
        continue;
      }
    }

    if ((c === "*" || c === "_") && text[i + 1] === c && isWordBoundaryBefore(text, i)) {
      const marker = c + c;
      const close = findClosing(text, marker, i + 2);
      if (close > i + 2) {
        flush();
        runs.push(...parseInline(text.slice(i + 2, close), { ...style, bold: true }));
        i = close + 2;
        continue;
      }
    }

    if (c === "~" && text[i + 1] === "~" && isWordBoundaryBefore(text, i)) {
      const close = findClosing(text, "~~", i + 2);
      if (close > i + 2) {
        flush();
        runs.push(...parseInline(text.slice(i + 2, close), { ...style, strike: true }));
        i = close + 2;
        continue;
      }
    }

    if ((c === "*" || c === "_") && isWordBoundaryBefore(text, i) && text[i + 1] !== " ") {
      const close = findClosing(text, c, i + 1);
      if (close > i + 1) {
        flush();
        runs.push(...parseInline(text.slice(i + 1, close), { ...style, italic: true }));
        i = close + 1;
        continue;
      }
    }

    if (c === "[") {
      const link = /^\[([^\]]*)\]\(([^)\s]*)\)/.exec(text.slice(i));
      if (link) {
        flush();
        runs.push(...parseInline(link[1]!, { ...style, link: true }));
        runs.push({ text: ` (${link[2]})`, style: { ...style, dim: true } });
        i += link[0]!.length;
        continue;
      }
    }

    buffer += c;
    i++;
  }

  flush();
  return runs;
}

/** Bungkus run menjadi baris-baris sesuai lebar (sadar ANSI). */
function wrapRuns(runs: Run[], width: number): string[] {
  const tokens: Array<{ text: string; rendered: string; space: boolean }> = [];
  for (const run of runs) {
    for (const part of run.text.split(/(\s+)/)) {
      if (part === "") continue;
      const space = /^\s+$/.test(part);
      tokens.push({
        text: part,
        rendered: space ? " " : renderRun({ text: part, style: run.style }),
        space,
      });
    }
  }

  const lines: string[] = [];
  let line = "";
  let length = 0;
  for (const token of tokens) {
    if (token.space) {
      if (length > 0) {
        line += " ";
        length += 1;
      }
      continue;
    }
    const wordLength = [...token.text].length;
    if (length > 0 && length + wordLength > width) {
      lines.push(line.replace(/\s+$/, ""));
      line = "";
      length = 0;
    }
    line += token.rendered;
    length += wordLength;
  }
  lines.push(line.replace(/\s+$/, ""));
  return lines.length > 0 ? lines : [""];
}

function applyInline(text: string, style: Style = {}): string {
  return parseInline(text, style)
    .map(renderRun)
    .join("");
}

function plainInline(text: string): string {
  return parseInline(text, {})
    .map((run) => run.text)
    .join("");
}

function isTableSeparator(line: string): boolean {
  return line.includes("|") && /^[\s|:-]+$/.test(line) && line.includes("-");
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

function renderHeading(level: number, text: string): string[] {
  const accent =
    level === 1 ? color.magenta : level === 2 ? color.cyan : level >= 4 ? color.gray : color.blue;
  const rendered = applyInline(text, { bold: true, accent });
  const underline = level <= 2 ? color.dim("─".repeat(Math.max(3, Math.min(40, [...plainInline(text)].length)))) : undefined;
  return underline ? ["", rendered, underline] : ["", rendered];
}

function renderCode(code: string[], lang: string): string[] {
  const out: string[] = [];
  out.push(color.gray(lang ? `┌─ ${lang}` : "┌─"));
  for (const line of code) out.push(color.gray("│ ") + line);
  out.push(color.gray("└─"));
  return out;
}

function renderQuote(lines: string[], width: number): string[] {
  const text = lines.join(" ").trim();
  const runs = parseInline(text, {});
  const wrapped = wrapRuns(runs, Math.max(10, width - 2));
  return wrapped.map((line) => color.gray("│ ") + line);
}

function renderList(items: string[], width: number): string[] {
  const out: string[] = [];
  for (const item of items) {
    const match = /^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/.exec(item);
    if (!match) continue;
    const depth = Math.floor(match[1]!.length / 2);
    const indent = "  ".repeat(depth);
    const isOrdered = /^\d/.test(match[2]!);
    const marker = isOrdered ? match[2]!.replace(/[.)]$/, ".") : "•";
    const prefix = `${indent}${color.cyan(marker)} `;
    const contPrefix = `${indent}${" ".repeat(marker.length + 1)}`;
    const runs = parseInline(match[4]!, {});
    const wrapped = wrapRuns(runs, Math.max(10, width - indent.length - marker.length - 1));
    wrapped.forEach((line, index) => out.push((index === 0 ? prefix : contPrefix) + line));
  }
  return out;
}

function truncatePlain(text: string, width: number): string {
  const chars = [...text];
  if (chars.length <= width) return text;
  if (width <= 1) return "…";
  return chars.slice(0, width - 1).join("") + "…";
}

function splitRow(row: string): string[] {
  return row
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderTable(rows: string[], width: number): string[] {
  const separator = rows.find((row) => isTableSeparator(row));
  const alignments: Array<"left" | "center" | "right"> = separator
    ? splitRow(separator).map((cell) => {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        return left && right ? "center" : right ? "right" : "left";
      })
    : [];
  const parsed = rows.filter((row) => !isTableSeparator(row)).map(splitRow);
  if (parsed.length === 0) return [];

  const columns = Math.max(...parsed.map((row) => row.length));
  const widths = new Array<number>(columns).fill(3);
  for (const row of parsed) {
    for (let c = 0; c < columns; c++) {
      widths[c] = Math.max(widths[c]!, [...plainInline(row[c] ?? "")].length);
    }
  }

  // Perkecil kolom terlebar hingga tabel muat di lebar terminal.
  const overhead = columns * 3 + 1;
  let total = widths.reduce((a, b) => a + b, 0) + overhead;
  while (total > width && Math.max(...widths) > 3) {
    const widest = widths.indexOf(Math.max(...widths));
    widths[widest] = widths[widest]! - 1;
    total--;
  }

  const pad = (text: string, w: number, align: "left" | "center" | "right"): string => {
    const content = truncatePlain(text, w);
    const rendered = applyInline(content);
    const visible = [...plainInline(content)].length;
    const gap = Math.max(0, w - visible);
    if (align === "right") return " ".repeat(gap) + rendered;
    if (align === "center") {
      const left = Math.floor(gap / 2);
      return " ".repeat(left) + rendered + " ".repeat(gap - left);
    }
    return rendered + " ".repeat(gap);
  };

  const line = (left: string, mid: string, right: string, fill: string): string =>
    color.gray(left + widths.map((w) => fill.repeat(w + 2)).join(mid) + right);

  const out: string[] = [line("┌", "┬", "┐", "─")];
  parsed.forEach((row, index) => {
    const cells = widths.map((w, c) => {
      const content = pad(row[c] ?? "", w, alignments[c] ?? "left");
      return index === 0 ? color.bold(content) : content;
    });
    out.push(color.gray("│") + " " + cells.join(color.gray(" │ ")) + " " + color.gray("│"));
    if (index === 0) out.push(line("├", "┼", "┤", "─"));
  });
  out.push(line("└", "┴", "┘", "─"));
  return out;
}

function renderParagraph(text: string, width: number): string[] {
  return wrapRuns(parseInline(text, {}), width);
}

/** Render Markdown ke string ber-ANSI yang siap ditulis ke terminal. */
export function renderMarkdown(input: string, options: MarkdownOptions = {}): string {
  const width = Math.max(20, options.width ?? process.stdout.columns ?? 80);
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    const fence = /^(\s*)```(.*)$/.exec(line);
    if (fence) {
      const lang = fence[2]!.trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) {
        code.push(lines[i]!);
        i++;
      }
      if (i < lines.length) i++;
      out.push("", ...renderCode(code, lang), "");
      continue;
    }

    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      out.push(...renderHeading(heading[1]!.length, heading[2]!), "");
      i++;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(color.gray("─".repeat(Math.min(width, 40))), "");
      i++;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const table: string[] = [line, lines[i + 1]!];
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
        table.push(lines[i]!);
        i++;
      }
      out.push("", ...renderTable(table, width), "");
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) {
        quote.push(lines[i]!.replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(...renderQuote(quote, width), "");
      continue;
    }

    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]!)) {
        items.push(lines[i]!);
        i++;
      }
      out.push(...renderList(items, width), "");
      continue;
    }

    if (line.trim() === "") {
      out.push("");
      i++;
      continue;
    }

    const paragraph: string[] = [line];
    i++;
    while (i < lines.length && lines[i]!.trim() !== "" && !isBlockStart(lines[i]!)) {
      paragraph.push(lines[i]!);
      i++;
    }
    out.push(...renderParagraph(paragraph.join(" "), width), "");
  }

  const body = out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
  return body + "\n";
}
