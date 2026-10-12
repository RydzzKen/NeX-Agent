import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../src/tools/types.js";
import { webFetchTool } from "../src/tools/web_fetch.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeContext(): ToolContext {
  return {
    mode: "build",
    signal: new AbortController().signal,
  } as unknown as ToolContext;
}

function mockFetch(handler: (url: string) => Response | Promise<Response>): typeof fetch {
  const fn = vi.fn(async (url: string | URL | Request) => handler(String(url)));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn as unknown as typeof fetch;
}

const SAMPLE_HTML =
  "<html><head><title>Contoh &amp; Halaman</title><style>x{}</style></head>" +
  "<body><h1>Judul</h1><p>Isi <b>penting</b>.</p><script>alert(1)</script></body></html>";

describe("web_fetch", () => {
  it("mengambil HTML, menambahkan judul + URL, dan membuang script", async () => {
    mockFetch(() => new Response(SAMPLE_HTML, { status: 200, headers: { "content-type": "text/html" } }));
    const result = await webFetchTool.execute({ url: "https://example.com/page" }, makeContext());
    expect(result.ok).not.toBe(false);
    expect(result.content).toContain("# Contoh & Halaman");
    expect(result.content).toContain("https://example.com/page");
    expect(result.content).toContain("Judul");
    expect(result.content).toContain("Isi penting.");
    expect(result.content).not.toContain("alert(1)");
    expect(result.summary).toContain("example.com");
  });

  it("mengembalikan teks mentah untuk non-HTML", async () => {
    mockFetch(() => new Response("halo dunia", { status: 200, headers: { "content-type": "text/plain" } }));
    const result = await webFetchTool.execute({ url: "https://example.com/a.txt" }, makeContext());
    expect(result.content).toContain("halo dunia");
    expect(result.content).not.toContain("# ");
  });

  it("memotong keluaran sesuai maxChars", async () => {
    const long = `<p>${"a".repeat(5000)}</p>`;
    mockFetch(() => new Response(long, { status: 200, headers: { "content-type": "text/html" } }));
    const result = await webFetchTool.execute({ url: "https://example.com/big", maxChars: 500 }, makeContext());
    expect(result.content).toContain("dipotong");
    expect(result.content.length).toBeLessThan(700);
  });

  it("mengembalikan error (bukan throw) saat HTTP gagal", async () => {
    mockFetch(() => new Response("nope", { status: 404, statusText: "Not Found" }));
    const result = await webFetchTool.execute({ url: "https://example.com/missing" }, makeContext());
    expect(result.ok).toBe(false);
    expect(result.content).toContain("HTTP 404");
  });

  it("menolak URL tidak valid dan protokol non-http", async () => {
    const bad = await webFetchTool.execute({ url: "bukan url" }, makeContext());
    expect(bad.ok).toBe(false);
    expect(bad.content).toContain("tidak valid");

    const ftp = await webFetchTool.execute({ url: "ftp://example.com/x" }, makeContext());
    expect(ftp.ok).toBe(false);
    expect(ftp.content).toContain("http/https");
  });

  it("mengembalikan error (bukan throw) saat jaringan gagal", async () => {
    mockFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const result = await webFetchTool.execute({ url: "https://example.com/down" }, makeContext());
    expect(result.ok).toBe(false);
    expect(result.content).toContain("ECONNREFUSED");
  });
});
