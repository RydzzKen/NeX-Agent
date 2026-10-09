import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsageStore } from "../src/usage/store.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nex-usage-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function event(daysAgo: number, model = "m1") {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return {
    ts: date.toISOString(),
    sessionId: "s1",
    provider: "p",
    model,
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
    cost: 0.1,
    costKnown: true,
  };
}

describe("UsageStore", () => {
  it("menyimpan dan membaca kembali event", async () => {
    const store = new UsageStore(path.join(root, "usage.jsonl"));
    await store.append(event(0));
    await store.append(event(0));
    const events = await store.readAll();
    expect(events).toHaveLength(2);
  });

  it("mengagregasi per rentang waktu", async () => {
    const store = new UsageStore(path.join(root, "usage.jsonl"));
    await store.append(event(0));
    await store.append(event(2)); // minggu ini
    await store.append(event(10)); // lebih dari seminggu

    const today = await store.aggregate("today");
    expect(today.totals.calls).toBe(1);

    const week = await store.aggregate("week");
    expect(week.totals.calls).toBe(2);

    const all = await store.aggregate("all");
    expect(all.totals.calls).toBe(3);
    expect(all.totals.usage.input).toBe(300);
    expect(all.perModel[0]!.model).toBe("m1");
  });

  it("mengabaikan file yang tidak ada dan baris rusak", async () => {
    const store = new UsageStore(path.join(root, "missing.jsonl"));
    expect(await store.readAll()).toEqual([]);

    const file = path.join(root, "broken.jsonl");
    await fs.writeFile(file, "{bukan json}\n" + JSON.stringify(event(0)) + "\n", "utf8");
    const events = await new UsageStore(file).readAll();
    expect(events).toHaveLength(1);
  });
});
