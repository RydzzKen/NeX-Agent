import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_VERSION } from "../src/version.js";

describe("APP_VERSION", () => {
  it("sama dengan versi package.json", async () => {
    const raw = await fs.readFile(path.join(process.cwd(), "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    expect(APP_VERSION).toBe(pkg.version);
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
