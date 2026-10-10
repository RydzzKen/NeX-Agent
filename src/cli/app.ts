import path from "node:path";
import type { Mode, ModelInfo, StopReason } from "../core/types.js";
import { AgentSession } from "../core/loop.js";
import { Approvals } from "../core/approvals.js";
import { CheckpointManager } from "../core/checkpoint.js";
import { ContextManager } from "../core/context.js";
import { TodoStore } from "../core/todos.js";
import type { AgentIO } from "../core/io.js";
import type { ModelProvider } from "../providers/provider.js";
import { createProvider } from "../providers/factory.js";
import { ToolRegistry } from "../tools/registry.js";
import { createPathResolver } from "../safety/policy.js";
import { PermissionManager } from "../safety/permissions.js";
import { createWorkspace, type Workspace } from "../safety/workspace.js";
import { loadAgentsMd } from "../memory/agents_md.js";
import { discoverSkills, formatSkillsForPrompt, type Skill } from "../memory/skills.js";
import { CredentialStore } from "../config/credentials.js";
import {
  configDir,
  loadConfig,
  logsDir,
  rememberModel,
  saveConfig,
  sessionsDir,
  type AgentConfig,
} from "../config/config.js";
import { JsonlLogger, type Logger } from "../logging/logger.js";
import { SessionStore, deriveTitle, newSessionId, selectSession, type SessionRecord } from "../sessions/store.js";
import { UsageTracker } from "../usage/tracker.js";
import { UsageStore, type UsageRange } from "../usage/store.js";
import { createWebSearch } from "../util/websearch.js";
import { renderDiff } from "../util/diff.js";
import { color } from "../util/color.js";
import { firstNonEmpty } from "../util/strings.js";
import { todoHeader, todoLines } from "../util/todos.js";
import { renderCrossSession, renderUsage } from "./usage.js";
import { runConnect } from "./connect.js";
import { CUSTOM_MODEL_LABEL, cleanModelName, resolveModelChoice } from "./models.js";
import { TerminalIO } from "./render.js";
import { Prompter, PROMPT_EOF } from "./prompt.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface CliOptions {
  goal?: string;
  mode?: Mode;
  model?: string;
  provider?: string;
  maxSteps?: number;
  maxCost?: number;
  yes?: boolean;
  resume?: string;
  continue?: boolean;
  cwd?: string;
  allowPath?: string[];
  /** Izinkan semua permintaan persetujuan untuk sesi ini. */
  allowAll?: boolean;
  thinking?: boolean;
  /** Render markdown pada jawaban model (default true). */
  markdown?: boolean;
  /** Muat skill dari SKILL.md (default true). */
  skills?: boolean;
  debug?: boolean;
  json?: boolean;
}

interface ResolvedModel {
  id: string;
  info?: ModelInfo;
}

const SLASH_HELP: Array<[string, string]> = [
  ["/connect", "hubungkan provider"],
  ["/models [nomor|0|nama]", "lihat/ganti model (0 = custom)"],
  ["/plan", "pindah ke mode Plan (read-only)"],
  ["/build", "pindah ke mode Build (eksekusi)"],
  ["/sessions", "daftar sesi"],
  ["/resume <n>", "lanjut sesi ke-n (atau /resume <id>)"],
  ["/new", "mulai sesi baru"],
  ["/clear", "bersihkan riwayat sesi ini"],
  ["/rename <judul>", "ganti judul sesi"],
  ["/delete", "hapus sesi ini"],
  ["/undo [n]", "batalkan perubahan file (ke sebelum langkah n)"],
  ["/usage [today|week|all|<id>]", "pemakaian token & biaya"],
  ["/permissions [revoke <path>]", "lihat/cabut izin luar workspace"],
  ["/allow-all [on|off]", "izinkan semua izin untuk sesi ini"],
  ["/thinking [on|off]", "tampilkan/sembunyikan thinking"],
  ["/markdown [on|off]", "render markdown pada jawaban"],
  ["/skills", "daftar skill yang tersedia"],
  ["/skill <nama>|off", "aktifkan/paksa skill atau lepas semua"],
  ["/todos", "tampilkan daftar tugas (checklist)"],
  ["/exit", "keluar dari sesi chat (atau Ctrl+D)"],
  ["/help", "bantuan"],
];

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function exitCodeFor(reason: StopReason): number {
  switch (reason) {
    case "stop":
      return 0;
    case "interrupted":
      return 130;
    case "max_steps":
    case "max_cost":
    case "repetition":
      return 3;
    default:
      return 1;
  }
}

