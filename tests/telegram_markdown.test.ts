import { describe, expect, it } from "vitest";
import {
  chunkTelegramHtml,
  countHtmlEntities,
  htmlToPlainText,
  inlineTelegramHtml,
  renderTelegramChunks,
  renderTelegramHtml,
} from "../src/server/telegram_markdown.js";

describe("inlineTelegramHtml", () => {
  it("mengubah gaya inline menjadi tag Telegram", () => {
    expect(inlineTelegramHtml("**tebal** dan *miring* dan `kode`")).toBe(
      "<b>tebal</b> dan <i>miring</i> dan <code>kode</code>",
    );
    expect(inlineTelegramHtml("~~coret~~")).toBe("<s>coret</s>");
    expect(inlineTelegramHtml("__tebal__ _miring_")).toBe("<b>tebal</b> <i>miring</i>");
  });

  it("mengubah tautan dan URL telanjang", () => {
    expect(inlineTelegramHtml("[situs](https://contoh.id)")).toBe(
      '<a href="https://contoh.id">situs</a>',
    );
    expect(inlineTelegramHtml("lihat https://contoh.id/x y")).toBe(
      'lihat <a href="https://contoh.id/x">https://contoh.id/x</a> y',
    );
  });

  it("meng-escape karakter HTML agar aman", () => {
    expect(inlineTelegramHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
    expect(inlineTelegramHtml("harga <b> 5 & 3")).toBe("harga &lt;b&gt; 5 &amp; 3");
  });

  it("tidak salah mengenali tanda dalam kata", () => {
    expect(inlineTelegramHtml("snake_case dan a*b")).toBe("snake_case dan a*b");
  });
});

describe("renderTelegramHtml", () => {
  it("merender heading, daftar, dan blockquote", () => {
    const html = renderTelegramHtml("# Judul\n\n- satu\n- dua\n\n> kutipan");
    expect(html).toContain("<b>Judul</b>");
    expect(html).toContain("• satu\n• dua");
    expect(html).toContain("<blockquote>kutipan</blockquote>");
  });

  it("merender blok kode dengan escape dan bahasa", () => {
    const html = renderTelegramHtml("```ts\nconst a = 1 < 2;\n```");
    expect(html).toBe('<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>');
  });

  it("merender tabel sebagai blok pre yang rata", () => {
    const html = renderTelegramHtml("| Nama | Umur |\n| --- | --- |\n| Budi | 30 |");
    expect(html.startsWith("<pre>")).toBe(true);
    expect(html).toContain("Nama");
    expect(html).toContain("Budi");
    expect(html).toContain("─");
  });
});

describe("chunkTelegramHtml", () => {
  it("menjaga tag tetap seimbang dan panjang ≤ batas", () => {
    const html = `<b>${"a".repeat(200)}</b>`;
    const chunks = chunkTelegramHtml(html, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50);
      expect(chunk.startsWith("<b>")).toBe(true);
      expect(chunk.endsWith("</b>")).toBe(true);
    }
    // Gabungan teks tetap lengkap.
    const text = chunks.join("").replace(/<\/?b>/g, "");
    expect(text).toBe("a".repeat(200));
  });

  it("tidak memecah bila sudah di bawah batas", () => {
    expect(chunkTelegramHtml("<b>x</b>", 100)).toEqual(["<b>x</b>"]);
  });
});

describe("util lain", () => {
  it("htmlToPlainText membersihkan tag dan entitas", () => {
    expect(htmlToPlainText("<b>a</b> &lt;b&gt; &amp; c")).toBe("a <b> & c");
  });

  it("countHtmlEntities menghitung tag pembuka", () => {
    expect(countHtmlEntities("<b>x</b> <i>y</i>")).toBe(2);
  });

  it("renderTelegramChunks menggabungkan keduanya", () => {
    const chunks = renderTelegramChunks("**halo**", 100);
    expect(chunks).toEqual(["<b>halo</b>"]);
  });
});
