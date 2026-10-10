import path from "node:path";
import type { Mode, ModelInfo } from "../core/types.js";
import { AgentSession } from "../core/loop.js";
import { Approvals } from "../core/approvals.js";
import { CheckpointManager } from "../core/checkpoint.js";
import { createPathResolver } from "../safety/policy.js";
import { PermissionManager } from "../safety/permissions.js";
import { createWorkspace, type Workspace } from "../safety/workspace.js";
import { buildSystemPrompt } from "../memory/system_prompt.js";
import { discoverSkills, type Skill } from "../memory/skills.js";
import { CredentialStore } from "../config/credentials.js";
import {
  configDir,
  loadConfig,
  logsDir,
  rememberModel,
  sessionsDir,
  type AgentConfig,
} from "../config/config.js";
import { JsonlLogger, type Logger } from "../logging/logger.js";
import { SessionStore, deriveTitle, newSessionId, type SessionRecord } from "../sessions/store.js";
import { UsageTracker } from "../usage/tracker.js";
import { UsageStore } from "../usage/store.js";
import { createWebSearch } from "../util/websearch.js";
import { createProvider } from "../providers/factory.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ModelProvider } from "../providers/provider.js";
import { firstNonEmpty } from "../util/strings.js";
import { WebIO } from "./webio.js";
import type { ServerMessage, SessionSummary, WebState } from "./protocol.js";

/** Error konfigurasi pada server web (ditampilkan sebagai pesan, bukan crash). */
export class ServerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerConfigError";
  }
}

export interface WebAppOptions {
  cwd?: string;
  mode?: Mode;
  model?: string;
  provider?: string;
  maxSteps?: number;
  maxCost?: number;
  /** Setujui semua kategori konfirmasi. */
  yes?: boolean;
  /** Izinkan semua permintaan izin untuk sesi ini. */
  allowAll?: boolean;
  skills?: boolean;
  debug?: boolean;
}

function summarize(record: SessionRecord): SessionSummary {
  return {
    id: record.id,
    title: record.title,
    model: record.model,
    providerId: record.providerId,
    mode: record.mode,
    workspace: record.workspace,
    updatedAt: record.updatedAt,
    cost: record.cost,
    messages: record.history.length,
  };
}

/**
 * Orkestrasi satu sesi agent untuk antarmuka web. Menyimpan satu sesi aktif
 * (seperti CLI), namun bisa membuka sesi mana pun dari daftar — termasuk dari
 * workspace lain — dengan membangun ulang workspace & permission.
 */
export class WebApp {
  private workspace: Workspace;
  private readonly config: AgentConfig;
  private readonly credentials = new CredentialStore();
  private readonly logger: Logger;
  private readonly registry = new ToolRegistry();
  private readonly io: WebIO;
  private readonly approvals: Approvals;
  private permissions: PermissionManager;
  private skills: Skill[] = [];
  private skillsEnabled = false;
  private baseSystemPrompt = "";
  private provider!: ModelProvider;
  private providerKey = "";
  private record!: SessionRecord;
  private session!: AgentSession;
  private readonly store = new SessionStore();
  private readonly tracker = new UsageTracker();
  private readonly usageStore = new UsageStore(path.join(configDir(), "usage.jsonl"));
  private running = false;
  private controller: AbortController | undefined;

  private constructor(
    private readonly opts: WebAppOptions,
    workspace: Workspace,
    config: AgentConfig,
    sink: (message: ServerMessage) => void,
  ) {
    this.workspace = workspace;
    this.config = config;
    this.logger = new JsonlLogger(path.join(logsDir(), "agent.jsonl"), { debug: Boolean(opts.debug) });
    this.io = new WebIO(sink);
    this.permissions = new PermissionManager(workspace.root);
    this.approvals = new Approvals(this.io, {
      yes: Boolean(opts.yes),
      interactive: true,
      allowAll: Boolean(opts.allowAll),
    });
  }

  static async create(opts: WebAppOptions, sink: (message: ServerMessage) => void): Promise<WebApp> {
    const workspace = createWorkspace(opts.cwd);
    const config = await loadConfig();
    const app = new WebApp(opts, workspace, config, sink);
    await app.init();
    return app;
  }