export class ChatApp {
  private session!: AgentSession;
  private provider!: ModelProvider;
  private providerKey!: string;
  private record!: SessionRecord;
  private checkpoints!: CheckpointManager;
  private readonly store = new SessionStore();
  private readonly tracker = new UsageTracker();
  private readonly usageStore = new UsageStore(path.join(configDir(), "usage.jsonl"));
  private readonly registry = new ToolRegistry();
  private skills: Skill[] = [];
  private activeSkills: Skill[] = [];
  private skillsEnabled = false;
  private baseSystemPrompt = "";

  private constructor(
    private readonly workspace: Workspace,
    private config: AgentConfig,
    private readonly credentials: CredentialStore,
    private readonly logger: Logger,
    private readonly prompter: Prompter,
    private readonly io: TerminalIO,
    private readonly permissions: PermissionManager,
    private readonly approvals: Approvals,
    private readonly opts: CliOptions,
  ) {}

  static async create(opts: CliOptions): Promise<ChatApp> {
    const workspace = createWorkspace(opts.cwd);
    const config = await loadConfig();
    const credentials = new CredentialStore();
    const logger = new JsonlLogger(path.join(logsDir(), "agent.jsonl"), { debug: Boolean(opts.debug) });
    const prompter = new Prompter();
    const io = new TerminalIO(prompter, {
      thinking: opts.thinking !== false,
      json: Boolean(opts.json),
      markdown: opts.markdown ?? config.markdown ?? true,
    });
    const permissions = new PermissionManager(workspace.root);
    for (const p of opts.allowPath ?? []) {
      permissions.allowStanding(p, "read", "allow-path");
      permissions.allowStanding(p, "write", "allow-path");
    }
    const approvals = new Approvals(io, {
      yes: Boolean(opts.yes),
      interactive: Boolean(process.stdin.isTTY) && !opts.json,
      allowAll: Boolean(opts.allowAll),
    });

    const app = new ChatApp(
      workspace,
      config,
      credentials,
      logger,
      prompter,
      io,
      permissions,
      approvals,
      opts,
    );
    await app.init();
    return app;
  }

  private async init(): Promise<void> {
    // Sesi: resume / continue / baru.
    let record: SessionRecord | undefined;
    if (this.opts.resume) {
      record = await this.store.load(this.opts.resume);
      if (!record) throw new ConfigError(`Sesi tidak ditemukan: ${this.opts.resume}`);
    } else if (this.opts.continue) {
      record = await this.store.lastForWorkspace(this.workspace.root);
    }

    this.record = record ?? {
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

    const sessionDir = path.join(sessionsDir(), this.record.id);
    this.checkpoints = await CheckpointManager.load(sessionDir, this.logger);

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
      firstNonEmpty(
        this.opts.model,
        record?.model,
        this.config.models?.[this.workspace.root],
      ),
    );
    if (!model) {
      throw new ConfigError(
        "Model tidak diketahui. Tentukan dengan --model atau jalankan /models setelah /connect.",
      );
    }
    this.record.model = model.id;
    this.record.providerId = this.providerKey;

    await this.buildSession(
      model,
      this.opts.mode ?? record?.mode ?? "build",
      record?.history ?? [],
      record?.todos ?? [],
    );
    // Model terakhir diingat per workspace (PRD §7) agar run berikutnya tidak
    // perlu memilih ulang.
    await rememberModel(this.workspace.root, model.id);
  }

  private async ensureProvider(): Promise<void> {
    const key = firstNonEmpty(
      this.opts.provider,
      this.record.providerId,
      this.config.defaultProvider,
    );
    let provider = key ? await createProvider(key, this.credentials) : undefined;

    if (!provider && Boolean(process.stdin.isTTY) && !this.opts.json) {
      const result = await runConnect(this.prompter, this.credentials);
      if (result) {
        provider = result.provider;
        this.providerKey = result.providerKey;
        this.config = await saveConfig({ defaultProvider: result.providerKey });
      }
    }

    if (!provider || !this.providerKey) {
      if (provider && key) this.providerKey = key;
    }
    if (!provider) {
      throw new ConfigError(
        "Belum ada provider terhubung. Jalankan /connect (interaktif) untuk menghubungkan Anthropic, OpenAI, atau custom provider.",
      );
    }
    if (!this.providerKey) this.providerKey = key ?? provider.id;
    this.provider = provider;
  }

