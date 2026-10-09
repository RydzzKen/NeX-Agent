import type { ModelInfo, NeutralMessage, TokenUsage } from "../core/types.js";

/** Spesifikasi tool yang dikirim ke model (skema JSON). */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema untuk parameter. */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  system?: string;
  messages: NeutralMessage[];
  tools: ToolSpec[];
  signal?: AbortSignal;
}

/** Panggilan tool yang di stream provider (argumen sudah lengkap saat emit). */
export interface StreamToolCall {
  id: string;
  name: string;
  /** JSON mentah. */
  arguments: string;
}

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; call: StreamToolCall }
  | { type: "usage"; usage: TokenUsage }
  | { type: "done"; stopReason: "stop" | "tool_use" | "length" };

/**
 * Interface tunggal untuk semua provider. Adapter bertanggung jawab
 * menerjemahkan format netral <-> format wire provider.
 */
export interface ModelProvider {
  /** ID unik provider, mis. "anthropic" atau "custom:9router". */
  readonly id: string;
  /** Nama tampilan. */
  readonly label: string;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  stream(req: ChatRequest): AsyncIterable<StreamEvent>;
}

export interface ProviderCredentials {
  apiKey?: string;
  baseURL?: string;
}
