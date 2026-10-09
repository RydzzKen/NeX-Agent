import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  event: string;
  [key: string]: unknown;
}

export interface LogInput {
  level: LogLevel;
  event: string;
  [key: string]: unknown;
}

export interface Logger {
  log(entry: LogInput): void;
  info(event: string, data?: Record<string, unknown>): void;
  debug(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}

const SECRET_KEY = /(api[-_]?key|token|secret|password|passwd|authorization|bearer|cookie)/i;

/** Ganti nilai sensitif agar tidak pernah masuk log. */
export function redact(value: unknown, keyHint = ""): unknown {
  if (SECRET_KEY.test(keyHint)) return "***";
  if (Array.isArray(value)) return value.map((v) => redact(v, keyHint));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redact(v, k);
    }
    return out;
  }
  return value;
}

export class JsonlLogger implements Logger {
  private stream: fs.WriteStream | null = null;
  private readonly debugEnabled: boolean;

  constructor(filePath: string | null, opts: { debug?: boolean } = {}) {
    this.debugEnabled = opts.debug ?? false;
    if (filePath) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      this.stream = fs.createWriteStream(filePath, { flags: "a" });
    }
  }

  log(entry: LogInput): void {
    if (!this.stream) return;
    if (entry.level === "debug" && !this.debugEnabled) return;
    const full: LogEntry = { ts: new Date().toISOString(), ...entry };
    this.stream.write(JSON.stringify(redact(full)) + "\n");
  }

  info(event: string, data: Record<string, unknown> = {}): void {
    this.log({ level: "info", event, ...data });
  }
  debug(event: string, data: Record<string, unknown> = {}): void {
    this.log({ level: "debug", event, ...data });
  }
  warn(event: string, data: Record<string, unknown> = {}): void {
    this.log({ level: "warn", event, ...data });
  }
  error(event: string, data: Record<string, unknown> = {}): void {
    this.log({ level: "error", event, ...data });
  }

  close(): void {
    this.stream?.end();
    this.stream = null;
  }
}

export class NullLogger implements Logger {
  log(): void {}
  info(): void {}
  debug(): void {}
  warn(): void {}
  error(): void {}
}

export const nullLogger = new NullLogger();
