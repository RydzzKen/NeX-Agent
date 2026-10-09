import path from "node:path";
import type { Mode, ModelInfo, ModelPricing, NeutralMessage, StopReason, TokenUsage, ToolCallRequest } from "./types.js";
import { EMPTY_USAGE } from "./types.js";
import type { StepInfo } from "./io.js";
import type { AgentIO } from "./io.js";
import type { Approvals } from "./approvals.js";
import type { Logger } from "../logging/logger.js";
import { ContextManager, trimToolResult } from "./context.js";
import { CheckpointManager } from "./checkpoint.js";
import { RepetitionDetector, fingerprint } from "./repetition.js";
import { TodoStore, type TodoItem } from "./todos.js";
import type { ModelProvider, StreamEvent, ToolSpec } from "../providers/provider.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext, ResolvedPath, WebSearchFn } from "../tools/types.js";
import { ToolDeniedError, ToolInputError } from "../tools/errors.js";
import type { AccessKind } from "./io.js";
import type { Workspace } from "../safety/workspace.js";
import type { PermissionManager } from "../safety/permissions.js";
import type { UsageTracker } from "../usage/tracker.js";
import type { UsageEvent } from "../usage/store.js";

export interface SessionDeps {
  provider: ModelProvider;
  providerId: string;
  registry: ToolRegistry;
  io: AgentIO;
  approvals: Approvals;
  logger: Logger;
  checkpoints: CheckpointManager;
  workspace: Workspace;
  permissions: PermissionManager;
  systemPrompt: string;
  resolvePath: (raw: string, access: AccessKind) => Promise<ResolvedPath>;
  tracker: UsageTracker;
  search?: WebSearchFn;
  onUsage?: (event: UsageEvent) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  sessionId?: string;
}

export interface SessionOptions {
  model: string;
  mode: Mode;
  modelInfo?: ModelInfo;
  maxSteps?: number;
  maxCost?: number;
  retries?: number;
  history?: NeutralMessage[];
  todos?: TodoItem[];
}

export interface RunResult {
  stopReason: StopReason;
  /** Pesan ringkasan bila berhenti bukan karena sukses. */
  message?: string;
  steps: number;
}

interface ModelTurn {
  text: string;
  thinking: string;
  toolCalls: ToolCallRequest[];
  usage: TokenUsage;
  stopReason: "stop" | "tool_use" | "length";
}

const DEFAULT_MAX_STEPS = 25;
const MAX_PARALLEL_READS = 4;

function isRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /fetch|network|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|timeout|429|50\d/i.test(
    msg,
  );
}

/** Satu sesi agentik: menyimpan riwayat, mode, dan menjalankan loop. */
export class AgentSession {
  private history: NeutralMessage[];
  private mode: Mode;
  private model: string;
  private modelInfo?: ModelInfo;
  private readonly maxSteps: number;
  private readonly maxCost?: number;
  private readonly retries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly todos: TodoStore;
  private stepCounter = 0;

  constructor(
    private readonly deps: SessionDeps,
    options: SessionOptions,
  ) {
    this.history = options.history ?? [];
    this.mode = options.mode;
    this.model = options.model;
    this.modelInfo = options.modelInfo;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.maxCost = options.maxCost;
    this.retries = options.retries ?? 3;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.todos = new TodoStore(options.todos ?? []);
  }

  getMode(): Mode {
    return this.mode;
  }

  getModel(): string {
    return this.model;
  }

  getModelInfo(): ModelInfo | undefined {
    return this.modelInfo;
  }

  getHistory(): NeutralMessage[] {
    return this.history;
  }

  /** Ganti riwayat (mis. saat melanjutkan sesi). */
  setHistory(history: NeutralMessage[]): void {
    this.history = history;
  }

  clearHistory(): void {
    this.history = [];
  }

  get tracker(): UsageTracker {
    return this.deps.tracker;
  }

  getTodos(): TodoItem[] {
    return this.todos.list();
  }

  setTodos(todos: TodoItem[]): void {
    this.todos.replace(todos);
  }

  setMode(mode: Mode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.deps.io.modeChanged?.(mode);
  }

  setModel(model: string, info?: ModelInfo): void {
    this.model = model;
    this.modelInfo = info;
  }

  setProvider(provider: ModelProvider, providerId: string): void {
    this.deps.provider = provider;
    this.deps.providerId = providerId;
  }

  appendUserMessage(text: string): void {
    this.history.push({ role: "user", content: text });
  }

