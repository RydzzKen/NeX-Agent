import type { NeutralMessage } from "./types.js";

/** F-13: hasil tool di atas ambang ini dipangkas dengan penanda. */
export const MAX_TOOL_RESULT_CHARS = 20_000;

/** Estimasi token kasar: ~4 karakter per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Pangkas hasil tool yang terlalu panjang dengan penanda. */
export function trimToolResult(content: string, max = MAX_TOOL_RESULT_CHARS): string {
  if (content.length <= max) return content;
  const kept = content.slice(0, max);
  const dropped = content.length - max;
  return `${kept}\n... [dipangkas ${dropped} karakter; batas ${max}]`;
}

export interface ContextReport {
  usedTokens: number;
  windowTokens?: number;
  percent?: number;
  warn: boolean;
}

/** Pengelolaan konteks (F-13, P0 dasar). */
export class ContextManager {
  constructor(
    private readonly contextWindow?: number,
    private readonly warnAt = 0.85,
  ) {}

  estimate(messages: NeutralMessage[]): number {
    let total = 0;
    for (const message of messages) {
      total += estimateTokens(message.content);
      if (message.toolCalls) {
        for (const call of message.toolCalls) {
          total += estimateTokens(call.name) + estimateTokens(call.arguments);
        }
      }
      total += 4;
    }
    return total;
  }

  measure(messages: NeutralMessage[]): ContextReport {
    const usedTokens = this.estimate(messages);
    if (!this.contextWindow) return { usedTokens, warn: false };
    const percent = usedTokens / this.contextWindow;
    return { usedTokens, windowTokens: this.contextWindow, percent, warn: percent >= this.warnAt };
  }
}
