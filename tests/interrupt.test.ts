import { describe, expect, it } from "vitest";
import { resolveInterrupt, type InterruptState } from "../src/cli/interrupt.js";

function state(patch: Partial<InterruptState> = {}): InterruptState {
  return { running: false, aborting: false, exitArmed: false, ...patch };
}

describe("resolveInterrupt", () => {
  it("menekan pertama saat tugas berjalan → hentikan tugas", () => {
    expect(resolveInterrupt(state({ running: true }))).toBe("abort");
  });

  it("menekan saat tugas sudah diminta berhenti → paksa keluar", () => {
    expect(resolveInterrupt(state({ running: true, aborting: true }))).toBe("force-exit");
  });

  it("menekan saat menganggur → minta konfirmasi keluar", () => {
    expect(resolveInterrupt(state({ exitArmed: false }))).toBe("arm-exit");
  });

  it("menekan kedua saat menganggur → keluar", () => {
    expect(resolveInterrupt(state({ exitArmed: true }))).toBe("exit");
  });

  it("mengabaikan exitArmed selama tugas berjalan", () => {
    expect(resolveInterrupt(state({ running: true, exitArmed: true }))).toBe("abort");
  });
});