  private async init(): Promise<void> {
    this.record = {
      id: newSessionId(),
      title: "(baru)",
      workspace: this.workspace.root,
      providerId: "",
      model: "",
      mode: this.opts.mode ?? "build",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      cost: 0,
      history: [],
    };

    this.skillsEnabled = this.opts.skills ?? this.config.skills ?? true;
    if (this.skillsEnabled) {
      this.skills = await discoverSkills({
        workspaceRoot: this.workspace.root,
        globalConfigDir: configDir(),
      });
    }

    await this.ensureProvider();
    const model = await this.resolveModel(
      this.provider,
      firstNonEmpty(this.opts.model, this.config.models?.[this.workspace.root]),
    );
    if (!model) {
      throw new ServerConfigError(
        "Model tidak diketahui. Tentukan dengan --model, atau jalankan `nex-agent` lalu /connect & /models.",
      );
    }
    this.record.model = model.id;
    this.record.providerId = this.providerKey;
    await this.buildSession(model.id, this.opts.mode ?? "build", [], [], model.info);
    await rememberModel(this.workspace.root, model.id);
  }

  private async ensureProvider(): Promise<void> {
    const key = firstNonEmpty(this.opts.provider, this.config.defaultProvider);
    if (!key) {
      throw new ServerConfigError(
        "Belum ada provider terhubung. Jalankan `nex-agent` lalu /connect lebih dulu.",
      );
    }
    const provider = await createProvider(key, this.credentials);
    if (!provider) {
      throw new ServerConfigError(`Provider tidak dikenal: ${key}. Jalankan /connect di CLI.`);
    }
    this.provider = provider;
    this.providerKey = key;
  }

  private async resolveModel(
    provider: ModelProvider,
    preferred?: string,
  ): Promise<{ id: string; info?: ModelInfo } | undefined> {
    let models: ModelInfo[] = [];
    try {
      models = await provider.listModels();
    } catch (err) {
      this.logger.warn("provider.list_models_failed", { error: (err as Error).message });
    }
    if (preferred) return { id: preferred, info: models.find((m) => m.id === preferred) };
    if (models.length === 0) return undefined;
    return { id: models[0]!.id, info: models[0] };
  }

  private async buildSession(
    model: string,
    mode: Mode,
    history: SessionRecord["history"],
    todos: SessionRecord["todos"] = [],
    info?: ModelInfo,
  ): Promise<void> {
    this.baseSystemPrompt = await buildSystemPrompt({
      workspaceRoot: this.workspace.root,
      globalConfigDir: configDir(),
      skills: this.skills,
      skillsEnabled: this.skillsEnabled,
    });
    const checkpoints = await CheckpointManager.load(
      path.join(sessionsDir(), this.record.id),
      this.logger,
    );
    const resolvePath = createPathResolver({
      workspace: this.workspace,
      permissions: this.permissions,
      approvals: this.approvals,
      getMode: () => this.session.getMode(),
    });
    this.session = new AgentSession(
      {
        provider: this.provider,
        providerId: this.providerKey,
        registry: this.registry,
        io: this.io,
        approvals: this.approvals,
        logger: this.logger,
        checkpoints,
        workspace: this.workspace,
        permissions: this.permissions,
        systemPrompt: this.baseSystemPrompt,
        resolvePath,
        tracker: this.tracker,
        search: createWebSearch(this.config.searchUrl),
        skills: this.skills,
        onUsage: (event) => this.usageStore.append(event),
        sessionId: this.record.id,
      },
      {
        model,
        mode,
        ...(info ? { modelInfo: info } : {}),
        maxSteps: this.opts.maxSteps,
        maxCost: this.opts.maxCost,
        history,
        todos,
      },
    );
    this.session.setProvider(this.provider, this.providerKey);
  }

  private async saveRecord(): Promise<void> {
    const history = this.session.getHistory();
    const firstUser = history.find((m) => m.role === "user");
    this.record = {
      ...this.record,
      providerId: this.providerKey,
      model: this.session.getModel(),
      mode: this.session.getMode(),
      title:
        this.record.title === "(baru)" && firstUser
          ? deriveTitle(firstUser.content)
          : this.record.title,
      updatedAt: new Date().toISOString(),
      cost: this.tracker.totals().cost,
      history,
      todos: this.session.getTodos(),
    };
    await this.store.save(this.record);
  }

  get workspaceRoot(): string {
    return this.workspace.root;
  }

  isBusy(): boolean {
    return this.running;
  }

  /** Jalankan satu prompt pengguna; mengembalikan hasil akhir proses. */
  async send(text: string): Promise<void> {
    if (this.running) {
      this.io.warn("Sesi sedang menjalankan tugas lain; tunggu hingga selesai.");
      return;
    }
    this.running = true;
    this.controller = new AbortController();
    this.io.emit({ type: "busy", on: true });
    try {
      await this.session.run(text, this.controller.signal);
    } catch (err) {
      this.io.error(`Terjadi kesalahan: ${(err as Error).message}`);
    } finally {
      this.running = false;
      this.controller = undefined;
      await this.saveRecord();
      this.io.emit({ type: "busy", on: false });
      await this.notifyState();
    }
  }

