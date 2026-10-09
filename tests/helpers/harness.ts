import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChatRequest, ModelProvider, StreamEvent } from "../../src/providers/provider.js";
import type { ModelInfo, Mode, TokenUsage } from "../../src/core/types.js";
import { AgentSession, type RunResult } from "../../src/core/loop.js";
import type { AgentIO, ConfirmDecision } from "../../src/core/io.js";
import { silentIO } from "../../src/core/io.js";
import { Approvals } from "../../src/core/approvals.js";
import { CheckpointManager } from "../../src/core/checkpoint.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionManager } from "../../src/safety/permissions.js";
import { createPathResolver } from "../../src/safety/policy.js";
import { createWorkspace } from "../../src/safety/workspace.js";
import { nullLogger } from "../../src/logging/logger.js";
import { UsageTracker } from "../../src/usage/tracker.js";

export interface ScriptedTurn {
  text?: string;
  thinking?: string;
  toolCalls?: Array<{ id?: string; name: string; arguments: string }>;
  usage?: Partial<TokenUsage>;
  stop?: "stop" | "tool_use" | "length";
}

export type Script = ScriptedTurn[] | ((turn: number, req: ChatRequest) => ScriptedTurn);

/** Provider palsu dengan skenario tetap. */
export class FakeProvider implements ModelProvider {
  readonly id = "fake";
  readonly label = "Fake";
  calls = 0;

  constructor(private readonly script: Script) {}

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "fake-model", contextWindow: 128_000, pricing: { input: 1, output: 2 } }];
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const index = this.calls++;
    const turn =
      typeof this.script === "function"
        ? this.script(index, req)
        : (this.script[index] ?? { text: "selesai" });

    if (turn.thinking) yield { type: "thinking", text: turn.thinking };
    if (turn.text) yield { type: "text", text: turn.text };
    for (let i = 0; i < (turn.toolCalls ?? []).length; i++) {
      const call = turn.toolCalls![i]!;
      yield {
        type: "tool_call",
        call: { id: call.id ?? `call_${index}_${i}`, name: call.name, arguments: call.arguments },
      };
    }
    yield { type: "usage", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, ...turn.usage } };
    yield {
      type: "done",
      stopReason: turn.toolCalls?.length ? "tool_use" : (turn.stop ?? "stop"),
    };
  }
}

export interface HarnessOptions {
  script: Script;
  mode?: Mode;
  maxSteps?: number;
  maxCost?: number;
  registry?: ToolRegistry;
  io?: AgentIO;
  decisions?: ConfirmDecision;
  workspaceRoot?: string;
  systemPrompt?: string;
}

export interface Harness {
  session: AgentSession;
  io: AgentIO;
  provider: FakeProvider;
  registry: ToolRegistry;
  workspaceRoot: string;
  checkpoints: CheckpointManager;
  permissions: PermissionManager;
  tracker: UsageTracker;
  run(text?: string, signal?: AbortSignal): Promise<RunResult>;
  cleanup(): Promise<void>;
}

export async function createHarness(options: HarnessOptions): Promise<Harness> {
  const workspaceRoot =
    options.workspaceRoot ?? (await fs.mkdtemp(path.join(os.tmpdir(), "nex-agent-test-")));
  await fs.mkdir(path.join(workspaceRoot, ".git"), { recursive: true });

  const workspace = createWorkspace(workspaceRoot);
  const permissions = new PermissionManager(workspace.root);
  const io = options.io ?? silentIO(options.decisions ?? "yes");
  const approvals = new Approvals(io, { yes: true, interactive: false });
  const registry = options.registry ?? new ToolRegistry();
  const tracker = new UsageTracker();
  const provider = new FakeProvider(options.script);
  const checkpoints = await CheckpointManager.load(path.join(workspaceRoot, ".agent-state"));

  const resolvePath = createPathResolver({
    workspace,
    permissions,
    approvals,
    getMode: () => session.getMode(),
  });

  const session = new AgentSession(
    {
      provider,
      providerId: "fake",
      registry,
      io,
      approvals,
      logger: nullLogger,
      checkpoints,
      workspace,
      permissions,
      systemPrompt: options.systemPrompt ?? "test",
      resolvePath,
      tracker,
      sleep: async () => {},
    },
    {
      model: "fake-model",
      mode: options.mode ?? "build",
      modelInfo: { id: "fake-model", contextWindow: 128_000, pricing: { input: 1, output: 2 } },
      ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
      ...(options.maxCost !== undefined ? { maxCost: options.maxCost } : {}),
      retries: 0,
    },
  );

  return {
    session,
    io,
    provider,
    registry,
    workspaceRoot,
    checkpoints,
    permissions,
    tracker,
    run: (text = "kerjakan tugas", signal = new AbortController().signal) =>
      session.run(text, signal),
    cleanup: async () => {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    },
  };
}
