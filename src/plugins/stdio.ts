import { spawn, type ChildProcess } from "node:child_process";
import type { JsonRpcMessage, RpcTransport } from "./jsonrpc.js";
import { parseJsonRpc } from "./jsonrpc.js";

/**
 * Transport MCP stdio: buka proses (mis. `npx -y @upstash/context7-mcp`) dan
 * berkomunikasi lewat JSON-RPC dengan satu pesan per baris pada stdin/stdout.
 * stderr hanya ditampung (untuk pesan error), tidak pernah masuk log.
 */

export interface StdioTransportOptions {
  command: string;
  args?: string[];
  /** Variabel lingkungan tambahan (rahasia sudah di-resolve). */
  env?: Record<string, string>;
  cwd?: string;
  /** Gabungkan dengan `process.env` (default true). */
  mergeEnv?: boolean;
  /** Panggilan untuk output diagnostik (stderr server), sudah dipotong. */
  onDiagnostic?: (text: string) => void;
}

const MAX_STDERR = 2000;

export function createStdioTransport(opts: StdioTransportOptions): RpcTransport {
  const child: ChildProcess = spawn(opts.command, opts.args ?? [], {
    cwd: opts.cwd ?? process.cwd(),
    env: {
      ...(opts.mergeEnv !== false ? process.env : {}),
      ...opts.env,
    } as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    if (stderr.length < MAX_STDERR) stderr += text;
    opts.onDiagnostic?.(text);
  });

  let buffer = "";
  let messageHandler: ((message: JsonRpcMessage) => void) | undefined;
  let closeHandler: ((error?: Error) => void) | undefined;
  let closed = false;

  const emitLine = (line: string): void => {
    const message = parseJsonRpc(line);
    if (message) messageHandler?.(message);
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index: number;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) emitLine(line);
    }
  });

  const handleClose = (error?: Error): void => {
    if (closed) return;
    closed = true;
    closeHandler?.(error);
  };

  child.on("error", (err) => handleClose(err));
  child.on("close", (code, signal) => {
    const detail = stderr.trim() ? ` (stderr: ${stderr.trim().slice(0, 200)})` : "";
    const reason = code === null ? `dibunuh oleh ${signal ?? "sinyal"}` : `keluar dengan kode ${code}`;
    handleClose(new Error(`Server MCP stdio ${reason}${detail}`));
  });

  return {
    write(message: JsonRpcMessage): void {
      const stdin = child.stdin;
      if (closed || !stdin || stdin.destroyed) throw new Error("Transport MCP stdio sudah ditutup.");
      stdin.write(JSON.stringify(message) + "\n");
    },
    onMessage(handler): void {
      messageHandler = handler;
    },
    onClose(handler): void {
      closeHandler = handler;
    },
    close(): Promise<void> {
      if (closed) return Promise.resolve();
      child.kill("SIGTERM");
      // Tunggu proses benar-benar keluar (batas aman).
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          handleClose();
          resolve();
        }, 2000);
        child.once("exit", () => {
          clearTimeout(timer);
          handleClose();
          resolve();
        });
      });
    },
  };
}