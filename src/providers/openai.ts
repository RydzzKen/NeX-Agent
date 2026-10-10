import type { ModelInfo, NeutralMessage, TokenUsage } from "../core/types.js";
import { EMPTY_USAGE } from "../core/types.js";
import type { ChatRequest, ModelProvider, ProviderCredentials, StreamEvent } from "./provider.js";
import { formatHttpError } from "./errors.js";
import { parseSSE } from "./sse.js";

export interface OpenAICompatibleOptions {
  id: string;
  label: string;
  baseURL: string;
  apiKey?: string;
  /** Header tambahan (mis. untuk router tertentu). */
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

interface OpenAIToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      thinking?: string | null;
      tool_calls?: OpenAIToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { cached_tokens?: number };
  };
}

function mapUsage(usage: OpenAIChunk["usage"]): TokenUsage {
  if (!usage) return { ...EMPTY_USAGE };
  return {
    input: usage.prompt_tokens ?? 0,
    output: usage.completion_tokens ?? 0,
    cacheRead: usage.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWrite: 0,
  };
}

function toOpenAIMessages(
  messages: NeutralMessage[],
): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId ?? "",
        content: message.content,
      };
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      };
    }
    return { role: message.role, content: message.content };
  });
}

/** Provider yang berbicara protokol OpenAI Chat Completions. */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly label: string;
  private readonly baseURL: string;
  private readonly apiKey?: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatibleOptions) {
    this.id = options.id;
    this.label = options.label;
    this.baseURL = options.baseURL.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.extraHeaders = options.headers ?? {};
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...this.extraHeaders,
    };
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;
    return headers;
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await this.fetchImpl(`${this.baseURL}/models`, {
        headers: this.headers(),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = (await response.json()) as { data?: Array<{ id?: string }> };
      const models = (json.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === "string")
        .map((id) => ({ id }));
      return models;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const body: Record<string, unknown> = {
      model: req.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        ...(req.system ? [{ role: "system", content: req.system }] : []),
        ...toOpenAIMessages(req.messages),
      ],
    };
    if (req.tools.length) {
      body.tools = req.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
    }

    const response = await this.fetchImpl(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw new Error(formatHttpError(this.id, response.status, text));
    }

    const toolCalls = new Map<number, { id: string; name: string; args: string }>();
    let finishReason = "stop";
    let usage: TokenUsage | undefined;

    for await (const message of parseSSE(response.body)) {
      if (message.data === "[DONE]") break;
      let chunk: OpenAIChunk;
      try {
        chunk = JSON.parse(message.data) as OpenAIChunk;
      } catch {
        continue;
      }
      if (chunk.usage) usage = mapUsage(chunk.usage);
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content) {
        yield { type: "text", text: delta.content };
      }
      const reasoning = delta.reasoning_content ?? delta.thinking;
      if (typeof reasoning === "string" && reasoning) {
        yield { type: "thinking", text: reasoning };
      }
      if (delta.tool_calls) {
        for (const call of delta.tool_calls) {
          const index = call.index ?? 0;
          const existing = toolCalls.get(index) ?? { id: "", name: "", args: "" };
          if (call.id) existing.id = call.id;
          if (call.function?.name) existing.name += call.function.name;
          if (call.function?.arguments) existing.args += call.function.arguments;
          toolCalls.set(index, existing);
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    for (const [, call] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      yield {
        type: "tool_call",
        call: { id: call.id || `call_${Date.now()}`, name: call.name, arguments: call.args || "{}" },
      };
    }
    if (usage) yield { type: "usage", usage };
    yield {
      type: "done",
      stopReason: finishReason === "tool_calls" ? "tool_use" : finishReason === "length" ? "length" : "stop",
    };
  }
}

/** Factory untuk provider custom kompatibel OpenAI. */
export function createCustomProvider(
  name: string,
  creds: ProviderCredentials,
  fetchImpl?: typeof fetch,
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: `custom:${name}`,
    label: name,
    baseURL: creds.baseURL ?? "",
    ...(creds.apiKey !== undefined ? { apiKey: creds.apiKey } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}