  private async resolveModel(provider: ModelProvider, preferred?: string): Promise<ResolvedModel | undefined> {
    let models: ModelInfo[] = [];
    try {
      models = await provider.listModels();
    } catch (err) {
      this.logger.warn("provider.list_models_failed", { error: (err as Error).message });
    }

    if (preferred) {
      return { id: preferred, info: models.find((m) => m.id === preferred) };
    }
    if (models.length === 0) {
      if (!Boolean(process.stdin.isTTY)) return undefined;
      const manual = cleanModelName(await this.prompter.question("Nama model: "));
      return manual ? { id: manual } : undefined;
    }
    if (models.length === 1 || !Boolean(process.stdin.isTTY)) {
      return { id: models[0]!.id, info: models[0] };
    }
    process.stdout.write("Model tersedia:\n");
    process.stdout.write(`  0) ${CUSTOM_MODEL_LABEL}\n`);
    models.slice(0, 40).forEach((m, i) => process.stdout.write(`  ${i + 1}) ${m.id}\n`));
    const answer = await this.prompter.question("Pilih model (0 = custom, nomor, atau nama): ");
    const choice = resolveModelChoice(answer, models);
    if (choice.kind === "model") return { id: choice.model.id, info: choice.model };
    if (choice.kind === "custom") {
      const manual = cleanModelName(await this.prompter.question("Nama model custom: "));
      return manual ? { id: manual } : { id: models[0]!.id, info: models[0] };
    }
    return { id: models[0]!.id, info: models[0] };
  }

  private async buildSystemPrompt(): Promise<string> {
    const memory = await loadAgentsMd({
      workspaceRoot: this.workspace.root,
      globalConfigDir: configDir(),
    });
    const rules = [
      "- Selalu jawab setiap tool call dengan memanggil tool; jangan mengarang hasil.",
      "- Di mode Plan kamu hanya boleh membaca; jangan menulis file.",
      "- Buat perubahan kecil dan terarah; jangan mengubah file di luar tugas.",
      "- Perubahan file memerlukan persetujuan dan menampilkan diff; jelaskan alasan singkat.",
      "- Untuk tugas berlapis, pakai tool todo_write untuk mencatat rencana sebagai checklist, lalu perbarui statusnya (pending/in_progress/completed) seiring kemajuan.",
      "- Jangan pernah menulis kredensial ke file atau output.",
    ];
    if (this.skillsEnabled) {
      rules.push(
        "- Muat instruksi skill lewat tool `skill` saat tugas cocok dengan skill yang terdaftar.",
        "- Bila pengguna meminta, kamu boleh membuat skill baru dengan menulis `skills/<nama>/SKILL.md` (frontmatter `name` + `description`). Perubahan file tetap butuh konfirmasi.",
      );
    }
    const header = [
      "Kamu adalah agent CLI untuk rekayasa perangkat lunak, berjalan di terminal.",
      `Workspace: ${this.workspace.root}`,
      "",
      "Aturan:",
      ...rules,
    ].join("\n");
    const base = memory.content ? `${header}\n\n# Konteks proyek (AGENTS.md)\n${memory.content}` : header;
    const skillsSection = formatSkillsForPrompt(this.skills);
    this.baseSystemPrompt = skillsSection ? `${base}\n\n${skillsSection}` : base;
    return this.baseSystemPrompt;
  }

  /** System prompt dasar + skill yang diaktifkan manual lewat `/skill`. */
  private composeSystemPrompt(): string {
    let prompt = this.baseSystemPrompt;
    for (const skill of this.activeSkills) {
      prompt += `\n\n# Skill aktif (dipilih pengguna): ${skill.name}\n${skill.body}`;
    }
    return prompt;
  }

