import path from "node:path";
import type {
  Mode,
  ModelInfo,
  ModelPricing,
  NeutralMessage,
  StopReason,
  SubagentPlan,
  SubagentResult,
  TokenUsage,
  ToolCallRequest,
} from "./types.js";
import { EMPTY_USAGE } from "./types.js";
import { runSubagent } from "./task.js";
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
import { formatErrorMessage } from "../util/errors.js";
import type { AccessKind } from "./io.js";
import type { Workspace } from "../safety/workspace.js";
import type { Skill } from "../memory/skills.js";
import { modeDirective } from "../memory/system_prompt.js";
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
  skills?: Skill[];
  /**
   * Daftarkan skill yang baru dibuat agar langsung aktif di sesi ini (dipakai
   * tool `skill_write`). Diinjeksi oleh CLI/web; core hanya memanggil.
   */
  registerSkill?: (skill: Skill) => void | Promise<void>;
  /**
   * Bangun ulang system prompt setelah memori jangka panjang berubah (dipakai
   * tool `memory`). Diinjeksi oleh CLI/web; core hanya memanggil.
   */
  refreshMemory?: () => void | Promise<void>;
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

/**
 * Ringkasan singkat untuk baris "berhenti" saat provider gagal. Detail lengkap
 * (termasuk body respons provider) sudah ditampilkan lewat `io.error`, jadi
 * ringkasan cukup menegaskan status tanpa mengulang isi body.
 */
