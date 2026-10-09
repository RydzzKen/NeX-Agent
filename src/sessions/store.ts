import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Mode, NeutralMessage } from "../core/types.js";
import type { TodoItem } from "../core/todos.js";
import { sessionsDir } from "../config/config.js";

export interface SessionRecord {
  id: string;
  title: string;
  workspace: string;
  providerId: string;
  model: string;
  mode: Mode;
  createdAt: string;
  updatedAt: string;
  cost: number;
  history: NeutralMessage[];
  todos?: TodoItem[];
}

export function newSessionId(): string {
  return `ses_${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;
}

export function deriveTitle(firstUserMessage: string): string {
  const clean = firstUserMessage
    .replace(/```[\s\S]*?```/g, " ") // buang blok kode
    .replace(/`([^`]*)`/g, "$1") // inline code
    .replace(/[#>*_]+/g, " ") // markdown ringan
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "(kosong)";
  // Ambil kalimat pertama sebagai nama singkat yang mudah dibaca.
  const sentence = clean.split(/(?<=[.!?])\s/)[0] ?? clean;
  const title = sentence.length > 60 ? `${sentence.slice(0, 57).trimEnd()}...` : sentence;
  return title || "(kosong)";
}

/**
 * Pilih sesi dari daftar (urut seperti `/sessions`). Menerima nomor urut
 * ("1", "2", ...) atau id sesi. Mengembalikan `undefined` bila tidak cocok.
 */
export function selectSession(
  sessions: SessionRecord[],
  selector: string | undefined,
): SessionRecord | undefined {
  if (!selector) return undefined;
  const trimmed = selector.trim();
  const index = Number.parseInt(trimmed, 10);
  if (String(index) === trimmed && index >= 1) return sessions[index - 1];
  return sessions.find((s) => s.id === trimmed);
}

export class SessionStore {
  constructor(private readonly dir: string = sessionsDir()) {}

  private filePath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  async save(record: SessionRecord): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.filePath(record.id), JSON.stringify(record, null, 2), "utf8");
  }

  async load(id: string): Promise<SessionRecord | undefined> {
    try {
      const raw = await fs.readFile(this.filePath(id), "utf8");
      return JSON.parse(raw) as SessionRecord;
    } catch {
      return undefined;
    }
  }

  async list(): Promise<SessionRecord[]> {
    let files: string[];
    try {
      files = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const records: SessionRecord[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const record = await this.load(file.slice(0, -5));
      if (record) records.push(record);
    }
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async listForWorkspace(workspace: string): Promise<SessionRecord[]> {
    return (await this.list()).filter((r) => r.workspace === workspace);
  }

  async lastForWorkspace(workspace: string): Promise<SessionRecord | undefined> {
    return (await this.listForWorkspace(workspace))[0];
  }

  async delete(id: string): Promise<boolean> {
    try {
      await fs.unlink(this.filePath(id));
      return true;
    } catch {
      return false;
    }
  }
}