  private async buildSession(
    model: ResolvedModel,
    mode: Mode,
    history: SessionRecord["history"],
    todos: SessionRecord["todos"] = [],
  ): Promise<void> {
    await this.buildSystemPrompt();
    const systemPrompt = this.composeSystemPrompt();
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
        io: this.io as AgentIO,
        approvals: this.approvals,
        logger: this.logger,
        checkpoints: this.checkpoints,
        workspace: this.workspace,
        permissions: this.permissions,
        systemPrompt,
        resolvePath,
        tracker: this.tracker,
        search: createWebSearch(this.config.searchUrl),
        skills: this.skills,
        onUsage: (event) => this.usageStore.append(event),
        sessionId: this.record.id,
      },
      {
        model: model.id,
        mode,
        ...(model.info ? { modelInfo: model.info } : {}),
        maxSteps: this.opts.maxSteps ?? this.config.maxSteps,
        maxCost: this.opts.maxCost ?? this.config.maxCost,
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
      title: this.record.title === "(baru)" && firstUser ? deriveTitle(firstUser.content) : this.record.title,
      updatedAt: new Date().toISOString(),
      cost: this.tracker.totals().cost,
      history,
      todos: this.session.getTodos(),
    };
    await this.store.save(this.record);
  }

  private banner(): void {
    if (this.opts.json) return;
    const markers = this.workspace.markers.length ? `  (${this.workspace.markers.slice(0, 2).join(", ")})` : "";
    process.stdout.write(
      `${color.green("●")} workspace  ${this.workspace.root}${markers}\n` +
        `${color.green("●")} mode       ${this.session.getMode()}\n` +
        `${color.green("●")} model      ${this.providerKey} / ${this.session.getModel()}\n\n`,
    );
  }

  /** Jalankan satu tugas (mode non-chat). */
  async runGoal(goal: string): Promise<number> {
    this.banner();
    const controller = new AbortController();
    const cleanup = this.installInterrupt(controller);
    let code: number;
    try {
      const result = await this.session.run(goal, controller.signal);
      code = exitCodeFor(result.stopReason);
    } finally {
      cleanup();
      await this.saveRecord();
      await this.close();
    }
    if (!this.opts.json) process.stdout.write("\n");
    return code;
  }

  /** REPL chat interaktif. */
  async runRepl(): Promise<number> {
    this.banner();
    this.io.info("Ketik /help untuk daftar perintah. Ctrl+C dua kali untuk keluar.");
    for (;;) {
      const prompt = `${color.gray("[")}${this.session.getMode()}${color.gray("]")} › `;
      const line = (await this.prompter.question(`\n${prompt}`)).trim();
      if (line === PROMPT_EOF) break;
      if (line === "") continue;
      if (line.startsWith("/")) {
        const action = await this.handleSlash(line);
        if (action === "exit") break;
        continue;
      }
      const controller = new AbortController();
      const cleanup = this.installInterrupt(controller);
      try {
        await this.session.run(line, controller.signal);
      } finally {
        cleanup();
        await this.saveRecord();
      }
    }
    await this.close();
    return 0;
  }

  private installInterrupt(controller: AbortController): () => void {
    let count = 0;
    const handler = (): void => {
      count++;
      if (count === 1) {
        this.io.warn("Menghentikan… (Ctrl+C lagi untuk keluar sekarang)");
        controller.abort();
      } else {
        process.stdout.write("\n");
        process.exit(130);
      }
    };
    process.on("SIGINT", handler);
    return () => process.removeListener("SIGINT", handler);
  }

  private async handleSlash(line: string): Promise<"continue" | "exit"> {
    const [cmdRaw, ...args] = line.split(/\s+/);
    const cmd = cmdRaw ?? "";
    switch (cmd) {
      case "/help":
        this.printHelp();
        return "continue";
      case "/exit":
      case "/quit":
        return "exit";
      case "/plan":
        this.session.setMode("plan");
        return "continue";
      case "/build":
        this.session.setMode("build");
        return "continue";
      case "/connect":
        await this.commandConnect();
        return "continue";
      case "/models":
        await this.commandModels(args[0]);
        return "continue";
      case "/sessions":
        await this.commandSessions();
        return "continue";
      case "/resume":
        await this.commandResume(args[0]);
        return "continue";
      case "/new":
        await this.commandNew();
        return "continue";
      case "/clear":
        this.session.clearHistory();
        this.io.info("Riwayat sesi dibersihkan.");
        await this.saveRecord();
        return "continue";
      case "/rename":
        await this.commandRename(args.join(" "));
        return "continue";
      case "/delete":
        await this.commandDelete();
        return "continue";
      case "/undo":
        await this.commandUndo(args[0]);
        return "continue";
      case "/usage":
        await this.commandUsage(args[0]);
        return "continue";
      case "/permissions":
        await this.commandPermissions(args);
        return "continue";
      case "/allow-all": {
        const value = args[0];
        const on = value === undefined ? !this.approvals.allowAll() : value === "on";
        this.approvals.setAllowAll(on);
        this.io.info(
          on
            ? "Izinkan semua izin untuk sesi ini: AKTIF (mode Plan tetap read-only)."
            : "Izinkan semua izin untuk sesi ini: nonaktif.",
        );
        return "continue";
      }
      case "/thinking": {
        const value = args[0];
        const on = value === undefined ? !this.io.thinkingEnabled() : value === "on";
        this.io.setThinking(on);
        this.io.info(`Thinking ${on ? "aktif" : "nonaktif"}.`);
        return "continue";
      }
      case "/markdown": {
        const value = args[0];
        const on = value === undefined ? !this.io.isMarkdownEnabled() : value === "on";
        this.io.setMarkdown(on);
        this.config = await saveConfig({ markdown: on });
        this.io.info(`Markdown ${on ? "aktif" : "nonaktif"}.`);
        return "continue";
      }
      case "/skills":
        this.commandSkills();
        return "continue";
      case "/skill":
        this.commandSkill(args[0]);
        return "continue";
      case "/todos":
        this.commandTodos();
        return "continue";
      default:
        this.io.warn(`Perintah tidak dikenal: ${cmd}. Ketik /help.`);
        return "continue";
    }
  }

  private printHelp(): void {
    process.stdout.write("\nPerintah:\n");
    for (const [name, desc] of SLASH_HELP) {
      process.stdout.write(`  ${name.padEnd(32)}${desc}\n`);
    }
    process.stdout.write("\n");
  }

  private async commandConnect(): Promise<void> {
    const result = await runConnect(this.prompter, this.credentials);
    if (!result) return;
    this.provider = result.provider;
    this.providerKey = result.providerKey;
    this.config = await saveConfig({ defaultProvider: result.providerKey });
    const model = await this.resolveModel(this.provider, undefined);
    if (!model) {
      this.io.warn("Tidak ada model terpilih.");
      return;
    }
    this.session.setProvider(this.provider, this.providerKey);
    this.session.setModel(model.id, model.info);
    this.record.model = model.id;
    this.record.providerId = result.providerKey;
    await rememberModel(this.workspace.root, model.id);
    this.io.info(`Terhubung ke ${result.providerKey} / ${model.id}.`);
  }

  private async commandModels(arg?: string): Promise<void> {
    let models: ModelInfo[] = [];
    try {
      models = await this.provider.listModels();
    } catch (err) {
      this.io.error(`Gagal memuat model: ${(err as Error).message}`);
    }

    if (!arg) {
      process.stdout.write(`\nModel untuk ${this.providerKey} (${models.length}):\n`);
      process.stdout.write(`    0) ${CUSTOM_MODEL_LABEL}\n`);
      models.forEach((m, i) => process.stdout.write(`  ${String(i + 1).padStart(3)}) ${m.id}\n`));
      process.stdout.write("\n  Ganti dengan /models <nomor>, /models 0 (custom), atau /models <nama>.\n\n");
      return;
    }

    const choice = resolveModelChoice(arg, models);
    if (choice.kind === "custom") {
      const name = cleanModelName(await this.prompter.question("Nama model custom: "));
      if (!name) {
        this.io.warn("Nama model kosong; dibatalkan.");
        return;
      }
      await this.switchModel({ id: name });
      return;
    }
    if (choice.kind === "model") {
      await this.switchModel({ id: choice.model.id, info: choice.model });
      return;
    }
    this.io.warn(`Pilihan tidak valid: ${arg}. Gunakan nomor, 0, atau nama model.`);
  }

  /** Ganti model sesi aktif dan ingat pilihan untuk run berikutnya. */
  private async switchModel(model: ResolvedModel): Promise<void> {
    this.session.setModel(model.id, model.info);
    this.record.model = model.id;
    this.record.providerId = this.providerKey;
    await rememberModel(this.workspace.root, model.id);
    await this.saveRecord();
    this.io.info(`Model diganti ke ${this.providerKey} / ${model.id}.`);
  }

  private async commandSessions(): Promise<void> {
    const sessions = await this.store.listForWorkspace(this.workspace.root);
    if (sessions.length === 0) {
      this.io.info("Belum ada sesi untuk workspace ini.");
      return;
    }
    process.stdout.write("\nSesi:\n");
    sessions.forEach((s, i) => {
      const active = s.id === this.record.id ? color.green("●") : " ";
      process.stdout.write(
        `  ${active} ${String(i + 1).padStart(2)}) ${s.updatedAt.slice(0, 16).replace("T", " ")}  ${(s.model || "-").padEnd(20)}  ${s.title}\n`,
      );
    });
    process.stdout.write("\n  Gunakan /resume <nomor> untuk melanjutkan sesi.\n\n");
  }

  /** Lanjutkan sesi berdasarkan nomor (urutan /sessions) atau id. */
  private async commandResume(arg?: string): Promise<void> {
    const sessions = await this.store.listForWorkspace(this.workspace.root);
    if (sessions.length === 0) {
      this.io.info("Belum ada sesi untuk workspace ini.");
      return;
    }
    if (!arg) {
      await this.commandSessions();
      return;
    }

    const target = selectSession(sessions, arg) ?? (await this.store.load(arg));
    if (!target || target.workspace !== this.workspace.root) {
      this.io.warn(`Sesi tidak ditemukan: ${arg}. Lihat /sessions.`);
      return;
    }
    if (target.id === this.record.id) {
      this.io.info("Sudah berada di sesi ini.");
      return;
    }

    await this.saveRecord();
    await this.activateRecord(target);
    this.io.info(`Melanjutkan sesi: ${target.title} (${target.id})`);
  }

  /** Pasang sebuah record sebagai sesi aktif (resume). */
  private async activateRecord(record: SessionRecord): Promise<void> {
    this.record = record;
    this.checkpoints = await CheckpointManager.load(
      path.join(sessionsDir(), record.id),
      this.logger,
    );

    const providerKey = record.providerId;
    if (providerKey && providerKey !== this.providerKey) {
      const provider = await createProvider(providerKey, this.credentials);
      if (provider) {
        this.provider = provider;
        this.providerKey = providerKey;
      }
    }

    const model = firstNonEmpty(record.model, this.session.getModel()) ?? "";
    await this.buildSession({ id: model }, record.mode, record.history, record.todos ?? []);
  }

  private async commandNew(): Promise<void> {
    await this.saveRecord();
    this.activeSkills = [];
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
    this.checkpoints = await CheckpointManager.load(
      path.join(sessionsDir(), this.record.id),
      this.logger,
    );
    const info = this.session.getModelInfo();
    await this.buildSession(
      { id: this.session.getModel(), ...(info ? { info } : {}) },
      this.session.getMode(),
      [],
    );
    this.io.info(`Sesi baru: ${this.record.id}`);
  }

  private async commandRename(title: string): Promise<void> {
    if (!title.trim()) {
      this.io.warn("Judul kosong.");
      return;
    }
    this.record.title = title.trim();
    await this.saveRecord();
    this.io.info(`Judul sesi: ${this.record.title}`);
  }

  private async commandDelete(): Promise<void> {
    await this.store.delete(this.record.id);
    this.io.info(`Sesi ${this.record.id} dihapus.`);
    await this.commandNew();
  }

  private async commandUndo(arg?: string): Promise<void> {
    const step = arg ? Number.parseInt(arg, 10) : undefined;
    const result =
      step !== undefined && Number.isFinite(step)
        ? await this.checkpoints.undoTostep(step, this.workspace.root)
        : await this.checkpoints.undoLast(this.workspace.root);
    if (result.entries.length === 0) {
      this.io.info("Tidak ada perubahan file yang bisa dibatalkan.");
      return;
    }
    for (const entry of result.entries) {
      this.io.diff(renderDiff(entry.after ?? "", entry.before ?? "", entry.display));
    }
    this.io.info(`${result.entries.length} file dikembalikan.`);
  }

  private async commandUsage(arg?: string): Promise<void> {
    if (arg === "today" || arg === "week" || arg === "all") {
      const summary = await this.usageStore.aggregate(arg as UsageRange);
      process.stdout.write(renderCrossSession(summary, arg) + "\n");
      return;
    }
    if (arg) {
      const record = await this.store.load(arg);
      if (record) {
        this.io.info(
          `Sesi ${record.id}: ${record.title} — ${record.model}, biaya ~$${record.cost.toFixed(4)}, ${record.history.length} pesan.`,
        );
        return;
      }
    }
    const usedTokens = new ContextManager(this.session.getModelInfo()?.contextWindow).estimate(
      this.session.getHistory(),
    );
    process.stdout.write(
      renderUsage(this.tracker, {
        ...(this.session.getModelInfo()?.contextWindow
          ? { contextWindow: this.session.getModelInfo()!.contextWindow }
          : {}),
        usedTokens,
        ...(this.opts.maxCost ?? this.config.maxCost
          ? { maxCost: this.opts.maxCost ?? this.config.maxCost! }
          : {}),
      }) + "\n",
    );
  }

  private async commandPermissions(args: string[]): Promise<void> {
    if (args[0] === "revoke" && args[1]) {
      const ok = this.permissions.revoke(args[1]);
      this.io.info(ok ? `Izin dicabut: ${args[1]}` : `Tidak ada izin tercatat untuk: ${args[1]}`);
      return;
    }
    const list = this.permissions.list();
    if (list.length === 0) {
      const suffix = this.approvals.allowAll() ? " (allow-all AKTIF untuk sesi ini)" : "";
      this.io.info(`Belum ada izin akses luar workspace pada sesi ini${suffix}.`);
      return;
    }
    process.stdout.write("\nIzin akses luar workspace:\n");
    for (const record of list) {
      process.stdout.write(
        `  ${record.access.padEnd(6)} ${record.standing ? "diingat" : "sekali"}  ${record.origin.padEnd(11)} ${record.path}\n`,
      );
    }
    process.stdout.write("\n");
  }

  private commandSkills(): void {
    if (this.skills.length === 0) {
      this.io.info(
        "Belum ada skill. Letakkan folder berisi SKILL.md di ./skills, ./.nex-agent/skills, atau ~/.config/agent/skills.",
      );
      return;
    }
    process.stdout.write("\nSkill tersedia (dimuat otomatis saat relevan):\n");
    for (const skill of this.skills) {
      const active = this.activeSkills.some((a) => a.name === skill.name) ? color.green("●") : " ";
      process.stdout.write(
        `  ${active} ${skill.name.padEnd(24)} ${truncate(skill.description, 60)}\n`,
      );
    }
    process.stdout.write("\n  Paksa aktif: /skill <nama>  ·  lepas semua: /skill off\n\n");
  }

  private commandSkill(name?: string): void {
    if (!name || name === "off") {
      this.activeSkills = [];
      this.session.setSystemPrompt(this.composeSystemPrompt());
      if (!name) {
        this.commandSkills();
        return;
      }
      this.io.info("Skill yang dipaksa aktif dilepas.");
      return;
    }
    const skill = this.skills.find((s) => s.name === name);
    if (!skill) {
      this.io.warn(`Skill tidak ditemukan: ${name}. Lihat /skills.`);
      return;
    }
    if (this.activeSkills.some((s) => s.name === name)) {
      this.io.info(`Skill ${name} sudah aktif.`);
      return;
    }
    this.activeSkills.push(skill);
    this.session.setSystemPrompt(this.composeSystemPrompt());
    this.io.info(`Skill ${name} dipaksa aktif untuk sesi ini.`);
  }

  private commandTodos(): void {
    const todos = this.session.getTodos();
    if (todos.length === 0) {
      this.io.info("Belum ada daftar tugas. Minta agent merencanakan tugas untuk mengisinya.");
      return;
    }
    const counts = new TodoStore(todos).counts();
    process.stdout.write(
      `\n${todoHeader(todos)}  (${counts.inProgress} berjalan, ${counts.pending} menunggu, ${counts.cancelled} dibatalkan)\n`,
    );
    for (const line of todoLines(todos)) process.stdout.write(`  ${line}\n`);
    process.stdout.write("\n");
  }

  private async close(): Promise<void> {
    this.logger.info("session.close", { id: this.record.id });
    if (this.logger instanceof JsonlLogger) this.logger.close();
    this.prompter.close();
  }
}

export { exitCodeFor };
