import type { TodoItem } from "../core/todos.js";
import { color } from "./color.js";

const CHECKBOX: Record<TodoItem["status"], string> = {
  pending: "[ ]",
  in_progress: "[>]",
  completed: "[x]",
  cancelled: "[-]",
};

function style(item: TodoItem): string {
  switch (item.status) {
    case "pending":
      return `${color.gray("[ ]")} ${item.content}`;
    case "in_progress":
      return `${color.yellow("[>]")} ${item.content}`;
    case "completed":
      return `${color.green("[x]")} ${color.dim(item.content)}`;
    case "cancelled":
      return `${color.gray("[-]")} ${color.dim(item.content)}`;
  }
}

/** Baris checklist tanpa warna (untuk tes dan JSON). */
export function plainTodoLines(items: TodoItem[]): string[] {
  return items.map((item) => `${CHECKBOX[item.status]} ${item.content}`);
}

/** Baris checklist berwarna untuk terminal. */
export function todoLines(items: TodoItem[]): string[] {
  return items.map(style);
}

export function todoHeader(items: TodoItem[]): string {
  const total = items.length;
  const done = items.filter((t) => t.status === "completed").length;
  return total === 0 ? "Tugas:" : `Tugas: ${done}/${total}`;
}