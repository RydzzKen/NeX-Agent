import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWebSearch,
  normalizeHits,
  parseDuckDuckGo,
  searchDuckDuckGo,
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
