import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWebSearch,
  normalizeHits,
  parseDuckDuckGo,
  parseDuckDuckGoHtml,
  searchDuckDuckGo,
  searchDuckDuckGoHtml,
} from "../src/util/websearch.js";

describe("parseDuckDuckGo", () => {
  it("mengambil Abstract sebagai hasil pertama", () => {
    const hits = parseDuckDuckGo(
      {
        Heading: "TypeScript",
        AbstractText: "TypeScript adalah superset JavaScript.",
        AbstractURL: "https://en.wikipedia.org/wiki/TypeScript",
      },
      "typescript",
    );
    expect(hits).toEqual([
      {
        title: "TypeScript",
        url: "https://en.wikipedia.org/wiki/TypeScript",
        snippet: "TypeScript adalah superset JavaScript.",
      },
    ]);
  });

  it("menggabungkan Results dan RelatedTopics (termasuk grup bersarang)", () => {
    const hits = parseDuckDuckGo(
      {
        Results: [{ Text: "Situs Resmi", FirstURL: "https://www.typescriptlang.org/" }],
        RelatedTopics: [
          {
            Topics: [
              { Text: "Zod - Validasi skema", FirstURL: "https://zod.dev/" },
              { Text: "Vitest", FirstURL: "https://vitest.dev/" },
            ],
          },
        ],
      },
      "typescript",
    );
    expect(hits.map((h) => h.url)).toEqual([
      "https://www.typescriptlang.org/",
      "https://zod.dev/",
      "https://vitest.dev/",
    ]);
    // Judul RelatedTopics dipangkas pada " - ".
    expect(hits[1]?.title).toBe("Zod");
  });

  it("membuang hasil tanpa URL dan duplikat", () => {
    const hits = parseDuckDuckGo(
      {
        Results: [
          { Text: "tanpa url" },
          { Text: "A", FirstURL: "https://a.example" },
          { Text: "A dup", FirstURL: "https://a.example" },
        ],
      },
      "q",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.url).toBe("https://a.example");
  });

  it("membatasi jumlah hasil", () => {
    const RelatedTopics = Array.from({ length: 30 }, (_, i) => ({
      Text: `T${i}`,
      FirstURL: `https://example.com/${i}`,
    }));
    expect(parseDuckDuckGo({ RelatedTopics }, "q")).toHaveLength(10);
  });

  it("mengembalikan daftar kosong bila tidak ada data", () => {
    expect(parseDuckDuckGo({}, "q")).toEqual([]);
  });
});

describe("normalizeHits", () => {
  it("menerima snippet, content (SearXNG), dan description (Brave)", () => {
    const hits = normalizeHits([
      { title: "A", url: "https://a.example", snippet: "s" },
      { title: "B", url: "https://b.example", content: "c" },
      { title: "C", url: "https://c.example", description: "d" },
    ]);
    expect(hits.map((h) => h.snippet)).toEqual(["s", "c", "d"]);
  });

  it("mengabaikan baris non-array/tanpa URL", () => {
    expect(normalizeHits(undefined)).toEqual([]);
    expect(normalizeHits("x")).toEqual([]);
    expect(normalizeHits([{ title: "x" }, null, 3])).toEqual([]);
  });
});

describe("searchDuckDuckGo", () => {
  it("memanggil Instant Answer API dengan query terenkode dan user-agent", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain("api.duckduckgo.com");
      expect(String(url)).toContain("q=typescript%20zod");
      expect(init?.headers).toMatchObject({ accept: "application/json" });
      expect((init?.headers as Record<string, string>)["user-agent"]).toContain("NeX-Agent");
      return new Response(
        JSON.stringify({ Heading: "TS", AbstractText: "ok", AbstractURL: "https://example.com/ts" }),
        { status: 200 },
      );
    });
    const hits = await searchDuckDuckGo(
      "typescript zod",
      new AbortController().signal,
      fetchMock as unknown as typeof fetch,
    );
    expect(hits[0]).toEqual({ title: "TS", url: "https://example.com/ts", snippet: "ok" });
  });

  it("melempar error saat respons HTTP gagal", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
    await expect(
      searchDuckDuckGo("q", new AbortController().signal, fetchMock as unknown as typeof fetch),
    ).rejects.toThrow("HTTP 500");
  });
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(body: unknown) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

