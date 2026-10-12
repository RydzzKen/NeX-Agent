import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { extractTitle, htmlToText } from "../util/html.js";

const DEFAULT_MAX_CHARS = 20_000;
const HARD_MAX_CHARS = 200_000;
const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 20_000;
const USER_AGENT = "NeX-Agent/1.0 (+https://github.com/RydzzKen/NeX-Agent)";

const schema = z.object({
  url: z.string().min(1).describe("URL absolut (http/https) halaman yang diambil."),
  maxChars: z
    .number()
    .int()
    .min(500)
    .max(HARD_MAX_CHARS)
    .optional()
    .describe(`Batas karakter keluaran (default ${DEFAULT_MAX_CHARS}).`),
});

/**
 * Baca isi respons secara bertahap, berhenti setelah `maxBytes` agar halaman
 * besar tidak menghabiskan memori.
 */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return await response.text();
  const decoder = new TextDecoder("utf-8");
  let text = "";
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (total >= maxBytes) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  text += decoder.decode();
  return text;
}

function looksLikeHtml(contentType: string, body: string): boolean {
  if (contentType.includes("html") || contentType.includes("xml")) return true;
  const head = body.slice(0, 4096).toLowerCase();
  return head.includes("<html") || head.includes("<!doctype") || head.includes("<body");
}

export const webFetchTool: ToolDefinition<typeof schema> = {
  name: "web_fetch",
  description:
    "Ambil halaman web (http/https) dan ubah isinya menjadi teks/Markdown yang bisa dibaca. " +
    "Berguna untuk membuka dokumentasi, artikel, atau URL hasil web_search.",
  risk: "read",
  schema,
  summarize: (i) => i.url,
  async execute(input, ctx) {
    let url: URL;
    try {
      url = new URL(input.url.trim());
    } catch {
      return { ok: false, content: `URL tidak valid: ${input.url}` };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, content: `Hanya URL http/https yang didukung (bukan ${url.protocol}).` };
    }

    const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const onAbort = (): void => controller.abort();
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await fetch(url.href, {
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        },
        redirect: "follow",
        signal: controller.signal,
      });
      if (!response.ok) {
        const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
        return { ok: false, content: `Gagal mengambil ${url.href}: HTTP ${status}` };
      }

      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      const raw = await readCapped(response, MAX_BYTES);
      const isHtml = looksLikeHtml(contentType, raw);
      const title = isHtml ? extractTitle(raw) : undefined;
      const text = isHtml ? htmlToText(raw) : raw.trim();

      const truncated = text.length > maxChars;
      const body = truncated ? text.slice(0, maxChars) : text;
      const header = title ? `# ${title}\n${url.href}\n\n` : `${url.href}\n\n`;
      const footer = truncated ? `\n\n... (dipotong pada ${maxChars} dari ${text.length} karakter)` : "";
      return {
        content: header + body + footer,
        summary: `${url.hostname}${title ? ` — ${title}` : ""} (${Math.min(text.length, maxChars)} karakter)`,
      };
    } catch (err) {
      const error = err as Error;
      const message = error?.name === "AbortError" ? `Timeout setelah ${TIMEOUT_MS / 1000} detik` : error.message;
      return { ok: false, content: `Gagal mengambil ${url.href}: ${message}` };
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
    }
  },
};