function providerErrorSummary(message: string): string {
  const status = /HTTP (\d{3})/.exec(message)?.[1];
  return status ? `Gagal memanggil model (HTTP ${status}).` : "Gagal memanggil model.";
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

  /** Ganti system prompt (mis. saat mengaktifkan skill manual). */
  setSystemPrompt(text: string): void {
    this.deps.systemPrompt = text;
  }

  /** Ganti daftar skill yang terlihat oleh tool `skill` (hot-reload). */
  setSkills(skills: Skill[]): void {
    this.deps.skills = skills;
  }

  appendUserMessage(text: string): void {
    this.history.push({ role: "user", content: text });
  }

  /**
   * Jalankan sesi anak (subagent) dengan konteks kosong — dipakai tool `task`.
   * Anak memakai provider/model induk, anggaran sendiri, dan pemakaiannya
   * digabung kembali ke tracker induk. Tool `task` tidak dipasang di anak
   * (kedalaman 1).
   */
  async runTask(plan: SubagentPlan, signal: AbortSignal): Promise<SubagentResult> {
    return runSubagent(
      { ...this.deps, model: this.model, modelInfo: this.modelInfo },
      plan,
      signal,
    );
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
      skills: this.deps.skills,
      ...(this.deps.registerSkill ? { registerSkill: this.deps.registerSkill } : {}),
      ...(this.deps.refreshMemory ? { refreshMemory: this.deps.refreshMemory } : {}),
      task: (plan, signal) => this.runTask(plan, signal),
      resolvePath: this.deps.resolvePath,
      confirm: (req, opts) => this.deps.approvals.confirm(req, opts),
      confirmSensitive: (req) => this.deps.approvals.requestSensitiveAccess(req),
      requestSecret: (req) => this.deps.approvals.requestSecret(req),
    };
  }

  /**
   * Jalankan perintah shell langsung dari input `!...` tanpa memanggil model.
   * Memakai tool `run_shell` yang sama agar izin, konfirmasi, dan pembatasan
   * mode tetap berlaku; output dikembalikan untuk ditampilkan di transkrip.
   */
  async runShell(
    command: string,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; content: string; summary?: string; denied?: boolean }> {
    const tool = this.deps.registry.get("run_shell");
    if (!tool) {
      const content = "Tool run_shell tidak tersedia.";
      this.deps.io.error(content);
      return { ok: false, content };
    }
    const parsed = tool.schema.safeParse({ command });
    if (!parsed.success) {
      const content = `Argumen tidak valid untuk run_shell: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`;
      this.deps.io.error(content);
      return { ok: false, content };
    }
    const risk = tool.riskFor ? tool.riskFor(parsed.data) : tool.risk;
    if (this.mode === "plan" && risk === "mutate") {
      const content = `Ditolak: tool "run_shell" tidak diizinkan di mode Plan.`;
      this.deps.io.warn(content);
      return { ok: false, content, denied: true };
    }

    const summary = tool.summarize ? tool.summarize(parsed.data) : command;
    const stepInfo: StepInfo = {
      index: this.stepCounter + 1,
      total: this.maxSteps,
      name: "run_shell",
      argsSummary: summary,
      risk,
    };
    this.stepCounter += 1;
    this.deps.io.stepStart(stepInfo);
    const started = Date.now();
    try {
      const result = await tool.execute(parsed.data, this.toolContext(signal));
      const content = trimToolResult(result.content);
      this.deps.io.stepEnd(stepInfo, {
        status: result.ok === false ? "error" : "ok",
        durationMs: Date.now() - started,
        summary: result.summary,
        output: content,
      });
      if (result.todos) this.deps.io.todos?.(result.todos);
      this.deps.logger.info("tool.ok", {
        tool: "run_shell",
        args: JSON.stringify({ command }),
        durationMs: Date.now() - started,
      });
      return {
        ok: result.ok !== false,
        content,
        ...(result.summary ? { summary: result.summary } : {}),
      };
    } catch (err) {
      const denied = err instanceof ToolDeniedError;
      const message = err instanceof Error ? err.message : String(err);
      const detail = formatErrorMessage(err, { fallback: "kesalahan tidak diketahui" });
      this.deps.io.stepEnd(stepInfo, {
        status: denied ? "denied" : "error",
        durationMs: Date.now() - started,
        summary: denied ? "ditolak" : "error",
        output: detail,
      });
      this.deps.logger.warn(denied ? "tool.denied" : "tool.error", {
        tool: "run_shell",
        error: message,
      });
      return {
        ok: false,
        denied: denied || undefined,
        content: denied ? `Ditolak: ${detail}` : detail,
      };
    }
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
        // Batal dari pengguna (Ctrl+C) memutus koneksi provider — itu bukan
        // error provider, jadi laporkan sebagai interupsi yang bersih.
        if (signal.aborted) return this.interrupt();
        const message = formatErrorMessage(err, {
          fallback: "Kesalahan provider tidak diketahui.",
        });
        // Pesan HTTP dari provider sudah berbunyi "Provider <id> gagal: …" —
        // jangan dibungkus lagi agar tidak ada kata "gagal" dua kali.
        this.deps.io.error(
          /^Provider /i.test(message) ? message : `Gagal memanggil model: ${message}`,
        );
        // Jangan ulangi `message` di ringkasan berhenti: body dari provider bisa
        // sangat panjang dan sudah tampil di baris error tepat di atasnya.
        this.deps.io.summary("provider_error", providerErrorSummary(message));
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

      const { results, invalidJson, aborted } = await this.executeToolCalls(turn.toolCalls, signal);
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
        const message = "Tool call JSON tidak valid dua kali berturut-turut. Loop dihentikan.";
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
        this.deps.logger.warn("provider.retry", {
          attempt,
          backoff,
          error: (err as Error).message,
        });
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
      // Direktif mode disusun dari mode SAAT INI setiap giliran, jadi ganti
      // mode (/plan, /build, web) langsung terlihat oleh model tanpa rebuild.
      system: `${this.deps.systemPrompt}\n\n${modeDirective(this.mode)}`,
      messages: this.history,
      tools,
      signal,
    });

    let thinkingOpen = false;
    try {
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
              ...(event.call.extraContent ? { extraContent: event.call.extraContent } : {}),
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
    } finally {
      // Tutup blok thinking/teks walau stream diputus (mis. Ctrl+C) agar
      // renderer tidak tertinggal dalam keadaan terbuka.
      if (thinkingOpen) this.deps.io.thinkingEnd();
      // Renderer boleh menuntaskan animasi (efek mengetik) sebelum langkah
      // berikutnya menulis output lain, agar urutan baris tetap rapi.
      await this.deps.io.textEnd?.();
    }
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
        const batchResults = await Promise.all(batch.map((c) => this.executeSingle(c, signal)));
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

  private async executeSingle(call: ToolCallRequest, signal: AbortSignal): Promise<ExecutedResult> {
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

    // Penegakan mode Plan di eksekutor (bukan hanya daftar tool). Risiko bisa
    // dinamis (riskFor), mis. tool `task`: readOnly -> read, lain -> mutate.
    const risk = tool.riskFor ? tool.riskFor(parsed.data) : tool.risk;
    if (this.mode === "plan" && risk === "mutate") {
      const content = `Ditolak: tool "${call.name}" tidak diizinkan di mode Plan.`;
      this.deps.io.warn(content);
      return {
        ...base,
        denied: true,
        content,
        fingerprint: fingerprint(call.name, call.arguments, content),
      };
    }

    // Checkpoint sebelum mutating. Snapshot hanya membaca path absolut internal.
    if (risk === "mutate" && tool.mutatedPaths) {
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
      risk,
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
          output: content,
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
      const detail = formatErrorMessage(err, { fallback: "kesalahan tidak diketahui" });
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
        ? `Ditolak: ${detail}`
        : err instanceof ToolInputError
          ? message
          : `Error menjalankan ${call.name}: ${detail}`;
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
