import { describe, expect, it } from "vitest";
import { TodoStore, type TodoItem } from "../src/core/todos.js";
import { plainTodoLines, todoHeader } from "../src/util/todos.js";
import { TerminalIO } from "../src/cli/render.js";
import type { PrompterLike } from "../src/cli/prompt.js";
import { silentIO, type AgentIO, type StepInfo } from "../src/core/io.js";
import { createHarness } from "./helpers/harness.js";

/** IO yang merekam pemanggilan render checklist dan langkah tool. */
function recordingIO(): {
  io: AgentIO;
  todos: TodoItem[][];
  steps: string[];
} {
  const base = silentIO("yes");
  const todos: TodoItem[][] = [];
  const steps: string[] = [];
  const io: AgentIO = {
    ...base,
    stepStart: (info: StepInfo) => steps.push(`start:${info.name}`),
    stepEnd: (info: StepInfo) => steps.push(`end:${info.name}`),
    todos: (items) => todos.push(items),
  };
  return { io, todos, steps };
}

const stubPrompter: PrompterLike = {
  question: async () => "",
  close: () => {},
};

describe("TodoStore", () => {
  it("mengganti seluruh daftar dan memberi status default pending", () => {
    const store = new TodoStore();
    const items = store.replace([{ content: "Tahap 1" }, { content: "Tahap 2", status: "in_progress" }]);
    expect(items).toHaveLength(2);
    expect(items[0]!.status).toBe("pending");
    expect(items[1]!.status).toBe("in_progress");
    expect(items[0]!.id).not.toBe(items[1]!.id);
  });

  it("menghitung status dan memutakhirkan per id", () => {
    const store = new TodoStore();
    const items = store.replace([
      { content: "a", status: "completed" },
      { content: "b", status: "in_progress" },
      { content: "c" },
    ]);
    const counts = store.counts();
    expect(counts).toMatchObject({ total: 3, completed: 1, inProgress: 1, pending: 1 });

    expect(store.setStatus(items[2]!.id, "completed")).toBe(true);
    expect(store.setStatus("tidak-ada", "completed")).toBe(false);
    expect(store.counts().completed).toBe(2);
  });

  it("memulihkan daftar dari data awal (resume)", () => {
    const initial = [{ id: "todo_1", content: "lama", status: "pending" as const }];
    const store = new TodoStore(initial);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]!.content).toBe("lama");
    // ID baru melanjutkan dari suffix terbesar agar tidak bertabrakan.
    const added = store.replace([{ content: "baru" }]);
    expect(added[0]!.id).toBe("todo_2");
  });
});

describe("render todo", () => {
  it("menghasilkan baris checklist dengan kotak status", () => {
    const items = new TodoStore()
      .replace([
        { content: "Tahap 1", status: "completed" },
        { content: "Tahap 2", status: "in_progress" },
        { content: "Tahap 3" },
      ]);
    const lines = plainTodoLines(items);
    expect(lines[0]).toBe("[x] Tahap 1");
    expect(lines[1]).toBe("[>] Tahap 2");
    expect(lines[2]).toBe("[ ] Tahap 3");
    expect(todoHeader(items)).toBe("Tugas: 1/3");
  });

  it("meng-update checklist di tempat pada render berikutnya", () => {
    const writes: string[] = [];
    const io = new TerminalIO(stubPrompter, { thinking: false, json: false }, (s) => writes.push(s));
    const store = new TodoStore();

    const first = store.replace([{ content: "Tahap 1" }, { content: "Tahap 2" }]);
    io.todos?.(first);
    // Render pertama: tidak ada escape penghapus.
    expect(writes[0]).not.toContain("\u001b[");

    const second = store.replace([
      { content: "Tahap 1", status: "completed" },
      { content: "Tahap 2", status: "in_progress" },
    ]);
    io.todos?.(second);
    // Render berikutnya naik dan menghapus blok sebelumnya.
    expect(writes[1]).toContain("\u001b[3F");
    expect(writes[1]).toContain("\u001b[0J");
    expect(writes[1]).toContain("[x] Tahap 1");
    expect(writes[1]).toContain("[>] Tahap 2");
  });

  it("tidak menimpa checklist lama bila sudah ada output lain di antaranya", () => {
    const writes: string[] = [];
    const io = new TerminalIO(stubPrompter, { thinking: false, json: false }, (s) => writes.push(s));
    const store = new TodoStore();

    io.todos?.(store.replace([{ content: "Tahap 1" }]));
    io.info("output lain");
    io.todos?.(store.replace([{ content: "Tahap 1", status: "completed" }]));
    // Karena ada baris info, render kedua tidak memakai escape penghapus.
    expect(writes[2]).not.toContain("\u001b[");
  });
});

describe("loop merender todo via io", () => {
  it("memanggil io.todos dan tidak mencetak todo_write sebagai langkah", async () => {
    const { io, todos, steps } = recordingIO();
    const harness = await createHarness({
      io,
      script: [
        {
          toolCalls: [
            {
              id: "t1",
              name: "todo_write",
              arguments: JSON.stringify({ todos: [{ content: "Tahap 1" }] }),
            },
          ],
        },
        { text: "selesai" },
      ],
    });
    try {
      await harness.run();
    } finally {
      await harness.cleanup();
    }
    expect(todos).toHaveLength(1);
    expect(todos[0]).toHaveLength(1);
    expect(steps).not.toContain("start:todo_write");
    expect(steps).not.toContain("end:todo_write");
    expect(harness.session.getTodos()).toHaveLength(1);
  });
});
