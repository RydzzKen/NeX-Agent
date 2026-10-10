/**
 * Koneksi JSON-RPC 2.0 yang netral transport.
 *
 * Transport (stdio, HTTP, SSE) hanya bertugas membawa pesan; kelas ini
 * menangani identitas permintaan, peta permintaan yang belum dibalas, timeout,
 * pembatalan AbortSignal, dan balasan otomatis untuk `ping`.
 */

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number | string;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: number | string;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure;

export function isRequestMessage(message: JsonRpcMessage): message is JsonRpcRequest {
  return "method" in message && "id" in message;
}

export function isNotificationMessage(message: JsonRpcMessage): message is JsonRpcNotification {
  return "method" in message && !("id" in message);
}

/** Parse satu pesan (dari baris/data SSE). `undefined` bila bukan JSON-RPC valid. */
export function parseJsonRpc(raw: string): JsonRpcMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const message = value as Record<string, unknown>;
  if (message.jsonrpc !== "2.0") return undefined;
  if ("method" in message && typeof message.method === "string") {
    return message as unknown as JsonRpcMessage;
  }
  if ("id" in message && (typeof message.id === "number" || typeof message.id === "string")) {
    if ("result" in message) return message as unknown as JsonRpcSuccess;
    if ("error" in message) return message as unknown as JsonRpcFailure;
  }
  return undefined;
}

/** Transport abstrak: menulis pesan dan menerima pesan masuk. */
export interface RpcTransport {
  write(message: JsonRpcMessage): void;
  /** Pasang handler untuk pesan masuk (dipanggil tepat sekali). */
  onMessage(handler: (message: JsonRpcMessage) => void): void;
  /** Pasang handler penutupan (error opsional, mis. proses keluar mendadak). */
  onClose(handler: (error?: Error) => void): void;
  close(): Promise<void>;
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Penimpa timeout per permintaan. Koneksi memiliki default sendiri. */
  timeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

export class JsonRpcConnection {
  private nextId = 1;
  private readonly pending = new Map<number | string, PendingRequest>();
  private closedError?: Error;

  constructor(
    private readonly transport: RpcTransport,
    private readonly defaultTimeoutMs: number,
  ) {
    transport.onMessage((message) => {
      // Permintaan dari server (mis. ping) harus dibalas agar tidak menggantung.
      if (isRequestMessage(message)) {
        this.replyToServerRequest(message);
        return;
      }
      if (isNotificationMessage(message)) return;
      this.resolvePending(message);
    });
    transport.onClose((error) => {
      this.handleClose(error);
    });
  }

  /** Kirim permintaan dan tunggu hasilnya. Melempar pada error/timeout/batal. */
  async request(method: string, params?: unknown, opts: RequestOptions = {}): Promise<unknown> {
    if (this.closedError) throw this.closedError;
    const id = this.nextId++;
    const message: JsonRpcRequest = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;

    return new Promise<unknown>((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout MCP (${timeoutMs}ms): ${method}`));
      }, timeoutMs);

      const onAbort = (): void => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error("Dibatalkan oleh pengguna."));
      };
      if (opts.signal?.aborted) {
        onAbort();
        return;
      }
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      const entry: PendingRequest = {
        resolve: (value) => {
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (reason) => {
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", onAbort);
          reject(reason);
        },
      };
      this.pending.set(id, entry);
      try {
        this.transport.write(message);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Kirim notifikasi (tanpa balasan). */
  notify(method: string, params?: unknown): void {
    const message: JsonRpcNotification = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    this.transport.write(message);
  }

  private replyToServerRequest(request: JsonRpcRequest): void {
    const unsupported = request.method !== "ping";
    const reply: JsonRpcSuccess | JsonRpcFailure = unsupported
      ? { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } }
      : { jsonrpc: "2.0", id: request.id, result: {} };
    try {
      this.transport.write(reply);
    } catch {
      // transport mati; abaikan
    }
  }

  private resolvePending(message: JsonRpcSuccess | JsonRpcFailure): void {
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    if ("error" in message) {
      const detail =
        typeof message.error.data === "string" ? `: ${message.error.data}` : "";
      entry.reject(
        new Error(`MCP error ${message.error.code}: ${message.error.message}${detail}`),
      );
    } else {
      entry.resolve(message.result);
    }
  }

  private handleClose(error?: Error): void {
    if (this.closedError) return;
    this.closedError = error ?? new Error("Koneksi MCP ditutup.");
    for (const [, entry] of this.pending) {
      entry.reject(this.closedError);
    }
    this.pending.clear();
  }

  async close(): Promise<void> {
    this.handleClose();
    await this.transport.close();
  }
}