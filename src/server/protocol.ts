import { z } from "zod";
import type {
  ConfirmRequest,
  PathAccessRequest,
  SensitiveAccessRequest,
  StepInfo,
  StepOutcome,
} from "../core/io.js";
import type { Mode, NeutralMessage, StopReason } from "../core/types.js";
import type { TodoItem } from "../core/todos.js";

/**
 * Protokol satu kanal WebSocket.
 *
 * Klien → server divalidasi ketat dengan Zod (semua input dari jaringan).
 * Server → klien diketik lewat union `ServerMessage`.
 */

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("chat.send"), text: z.string().min(1).max(200_000) }),
  z.object({ type: z.literal("chat.interrupt") }),
  z.object({ type: z.literal("approval.resolve"), id: z.string().min(1), decision: z.enum(["yes", "no", "all"]) }),
  z.object({ type: z.literal("path.resolve"), id: z.string().min(1), allow: z.boolean() }),
  z.object({ type: z.literal("sensitive.resolve"), id: z.string().min(1), allow: z.boolean() }),
  z.object({ type: z.literal("session.new") }),
  z.object({ type: z.literal("session.open"), id: z.string().min(1) }),
  z.object({ type: z.literal("session.delete"), id: z.string().min(1) }),
  z.object({ type: z.literal("session.rename"), id: z.string().min(1), title: z.string().min(1).max(200) }),
  z.object({ type: z.literal("mode.set"), mode: z.enum(["plan", "build"]) }),
  z.object({ type: z.literal("allowAll.set"), on: z.boolean() }),
  z.object({ type: z.literal("state.request") }),
  z.object({
    type: z.literal("terminal.open"),
    id: z.string().min(1).max(64),
    cols: z.number().int().min(2).max(1000),
    rows: z.number().int().min(2).max(1000),
  }),
  z.object({ type: z.literal("terminal.input"), id: z.string().min(1).max(64), data: z.string().max(100_000) }),
  z.object({
    type: z.literal("terminal.resize"),
    id: z.string().min(1).max(64),
    cols: z.number().int().min(2).max(1000),
    rows: z.number().int().min(2).max(1000),
  }),
  z.object({ type: z.literal("terminal.close"), id: z.string().min(1).max(64) }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

/** Parse & validasi satu pesan klien. `undefined` bila tidak valid. */
export function parseClientMessage(raw: string): ClientMessage | undefined {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = clientMessageSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/** Ringkasan sesi untuk daftar di sidebar web. */
export interface SessionSummary {
  id: string;
  title: string;
  model: string;
  providerId: string;
  mode: Mode;
  workspace: string;
  updatedAt: string;
  cost: number;
  messages: number;
}

export interface WebState {
  workspace: string;
  mode: Mode;
  model: string;
  provider: string;
  allowAll: boolean;
  busy: boolean;
  skills: Array<{ name: string; description: string }>;
  sessions: SessionSummary[];
  current: SessionSummary;
}

/** Pesan dari server ke klien. */
export type ServerMessage =
  | { type: "ready"; state: WebState }
  | { type: "state"; state: WebState }
  | { type: "sessions"; items: SessionSummary[] }
  | { type: "session"; summary: SessionSummary; history: NeutralMessage[] }
  | { type: "text"; chunk: string }
  | { type: "textEnd" }
  | { type: "thinking"; chunk: string }
  | { type: "thinkingEnd" }
  | { type: "stepStart"; info: StepInfo }
  | { type: "stepEnd"; info: StepInfo; outcome: StepOutcome }
  | { type: "diff"; text: string }
  | { type: "todos"; items: TodoItem[] }
  | { type: "info"; message: string }
  | { type: "warn"; message: string }
  | { type: "error"; message: string }
  | { type: "summary"; reason: StopReason; message: string }
  | { type: "mode"; mode: Mode }
  | { type: "busy"; on: boolean }
  | { type: "confirm"; id: string; request: ConfirmRequest }
  | { type: "pathAccess"; id: string; request: PathAccessRequest }
  | { type: "sensitiveAccess"; id: string; request: SensitiveAccessRequest }
  | { type: "terminal.data"; id: string; data: string }
  | { type: "terminal.exit"; id: string; code: number | null }
  | { type: "terminal.list"; items: Array<{ id: string; running: boolean }> }
  | { type: "fatal"; message: string };
