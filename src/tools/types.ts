import type { z } from "zod";
import type { Logger } from "../logging/logger.js";
import type { AccessKind, ConfirmDecision, ConfirmRequest, SensitiveAccessRequest } from "../core/io.js";
import type { Mode, ToolRisk } from "../core/types.js";
import type { TodoItem, TodoStore } from "../core/todos.js";
import type { PermissionManager } from "../safety/permissions.js";
import type { Workspace } from "../safety/workspace.js";

/** Hasil eksekusi tool yang dikembalikan ke loop. */
export interface ToolExecResult {
  /** Konten untuk model. */
  content: string;
  /** Ringkasan singkat untuk layar. */
  summary?: string;
  /** Default true. Bila false, dianggap error yang dikembalikan ke model. */
  ok?: boolean;
  /** Daftar tugas terbaru; loop akan merender checklist-nya. */
  todos?: TodoItem[];
}

export interface ResolvedPath {
  /** Path absolut yang sudah disetujui. */
  abs: string;
  /** Path relatif workspace untuk tampilan. */
  display: string;
  outside: boolean;
}

export type WebSearchFn = (
  query: string,
  signal: AbortSignal,
) => Promise<Array<{ title: string; url: string; snippet?: string }>>;

export interface ToolContext {
  workspace: Workspace;
  permissions: PermissionManager;
  mode: Mode;
  signal: AbortSignal;
  logger: Logger;
  /** Daftar tugas sesi; tool todo_write memutakhirkannya. */
  todos: TodoStore;
  /** Fungsi pencarian web opsional (dikonfigurasi di CLI). */
  search?: WebSearchFn;
  /** Selesaikan dan cek izin akses path; melempar ToolDeniedError bila ditolak. */
  resolvePath(raw: string, access: AccessKind): Promise<ResolvedPath>;
  /** Minta persetujuan; `allowAll` mengizinkan opsi "setujui semua". */
  confirm(req: ConfirmRequest, opts?: { allowAll?: boolean }): Promise<ConfirmDecision>;
  /** Konfirmasi file sensitif; tidak bisa dilewati allow-all. */
  confirmSensitive(req: SensitiveAccessRequest): Promise<boolean>;
}

export interface ToolDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  risk: ToolRisk;
  schema: S;
  /**
   * Tool kontrol tidak ditampilkan sebagai "langkah" di layar; efeknya
   * dirender lewat hasilnya sendiri (mis. todo_write menggambar checklist).
   */
  control?: boolean;
  execute(input: z.infer<S>, ctx: ToolContext): Promise<ToolExecResult>;
  /**
   * Path file yang akan dimutasi tool ini (untuk checkpoint sebelum eksekusi).
   * Dikembalikan dalam bentuk mentah (belum diresolusi).
   */
  mutatedPaths?(input: z.infer<S>): string[];
  /** Ringkasan argumen untuk ditampilkan di layar. */
  summarize?(input: z.infer<S>): string;
}
