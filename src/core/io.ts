import type { Mode, StopReason } from "./types.js";
import type { TodoItem } from "./todos.js";

/** Ringkasan satu langkah tool untuk ditampilkan. */
export interface StepInfo {
  index: number;
  total: number;
  name: string;
  argsSummary: string;
  risk: "read" | "mutate";
}

export interface StepOutcome {
  status: "ok" | "error" | "denied";
  durationMs: number;
  summary?: string;
  /** Output tool untuk ditampilkan UI (opsional; bisa dipotong per renderer). */
  output?: string;
}

export type AccessKind = "read" | "write";

/** Pertanyaan konfirmasi generik. */
export interface ConfirmRequest {
  kind: "shell" | "write" | "read" | "cost" | "exit" | "mcp";
  title: string;
  detail: string;
  /** Diff berwarna (sudah di-render) bila relevan. */
  diff?: string;
  /** Apakah aksi ini menimbulkan efek samping yang tidak bisa di-undo. */
  irreversible?: boolean;
}

export type ConfirmDecision = "yes" | "no" | "all";

export interface PathAccessRequest {
  path: string;
  access: AccessKind;
  outsideWorkspace: boolean;
  reason?: string;
}

/** Permintaan konfirmasi untuk file/perintah yang menyentuh rahasia. */
export interface SensitiveAccessRequest {
  kind: "path" | "shell";
  /** Path absolut atau perintah shell yang menyentuh file sensitif. */
  detail: string;
  access?: AccessKind;
  outsideWorkspace?: boolean;
  reason: string;
}

/**
 * Permintaan rahasia sesaat (mis. password sudo atau password SSH). Rahasia
 * hanya dipakai sekali pakai, tidak boleh disimpan ke file, log, atau
 * lingkungan (`env`).
 */
export interface SecretRequest {
  kind: "sudo" | "ssh";
  /** Perintah yang membutuhkan rahasia (ditampilkan ke pengguna). */
  detail: string;
  /** Penjelasan singkat kenapa rahasia dibutuhkan. */
  reason: string;
}

/**
 * Abstraksi interaksi pengguna. `core/` hanya berbicara lewat interface ini;
 * implementasi konkret ada di `cli/`.
 */
export interface AgentIO {
  /** Teks jawaban final model (streaming). */
  text(chunk: string): void;
  /**
   * Akhir potongan teks satu giliran model (untuk flush/render).
   * Boleh mengembalikan Promise bila renderer masih menganimasikan antrean
   * (mis. efek mengetik); loop menunggunya sebelum lanjut ke langkah berikut.
   */
  textEnd?(): void | Promise<void>;
  /** Potongan thinking model (streaming). */
  thinking(chunk: string): void;
  thinkingEnd(): void;

  stepStart(info: StepInfo): void;
  stepEnd(info: StepInfo, outcome: StepOutcome): void;

  /** Tampilkan diff berwarna. */
  diff(text: string): void;

  /** Render ulang daftar tugas (checklist) — update live. */
  todos?(items: TodoItem[]): void;

  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;

  /** Ringkasan saat loop berhenti bukan karena sukses. */
  summary(reason: StopReason, message: string): void;

  /** Minta persetujuan aksi. */
  confirm(req: ConfirmRequest): Promise<ConfirmDecision>;

  /** Minta izin akses path di luar workspace. */
  requestPathAccess(req: PathAccessRequest): Promise<boolean>;

  /**
   * Konfirmasi khusus file sensitif (.env, kredensial, private key). Tidak
   * bisa dilewati oleh allow-all/--yes; hanya prompt interaktif eksplisit.
   */
  requestSensitiveAccess?(req: SensitiveAccessRequest): Promise<boolean>;

  /**
   * Minta rahasia sesaat (mis. password sudo atau password SSH). Mengembalikan
   * `null` bila pengguna membatalkan atau UI tidak mendukung input rahasia.
   * Nilai ini tidak boleh disimpan/di-log oleh pemanggil.
   */
  requestSecret?(req: SecretRequest): Promise<string | null>;

  /** Mode saat ini berubah. */
  modeChanged?(mode: Mode): void;

  /**
   * Indikator agen mulai/selesai bekerja, dipakai UI untuk spinner/status.
   * Opsional; dipanggil lapisan UI mengelilingi satu giliran `run`.
   */
  busy?(on: boolean): void;

  /**
   * Sebuah lapisan kerja yang lebih dalam (mis. subagent `task`) mulai
   * berjalan. UI dapat membuka buffer/view terpisah untuknya.
   */
  subtaskStart?(label: string): void;

  /** Lapisan kerja yang lebih dalam selesai. */
  subtaskEnd?(): void;
}

/** IO diam untuk tes dan mode non-interaktif tanpa `--yes`. */
export function silentIO(decisions: ConfirmDecision = "no"): AgentIO {
  return {
    text: () => {},
    textEnd: () => {},
    thinking: () => {},
    thinkingEnd: () => {},
    stepStart: () => {},
    stepEnd: () => {},
    diff: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    summary: () => {},
    confirm: async () => decisions,
    requestPathAccess: async () => decisions === "yes" || decisions === "all",
    requestSensitiveAccess: async () => decisions === "yes" || decisions === "all",
    requestSecret: async () => null,
  };
}
