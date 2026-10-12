import type { ConfirmDecision, StepInfo, StepOutcome } from "./io.js";
import type { AgentIO } from "./io.js";
import type { TodoItem } from "./todos.js";
import type { ModelInfo, Mode, StopReason, SubagentPlan, SubagentResult } from "./types.js";
import type { SessionDeps } from "./loop.js";
import { AgentSession } from "./loop.js";
import { Approvals } from "./approvals.js";
import { UsageTracker } from "../usage/tracker.js";
import { createPathResolver } from "../safety/policy.js";
import { forkRegistry } from "../tools/registry.js";

/**
 * IO pembungkus untuk sesi anak: langkah tool diberi label `subtask` agar
 * mudah dibedakan di layar, sisanya diteruskan ke IO induk.
 */
class SubtaskIO implements AgentIO {
  constructor(
    private readonly inner: AgentIO,
    private readonly label: string,
  ) {}

  text(chunk: string): void {
    this.inner.text(chunk);
  }

  textEnd?(): void {
    this.inner.textEnd?.();
  }

  thinking(chunk: string): void {
    this.inner.thinking(chunk);
  }

  thinkingEnd(): void {
    this.inner.thinkingEnd();
  }

  stepStart(info: StepInfo): void {
    this.inner.stepStart({ ...info, argsSummary: `${this.label}: ${info.argsSummary}` });
  }

  stepEnd(info: StepInfo, outcome: StepOutcome): void {
    this.inner.stepEnd(info, outcome);
  }

  diff(text: string): void {
    this.inner.diff(text);
  }

  todos(items: TodoItem[]): void {
    this.inner.todos?.(items);
  }

  info(message: string): void {
    this.inner.info(message);
  }

  warn(message: string): void {
    this.inner.warn(message);
  }

  error(message: string): void {
    this.inner.error(message);
  }

  summary(reason: StopReason, message: string): void {
    this.inner.summary(reason, message);
  }

  // Tidak pernah dipanggil: persetujuan sesi anak ditangani Approvals-anak
  // yang otomatis (dalam workspace) dan menolak yang sensitif.
  confirm(): Promise<ConfirmDecision> {
    return Promise.resolve("no");
  }

  requestPathAccess(): Promise<boolean> {
    return Promise.resolve(false);
  }

  requestSensitiveAccess(): Promise<boolean> {
    return Promise.resolve(false);
  }

  requestSecret(): Promise<string | null> {
    return Promise.resolve(null);
  }

  modeChanged?(mode: Mode): void {
    this.inner.modeChanged?.(mode);
  }

  busy?(on: boolean): void {
    this.inner.busy?.(on);
  }
}

const DEFAULT_TASK_STEPS = 12;
const MAX_TASK_STEPS = 50;
const MAX_TASK_COST = 50;
const SUMMARY_LIMIT = 4000;

/**
 * Persetujuan sesi anak (autonomous): konfirmasi di dalam workspace disetujui
 * otomatis, tetapi akses luar workspace, file sensitif, dan rahasia SELALU
 * ditolak — tidak ada prompt yang dilempar ke pengguna.
 */
class SubagentApprovals extends Approvals {
  constructor(io: AgentIO) {
    super(io, { yes: true, interactive: false, allowAll: true });
  }

  override requestPathAccess(): Promise<boolean> {
    return Promise.resolve(false);
  }

  override requestSensitiveAccess(): Promise<boolean> {
    return Promise.resolve(false);
  }

  override requestSecret(): Promise<string | null> {
    return Promise.resolve(null);
  }
}

/** Dependensi sesi anak: dependensi sesi biasa + model yang dipakai induk. */
export interface SubagentDeps extends SessionDeps {
  model: string;
  modelInfo?: ModelInfo;
}

/** Potong ringkasan agar tidak membanjiri konteks induk. */
export function trimSummary(text: string, limit: number = SUMMARY_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…\n[ringkasan dipotong ${text.length - limit} karakter]`;
}

/** Teks jawaban final anak (pesan assistant terakhir tanpa tool call). */
function lastAssistantText(session: AgentSession): string {
  const history = session.getHistory();
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]!;
    if (msg.role === "assistant" && (!msg.toolCalls || msg.toolCalls.length === 0)) {
      return msg.content;
    }
  }
  return "";
}

/**
 * Jalankan satu sesi anak (subagent) dengan konteks kosong:
 * - persetujuan autonomous (dalam workspace otomatis; sensitif/luar ditolak),
 * - anggaran sendiri; pemakaian digabung ke tracker induk setelah selesai,
 * - mode Plan read-only bila `readOnly: true`,
 * - tanpa tool `task` (kedalaman 1),
 * - hasil berupa ringkasan teks untuk induk.
 */
export async function runSubagent(
  deps: SubagentDeps,
  plan: SubagentPlan,
  signal: AbortSignal,
): Promise<SubagentResult> {
  const readOnly = plan.readOnly === true;
  const maxSteps = Math.min(MAX_TASK_STEPS, Math.max(1, plan.maxSteps ?? DEFAULT_TASK_STEPS));
  const maxCost =
    plan.maxCost && plan.maxCost > 0 ? Math.min(plan.maxCost, MAX_TASK_COST) : undefined;
  const mode: Mode = readOnly ? "plan" : "build";

  const childIo = new SubtaskIO(deps.io, "subtask");
  const approvals = new SubagentApprovals(childIo);
  const tracker = new UsageTracker();
  const registry = forkRegistry(deps.registry, readOnly);
  const resolvePath = createPathResolver({
    workspace: deps.workspace,
    permissions: deps.permissions,
    approvals,
    getMode: () => mode,
  });

  const child = new AgentSession(
    {
      ...deps,
      io: childIo,
      approvals,
      registry,
      tracker,
      resolvePath,
    },
    {
      model: deps.model,
      modelInfo: deps.modelInfo,
      mode,
      maxSteps,
      ...(maxCost !== undefined ? { maxCost } : {}),
    },
  );

  const childResult = await child.run(plan.prompt.trim(), signal);
  const last = lastAssistantText(child).trim();
  const summary = trimSummary(last.length > 0 ? last : childResult.message?.trim() || "Selesai.");

  // Gabungkan pemakaian anak ke tracker induk agar total sesi tetap ter-budget.
  deps.tracker.merge(tracker);

  return {
    summary,
    steps: childResult.steps,
    stopReason: childResult.stopReason,
    status: childResult.stopReason === "stop" ? "ok" : "limited",
  };
}