/**
 * Tipe netral inti. Semua modul berbicara dengan bentuk ini; tidak ada
 * detail provider yang bocor ke sini.
 */

export type Mode = "plan" | "build";

/** Jenis risktool. Dipakai untuk penegakan mode dan perencanaan eksekusi. */
export type ToolRisk = "read" | "mutate";

/** Panggilan tool yang diminta model. `arguments` mentah (JSON string). */
export interface ToolCallRequest {
  id: string;
  name: string;
  /** JSON mentah dari model; divalidasi di eksekutor. */
  arguments: string;
}

/** Hasil satu tool call. Selalu ada tepat satu per ToolCallRequest. */
export interface ToolResult {
  callId: string;
  name: string;
  ok: boolean;
  /** Konten yang dikirim kembali ke model. */
  content: string;
  /** Ringkasan singkat untuk ditampilkan di layar. */
  summary?: string;
  /** True bila tool ditolak (mode Plan / pengguna menolak). */
  denied?: boolean;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const EMPTY_USAGE: TokenUsage = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

/** Pesan dalam format netral. Riwayat sesi disimpan dalam bentuk ini. */
export interface NeutralMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Hanya untuk role assistant: tool call yang diminta. */
  toolCalls?: ToolCallRequest[];
  /** Hanya untuk role tool: ID tool call yang dijawab. */
  toolCallId?: string;
  /** Hanya untuk role tool: nama tool. */
  name?: string;
}

export type StopReason =
  | "stop"
  | "max_steps"
  | "max_cost"
  | "repetition"
  | "interrupted"
  | "provider_error"
  | "invalid_tool_json";

/** Harga per satu juta token. Bila tidak diketahui, biarkan undefined. */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelInfo {
  id: string;
  name?: string;
  contextWindow?: number;
  pricing?: ModelPricing;
}
