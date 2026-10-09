import { addUsage, EMPTY_USAGE, type ModelPricing, type TokenUsage } from "../core/types.js";
import { cacheSavings, computeCost } from "./cost.js";

export interface ModelUsageEntry {
  provider: string;
  model: string;
  calls: number;
  usage: TokenUsage;
  /** Estimasi biaya; undefined bila tidak ada model yang punya harga. */
  cost: number;
  /** True bila setidaknya satu harga model diketahui. */
  costKnown: boolean;
  cacheSaved: number;
}

export interface UsageTotals {
  calls: number;
  usage: TokenUsage;
  cost: number;
  costKnown: boolean;
  cacheSaved: number;
}

/** Pelacak pemakaian per sesi, dipecah per provider/model. */
export class UsageTracker {
  private readonly entries = new Map<string, ModelUsageEntry>();

  record(provider: string, model: string, usage: TokenUsage, pricing?: ModelPricing): void {
    const key = `${provider}\u0000${model}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        provider,
        model,
        calls: 0,
        usage: { ...EMPTY_USAGE },
        cost: 0,
        costKnown: false,
        cacheSaved: 0,
      };
      this.entries.set(key, entry);
    }
    entry.calls += 1;
    entry.usage = addUsage(entry.usage, usage);
    const cost = computeCost(usage, pricing);
    if (cost !== undefined) {
      entry.cost += cost;
      entry.costKnown = true;
    }
    const saved = cacheSavings(usage, pricing);
    if (saved !== undefined) entry.cacheSaved += saved;
  }

  totals(): UsageTotals {
    let usage: TokenUsage = { ...EMPTY_USAGE };
    let calls = 0;
    let cost = 0;
    let costKnown = false;
    let cacheSaved = 0;
    for (const entry of this.entries.values()) {
      usage = addUsage(usage, entry.usage);
      calls += entry.calls;
      cost += entry.cost;
      costKnown = costKnown || entry.costKnown;
      cacheSaved += entry.cacheSaved;
    }
    return { calls, usage, cost, costKnown, cacheSaved };
  }

  perModel(): ModelUsageEntry[] {
    return [...this.entries.values()].sort((a, b) => b.cost - a.cost || b.calls - a.calls);
  }

  reset(): void {
    this.entries.clear();
  }
}
