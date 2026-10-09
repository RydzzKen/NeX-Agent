import type { ModelPricing, TokenUsage } from "../core/types.js";

const PER_MILLION = 1_000_000;

/**
 * Hitung biaya estimasi (USD) dari pemakaian token.
 * Mengembalikan undefined bila harga model tidak diketahui.
 */
export function computeCost(usage: TokenUsage, pricing?: ModelPricing): number | undefined {
  if (!pricing) return undefined;
  const input = (usage.input / PER_MILLION) * pricing.input;
  const output = (usage.output / PER_MILLION) * pricing.output;
  const cacheRead = (usage.cacheRead / PER_MILLION) * (pricing.cacheRead ?? pricing.input);
  const cacheWrite = (usage.cacheWrite / PER_MILLION) * (pricing.cacheWrite ?? pricing.input);
  const total = input + output + cacheRead + cacheWrite;
  return Number.isFinite(total) ? total : undefined;
}

/** Biaya yang ditabung berkat cache read (dibanding harga input penuh). */
export function cacheSavings(usage: TokenUsage, pricing?: ModelPricing): number | undefined {
  if (!pricing) return undefined;
  const full = (usage.cacheRead / PER_MILLION) * pricing.input;
  const cached = (usage.cacheRead / PER_MILLION) * (pricing.cacheRead ?? pricing.input);
  return full - cached;
}

export function formatUsd(amount: number, digits = 4): string {
  return `$${amount.toFixed(digits)}`;
}

export function formatUsdEstimate(amount: number): string {
  return `~$${amount.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}