  private contextManager(): ContextManager {
    return new ContextManager(this.modelInfo?.contextWindow);
  }

  private toolContext(signal: AbortSignal): ToolContext {
    return {
      workspace: this.deps.workspace,
      permissions: this.deps.permissions,
      mode: this.mode,
      signal,
      logger: this.deps.logger,
      todos: this.todos,
      search: this.deps.search,
      resolvePath: this.deps.resolvePath,
      confirm: (req, opts) => this.deps.approvals.confirm(req, opts),
      confirmSensitive: (req) => this.deps.approvals.requestSensitiveAccess(req),
    };
  }

  /** Jalankan satu tugas pengguna sampai selesai atau kondisi berhenti. */
  async run(userText: string, signal: AbortSignal): Promise<RunResult> {
    this.history.push({ role: "user", content: userText });
    this.deps.checkpoints.beginTask();
    this.stepCounter = 0;
    const repetition = new RepetitionDetector();
    let consecutiveInvalidJson = 0;

    for (let iteration = 1; ; iteration++) {
      if (signal.aborted) return this.interrupt();

      if (iteration > this.maxSteps) {
        const message = `Batas langkah (${this.maxSteps}) tercapai tanpa penyelesaian.`;
        this.deps.io.summary("max_steps", message);
        return { stopReason: "max_steps", message, steps: iteration - 1 };
      }

      const report = this.contextManager().measure(this.history);
      if (report.warn && report.percent !== undefined) {
        this.deps.io.warn(
          `Konteks ${(report.percent * 100).toFixed(0)}% terpakai (${report.usedTokens} token).`,
        );
      }

      let turn: ModelTurn;
      try {
        turn = await this.callModel(signal);
      } catch (err) {
        const message = (err as Error).message;
        this.deps.io.error(`Gagal memanggil model: ${message}`);
        this.deps.io.summary("provider_error", message);
        return { stopReason: "provider_error", message, steps: iteration };
      }

      if (signal.aborted) return this.interrupt();

      this.recordUsage(turn.usage);

      const budget = this.checkBudget();
      if (budget.exceeded) {
        this.deps.io.summary("max_cost", budget.message);
        return { stopReason: "max_cost", message: budget.message, steps: iteration };
      }
      if (budget.warning) this.deps.io.warn(budget.warning);

      if (turn.toolCalls.length === 0) {
        this.history.push({ role: "assistant", content: turn.text });
        return { stopReason: "stop", steps: iteration };
      }

      this.history.push({ role: "assistant", content: turn.text, toolCalls: turn.toolCalls });

      const { results, invalidJson, aborted } = await this.executeToolCalls(
        turn.toolCalls,
        signal,
      );
      let repetitionHit = false;
      for (const result of results) {
        this.history.push({
          role: "tool",
          toolCallId: result.callId,
          name: result.name,
          content: result.content,
        });
        if (repetition.check(result.fingerprint)) repetitionHit = true;
      }

      if (aborted) return this.interrupt();

      consecutiveInvalidJson = invalidJson > 0 ? consecutiveInvalidJson + invalidJson : 0;
      if (consecutiveInvalidJson >= 2) {
        const message =
          "Tool call JSON tidak valid dua kali berturut-turut. Loop dihentikan.";
        this.deps.io.summary("invalid_tool_json", message);
        return { stopReason: "invalid_tool_json", message, steps: iteration };
      }

      if (repetitionHit) {
        const message = "Pengulangan terdeteksi (panggilan identik berulang).";
        this.deps.io.summary("repetition", message);
        return { stopReason: "repetition", message, steps: iteration };
      }
    }
  }

  private interrupt(): RunResult {
    const message = "Diinterupsi oleh pengguna. Sesi tersimpan dan bisa dilanjutkan.";
    this.deps.io.summary("interrupted", message);
    return { stopReason: "interrupted", message, steps: this.stepCounter };
  }

  private checkBudget(): { exceeded: boolean; message: string; warning?: string } {
    if (this.maxCost === undefined) return { exceeded: false, message: "" };
    const totals = this.deps.tracker.totals();
    if (totals.cost >= this.maxCost) {
      return {
        exceeded: true,
        message: `Anggaran $${this.maxCost.toFixed(2)} tercapai (estimasi $${totals.cost.toFixed(4)}).`,
      };
    }
    if (totals.cost >= this.maxCost * 0.8) {
      return {
        exceeded: false,
        message: "",
        warning: `Pemakaian biaya ${((totals.cost / this.maxCost) * 100).toFixed(0)}% dari anggaran.`,
      };
    }
    return { exceeded: false, message: "" };
  }

