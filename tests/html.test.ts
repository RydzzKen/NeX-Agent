import { describe, expect, it } from "vitest";
import { decodeEntities, extractTitle, htmlToText, stripTags } from "../src/util/html.js";

describe("decodeEntities", () => {
  it("mendekode named, desimal, dan heksadesimal", () => {
    expect(decodeEntities("&amp;&lt;&gt;&quot;&#39;&#x41;&#66;")).toBe("&<>\"'AB");
  });

  it("menangani &nbsp; dan entitas tak dikenal", () => {
    expect(decodeEntities("a&nbsp;b &unknown; c")).toBe("a b &unknown; c");
  });

  it("memprioritaskan &amp; di akhir agar tidak salah dekode", () => {
    expect(decodeEntities("&amp;lt;")).toBe("&lt;");
  });
});

describe("stripTags", () => {
  it("membuang seluruh tag", () => {
    expect(stripTags("<p>Halo <b>dunia</b></p>")).toBe("Halo dunia");
  });
});

describe("htmlToText", () => {
  it("mengubah struktur dasar menjadi teks terbaca", () => {
    const html =
      "<html><head><title>Judul</title><style>p{}</style></head><body>" +
      "<h1>Heading</h1><p>Halo <b>dunia</b> &amp; semuanya.</p>" +
      "<ul><li>Satu</li><li>Dua</li></ul>" +
      "<script>var x = 1;</script></body></html>";
    const text = htmlToText(html);
    expect(text).toContain("# Heading");
    expect(text).toContain("Halo dunia & semuanya.");
    expect(text).toContain("- Satu");
    expect(text).toContain("- Dua");
    expect(text).not.toContain("var x");
    expect(text).not.toContain("p{}");
  });

  it("mengubah <br> dan heading bersarang menjadi baris baru", () => {
    expect(htmlToText("a<br>b").split("\n")).toEqual(["a", "b"]);
    expect(htmlToText("<h2>Sub</h2>")).toContain("## Sub");
  });

  it("memadatkan spasi dan baris kosong berlebih", () => {
    expect(htmlToText("<p>a</p>\n\n\n\n<p>b</p>")).toBe("a\n\nb");
  });

  it("mengembalikan string kosong untuk masukan kosong", () => {
    expect(htmlToText("")).toBe("");
  });
});

describe("extractTitle", () => {
  it("mengambil dan membersihkan <title>", () => {
    expect(extractTitle("<head><title> A &amp; B </title></head>")).toBe("A & B");
  });

  it("mengembalikan undefined bila tidak ada judul", () => {
    expect(extractTitle("<p>tanpa judul</p>")).toBeUndefined();
    expect(extractTitle("<title>   </title>")).toBeUndefined();
  });
});
