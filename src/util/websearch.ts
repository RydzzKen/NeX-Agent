import type { WebSearchFn } from "../tools/types.js";

interface SearchHit {
  title: string;
  url: string;
  snippet?: string;
}

async function searchDuckDuckGo(query: string, signal: AbortSignal): Promise<SearchHit[]> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1`;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = (await response.json()) as {
    AbstractText?: string;
    AbstractURL?: string;
    Heading?: string;
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
  };
  const hits: SearchHit[] = [];
  if (json.AbstractText && json.AbstractURL) {
    hits.push({ title: json.Heading ?? query, url: json.AbstractURL, snippet: json.AbstractText });
  }
  for (const topic of json.RelatedTopics ?? []) {
    if (hits.length >= 8) break;
    if (topic.Text && topic.FirstURL) hits.push({ title: topic.Text.split(" - ")[0] ?? topic.Text, url: topic.FirstURL, snippet: topic.Text });
  }
  return hits;
}

/** Bangun fungsi pencarian web. `endpoint` opsional: JSON `{results:[...]}`. */
export function createWebSearch(endpoint?: string): WebSearchFn {
  if (!endpoint) return searchDuckDuckGo;
  return async (query: string, signal: AbortSignal): Promise<SearchHit[]> => {
    const url = `${endpoint}${endpoint.includes("?") ? "&" : "?"}q=${encodeURIComponent(query)}`;
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = (await response.json()) as { results?: SearchHit[] };
    return json.results ?? [];
  };
}
