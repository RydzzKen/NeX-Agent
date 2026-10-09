import { describe, expect, it } from "vitest";
import type { StreamEvent } from "../src/providers/provider.js";
import { OpenAICompatibleProvider, createCustomProvider } from "../src/providers/openai.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";

function sse(chunks: unknown[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

function fetchBody(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, { status, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("OpenAICompatibleProvider", () => {
  it("mengurai teks, tool call, usage, dan stop reason", async () => {
    const body = sse([
      { choices: [{ delta: { content: "Hi" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a"}' } }] } }] },
      { choices: [{ finish_reason: "tool_calls" }] },
      { usage: { prompt_tokens: 10, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } } },
    ]);
    const provider = new OpenAICompatibleProvider({
      id: "x",
      label: "X",
      baseURL: "http://localhost:1234/v1",
      fetchImpl: fetchBody(body),
    });

    const events = await collect(
      provider.stream({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [] }),
    );

    expect(events).toContainEqual({ type: "text", text: "Hi" });
    expect(events).toContainEqual({
      type: "tool_call",
      call: { id: "call_1", name: "read_file", arguments: '{"path":"a"}' },
    });
    expect(events).toContainEqual({ type: "usage", usage: { input: 10, output: 3, cacheRead: 2, cacheWrite: 0 } });
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "tool_use" });
  });

  it("membuat provider custom dengan id custom:<nama>", () => {
    const provider = createCustomProvider("9router", { baseURL: "http://localhost:20128/v1" });
    expect(provider.id).toBe("custom:9router");
  });

  it("melempar error saat HTTP gagal", async () => {
    const provider = new OpenAICompatibleProvider({
      id: "x",
      label: "X",
      baseURL: "http://localhost/v1",
      fetchImpl: fetchBody("boom", 500),
    });
    await expect(
      collect(provider.stream({ model: "m", messages: [], tools: [] })),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe("AnthropicProvider", () => {
  it("mengurai text_delta, tool_use, dan usage", async () => {
    const body = sse([
      { type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 4 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Halo" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "list_dir" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"."}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
      { type: "message_stop" },
    ]);
    const provider = new AnthropicProvider({ apiKey: "k", fetchImpl: fetchBody(body) });

    const events = await collect(
      provider.stream({ model: "m", messages: [{ role: "user", content: "hi" }], tools: [] }),
    );

    expect(events).toContainEqual({ type: "text", text: "Halo" });
    expect(events).toContainEqual({
      type: "tool_call",
      call: { id: "tu_1", name: "list_dir", arguments: '{"path":"."}' },
    });
    expect(events).toContainEqual({ type: "usage", usage: { input: 12, output: 7, cacheRead: 4, cacheWrite: 0 } });
    expect(events.at(-1)).toEqual({ type: "done", stopReason: "tool_use" });
  });

  it("menggabungkan tool_result berurutan ke satu pesan user", async () => {
    let sentBody: string | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      sentBody = init?.body as string;
      return new Response(sse([{ type: "message_stop" }]), { status: 200 });
    }) as unknown as typeof fetch;

    const provider = new AnthropicProvider({ apiKey: "k", fetchImpl });
    await collect(
      provider.stream({
        model: "m",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "a", arguments: "{}" }, { id: "t2", name: "b", arguments: "{}" }] },
          { role: "tool", toolCallId: "t1", name: "a", content: "r1" },
          { role: "tool", toolCallId: "t2", name: "b", content: "r2" },
        ],
        tools: [],
      }),
    );

    const body = JSON.parse(sentBody ?? "{}") as { messages: Array<{ role: string; content: unknown }> };
    const userWithResults = body.messages.find(
      (m) => m.role === "user" && Array.isArray(m.content) && (m.content as unknown[]).length === 2,
    );
    expect(userWithResults).toBeDefined();
    expect(userWithResults!.role).toBe("user");
  });
});
