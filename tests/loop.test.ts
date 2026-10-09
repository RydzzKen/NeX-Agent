import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createHarness } from "./helpers/harness.js";
import { ToolRegistry, type AnyTool } from "../src/tools/registry.js";

function readCall(path: string, id?: string) {
  return { ...(id ? { id } : {}), name: "read_file", arguments: JSON.stringify({ path }) };
}

describe("loop agentik (kriteria penerimaan)", () => {
  it("berhenti tepat di batas langkah dengan model palsu", async () => {
    const harness = await createHarness({
      maxSteps: 3,
      script: (turn) => ({ toolCalls: [readCall(`f${turn}.txt`)] }),
    });
    try {
      const result = await harness.run();
      expect(result.stopReason).toBe("max_steps");
      expect(harness.provider.calls).toBe(3); // berhenti sebelum langkah ke-4
    } finally {
      await harness.cleanup();
    }
  });

  it("tiga tool call menghasilkan tiga hasil dengan ID cocok, termasuk satu ditolak", async () => {
    const harness = await createHarness({
      mode: "plan",
      script: [
        {
          toolCalls: [
            { id: "c1", name: "read_file", arguments: JSON.stringify({ path: "hello.txt" }) },
            { id: "c2", name: "list_dir", arguments: JSON.stringify({ path: "." }) },
            { id: "c3", name: "write_file", arguments: JSON.stringify({ path: "x.txt", content: "hi" }) },
          ],
        },
        { text: "selesai" },
      ],
    });
    try {
      await fs.writeFile(path.join(harness.workspaceRoot, "hello.txt"), "hi\n");
      await harness.run();

      const toolMessages = harness.session.getHistory().filter((m) => m.role === "tool");
      expect(toolMessages).toHaveLength(3);
      expect(toolMessages.map((m) => m.toolCallId)).toEqual(["c1", "c2", "c3"]);

      const denied = toolMessages.find((m) => m.toolCallId === "c3");
      expect(denied?.content).toContain("Ditolak");
      const ok = toolMessages.find((m) => m.toolCallId === "c1");
      expect(ok?.content).toContain("hi");
    } finally {
      await harness.cleanup();
    }
  });

  it("menjalankan tool read-only paralel dan mutating berurutan", async () => {
    const events: string[] = [];
    function tool(name: string, risk: "read" | "mutate"): AnyTool {
      return {
        name,
        description: name,
        risk,
        schema: z.object({}),
        summarize: () => name,
        execute: async () => {
          events.push(`start:${name}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
          events.push(`end:${name}`);
          return { content: `${name} ok` };
        },
      };
    }
    const registry = new ToolRegistry([
      tool("readA", "read"),
      tool("readB", "read"),
      tool("mutC", "mutate"),
      tool("mutD", "mutate"),
    ]);
    const harness = await createHarness({
      registry,
      script: [
        {
          toolCalls: [
            { id: "r1", name: "readA", arguments: "{}" },
            { id: "r2", name: "readB", arguments: "{}" },
          ],
        },
        {
          toolCalls: [
            { id: "m1", name: "mutC", arguments: "{}" },
            { id: "m2", name: "mutD", arguments: "{}" },
          ],
        },
        { text: "selesai" },
      ],
    });
    try {
      await harness.run();
      expect(events.slice(0, 2)).toEqual(["start:readA", "start:readB"]);
      expect(events.slice(4)).toEqual(["start:mutC", "end:mutC", "start:mutD", "end:mutD"]);
    } finally {
      await harness.cleanup();
    }
  });

  it("JSON tool call rusak dua kali berturut-turut menghentikan loop dengan ringkasan", async () => {
    const harness = await createHarness({
      script: [
        { toolCalls: [{ id: "b1", name: "read_file", arguments: "{rusak" }] },
        { toolCalls: [{ id: "b2", name: "read_file", arguments: "{rusak lagi" }] },
      ],
    });
    try {
      const result = await harness.run();
      expect(result.stopReason).toBe("invalid_tool_json");
      expect(result.message).toBeTruthy();
      const toolMessages = harness.session.getHistory().filter((m) => m.role === "tool");
      expect(toolMessages).toHaveLength(2);
    } finally {
      await harness.cleanup();
    }
  });

  it("menghentikan loop saat model mengulang panggilan identik ketiga kali", async () => {
    const harness = await createHarness({
      script: () => ({ toolCalls: [readCall("same.txt")] }),
    });
    try {
      const result = await harness.run();
      expect(result.stopReason).toBe("repetition");
      expect(result.steps).toBe(3);
    } finally {
      await harness.cleanup();
    }
  });

  it("menolak tool mutating di mode Plan walau dipaksa model", async () => {
    const harness = await createHarness({
      mode: "plan",
      script: [
        { toolCalls: [{ id: "w1", name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: "x" }) }] },
        { text: "menyerah" },
      ],
    });
    try {
      const result = await harness.run();
      expect(result.stopReason).toBe("stop");
      const tool = harness.session.getHistory().find((m) => m.role === "tool");
      expect(tool?.content).toContain("mode Plan");
      await expect(fs.readFile(path.join(harness.workspaceRoot, "a.txt"), "utf8")).rejects.toThrow();
    } finally {
      await harness.cleanup();
    }
  });

  it("edit tiga file lalu undo mengembalikan ketiganya persis", async () => {
    const files = ["a.ts", "b.ts", "c.ts"];
    const harness = await createHarness({
      script: [
        {
          toolCalls: files.map((f, i) => ({
            id: `e${i}`,
            name: "edit_file",
            arguments: JSON.stringify({ path: f, oldString: "B", newString: "B_diubah" }),
          })),
        },
        { text: "selesai" },
      ],
    });
    try {
      for (const f of files) {
        await fs.writeFile(path.join(harness.workspaceRoot, f), "A\nB\nC\n", "utf8");
      }
      await harness.run();
      for (const f of files) {
        expect(await fs.readFile(path.join(harness.workspaceRoot, f), "utf8")).toContain("B_diubah");
      }

      const undo = await harness.checkpoints.undoLast(harness.workspaceRoot);
      expect(undo.entries).toHaveLength(3);
      for (const f of files) {
        expect(await fs.readFile(path.join(harness.workspaceRoot, f), "utf8")).toBe("A\nB\nC\n");
      }
    } finally {
      await harness.cleanup();
    }
  });

  it("berhenti dan melapor saat anggaran biaya tercapai", async () => {
    const harness = await createHarness({
      maxCost: 0.000001,
      script: (turn) => ({ toolCalls: [readCall(`g${turn}.txt`)] }),
    });
    try {
      const result = await harness.run();
      expect(result.stopReason).toBe("max_cost");
      expect(result.message).toContain("Anggaran");
    } finally {
      await harness.cleanup();
    }
  });

  it("menandai tool call yang terputus sebagai dibatalkan", async () => {
    const controller = new AbortController();
    const harness = await createHarness({
      script: [
        {
          toolCalls: [
            { id: "k1", name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) },
            { id: "k2", name: "read_file", arguments: JSON.stringify({ path: "b.txt" }) },
          ],
        },
      ],
    });
    try {
      await fs.writeFile(path.join(harness.workspaceRoot, "a.txt"), "a");
      await fs.writeFile(path.join(harness.workspaceRoot, "b.txt"), "b");
      controller.abort();
      const result = await harness.run("tugas", controller.signal);
      expect(result.stopReason).toBe("interrupted");
    } finally {
      await harness.cleanup();
    }
  });

  it("membiarkan model membuat dan memperbarui daftar tugas via todo_write", async () => {
    const harness = await createHarness({
      script: [
        {
          toolCalls: [
            {
              id: "t1",
              name: "todo_write",
              arguments: JSON.stringify({
                todos: [
                  { content: "Tahap 1: baca file" },
                  { content: "Tahap 2: ubah file" },
                ],
              }),
            },
          ],
        },
        {
          toolCalls: [
            {
              id: "t2",
              name: "todo_write",
              arguments: JSON.stringify({
                todos: [
                  { content: "Tahap 1: baca file", status: "completed" },
                  { content: "Tahap 2: ubah file", status: "in_progress" },
                ],
              }),
            },
          ],
        },
        { text: "selesai" },
      ],
    });
    try {
      await harness.run();
      const todos = harness.session.getTodos();
      expect(todos).toHaveLength(2);
      expect(todos[0]!.status).toBe("completed");
      expect(todos[1]!.status).toBe("in_progress");

      const toolMessages = harness.session.getHistory().filter((m) => m.role === "tool");
      expect(toolMessages.every((m) => !m.content.startsWith("Ditolak"))).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });

  it("mengizinkan todo_write di mode Plan (read-only)", async () => {
    const harness = await createHarness({
      mode: "plan",
      script: [
        {
          toolCalls: [
            {
              id: "t1",
              name: "todo_write",
              arguments: JSON.stringify({ todos: [{ content: "Rencana" }] }),
            },
          ],
        },
        { text: "oke" },
      ],
    });
    try {
      await harness.run();
      expect(harness.session.getTodos()).toHaveLength(1);
      const tool = harness.session.getHistory().find((m) => m.role === "tool");
      expect(tool?.content).not.toContain("Ditolak");
    } finally {
      await harness.cleanup();
    }
  });
});
