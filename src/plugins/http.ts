import type { JsonRpcMessage, JsonRpcRequest, RpcTransport } from "./jsonrpc.js";
import { parseJsonRpc } from "./jsonrpc.js";
import { parseSSE } from "../providers/sse.js";

/**
 * Transport MCP "Streamable HTTP": setiap pesan JSON-RPC dikirim sebagai satu
 * POST; balasannya bisa langsung JSON (`application/json`) atau aliran
 * `text/event-stream`. Sesi (header `Mcp-Session-Id`) dijaga otomatis.
 */

export interface HttpTransportOptions {
  url: string;
  /** Header tambahan (rahasia sudah di-resolve). */
  headers?: Record<string, string>;
  onDiagnostic?: (text: string) => void;
}

/** POST satu pesan JSON-RPC; `null` bila bukan permintaan dengan id. */
export async function postJsonRpc(
  url: string,
  message: JsonRpcMessage,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<{ response: Response; requestId: number | string | undefined }> {
  const requestId = "id" in message ? message.id : undefined;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(message),
    signal,
  });
  return { response, requestId };
}

/** Baca balasan POST: satu pesan JSON-RPC (atau banyak lewat SSE). */
export async function readJsonRpcResponse(
  response: Response,
  deliver: (message: JsonRpcMessage) => void,
): Promise<void> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    if (!response.body) return;
    for await (const event of parseSSE(response.body)) {
      const parsed = parseJsonRpc(event.data);
      if (parsed) deliver(parsed);
    }
    return;
  }
  const text = await response.text();
  if (!text.trim()) return;
  const parsed = parseJsonRpc(text);
  if (parsed) deliver(parsed);
}

export function createHttpTransport(opts: HttpTransportOptions): RpcTransport {
  let messageHandler: ((message: JsonRpcMessage) => void) | undefined;
  let closeHandler: ((error?: Error) => void) | undefined;
  let sessionId: string | undefined;
  let closed = false;
  const abort = new AbortController();

  const deliver = (message: JsonRpcMessage): void => {
    messageHandler?.(message);
  };

  const failure = (requestId: number | string, message: string): JsonRpcMessage => ({
    jsonrpc: "2.0",
    id: requestId,
    error: { code: -32000, message },
  });

  const post = async (message: JsonRpcMessage): Promise<void> => {
    const isRequest = "id" in message;
    const requestId = isRequest ? (message as JsonRpcRequest).id : undefined;
    try {
      const { response } = await postJsonRpc(opts.url, message, effectiveHeaders(), abort.signal);
      if (isRequest) {
        if (!response.ok) {
          deliver(failure(requestId!, `HTTP ${response.status}`));
          return;
        }
        const candidate = response.headers.get("mcp-session-id");
        if (candidate) sessionId = candidate;
        await readJsonRpcResponse(response, deliver);
      }
      // Notification: balasan 202/204 tanpa isi dibiarkan.
    } catch (err) {
      if (isRequest) {
        deliver(failure(requestId!, err instanceof Error ? err.message : String(err)));
      } else {
        opts.onDiagnostic?.(`HTTP MCP gagal diproses: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  const effectiveHeaders = (): Record<string, string> => ({
    ...opts.headers,
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  });

  return {
    write(message: JsonRpcMessage): void {
      void post(message);
    },
    onMessage(handler): void {
      messageHandler = handler;
    },
    onClose(handler): void {
      closeHandler = handler;
    },
    close(): Promise<void> {
      if (closed) return Promise.resolve();
      closed = true;
      abort.abort();
      closeHandler?.();
      return Promise.resolve();
    },
  };
}