  private recordUsage(usage: TokenUsage): void {
    this.deps.tracker.record(this.deps.providerId, this.model, usage, this.modelInfo?.pricing);
    if (this.deps.onUsage && (usage.input || usage.output || usage.cacheRead || usage.cacheWrite)) {
      void this.deps.onUsage({
        ts: new Date().toISOString(),
        sessionId: this.deps.sessionId ?? "unknown",
        provider: this.deps.providerId,
        model: this.model,
        usage,
        cost: this.lastCost(usage),
        costKnown: Boolean(this.modelInfo?.pricing),
      });
    }
  }

  private lastCost(usage: TokenUsage): number {
    const pricing = this.modelInfo?.pricing as ModelPricing | undefined;
    if (!pricing) return 0;
    const perM = 1_000_000;
    return (
      (usage.input / perM) * pricing.input +
      (usage.output / perM) * pricing.output +
      (usage.cacheRead / perM) * (pricing.cacheRead ?? pricing.input) +
      (usage.cacheWrite / perM) * (pricing.cacheWrite ?? pricing.input)
    );
  }

  private async callModel(signal: AbortSignal): Promise<ModelTurn> {
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        return await this.streamOnce(signal);
      } catch (err) {
        if (attempt > this.retries || !isRetryable(err)) throw err;
        const backoff = 500 * 2 ** (attempt - 1);
        this.deps.logger.warn("provider.retry", { attempt, backoff, error: (err as Error).message });
        await this.sleep(backoff);
      }
    }
  }

  private async streamOnce(signal: AbortSignal): Promise<ModelTurn> {
    const tools: ToolSpec[] = this.deps.registry.specs(this.mode);
    const turn: ModelTurn = {
      text: "",
      thinking: "",
      toolCalls: [],
      usage: { ...EMPTY_USAGE },
      stopReason: "stop",
    };

    const stream = this.deps.provider.stream({
      model: this.model,
      system: this.deps.systemPrompt,
      messages: this.history,
      tools,
      signal,
    });

    let thinkingOpen = false;
    for await (const event of stream as AsyncIterable<StreamEvent>) {
      switch (event.type) {
        case "text":
          turn.text += event.text;
          this.deps.io.text(event.text);
          break;
        case "thinking":
          if (!thinkingOpen) {
            thinkingOpen = true;
          }
          turn.thinking += event.text;
          this.deps.io.thinking(event.text);
          break;
        case "tool_call":
          turn.toolCalls.push({
            id: event.call.id,
            name: event.call.name,
            arguments: event.call.arguments,
          });
          break;
        case "usage":
          turn.usage = event.usage;
          break;
        case "done":
          turn.stopReason = event.stopReason;
          break;
      }
    }
    if (thinkingOpen) this.deps.io.thinkingEnd();
    return turn;
  }

  private async executeToolCalls(
    calls: ToolCallRequest[],
    signal: AbortSignal,
  ): Promise<{ results: ExecutedResult[]; invalidJson: number; aborted: boolean }> {
    const results: ExecutedResult[] = [];
    let invalidJson = 0;
    let aborted = false;

    let i = 0;
    while (i < calls.length) {
      if (signal.aborted) {
        aborted = true;
        break;
      }
      const call = calls[i]!;
      const tool = this.deps.registry.get(call.name);
      const isRead = tool?.risk === "read";

      if (isRead) {
        // Kumpulkan hingga MAX_PARALLEL_READS tool read-only berturut-turut.
        const batch: ToolCallRequest[] = [];
        while (
          i < calls.length &&
          batch.length < MAX_PARALLEL_READS &&
          this.deps.registry.get(calls[i]!.name)?.risk === "read"
        ) {
          batch.push(calls[i]!);
          i++;
        }
        const batchResults = await Promise.all(
          batch.map((c) => this.executeSingle(c, signal)),
        );
        for (const r of batchResults) {
          results.push(r);
          if (r.invalidJson) invalidJson++;
        }
      } else {
        const r = await this.executeSingle(call, signal);
        results.push(r);
        if (r.invalidJson) invalidJson++;
        i++;
      }
    }

    // Tool call yang belum sempat dieksekusi karena interupsi.
    for (let j = i; j < calls.length; j++) {
      const call = calls[j]!;
      results.push({
        callId: call.id,
        name: call.name,
        content: "Dibatalkan oleh pengguna.",
        ok: false,
        denied: true,
        fingerprint: fingerprint(call.name, call.arguments, "cancelled"),
        invalidJson: false,
      });
    }

    return { results, invalidJson, aborted };
  }

  private async executeSingle(
    call: ToolCallRequest,
    signal: AbortSignal,
  ): Promise<ExecutedResult> {
    const tool = this.deps.registry.get(call.name);
    const ctx = this.toolContext(signal);

    const base: Omit<ExecutedResult, "content"> = {
      callId: call.id,
      name: call.name,
      ok: false,
      fingerprint: fingerprint(call.name, call.arguments, ""),
      invalidJson: false,
    };

    if (!tool) {
      const content = `Tool tidak dikenal: ${call.name}`;
      return { ...base, content, fingerprint: fingerprint(call.name, call.arguments, content) };
    }

    // Penegakan mode Plan di eksekutor (bukan hanya daftar tool).
    if (this.mode === "plan" && tool.risk === "mutate") {
      const content = `Ditolak: tool "${call.name}" tidak diizinkan di mode Plan.`;
      this.deps.io.warn(content);
      return {
        ...base,
        denied: true,
        content,
        fingerprint: fingerprint(call.name, call.arguments, content),
      };
    }

    // Parse & validasi argumen.
    let input: unknown;
    try {
      input = call.arguments.trim() === "" ? {} : JSON.parse(call.arguments);
    } catch (err) {
      const content = `Argumen tool bukan JSON valid: ${(err as Error).message}`;
      return {
        ...base,
        invalidJson: true,
        content,
        fingerprint: fingerprint(call.name, call.arguments, content),
      };
    }

    const parsed = tool.schema.safeParse(input);
    if (!parsed.success) {
      const content = `Argumen tidak valid untuk ${call.name}: ${parsed.error.issues
        .map((iss) => `${iss.path.join(".") || "(root)"}: ${iss.message}`)
        .join("; ")}`;
      return { ...base, content, fingerprint: fingerprint(call.name, call.arguments, content) };
    }

    // Checkpoint sebelum mutating. Snapshot hanya membaca path absolut internal.
    if (tool.risk === "mutate" && tool.mutatedPaths) {
      const paths = tool
        .mutatedPaths(parsed.data)
        .map((p) => path.resolve(this.deps.workspace.root, p));
      await this.deps.checkpoints.snapshotBefore(this.stepCounter + 1, paths);
    }

    const summary = tool.summarize ? tool.summarize(parsed.data) : call.name;
    const stepInfo: StepInfo = {
      index: this.stepCounter + 1,
      total: this.maxSteps,
      name: call.name,
      argsSummary: summary,
      risk: tool.risk,
    };
    const isControl = tool.control === true;
    this.stepCounter++;
    if (!isControl) this.deps.io.stepStart(stepInfo);
    const started = Date.now();

    try {
      const result = await tool.execute(parsed.data, ctx);
      const content = trimToolResult(result.content);
      if (!isControl) {
        this.deps.io.stepEnd(stepInfo, {
          status: result.ok === false ? "error" : "ok",
          durationMs: Date.now() - started,
          summary: result.summary,
        });
      }
      if (result.todos) this.deps.io.todos?.(result.todos);
      this.deps.logger.info("tool.ok", {
        tool: call.name,
        args: call.arguments,
        durationMs: Date.now() - started,
      });
      return {
        ...base,
        ok: result.ok !== false,
        content,
        summary: result.summary,
        fingerprint: fingerprint(call.name, call.arguments, content),
      };
    } catch (err) {
      const denied = err instanceof ToolDeniedError;
      const message = err instanceof Error ? err.message : String(err);
      if (!isControl) {
        this.deps.io.stepEnd(stepInfo, {
          status: denied ? "denied" : "error",
          durationMs: Date.now() - started,
          summary: denied ? "ditolak" : "error",
        });
      }
      this.deps.logger.warn(denied ? "tool.denied" : "tool.error", {
        tool: call.name,
        error: message,
      });
      const content = denied
        ? `Ditolak: ${message}`
        : err instanceof ToolInputError
          ? message
          : `Error menjalankan ${call.name}: ${message}`;
      return {
        ...base,
        denied,
        content,
        fingerprint: fingerprint(call.name, call.arguments, content),
      };
    }
  }
}

interface ExecutedResult {
  callId: string;
  name: string;
  ok: boolean;
  content: string;
  summary?: string;
  denied?: boolean;
  fingerprint: string;
  invalidJson: boolean;
}
