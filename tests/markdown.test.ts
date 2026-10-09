import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/util/markdown.js";
import { setColorEnabled } from "../src/util/color.js";
import { TerminalIO } from "../src/cli/render.js";
import type { PrompterLike } from "../src/cli/prompt.js";

const prompter: PrompterLike = { question: async () => "", close: () => {} };

beforeEach(() => setColorEnabled(false));
afterEach(() => setColorEnabled(false));

describe("renderMarkdown", () => {
  it("menghilangkan penanda heading", () => {
    const out = renderMarkdown("# Judul");
    expect(out).toContain("Judul");
    expect(out).not.toContain("# Judul");
  });

  it("merender daftar tak berurut dan berurut", () => {
    expect(renderMarkdown("- a\n- b")).toContain("• a");
    const ordered = renderMarkdown("1. satu\n2. dua");
    expect(ordered).toContain("1. satu");
    expect(ordered).toContain("2. dua");
  });

  it("merender gaya inline tanpa penanda", () => {
    expect(renderMarkdown("Halo **dunia**")).toContain("Halo dunia");
    expect(renderMarkdown("pakai `pnpm test`")).toContain("pakai pnpm test");
    expect(renderMarkdown("~~hapus~~")).toContain("hapus");
  });

  it("tidak salah menganggap underscore dalam kata sebagai italic", () => {
    expect(renderMarkdown("nama snake_case tetap")).toContain("snake_case");
  });

  it("merender tautan sebagai teks (url)", () => {
    expect(renderMarkdown("[docs](https://x.id)")).toContain("docs (https://x.id)");
  });

  it("merender blok kode dengan label bahasa", () => {
    const out = renderMarkdown("```ts\nconst x = 1;\n```");
    expect(out).toContain("ts");
    expect(out).toContain("│ const x = 1;");
  });

  it("merender tabel dengan garis kotak", () => {
    const out = renderMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(out).toContain("┌");
    expect(out).toContain("│");
    expect(out).not.toContain("|");
  });

  it("merender blockquote dan garis pemisah", () => {
    expect(renderMarkdown("> catatan")).toContain("│ catatan");
    expect(renderMarkdown("---")).toContain("─");
  });

  it("membungkus paragraf sesuai lebar", () => {
    const out = renderMarkdown("kata ".repeat(30).trim(), { width: 20 });
    const lines = out.trim().split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect([...line].length).toBeLessThanOrEqual(20);
  });

  it("selalu diakhiri baris baru", () => {
    expect(renderMarkdown("teks")).toMatch(/\n$/);
  });
});

describe("TerminalIO markdown", () => {
  it("menahan teks lalu merendernya saat textEnd", () => {
    const writes: string[] = [];
    const io = new TerminalIO(prompter, { thinking: false, json: false, markdown: true }, (s) =>
      writes.push(s),
    );
    io.text("# Halo");
    expect(writes.join("")).toBe("");
    io.textEnd();
    const out = writes.join("");
    expect(out).toContain("Halo");
    expect(out).not.toContain("# Halo");
  });

  it("stream langsung bila markdown dimatikan", () => {
    const writes: string[] = [];
    const io = new TerminalIO(prompter, { thinking: false, json: false, markdown: false }, (s) =>
      writes.push(s),
    );
    io.text("# Halo");
    expect(writes.join("")).toContain("# Halo");
  });

  it("mode json tidak merender markdown", () => {
    const writes: string[] = [];
    const io = new TerminalIO(prompter, { thinking: false, json: true, markdown: true }, (s) =>
      writes.push(s),
    );
    io.text("# Halo");
    io.textEnd();
    expect(writes.join("")).toContain('"text":"# Halo"');
  });
});
