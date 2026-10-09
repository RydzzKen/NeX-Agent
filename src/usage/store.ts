import fs from "node:fs/promises";
import path from "node:path";
import { addUsage, EMPTY_USAGE, type TokenUsage } from "../core/types.js";

export interface UsageEvent {
  ts: string;
  sessionId: string;
  provider: string;
  model: string;
  usage: TokenUsage;
  cost: number;
  costKnown: boolean;
}

export interface CrossSessionSummary {
  totals: { calls: number; usage: TokenUsage; cost: number; costKnown: boolean };
  perModel: Array<{ provider: string; model: string; calls: number; usage: TokenUsage; cost: number }>;
}

export type UsageRange = "today" | "week" | "all";

function rangeStart(range: UsageRange, now: Date): number {
  if (range === "all") return 0;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (range === "week") start.setDate(start.getDate() - 6);
  return start.getTime();
}

/** Penyimpanan pemakaian lintas sesi (JSONL) untuk `/usage today|week|all`. */
export class UsageStore {
  constructor(private readonly filePath: string) {}

  async append(event: UsageEvent): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, JSON.stringify(event) + "\n", "utf8");
  }

  async readAll(): Promise<UsageEvent[]> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const events: UsageEvent[] = [];
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          events.push(JSON.parse(trimmed) as UsageEvent);
        } catch {
          // baris rusak diabaikan
        }
      }
      return events;
    } catch {
      return [];
    }
  }

  async aggregate(range: UsageRange = "all", now: Date = new Date()): Promise<CrossSessionSummary> {
    const start = rangeStart(range, now);
    const events = (await this.readAll()).filter((e) => new Date(e.ts).getTime() >= start);

    const perModelMap = new Map<string, { provider: string; model: string; calls: number; usage: TokenUsage; cost: number }>();
    let usage: TokenUsage = { ...EMPTY_USAGE };
    let calls = 0;
    let cost = 0;
    let costKnown = false;

    for (const e of events) {
      const key = `${e.provider}\u0000${e.model}`;
      let entry = perModelMap.get(key);
      if (!entry) {
        entry = { provider: e.provider, model: e.model, calls: 0, usage: { ...EMPTY_USAGE }, cost: 0 };
        perModelMap.set(key, entry);
      }
      entry.calls += 1;
      entry.usage = addUsage(entry.usage, e.usage);
      entry.cost += e.cost;
      usage = addUsage(usage, e.usage);
      calls += 1;
      cost += e.cost;
      costKnown = costKnown || e.costKnown;
    }

    return {
      totals: { calls, usage, cost, costKnown },
      perModel: [...perModelMap.values()].sort((a, b) => b.cost - a.cost || b.calls - a.calls),
    };
  }
}
