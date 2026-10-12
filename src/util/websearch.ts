import type { WebSearchFn } from "../tools/types.js";

export interface SearchHit {
  title: string;
  url: string;
  snippet?: string;
}

/** Backend pencarian yang didukung. */
export type WebSearchProvider = "duckduckgo" | "searxng" | "brave";

export interface WebSearchOptions {
  /** Backend. Default "duckduckgo"; bila `url` diisi tanpa provider → endpoint JSON generik. */
  provider?: WebSearchProvider;
  /** Endpoint kustom: instance SearXNG, endpoint JSON generik, atau override Brave. */
  url?: string;
  /** Kunci API (Brave). Bila kosong, dibaca dari env `BRAVE_API_KEY`. */
  apiKey?: string;
}

const DDG_ENDPOINT = "https://api.duckduckgo.com/";
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESULTS = 10;
const USER_AGENT = "NeX-Agent/1.0 (+https://github.com/RydzzKen/NeX-Agent)";

interface DdgTopic {
  Text?: string;
  FirstURL?: string;
  Topics?: DdgTopic[];
}

interface DdgPayload {
  Heading?: string;
  AbstractText?: string;
  AbstractURL?: string;
  Results?: Array<{ Text?: string; FirstURL?: string }>;
  RelatedTopics?: DdgTopic[];
}

/** Bersihkan teks dari spasi berlebih. */
function tidy(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Ubah payload DuckDuckGo Instant Answer menjadi daftar hasil (murni, teruji).
 * Menangani `Abstract`, `Results`, dan `RelatedTopics` (termasuk grup bersarang).
 */
export function parseDuckDuckGo(payload: DdgPayload, query: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const push = (title: string | undefined, url: string | undefined, snippet?: string): void => {
    const link = (url ?? "").trim();
    if (!link || seen.has(link)) return;
    seen.add(link);
    const body = tidy(snippet);
    hits.push({
      title: tidy(title) || link,
      url: link,
      ...(body ? { snippet: body } : {}),
    });
  };

  push(payload.Heading ?? query, payload.AbstractURL, payload.AbstractText);
  for (const result of payload.Results ?? []) push(result.Text, result.FirstURL, result.Text);

  const walk = (topics: DdgTopic[] | undefined): void => {
    for (const topic of topics ?? []) {
      if (hits.length >= MAX_RESULTS) return;
      if (topic.Topics?.length) walk(topic.Topics);
      else if (topic.FirstURL) push(topic.Text?.split(" - ")[0], topic.FirstURL, topic.Text);
    }
  };
  walk(payload.RelatedTopics);

  return hits;
}

/** Baris hasil mentah dari berbagai backend (SearXNG memakai `content`, Brave `description`). */
interface RawHit {
  title?: string;
  url?: string;
  snippet?: string;
  content?: string;
  description?: string;
}

/** Normalisasi daftar hasil apa pun → `SearchHit[]` (dedupe, buang tanpa URL, batasi). */
export function normalizeHits(rows: unknown): SearchHit[] {
  if (!Array.isArray(rows)) return [];
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (hits.length >= MAX_RESULTS) break;
    if (!row || typeof row !== "object") continue;
    const r = row as RawHit;
    const link = tidy(r.url);
    if (!link || seen.has(link)) continue;
    seen.add(link);
    const body = tidy(r.snippet ?? r.content ?? r.description);
    hits.push({ title: tidy(r.title) || link, url: link, ...(body ? { snippet: body } : {}) });
  }
  return hits;
}

interface FetchOptions {
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
}

/** GET JSON dengan batas waktu; menghormati `signal` pemanggil. */
async function fetchJson<T>(url: string, signal: AbortSignal, opts: FetchOptions = {}): Promise<T> {
  const impl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const onAbort = (): void => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await impl(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/json", ...opts.headers },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

function withQuery(endpoint: string, query: string, extra = ""): string {
  const sep = endpoint.includes("?") ? "&" : "?";
  return `${endpoint}${sep}q=${encodeURIComponent(query)}${extra}`;
}

/** DuckDuckGo Instant Answer API (tanpa kunci, best-effort). */
export async function searchDuckDuckGo(
  query: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<SearchHit[]> {
  const url = withQuery(DDG_ENDPOINT, query, "&format=json&no_html=1&no_redirect=1");
  const payload = await fetchJson<DdgPayload>(url, signal, { fetchImpl });
  return parseDuckDuckGo(payload, query);
}

/** Endpoint JSON generik yang membalas `{ results: [...] }` (mis. SearXNG). */
export async function searchJson(
  query: string,
  endpoint: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<SearchHit[]> {
  const json = await fetchJson<{ results?: unknown }>(withQuery(endpoint, query), signal, { fetchImpl });
  return normalizeHits(json.results);
}

/** SearXNG dengan API JSON (`?format=json`). */
export async function searchSearxng(
  query: string,
  endpoint: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<SearchHit[]> {
  const extra = endpoint.includes("format=") ? "" : "&format=json";
  const json = await fetchJson<{ results?: unknown }>(withQuery(endpoint, query, extra), signal, {
    fetchImpl,
  });
  return normalizeHits(json.results);
}

/** Brave Search API (butuh kunci; header X-Subscription-Token). */
export async function searchBrave(
  query: string,
  apiKey: string | undefined,
  signal: AbortSignal,
  endpoint: string = BRAVE_ENDPOINT,
  fetchImpl: typeof fetch = fetch,
): Promise<SearchHit[]> {
  if (!apiKey) {
    throw new Error("Kunci Brave tidak ada. Setel env BRAVE_API_KEY (atau searchApiKey).");
  }
  const json = await fetchJson<{ web?: { results?: unknown } }>(
    withQuery(endpoint, query, `&count=${MAX_RESULTS}`),
    signal,
    { fetchImpl, headers: { "x-subscription-token": apiKey } },
  );
  return normalizeHits(json.web?.results);
}

/**
 * Bangun fungsi pencarian web dari konfigurasi.
 *
 * - `provider: "brave"` — Brave Search API (kunci dari `apiKey` atau `BRAVE_API_KEY`).
 * - `provider: "searxng"` — instance SearXNG, wajib `url`.
 * - `provider: "duckduckgo"` — Instant Answer API (default).
 * - `url` tanpa `provider` — endpoint JSON generik `{ results: [...] }`.
 */
export function createWebSearch(options: WebSearchOptions = {}): WebSearchFn {
  const { provider, url, apiKey } = options;

  if (provider === "brave") {
    return (query, signal) =>
      searchBrave(query, apiKey ?? process.env.BRAVE_API_KEY, signal, url ?? BRAVE_ENDPOINT, fetch);
  }
  if (provider === "searxng") {
    if (!url) {
      return async () => {
        throw new Error('searchProvider "searxng" butuh "searchUrl" (URL instance SearXNG).');
      };
    }
    return (query, signal) => searchSearxng(query, url, signal, fetch);
  }
  if (provider === "duckduckgo") return searchDuckDuckGo;
  if (url) return (query, signal) => searchJson(query, url, signal, fetch);
  return searchDuckDuckGo;
}