  interrupt(): void {
    this.controller?.abort();
  }

  setMode(mode: Mode): void {
    this.session.setMode(mode);
    void this.notifyState();
  }

  setAllowAll(value: boolean): void {
    this.approvals.setAllowAll(value);
    void this.notifyState();
  }

  allowAll(): boolean {
    return this.approvals.allowAll();
  }

  skillsList(): Array<{ name: string; description: string }> {
    return this.skills.map((s) => ({ name: s.name, description: s.description }));
  }

  async listSessions(): Promise<SessionSummary[]> {
    return (await this.store.list()).map(summarize);
  }

  currentSummary(): SessionSummary {
    return summarize(this.record);
  }

  getHistory(): SessionRecord["history"] {
    return this.session.getHistory();
  }

  async state(): Promise<WebState> {
    return {
      workspace: this.workspace.root,
      mode: this.session.getMode(),
      model: this.session.getModel(),
      provider: this.providerKey,
      allowAll: this.approvals.allowAll(),
      busy: this.running,
      skills: this.skillsList(),
      sessions: await this.listSessions(),
      current: this.currentSummary(),
    };
  }

  private async notifyState(): Promise<void> {
    this.io.emit({ type: "state", state: await this.state() });
  }

  private notifySession(): void {
    this.io.emit({
      type: "session",
      summary: this.currentSummary(),
      history: this.session.getHistory(),
    });
    this.io.emit({ type: "todos", items: this.session.getTodos() });
  }

  /** Buat sesi baru (menyimpan sesi aktif lebih dulu). */
  async newSession(): Promise<void> {
    await this.saveRecord();
    const info = this.session.getModelInfo();
    this.record = {
      id: newSessionId(),
      title: "(baru)",
      workspace: this.workspace.root,
      providerId: this.providerKey,
      model: this.session.getModel(),
      mode: this.session.getMode(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      cost: 0,
      history: [],
    };
    await this.buildSession(
      this.session.getModel(),
      this.session.getMode(),
      [],
      [],
      info,
    );
    this.notifySession();
    await this.notifyState();
  }

  /** Buka sesi berdasarkan id. Mengembalikan undefined bila tidak ada. */
  async openSession(id: string): Promise<SessionRecord | undefined> {
    const target = await this.store.load(id);
    if (!target) return undefined;
    await this.saveRecord();
    await this.activateRecord(target);
    this.notifySession();
    await this.notifyState();
    return target;
  }

  private async activateRecord(record: SessionRecord): Promise<void> {
    this.record = record;
    if (record.workspace && record.workspace !== this.workspace.root) {
      try {
        this.workspace = createWorkspace(record.workspace);
        this.permissions = new PermissionManager(this.workspace.root);
      } catch {
        // tetap pakai workspace lama bila path tidak valid
      }
    }
    if (record.providerId && record.providerId !== this.providerKey) {
      const provider = await createProvider(record.providerId, this.credentials);
      if (provider) {
        this.provider = provider;
        this.providerKey = record.providerId;
      }
    }
    const model = firstNonEmpty(record.model, this.session.getModel()) ?? record.model;
    await this.buildSession(model, record.mode, record.history, record.todos ?? []);
  }

  async deleteSession(id: string): Promise<boolean> {
    const ok = await this.store.delete(id);
    if (id === this.record.id) {
      await this.newSession();
    } else {
      await this.notifyState();
    }
    return ok;
  }

  async renameSession(id: string, title: string): Promise<void> {
    if (id === this.record.id) {
      this.record.title = title;
      await this.saveRecord();
      await this.notifyState();
      return;
    }
    const record = await this.store.load(id);
    if (!record) return;
    record.title = title;
    record.updatedAt = new Date().toISOString();
    await this.store.save(record);
    await this.notifyState();
  }

  /** Tolak semua approval yang menggantung (mis. semua klien terputus). */
  cancelPendingApprovals(): void {
    this.io.cancelAll();
  }

  /** Jawab approval/path/sensitive berdasarkan id. */
  resolveApproval(id: string, value: unknown): boolean {
    return this.io.resolve(id, value);
  }

  async close(): Promise<void> {
    this.logger.info("web.close", { id: this.record?.id });
    if (this.logger instanceof JsonlLogger) this.logger.close();
  }
}