describe("createWebSearch", () => {
  it("memakai DuckDuckGo saat opsi kosong atau provider duckduckgo", () => {
    expect(createWebSearch()).toBe(searchDuckDuckGo);
    expect(createWebSearch({ provider: "duckduckgo" })).toBe(searchDuckDuckGo);
  });

  it("memperlakukan url tanpa provider sebagai endpoint JSON generik", async () => {
    const fetchMock = mockFetch({ results: [{ title: "A", url: "https://a.example" }] });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const search = createWebSearch({ url: "https://searx.example/search?format=json" });
    const hits = await search("halo dunia", new AbortController().signal);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://searx.example/search?format=json&q=halo%20dunia",
    );
    expect(hits).toEqual([{ title: "A", url: "https://a.example" }]);
  });

  it("memakai ? saat endpoint generik belum punya query string", async () => {
    const fetchMock = mockFetch({ results: [] });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const search = createWebSearch({ url: "https://searx.example/search" });
    await search("x", new AbortController().signal);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://searx.example/search?q=x");
  });

  it("SearXNG menambahkan format=json dan membaca field content", async () => {
    const fetchMock = mockFetch({
      results: [{ title: "Zod", url: "https://zod.dev", content: "validasi skema" }],
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const search = createWebSearch({ provider: "searxng", url: "https://searx.example/search" });
    const hits = await search("zod", new AbortController().signal);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://searx.example/search?q=zod&format=json",
    );
    expect(hits).toEqual([{ title: "Zod", url: "https://zod.dev", snippet: "validasi skema" }]);
  });

  it("SearXNG tanpa url memberi error yang jelas", async () => {
    const search = createWebSearch({ provider: "searxng" });
    await expect(search("q", new AbortController().signal)).rejects.toThrow(/searchUrl/);
  });

  it("Brave memakai endpoint default, header kunci, dan membaca web.results", async () => {
    const fetchMock = mockFetch({
      web: { results: [{ title: "T", url: "https://t.example", description: "D" }] },
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const search = createWebSearch({ provider: "brave", apiKey: "secret" });
    const hits = await search("q", new AbortController().signal);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.search.brave.com/res/v1/web/search?q=q&count=10");
    expect((init?.headers as Record<string, string>)["x-subscription-token"]).toBe("secret");
    expect(hits).toEqual([{ title: "T", url: "https://t.example", snippet: "D" }]);
  });

  it("Brave tanpa kunci memberi error yang jelas", async () => {
    const saved = process.env.BRAVE_API_KEY;
    delete process.env.BRAVE_API_KEY;
    try {
      const search = createWebSearch({ provider: "brave" });
      await expect(search("q", new AbortController().signal)).rejects.toThrow(/BRAVE_API_KEY/);
    } finally {
      if (saved === undefined) delete process.env.BRAVE_API_KEY;
      else process.env.BRAVE_API_KEY = saved;
    }
  });
});

const DDG_HTML_RESULTS =
  '<div class="result"><h2><a rel="nofollow" class="result__a" ' +
  'href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fzod.dev%2F&rut=abc">Zod &amp; TypeScript</a></h2>' +
  '<a class="result__snippet" href="https://zod.dev">Validasi skema.</a></div>' +
  '<div class="result"><h2><a class="result__a" href="https://vitest.dev/">Vitest</a></h2>' +
  '<a class="result__snippet">Test runner cepat.</a></div>';

describe("parseDuckDuckGoHtml", () => {
  it("membuka URL redirect uddg dan memasangkan snippet", () => {
    const hits = parseDuckDuckGoHtml(DDG_HTML_RESULTS);
    expect(hits).toEqual([
      { title: "Zod & TypeScript", url: "https://zod.dev/", snippet: "Validasi skema." },
      { title: "Vitest", url: "https://vitest.dev/", snippet: "Test runner cepat." },
    ]);
  });

  it("mengabaikan duplikat dan anchor tanpa href", () => {
    const html =
      '<a class="result__a" href="https://a.example">A</a>' +
      '<a class="result__a">tanpa href</a>' +
      '<a class="result__a" href="https://a.example">A dup</a>';
    expect(parseDuckDuckGoHtml(html).map((h) => h.url)).toEqual(["https://a.example"]);
  });

  it("mengembalikan kosong bila tidak ada hasil", () => {
    expect(parseDuckDuckGoHtml("<div>kosong</div>")).toEqual([]);
  });
});

describe("searchDuckDuckGoHtml", () => {
  it("memanggil endpoint HTML DuckDuckGo dengan query terenkode", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain("html.duckduckgo.com");
      expect(String(url)).toContain("q=zod%20trpc");
      expect((init?.headers as Record<string, string>).accept).toContain("text/html");
      return new Response(DDG_HTML_RESULTS, { status: 200 });
    });
    const hits = await searchDuckDuckGoHtml(
      "zod trpc",
      new AbortController().signal,
      fetchMock as unknown as typeof fetch,
    );
    expect(hits).toHaveLength(2);
    expect(hits[0]?.url).toBe("https://zod.dev/");
  });
});

describe("searchDuckDuckGo fallback", () => {
  it("jatuh ke halaman HTML saat Instant Answer kosong", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("api.duckduckgo.com")) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response(DDG_HTML_RESULTS, { status: 200 });
    });
    const hits = await searchDuckDuckGo(
      "zod",
      new AbortController().signal,
      fetchMock as unknown as typeof fetch,
    );
    expect(hits.map((h) => h.url)).toEqual(["https://zod.dev/", "https://vitest.dev/"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("tidak memanggil HTML bila Instant Answer sudah berisi hasil", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ Heading: "TS", AbstractURL: "https://example.com/ts" }), {
        status: 200,
      }),
    );
    const hits = await searchDuckDuckGo(
      "ts",
      new AbortController().signal,
      fetchMock as unknown as typeof fetch,
    );
    expect(hits).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("mengembalikan kosong (bukan error) bila keduanya kosong", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("api.duckduckgo.com")) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response("<div>kosong</div>", { status: 200 });
    });
    const hits = await searchDuckDuckGo(
      "tak ada",
      new AbortController().signal,
      fetchMock as unknown as typeof fetch,
    );
    expect(hits).toEqual([]);
  });
});
