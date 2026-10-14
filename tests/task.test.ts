import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createHarness, type Script } from "./helpers/harness.js";
import { ToolRegistry, forkRegistry } from "../src/tools/registry.js";
import { taskTool } from "../src/tools/task.js";
import { trimSummary } from "../src/core/task.js";

describe("task: risk dinamis & registri anak", () => {
  it("riskFor menilai readOnly:true sebagai read", () => {
    expect(taskTool.riskFor?.({ prompt: "x", readOnly: true })).toBe("read");
    expect(taskTool.riskFor?.({ prompt: "x" })).toBe("mutate");
    expect(taskTool.risk === "mutate").toBe(true);
  });

  it("sesi anak tidak punya tool task (kedalaman 1)", () => {
    const reg = new ToolRegistry();
    const child = forkRegistry(reg, false);
    expect(child.has("task")).toBe(false);
    expect(child.has("read_file")).toBe(true);
    expect(child.has("write_file")).toBe(true);
  });

  it("sesi anak readOnly hanya memasang tool baca", () => {
    const reg = new ToolRegistry();
    const child = forkRegistry(reg, true);
    expect(child.has("read_file")).toBe(true);
    expect(child.has("grep")).toBe(true);
    expect(child.has("write_file")).toBe(false);
    expect(child.has("run_shell")).toBe(false);
  });

  it("tool task tetap terlihat di spesifikasi mode Plan (bisa read-only)", () => {
    const specs = new ToolRegistry().specs("plan");
    const names = specs.map((s) => s.name);
    expect(names).toContain("task");
    expect(names).not.toContain("write_file");
  });
});

describe("trimSummary", () => {
  it("tidak memotong teks pendek", () => {
    expect(trimSummary("pendek")).toBe("pendek");
  });

  it("memotong dan menandai teks panjang", () => {
    const out = trimSummary("a".repeat(5000));
    expect(out.length).toBeLessThan(5000);
    expect(out).toContain("…");
    expect(out).toContain("[ringkasan dipotong");
  });
});

describe("runSubagent (via tool task)", () => {
  it("sesi anak menjalankan tool baca dan mengembalikan ringkasan ke induk", async () => {
    const script: Script = (turn) => {
      if (turn === 0) {
        return {
          text: "delegasikan bagus",
          toolCalls: [{ name: "task", arguments: JSON.stringify({ prompt: "Ringkas a.txt", maxSteps: 4 }) }],
        };
      }
      if (turn === 1) {
        return { text: "membaca", toolCalls: [{ name: "read_file", arguments: '{"path":"a.txt"}' }] };
      }
      if (turn === 2) {
        return { text: "Ringkasan: ini isi a.txt." };
      }
      return { text: "parent lanjut" };
    };
    const h = await createHarness({ script });
    await fs.writeFile(path.join(h.workspaceRoot, "a.txt"), "halo dunia");
    try {
      const result = await h.run("Kerjakan");
      expect(result.stopReason).toBe("stop");

      const taskResult = h.session.getHistory().find((m) => m.role === "tool" && m.name === "task");
      expect(taskResult?.content).toContain("Ringkasan: ini isi a.txt.");

      // Pemakaian anak digabung ke tracker induk: 2 giliran induk + 2 giliran anak.
      expect(h.tracker.totals().calls).toBe(4);
      expect(h.tracker.perModel()[0]!.model).toBe("fake-model");
    } finally {
      await h.cleanup();
    }
  });

  it("mode Plan menolak task tanpa readOnly", async () => {
    const script: Script = (turn) =>
      turn === 0
        ? {
            text: "coba delegasi",
            toolCalls: [{ name: "task", arguments: '{"prompt":"x"}' }],
          }
        : { text: "selesai" };
    const h = await createHarness({ script, mode: "plan" });
    try {
      const result = await h.run("tugas");
      expect(result.stopReason).toBe("stop");
      const taskResult = h.session.getHistory().find((m) => m.role === "tool" && m.name === "task");
      expect(taskResult?.content).toContain('tidak diizinkan di mode Plan');
      expect(taskResult?.content).toContain('"task"');
    } finally {
      await h.cleanup();
    }
  });

  it("mode Plan mengizinkan task readOnly dan anak hanya memakai tool baca", async () => {
    const script: Script = (turn) => {
      if (turn === 0) {
        return {
          text: "eksplorasi",
          toolCalls: [
            { name: "task", arguments: JSON.stringify({ prompt: "Ringkas", readOnly: true, maxSteps: 3 }) },
          ],
        };
      }
      if (turn === 1) {
        return { text: "membaca", toolCalls: [{ name: "read_file", arguments: '{"path":"a.txt"}' }] };
      }
      if (turn === 2) {
        return { text: "Ringkasan: R." };
      }
      return { text: "parent" };
    };
    const h = await createHarness({ script, mode: "plan" });
    await fs.writeFile(path.join(h.workspaceRoot, "a.txt"), "halo");
    try {
      const result = await h.run("tugas");
      expect(result.stopReason).toBe("stop");
      const taskResult = h.session.getHistory().find((m) => m.role === "tool" && m.name === "task");
      expect(taskResult?.content).toContain("Ringkasan: R.");
      expect(taskResult?.content).not.toContain("tidak diizinkan");
    } finally {
      await h.cleanup();
    }
  });

  it("anak autonomous: tulis di luar workspace ditolak (tanpa prompt)", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "nex-task-out-"));
    const evil = path.join(outsideDir, "evil.txt");
    const script: Script = (turn) => {
      if (turn === 0) {
        return {
          text: "delegasikan",
          toolCalls: [
            { name: "task", arguments: JSON.stringify({ prompt: "Tulis di luar", maxSteps: 4 }) },
          ],
        };
      }
      if (turn === 1) {
        return {
          text: "menulis",
          toolCalls: [{ name: "write_file", arguments: JSON.stringify({ path: evil, content: "x" }) }],
        };
      }
      if (turn === 2) {
        return { text: "Subagent selesai." };
      }
      return { text: "parent" };
    };
    const h = await createHarness({ script });
    try {
      const result = await h.run("tugas");
      expect(result.stopReason).toBe("stop");
      const taskResult = h.session.getHistory().find((m) => m.role === "tool" && m.name === "task");
      expect(taskResult?.content).toContain("Subagent selesai.");
      // File di luar workspace tidak pernah dibuat.
      await expect(fs.stat(evil)).rejects.toThrow();
    } finally {
      await h.cleanup();
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});