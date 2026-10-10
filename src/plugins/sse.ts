import type { JsonRpcMessage, RpcTransport } from "./jsonrpc.js";
import { parseJsonRpc } from "./jsonrpc.js";
import { parseSSE } from "../providers/sse.js";
import { postJsonRpc } from "./http.js";

/**
 * Transport MCP HTTP+SSE (protokol lama): buka aliran `text/event-stream`
 * untuk menerima pesan, dan kirim permintaan lewat POST ke endpoint yang
 * diumumkan server melalui event `endpoint` (biasanya `/messages/?session_id=…`).
 */

export interface SseTransportOptions {
  url: string;
  headers?: Record<string, string>;
  onDiagnostic?: (text: string) => void;
  /** Batas waktu menunggu event `endpoint` (ms). Default 30.000. */
  endpointTimeoutMs?: number;
}

export interface SseHandle {
  transport: RpcTransport;
  /** Selesai saat event `endpoint` diterima; menolak bila gagal/timeout. */
  ready: Promise<void>;
}

function resolveEndpoint(raw: string, base: string): string {
  if (/^https?:\/\//i.test(raw)) return raw;
  try {
    return new URL(raw, base).toString();
  } catch {
    return base;
  }
}

export function createSseTransport(opts: SseTransportOptions): SseHandle {
  let messageHandler: ((message: JsonRpcMessage) => void) | undefined;
  let closeHandler: ((error?: Error) => void) | undefined;
  let endpoint: string | undefined;
  let closed = false;
  let readySettled = false;
  const abort = new AbortController();
  const buffered: JsonRpcMessage[] = [];

  let resolveReady!: () => void;
  let rejectReady!: (reason: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const settleReady = (error?: Error): void => {
    if (readySettled) return;
    readySettled = true;
    if (error) rejectReady(error);
    else resolveReady();
  };

  const failure = (message: JsonRpcMessage, reason: string): void => {
    if (!("id" in message)) {
      opts.onDiagnostic?.(reason);
      return;
    }
    messageHandler?.({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: reason } });
  };

  const send = async (message: JsonRpcMessage): Promise<void> => {
    const target = endpoint;
    if (!target) return;
    try {
      const { response } = await postJsonRpc(target, message, opts.headers ?? {}, abort.signal);
      if (!response.ok) failure(message, `HTTP ${response.status}`);
    } catch (err) {
      failure(message, err instanceof Error ? err.message : String(err));
    }
  };

  // Tulis sebelum endpoint diketahui akan ditampung, lalu dikirim saat siap.
  const writeOrBuffer = (message: JsonRpcMessage): void => {
    if (endpoint) void send(message);
    else buffered.push(message);
  };

  const finish = (error?: Error): void => {
    if (closed) return;
    closed = true;
    abort.abort();
    settleReady(error ?? (endpoint ? undefined : new Error("Aliran SSE berakhir sebelum endpoint diterima.")));
    closeHandler?.(error);
  };

  const initialize = async (): Promise<void> => {
    const response = await fetch(opts.url, {
      headers: { accept: "text/event-stream", ...opts.headers },
      signal: abort.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} saat membuka aliran SSE`);
    if (!response.body) throw new Error("Respons SSE tanpa body");

    const timer = setTimeout(() => {
      finish(new Error("Server SSE tidak mengumumkan endpoint (timeout)."));
    }, opts.endpointTimeoutMs ?? 30_000);

    try {
      for await (const event of parseSSE(response.body)) {
        if (event.event === "endpoint" && event.data.trim()) {
          clearTimeout(timer);
          endpoint = resolveEndpoint(event.data.trim(), opts.url);
          for (const pending of buffered.splice(0)) void send(pending);
          settleReady();
        } else if (event.data.trim()) {
          const parsed = parseJsonRpc(event.data);
          if (parsed) messageHandler?.(parsed);
        }
      }
      clearTimeout(timer);
      finish();
    } catch (err) {
      clearTimeout(timer);
      if (!readySettled) {
        readySettled = true;
        rejectReady(err instanceof Error ? err : new Error(String(err)));
      }
      finish(err instanceof Error ? err : new Error(String(err)));
    }
  };

  void initialize().catch((err: unknown) => {
    if (!readySettled) {
      readySettled = true;
      rejectReady(err instanceof Error ? err : new Error(String(err)));
    }
  });

  return {
    transport: {
      write: writeOrBuffer,
      onMessage(handler): void {
        messageHandler = handler;
      },
      onClose(handler): void {
        closeHandler = handler;
      },
      close(): Promise<void> {
        finish();
        return Promise.resolve();
      },
    },
    ready,
  };
}