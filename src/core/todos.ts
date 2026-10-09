export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

export interface TodoCounts {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  cancelled: number;
}

export interface TodoInput {
  content: string;
  status?: TodoStatus;
}

/**
 * Daftar tugas (todo) milik satu sesi. Model memanggil tool `todo_write`
 * dengan daftar lengkap; store menggantinya utuh.
 */
export class TodoStore {
  private items: TodoItem[] = [];
  private counter = 0;

  constructor(initial: TodoItem[] = []) {
    this.items = initial.map((item) => ({ ...item }));
    // Mulai dari suffix id terbesar agar id baru tidak bertabrakan saat resume.
    this.counter = this.items.reduce((max, item) => {
      const match = /^todo_(\d+)$/.exec(item.id);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
  }

  /** Ganti seluruh daftar. Status default "pending". */
  replace(inputs: TodoInput[]): TodoItem[] {
    this.items = inputs.map((input) => ({
      id: `todo_${++this.counter}`,
      content: input.content,
      status: input.status ?? "pending",
    }));
    return this.list();
  }

  setStatus(id: string, status: TodoStatus): boolean {
    const item = this.items.find((t) => t.id === id);
    if (!item) return false;
    item.status = status;
    return true;
  }

  list(): TodoItem[] {
    return this.items.map((item) => ({ ...item }));
  }

  clear(): void {
    this.items = [];
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  counts(): TodoCounts {
    const counts: TodoCounts = {
      total: this.items.length,
      pending: 0,
      inProgress: 0,
      completed: 0,
      cancelled: 0,
    };
    for (const item of this.items) {
      if (item.status === "pending") counts.pending++;
      else if (item.status === "in_progress") counts.inProgress++;
      else if (item.status === "completed") counts.completed++;
      else counts.cancelled++;
    }
    return counts;
  }
}
