import type {
  AgentIO,
  ConfirmDecision,
  ConfirmRequest,
  PathAccessRequest,
  SensitiveAccessRequest,
  StepInfo,
  StepOutcome,
} from "../core/io.js";
import type { Mode, StopReason } from "../core/types.js";
import type { TodoItem } from "../core/todos.js";
import type { ServerMessage } from "./protocol.js";

export type Sink = (message: ServerMessage) => void;

interface PendingPrompt {
  resolve(value: unknown): void;
}

/**
 * `AgentIO` yang meneruskan peristiwa ke klien web lewat `sink`.
 *
 * Konfirmasi tidak dijawab langsung: sebuah permintaan diberi id, dikirim ke
 * klien, lalu `resolve(id, ...)` dipanggil saat klien membalas. Bila klien
 * terputus, `cancelAll()` menolak semua permintaan yang menggantung agar loop
 * tidak macet.
 */
export class WebIO implements AgentIO {
  private readonly pending = new Map<string, PendingPrompt>();
  private counter = 0;

  constructor(private readonly sink: Sink) {}

  /** Kirim pesan server sewenang-wenang (dipakai WebApp untuk state/busy). */
  emit(message: ServerMessage): void {
    this.sink(message);
  }

  private nextId(): string {
    this.counter += 1;
    return `req_${this.counter}_${Date.now().toString(36)}`;
  }

  private ask<T>(id: string, message: ServerMessage): Promise<T> {
    return new Promise<T>((resolve) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void });
      this.sink(message);
    });
  }

  text(chunk: string): void {
    this.sink({ type: "text", chunk });
  }

  textEnd(): void {
    this.sink({ type: "textEnd" });
  }

  thinking(chunk: string): void {
    this.sink({ type: "thinking", chunk });
  }

  thinkingEnd(): void {
    this.sink({ type: "thinkingEnd" });
  }

  stepStart(info: StepInfo): void {
    this.sink({ type: "stepStart", info });
  }

  stepEnd(info: StepInfo, outcome: StepOutcome): void {
    this.sink({ type: "stepEnd", info, outcome });
  }

  diff(text: string): void {
    this.sink({ type: "diff", text });
  }

  todos(items: TodoItem[]): void {
    this.sink({ type: "todos", items });
  }

  info(message: string): void {
    this.sink({ type: "info", message });
  }

  warn(message: string): void {
    this.sink({ type: "warn", message });
  }

  error(message: string): void {
    this.sink({ type: "error", message });
  }

  summary(reason: StopReason, message: string): void {
    this.sink({ type: "summary", reason, message });
  }

  modeChanged(mode: Mode): void {
    this.sink({ type: "mode", mode });
  }

  confirm(req: ConfirmRequest): Promise<ConfirmDecision> {
    const id = this.nextId();
    return this.ask<ConfirmDecision>(id, { type: "confirm", id, request: req }).then((value) =>
      value === "yes" || value === "no" || value === "all" ? value : "no",
    );
  }

  requestPathAccess(req: PathAccessRequest): Promise<boolean> {
    const id = this.nextId();
    return this.ask<boolean>(id, { type: "pathAccess", id, request: req });
  }

  requestSensitiveAccess(req: SensitiveAccessRequest): Promise<boolean> {
    const id = this.nextId();
    return this.ask<boolean>(id, { type: "sensitiveAccess", id, request: req });
  }

  /** Jawab permintaan yang menggantung. Mengembalikan false bila id tak dikenal. */
  resolve(id: string, value: unknown): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    pending.resolve(value);
    return true;
  }

  /** Tolak semua permintaan yang menggantung (mis. semua klien terputus). */
  cancelAll(): void {
    for (const pending of this.pending.values()) pending.resolve(false);
    this.pending.clear();
  }
}
