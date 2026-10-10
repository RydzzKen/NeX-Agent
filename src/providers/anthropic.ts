import type { ModelInfo, NeutralMessage, TokenUsage } from "../core/types.js";
import { EMPTY_USAGE } from "../core/types.js";
import type { ChatRequest, ModelProvider, StreamEvent } from "./provider.js";
import { formatHttpError } from "./errors.js";
import { parseSSE } from "./sse.js";

export interface AnthropicOptions {
  id?: string;
  label?: string;
  baseURL?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}

interface AnthropicBlock {
  type: "text" | "tool_use" | "thinking";
  text?: string;
  id?: string;
  name?: string;
  json?: string;
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function toAnthropicMessages(messages: NeutralMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: message.toolCallId ?? "",
        content: message.content,
      };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) {
        (last.content as unknown[]).push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (message.role === "assistant") {
      const content: Array<Record<string, unknown>> = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: safeParse(call.arguments) });
      }
      out.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: "" }] });
      continue;
    }
    out.push({ role: "user", content: message.content });
  }
  return out;
}

/** Provider Anthropic Messages API. */
export class AnthropicProvider implements ModelProvider {
  readonly id: string;
  readonly label: string;
  private readonly baseURL: string;
  private readonly apiKey?: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly maxTokens: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicOptions = {}) {
    this.id = options.id ?? "anthropic";
    this.label = options.label ?? "Anthropic";
    this.baseURL = (options.baseURL ?? "https://api.anthropic.com").replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.extraHeaders = options.headers ?? {};
    this.maxTokens = options.maxTokens ?? 8192;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...this.extraHeaders,
    };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    return headers;
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const response = await this.fetchImpl(`${this.baseURL}/v1/models`, {
      headers: this.headers(),
      signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = (await response.json()) as { data?: Array<{ id?: string; display_name?: string }> };
    return (json.data ?? [])
      .filter((m): m is { id: string; display_name?: string } => typeof m.id === "string")
      .map((m) => ({ id: m.id, name: m.display_name }));
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: this.maxTokens,
      stream: true,
      messages: toAnthropicMessages(req.messages),
    };
    if (req.system) body.system = req.system;
    if (req.tools.length) {
      body.tools = req.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
    }

    const response = await this.fetchImpl(`${this.baseURL}/v1/messages`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw new Error(formatHttpError(this.id, response.status, text));
    }

    const blocks = new Map<number, AnthropicBlock>();
    let usage: TokenUsage = { ...EMPTY_USAGE };
    let stopReason = "stop";

    for await (const message of parseSSE(response.body)) {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(message.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = event.type as string;
      switch (type) {
        case "message_start": {
          const msg = event.message as { usage?: Record<string, number> } | undefined;
          const u = msg?.usage ?? {};
          usage = {
            input: u.input_tokens ?? 0,
            output: u.output_tokens ?? 0,
            cacheRead: u.cache_read_input_tokens ?? 0,
            cacheWrite: u.cache_creation_input_tokens ?? 0,
          };
          break;
        }
        case "content_block_start": {
          const index = (event.index as number) ?? 0;
          const block = event.content_block as AnthropicBlock;
          blocks.set(index, { ...block, json: "" });
          break;
        }
        case "content_block_delta": {
          const index = (event.index as number) ?? 0;
          const delta = event.delta as Record<string, unknown>;
          const block = blocks.get(index);
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            yield { type: "text", text: delta.text };
          } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
            yield { type: "thinking", text: delta.thinking };
          } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string" && block) {
            block.json = (block.json ?? "") + delta.partial_json;
          }
          break;
        }
        case "content_block_stop": {
          const index = (event.index as number) ?? 0;
          const block = blocks.get(index);
          if (block?.type === "tool_use") {
            yield {
              type: "tool_call",
              call: {
                id: block.id ?? `call_${Date.now()}`,
                name: block.name ?? "",
                arguments: block.json && block.json.trim() ? block.json : "{}",
              },
            };
          }
          break;
        }
        case "message_delta": {
          const delta = event.delta as { stop_reason?: string } | undefined;
          if (delta?.stop_reason) stopReason = delta.stop_reason;
          const u = event.usage as Record<string, number> | undefined;
          if (u?.output_tokens !== undefined) usage = { ...usage, output: u.output_tokens };
          break;
        }
        default:
          break;
      }
    }

    yield { type: "usage", usage };
    yield {
      type: "done",
      stopReason: stopReason === "tool_use" ? "tool_use" : stopReason === "max_tokens" ? "length" : "stop",
    };
  }
}
