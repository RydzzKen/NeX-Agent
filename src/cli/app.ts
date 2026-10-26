import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import type { Mode, ModelInfo, StopReason } from "../core/types.js";
import { AgentSession } from "../core/loop.js";
import { Approvals } from "../core/approvals.js";
import { CheckpointManager } from "../core/checkpoint.js";
import { ContextManager } from "../core/context.js";
import { TodoStore } from "../core/todos.js";
import type { AgentIO } from "../core/io.js";
import type { ModelProvider } from "../providers/provider.js";
import { CUSTOM_PROVIDER_PREFIX, createProvider } from "../providers/factory.js";
import { ToolRegistry } from "../tools/registry.js";
import { createPathResolver } from "../safety/policy.js";
import { PermissionManager } from "../safety/permissions.js";
import { createWorkspace, type Workspace } from "../safety/workspace.js";
import { discoverSkills, type Skill } from "../memory/skills.js";
import { installSkillViaSkillui, parseSkillInstallTokens } from "../memory/skillui.js";
import {
  findFact,
  looksSecret,
  readFacts,
  removeFact,
  upsertFact,
  writeFacts,
} from "../memory/long_term.js";
import { buildSystemPrompt } from "../memory/system_prompt.js";
import { CredentialStore } from "../config/credentials.js";
import { McpManager } from "../plugins/manager.js";
import { removeMcpServer } from "../plugins/config.js";
import { listMcpPresets } from "../plugins/presets.js";
import { applyMcpAdd, planMcpAdd, type McpAddPlan } from "../plugins/mcp_add.js";
import {
  clearRecentCustomModels,
  configDir,
  listRecentCustomModels,
  loadConfig,
  logsDir,
  rememberCustomModel,
  rememberModel,
  saveConfig,
  sessionsDir,
  type AgentConfig,
} from "../config/config.js";
import { JsonlLogger, type Logger } from "../logging/logger.js";
import { SessionStore, deriveTitle, newSessionId, selectSession, type SessionRecord } from "../sessions/store.js";
import { searchSessions } from "../sessions/search.js";
import { UsageTracker } from "../usage/tracker.js";
import { UsageStore, type UsageRange } from "../usage/store.js";
import { createWebSearch } from "../util/websearch.js";
import { diffStats, renderDiff } from "../util/diff.js";
import { color } from "../util/color.js";
import { isPrivateHost } from "../util/network.js";
import { firstNonEmpty } from "../util/strings.js";
import { formatErrorMessage } from "../util/errors.js";
import { todoHeader, todoLines } from "../util/todos.js";
import { renderCrossSession, renderUsage } from "./usage.js";
import { runConnect, describeProvider, defaultBaseURL, resolveProviderKey, providerRefFromArgs, type ConnectPick } from "./connect.js";
import { CUSTOM_MODEL_LABEL, cleanModelName, resolveModelChoice, validateFallbackModel } from "./models.js";
import { TerminalIO, type ChatIO, type PickItem, type PickRequest } from "./render.js";
import { Prompter, PROMPT_EOF, type PrompterLike } from "./prompt.js";
import { isBusySafeSlash } from "./slash.js";
import { createTuiPair, attachTui, type TuiPair } from "./tui/index.js";
import { describeDefault, parseDefaultTarget, readDefaultInterface, setDefaultInterface } from "./default.js";
import type { Screen } from "./tui/screen.js";
import { resolveInterrupt } from "./interrupt.js";
import { formatResumePreview } from "./resume_preview.js";
import { restartArgs } from "./restart_args.js";
import { describeUpdate, describeUpdateAvailable, describeUpdateSuccess, runUpdate } from "./update.js";
import { createWebServer, isLoopbackHost, reachableUrl, type WebServerHandle } from "../server/server.js";
import { ServerConfigError } from "../server/webapp.js";
import {
  TelegramDaemonError,
  startTelegramDaemon,
  stopTelegramDaemon,
  restartTelegramDaemon,
  telegramDaemonStatus,
  tailTelegramLog,
  telegramLogPath,
} from "../server/telegram_daemon.js";
import { maskToken, resolveTelegramSettings, loadTelegramToken, saveTelegramToken, clearTelegramToken } from "../server/telegram.js";
import { qrLines } from "../util/qr.js";

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
  /** Animasi mengetik pada jawaban model (default true). */
  typewriter?: boolean;
  /** Muat skill dari SKILL.md (default true). */
  skills?: boolean;
  debug?: boolean;
  json?: boolean;
  /** Mode antarmuka: CLI (readline) default, atau TUI layar penuh. */
  ui?: "cli" | "tui";
}

interface ResolvedModel {
  id: string;
  info?: ModelInfo;
}

export const SLASH_HELP: Array<[string, string]> = [
  ["/connect", "hubungkan provider (yang tersimpan bisa dipakai ulang)"],
  ["/provider [use|edit|hapus <id>]", "kelola provider tersimpan (id: anthropic, openai, custom:<nama>)"],
  ["/models [nomor|0|nama|clear]", "lihat/ganti model (0 = custom, clear = hapus riwayat custom)"],
  ["/plan", "pindah ke mode Plan (read-only)"],
  ["/build", "pindah ke mode Build (eksekusi)"],
  ["/sessions [clear]", "daftar sesi / hapus semua sesi workspace ini"],
  ["/resume <n>", "lanjut sesi ke-n (atau /resume <id>)"],
  ["/search <kata>", "cari teks di seluruh sesi"],
  ["/new", "mulai sesi baru"],
  ["/clear", "bersihkan riwayat sesi ini"],
  ["/rename <judul>", "ganti judul sesi"],
  ["/delete [all]", "hapus sesi ini (all = semua sesi workspace)"],
  ["/diff", "lihat perubahan file sesi ini yang belum di-undo"],
  ["/undo [n]", "batalkan perubahan file (ke sebelum langkah n)"],
  ["/usage [today|week|all|<id>]", "pemakaian token & biaya"],
  ["/permissions [revoke <path>]", "lihat/cabut izin luar workspace"],
  ["/allow-all [on|off]", "izinkan semua izin untuk sesi ini"],
  ["/diff-auto [on|off]", "tampilkan diff walau disetujui otomatis"],
  ["/thinking [on|off]", "tampilkan/sembunyikan thinking"],
  ["/markdown [on|off]", "render markdown pada jawaban"],
  ["/typewriter [on|off]", "efek mengetik pada jawaban model"],
  ["/default [tui|cli|reset]", "atur antarmuka default saat `agent` dijalankan tanpa tujuan"],
  ["/skills [install <sumber>]", "daftar skill · pasang skill via SkillUI"],
  ["/skill <nama>|off", "aktifkan/paksa skill atau lepas semua"],
  ["/mcp [add|remove|reload|key|presets]", "status server MCP; tambah preset, muat ulang, atau atur API key"],
  ["/todos", "tampilkan daftar tugas (checklist)"],
  ["/memory [add|forget|clear]", "memori jangka panjang tentang pengguna (lihat/tambah/hapus)"],
  ["/web [lan|stop]", "nyalakan server web (lan = buka ke jaringan) / hentikan"],
  ["/telegram [start|stop|restart|status|logs|token|allow]", "kelola bot Telegram (daemon latar belakang)"],
  ["/update [--stash]", "perbarui NeX-Agent dari repo git, lalu tawarkan restart (--stash: simpan perubahan lokal sementara)"],
  ["/restart", "jalankan ulang NeX-Agent untuk menerapkan versi baru"],
  ["/exit", "keluar dari sesi chat (atau Ctrl+D)"],
  ["/help", "bantuan"],
];

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const SEARCH_ROLE_LABEL: Record<string, string> = {
  user: "kamu",
  assistant: "agen",
  tool: "tool",
  system: "sistem",
};

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
  private mcp!: McpManager;
  private skills: Skill[] = [];
  private activeSkills: Skill[] = [];
  private skillsEnabled = false;
  private baseSystemPrompt = "";
  /** Base URL provider aktif (untuk banner + peringatan alamat lokal). */
  private providerBaseURL?: string;
  /** Tugas yang sedang berjalan (untuk Ctrl+C: hentikan lalu keluar). */
  private activeController?: AbortController;
  /** Ctrl+C saat menganggur: sekali = minta konfirmasi, dua kali = keluar. */
  private exitArmed = false;
  private readonly onSigint = (): void => this.handleInterrupt();
  /** Server web (dinyalakan lewat `/web`) selama proses chat ini hidup. */
  private webServer?: WebServerHandle;

  private constructor(
    private readonly workspace: Workspace,
    private config: AgentConfig,
    private readonly credentials: CredentialStore,
    private readonly logger: Logger,
    private readonly prompter: PrompterLike,
    private readonly io: ChatIO,
    private readonly permissions: PermissionManager,
    private readonly approvals: Approvals,
    private readonly opts: CliOptions,
  ) {}

  /** Penghenti layar TUI (bila berjalan lewat `nex-agent tui`). */
  private tuiDetach?: () => void;
  private tuiScreenRef?: Screen;

  /** Layar TUI bila mode `ui: "tui"` (untuk pembersihan di CLI runner). */
  get tuiScreen(): Screen | undefined {
    return this.tuiScreenRef;
  }

  /** Catat penghenti layar TUI (dipanggil `create`). */
  private setTuiLifecycle(screen: Screen, detach: () => void): void {
    this.tuiScreenRef = screen;
    this.tuiDetach = detach;
  }

  /** Hentikan layar TUI dan pulihkan terminal (aman dipanggil berkali-kali). */
  stopTui(): void {
    const detach = this.tuiDetach;
    this.tuiDetach = undefined;
    this.tuiScreenRef = undefined;
    detach?.();
  }

  /** Ganti mode Plan/Build (dipakai tombol Ctrl+Tab di TUI). */
  toggleMode(): void {
    const next: Mode = this.session.getMode() === "plan" ? "build" : "plan";
    this.session.setMode(next);
    this.io.modeChanged?.(next);
  }

  /** Mode sesi saat ini. */
  currentMode(): Mode {
    return this.session.getMode();
  }

  static async create(opts: CliOptions): Promise<ChatApp> {
    const workspace = createWorkspace(opts.cwd);
    const config = await loadConfig();
    const credentials = new CredentialStore();
    const logger = new JsonlLogger(path.join(logsDir(), "agent.jsonl"), { debug: Boolean(opts.debug) });
    const commands = SLASH_HELP.map(([usage]) => usage.split(/\s+/)[0]!);

    let prompter: PrompterLike;
    let io: ChatIO;
    let tuiPair: TuiPair | undefined;
    if (opts.ui === "tui") {
      tuiPair = createTuiPair({
        commands,
        cwd: workspace.root,
        initMode: opts.mode ?? "build",
        initModel: opts.model,
        initProvider: opts.provider,
        thinking: opts.thinking !== false,
        markdown: opts.markdown ?? config.markdown ?? true,
        typewriter: opts.typewriter ?? config.typewriter ?? true,
      });
      prompter = tuiPair.prompter;
      io = tuiPair.io;
    } else {
      prompter = new Prompter({ commands, cwd: workspace.root });
      io = new TerminalIO(prompter, {
        thinking: opts.thinking !== false,
        json: Boolean(opts.json),
        markdown: opts.markdown ?? config.markdown ?? true,
        typewriter: opts.typewriter ?? config.typewriter ?? true,
      });
    }
    const permissions = new PermissionManager(workspace.root);
    for (const p of opts.allowPath ?? []) {
      permissions.allowStanding(p, "read", "allow-path");
      permissions.allowStanding(p, "write", "allow-path");
    }
    const approvals = new Approvals(io, {
      yes: Boolean(opts.yes),
      interactive: Boolean(process.stdin.isTTY) && !opts.json,
      allowAll: Boolean(opts.allowAll),
      // Default: diff tetap terlihat saat auto-approve. JSON per baris tetap
      // bersih kecuali pengguna menyalakannya eksplisit di config.
      showDiffOnAutoApprove: config.showDiffOnAutoApprove ?? !opts.json,
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

    if (tuiPair) {
      let appRef: ChatApp | undefined;
      const wiring = attachTui(tuiPair, { toggleMode: () => appRef?.toggleMode() });
      app.setTuiLifecycle(tuiPair.screen, wiring.detach);
      appRef = app;
      // Saat agent sibuk, perintah slash yang aman dijalankan langsung tanpa
      // masuk antrean (opsi A) — lihat `cli/slash.ts`.
      tuiPair.prompter.setBusySlashHandler((line) => app.runBusySlash(line));
    }

    try {
      await app.init();
    } catch (err) {
      app.stopTui();
      throw err;
    }
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

    // Klien MCP: muat plugins.json, hubungkan server aktif, daftarkan tool-nya.
    // Kegagalan satu server hanya menjadi status `/mcp`, tidak menggagalkan sesi.
    this.mcp = new McpManager({ credentials: this.credentials, logger: this.logger });
    try {
      await this.mcp.start(this.registry);
    } catch (err) {
      this.logger.warn("mcp.start_failed", { error: (err as Error).message });
    }

    await this.ensureProvider();
    const model = await this.resolveModel(
      this.provider,
      firstNonEmpty(
        this.opts.model,
        record?.model,
        this.config.models?.[this.workspace.root],
      ),
      this.config.defaultModel,
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
    // Model terakhir diingat per workspace agar run berikutnya tidak
    // perlu memilih ulang.
    await rememberModel(this.workspace.root, model.id);

    // Ctrl+C: readline menangkapnya di prompt, SIGINT proses menangkapnya saat
    // tugas berjalan (raw mode dimatikan di Prompter.pause). Keduanya ke handler.
    this.prompter.onInterrupt(() => this.handleInterrupt());
    process.on("SIGINT", this.onSigint);
  }

  private async ensureProvider(): Promise<void> {
    const key = firstNonEmpty(
      this.opts.provider,
      this.record.providerId,
      this.config.defaultProvider,
    );
    let provider = key ? await createProvider(key, this.credentials) : undefined;

    if (!provider && Boolean(process.stdin.isTTY) && !this.opts.json) {
      const result = await runConnect(this.prompter, this.credentials, undefined, this.overlayPick());
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
    const creds = await this.credentials.get(this.providerKey);
    this.providerBaseURL = creds?.baseURL ?? defaultBaseURL(this.providerKey);
  }

  private async resolveModel(
    provider: ModelProvider,
    preferred?: string,
    fallbackDefault?: string,
  ): Promise<ResolvedModel | undefined> {
    let models: ModelInfo[] = [];
    try {
      models = await provider.listModels();
    } catch (err) {
      this.logger.warn("provider.list_models_failed", { error: (err as Error).message });
    }

    // defaultModel (global) divalidasi terhadap provider aktif agar model milik
    // provider lain tidak ikut terbawa; pilihan eksplisit (--model, sesi, atau
    // per-workspace) tetap dipercaya seperti sebelumnya.
    const effective = preferred ?? validateFallbackModel(fallbackDefault, models, this.providerKey);
    if (effective) {
      return { id: effective, info: models.find((m) => m.id === effective) };
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
    this.baseSystemPrompt = await buildSystemPrompt({
      workspaceRoot: this.workspace.root,
      globalConfigDir: configDir(),
      skills: this.skills,
      skillsEnabled: this.skillsEnabled,
    });
    return this.baseSystemPrompt;
  }

  /** Muat ulang daftar skill dari disk; kembalikan true bila berubah. */
  private async refreshSkills(): Promise<boolean> {
    if (!this.skillsEnabled) return false;
    const before = this.skillSignature();
    const fresh = await discoverSkills({
      workspaceRoot: this.workspace.root,
      globalConfigDir: configDir(),
    });
    this.skills = fresh;
    this.activeSkills = this.activeSkills
      .map((active) => fresh.find((s) => s.name === active.name))
      .filter((s): s is Skill => Boolean(s));
    return this.skillSignature() !== before;
  }

  private skillSignature(): string {
    return this.skills.map((s) => `${s.name}\u0000${s.description}\u0000${s.body.length}`).join("\u0001");
  }

  /** Segarkan skill ke sesi aktif (prompt + konteks tool) setelah perubahan. */
  private async applySkills(): Promise<void> {
    await this.buildSystemPrompt();
    this.session.setSystemPrompt(this.composeSystemPrompt());
    this.session.setSkills(this.skills);
  }

  /** Hot-reload: muat ulang skill dari disk dan terapkan bila ada perubahan. */
  private async reloadSkills(): Promise<void> {
    const changed = await this.refreshSkills();
    this.session.setSkills(this.skills);
    if (changed) await this.applySkills();
  }

  /** Dipanggil tool `skill_write`: daftarkan skill baru agar langsung aktif. */
  private async registerSkill(skill: Skill): Promise<void> {
    const index = this.skills.findIndex((s) => s.name === skill.name);
    if (index >= 0) this.skills[index] = skill;
    else this.skills.push(skill);
    await this.applySkills();
  }

  /** Dipanggil tool `memory`: bangun ulang prompt agar fakta baru langsung terpakai. */
  private async refreshMemory(): Promise<void> {
    await this.buildSystemPrompt();
    this.session.setSystemPrompt(this.composeSystemPrompt());
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
    await this.refreshSkills();
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
        search: createWebSearch({ provider: this.config.searchProvider, url: this.config.searchUrl }),
        skills: this.skills,
        registerSkill: (skill) => this.registerSkill(skill),
        refreshMemory: () => this.refreshMemory(),
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
    const lines = [
      `${color.green("●")} workspace  ${this.workspace.root}${markers}`,
      `${color.green("●")} mode       ${this.session.getMode()}`,
      `${color.green("●")} model      ${this.providerKey} / ${this.session.getModel()}`,
    ];
    if (this.providerBaseURL) {
      lines.push(`${color.green("●")} provider   ${this.providerBaseURL}`);
      if (isPrivateHost(this.providerBaseURL)) {
        lines.push(
          `${color.yellow("⚠")} provider menunjuk ke alamat jaringan lokal — pastikan ini server yang kamu maksud, bukan konfigurasi lama yang ikut terbawa. Ganti dengan /provider atau /connect.`,
        );
      }
    }
    process.stdout.write(`${lines.join("\n")}\n\n`);
  }

  /** Jalankan satu tugas (mode non-chat). */
  async runGoal(goal: string): Promise<number> {
    this.banner();
    const controller = new AbortController();
    this.activeController = controller;
    let code: number;
    this.io.busy?.(true);
    try {
      const result = await this.session.run(goal, controller.signal);
      code = exitCodeFor(result.stopReason);
    } finally {
      this.activeController = undefined;
      this.io.busy?.(false);
      await this.saveRecord();
      await this.close();
    }
    if (!this.opts.json) process.stdout.write("\n");
    return code;
  }

  /** REPL chat interaktif. */
  async runRepl(): Promise<number> {
    this.banner();
    this.io.info("Ketik /help untuk daftar perintah. Ctrl+C menghentikan tugas; dua kali keluar.");
    for (;;) {
      // Di TUI, mode sudah tampil di status bar — jangan tampilkan dua kali di prompt.
      const modeLabel =
        this.opts.ui === "tui"
          ? ""
          : `${color.gray("[")}${this.session.getMode()}${color.gray("]")} `;
      const prompt = `${modeLabel}› `;
      this.exitArmed = false;
      // Pesan yang dikirim saat agent sibuk (mode TUI) dijalankan lebih dulu.
      const queued = this.prompter.takeQueued?.();
      const line = (queued !== undefined ? queued : await this.prompter.question(`\n${prompt}`)).trim();
      if (line === PROMPT_EOF) break;
      if (line === "") continue;
      if (line.startsWith("/")) {
        const action = await this.handleSlash(line);
        if (action === "exit") break;
        continue;
      }
      const controller = new AbortController();
      this.activeController = controller;
      this.io.userMessage?.(line);
      this.io.lineBreak();
      this.prompter.pause();
      this.io.busy?.(true);
      try {
        await this.reloadSkills();
        await this.session.run(line, controller.signal);
      } finally {
        this.activeController = undefined;
        this.io.busy?.(false);
        this.prompter.resume();
        await this.saveRecord();
      }
    }
    await this.close();
    return 0;
  }

  /**
   * Tangani Ctrl+C.
   *
   * - Saat tugas berjalan: tekan pertama hentikan tugas (abort), tekan kedua
   *   saat masih berhenti memaksa keluar.
   * - Saat menganggur: tekan pertama minta konfirmasi, tekan kedua keluar.
   */
  private handleInterrupt(): void {
    const controller = this.activeController;
    const action = resolveInterrupt({
      running: Boolean(controller),
      aborting: Boolean(controller?.signal.aborted),
      exitArmed: this.exitArmed,
    });
    switch (action) {
      case "abort":
        this.io.warn("Menghentikan… (Ctrl+C lagi untuk keluar sekarang)");
        controller?.abort();
        return;
      case "force-exit":
        // Tugas sedang berhenti dan belum selesai bersih-bersih — paksa keluar.
        process.stdout.write("\n");
        process.exit(130);
        return;
      case "arm-exit":
        this.exitArmed = true;
        this.io.warn("Tekan Ctrl+C lagi untuk keluar (atau ketik /exit).");
        return;
      case "exit":
        process.stdout.write("\n");
        this.prompter.close();
        return;
    }
  }

  /**
   * Jalankan baris slash **langsung** saat agent sibuk (mode TUI), bila
   * perintah tergolong aman-sibuk (`isBusySafeSlash`). Mengembalikan `true`
   * bila diterima sehingga prompter tidak mengantre baris ini.
   */
  runBusySlash(line: string): boolean {
    if (!isBusySafeSlash(line)) return false;
    void this.handleSlash(line).catch((err: unknown) => {
      this.io.error(`Perintah gagal: ${formatErrorMessage(err)}`);
    });
    return true;
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
        this.io.modeChanged?.("plan");
        return "continue";
      case "/build":
        this.session.setMode("build");
        this.io.modeChanged?.("build");
        return "continue";
      case "/connect":
        await this.commandConnect();
        return "continue";
      case "/provider":
        await this.commandProvider(args);
        return "continue";
      case "/models":
        await this.commandModels(args[0]);
        return "continue";
      case "/sessions":
        await this.commandSessions(args[0]);
        return "continue";
      case "/resume":
        await this.commandResume(args[0]);
        return "continue";
      case "/search":
        await this.commandSearch(args.join(" "));
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
        if (args[0] === "all") await this.clearSessions();
        else await this.commandDelete();
        return "continue";
      case "/diff":
        await this.commandDiff();
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
      case "/diff-auto": {
        const value = args[0];
        const on = value === undefined ? !this.approvals.autoApproveDiffEnabled() : value === "on";
        this.approvals.setAutoApproveDiff(on);
        this.config = await saveConfig({ showDiffOnAutoApprove: on });
        this.io.info(`Diff saat auto-approve ${on ? "aktif" : "nonaktif"}.`);
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
      case "/typewriter": {
        const value = args[0];
        const on = value === undefined ? !this.io.isTypewriterEnabled() : value === "on";
        this.io.setTypewriter(on);
        this.config = await saveConfig({ typewriter: on });
        this.io.info(`Efek mengetik ${on ? "aktif" : "nonaktif"}.`);
        return "continue";
      }
      case "/default": {
        const value = args[0];
        if (value === undefined) {
          this.io.info(describeDefault(await readDefaultInterface()));
          return "continue";
        }
        const parsed = parseDefaultTarget(value);
        if (!parsed) {
          this.io.warn(`Target tidak valid: ${value} (gunakan tui, cli, atau reset).`);
          return "continue";
        }
        this.io.info(describeDefault(await setDefaultInterface(parsed)));
        return "continue";
      }
      case "/skills":
        await this.commandSkills(args);
        return "continue";
      case "/skill":
        await this.commandSkill(args[0]);
        return "continue";
      case "/todos":
        this.commandTodos();
        return "continue";
      case "/memory":
        await this.commandMemory(args);
        return "continue";
      case "/mcp":
        await this.commandMcp(args);
        return "continue";
      case "/web":
      case "/serve":
        await this.commandWeb(args[0]);
        return "continue";
      case "/telegram":
        await this.commandTelegram(args);
        return "continue";
      case "/update":
        await this.commandUpdate(args);
        return "continue";
      case "/restart":
        await this.commandRestart();
        return "continue";
      default:
        this.io.warn(`Perintah tidak dikenal: ${cmd}. Ketik /help.`);
        return "continue";
    }
  }

  private printHelp(): void {
    if (this.io.view) {
      const lines: string[] = [];
      lines.push("Perintah:");
      for (const [name, desc] of SLASH_HELP) {
        lines.push(`  ${name.padEnd(32)}${desc}`);
      }
      void this.io.view({ title: "Bantuan", lines }).catch(() => {
        process.stdout.write("\nPerintah:\n");
        for (const [name, desc] of SLASH_HELP) {
          process.stdout.write(`  ${name.padEnd(32)}${desc}\n`);
        }
        process.stdout.write("\n");
      });
      return;
    }
    process.stdout.write("\nPerintah:\n");
    for (const [name, desc] of SLASH_HELP) {
      process.stdout.write(`  ${name.padEnd(32)}${desc}\n`);
    }
    process.stdout.write("\n");
  }

  private async commandConnect(): Promise<void> {
    const result = await runConnect(this.prompter, this.credentials, undefined, this.overlayPick());
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

  /**
   * Pemilih overlay TUI (bila `ChatIO` mendukungnya) untuk alur interaktif
   * seperti `/connect`. `undefined` → pemanggil memakai prompt teks biasa.
   */
  private overlayPick(): ConnectPick | undefined {
    const pick = this.io.pick;
    if (!pick) return undefined;
    // Panggil lewat `this.io` agar `this` (state overlay TuiIO) tetap terikat.
    return <T>(req: PickRequest<T>): Promise<T | null> => this.io.pick!<T>(req);
  }

  /**
   * Kelola provider tersimpan: tampilkan daftar, aktifkan, edit, atau hapus.
   * Nilai API key tidak pernah ditampilkan (hanya status ada/tidak).
   */
  private async commandProvider(args: string[]): Promise<void> {
    const sub = args[0];
    const name = providerRefFromArgs(args.slice(1));

    if (!sub) {
      // TUI: buka pemilih melayang; Enter mengaktifkan provider terpilih.
      if (this.io.pick) {
        const keys = (await this.credentials.list()).sort();
        if (keys.length === 0) {
          this.io.info("Belum ada provider tersimpan. Jalankan /connect untuk menambahkan.");
          return;
        }
        const items: PickItem<string>[] = [];
        for (const key of keys) {
          const creds = await this.credentials.get(key);
          items.push({
            label: key,
            detail: `${creds?.baseURL ?? defaultBaseURL(key) ?? "-"}  ${creds?.apiKey ? "api key ok" : "tanpa api key"}${this.config.defaultProvider === key ? "  (default)" : ""}`,
            value: key,
          });
        }
        const chosen = await this.io.pick({
          title: "Provider tersimpan",
          items,
          hint: "↑/↓ pilih · Enter aktifkan · Esc tutup",
        });
        if (chosen !== null) await this.activateProvider(chosen);
        return;
      }
      await this.listProviders();
      return;
    }

    const saved = await this.credentials.list();

    if (sub === "use" || sub === "pakai") {
      if (!name) {
        this.io.warn("Pakai: /provider use <id>.");
        return;
      }
      await this.activateProvider(name);
      return;
    }

    if (sub === "edit") {
      if (!name) {
        this.io.warn("Pakai: /provider edit <id>.");
        return;
      }
      const key = resolveProviderKey(name, saved);
      if (!key) {
        this.io.warn(`Tidak ada provider tersimpan dengan id ${name}. Lihat /provider.`);
        return;
      }
      await this.editProvider(key);
      return;
    }

    if (sub === "hapus" || sub === "delete" || sub === "rm") {
      if (!name) {
        this.io.warn("Pakai: /provider hapus <id>.");
        return;
      }
      const key = resolveProviderKey(name, saved) ?? name;
      const deleted = await this.credentials.delete(key);
      if (!deleted) {
        this.io.warn(`Tidak ada provider tersimpan dengan id ${name}.`);
        return;
      }
      if (this.config.defaultProvider === key) {
        this.config = await saveConfig({ defaultProvider: undefined });
      }
      const active = key === this.providerKey ? " (masih aktif sampai sesi ini berakhir)" : "";
      this.io.info(`Provider ${key} dihapus${active}.`);
      return;
    }

    this.io.warn(`Argumen tidak dikenal: ${sub}. Pakai /provider [use|edit|hapus <id>].`);
  }

  /** Aktifkan provider tersimpan (id atau nama singkat custom). */
  private async activateProvider(name: string): Promise<void> {
    const saved = await this.credentials.list();
    const key = resolveProviderKey(name, saved);
    const provider = key ? await createProvider(key, this.credentials) : undefined;
    if (!key || !provider) {
      this.io.warn(`Provider tidak dikenal atau belum tersimpan: ${name}. Lihat /provider.`);
      return;
    }
    this.provider = provider;
    this.providerKey = key;
    this.config = await saveConfig({ defaultProvider: key });
    const model = await this.resolveModel(this.provider, undefined);
    if (!model) {
      this.io.warn("Tidak ada model terpilih.");
      return;
    }
    this.session.setProvider(this.provider, key);
    this.session.setModel(model.id, model.info);
    this.record.providerId = key;
    this.record.model = model.id;
    await rememberModel(this.workspace.root, model.id);
    this.io.info(`Provider aktif: ${key} / ${model.id}.`);
  }

  private async listProviders(): Promise<void> {
    const keys = (await this.credentials.list()).sort();
    if (keys.length === 0) {
      this.io.info("Belum ada provider tersimpan. Jalankan /connect untuk menambahkan.");
      return;
    }
    process.stdout.write("\nProvider tersimpan:\n");
    for (const key of keys) {
      const creds = await this.credentials.get(key);
      process.stdout.write(
        `  ${describeProvider({
          key,
          baseURL: creds?.baseURL ?? defaultBaseURL(key) ?? "",
          hasApiKey: Boolean(creds?.apiKey),
          active: key === this.providerKey,
          isDefault: this.config.defaultProvider === key,
        })}\n`,
      );
    }
    process.stdout.write(
      "\n  (* = aktif)  /provider use|edit|hapus <id>  (untuk custom, awalan 'custom:' boleh dilewat)\n\n",
    );
  }

  private async editProvider(name: string): Promise<void> {
    const creds = await this.credentials.get(name);
    if (!creds) {
      this.io.warn(`Tidak ada provider tersimpan dengan id ${name}. Lihat /provider.`);
      return;
    }
    const baseDefault = creds.baseURL ?? defaultBaseURL(name) ?? "";
    const baseAnswer = (
      await this.prompter.question(`Base URL [${baseDefault}]: `)
    ).trim();
    const baseURL = baseAnswer || baseDefault;

    const keyAnswer = await this.prompter.secretQuestion("API key baru (kosongkan untuk tetap): ");
    const keepKey = keyAnswer === PROMPT_EOF || !keyAnswer.trim();
    const apiKey = keepKey ? creds.apiKey : keyAnswer.trim();

    const next = {
      ...(baseURL ? { baseURL } : {}),
      ...(apiKey ? { apiKey } : {}),
    };
    await this.credentials.set(name, next);

    // Bila provider ini sedang aktif, pakai konfigurasi baru langsung.
    const isActive = name === this.providerKey;
    if (isActive) {
      const provider = await createProvider(name, this.credentials);
      if (provider) {
        this.provider = provider;
        this.session.setProvider(provider, name);
      }
    }
    const tail = name.startsWith(CUSTOM_PROVIDER_PREFIX) ? "" : " (base URL hanya berlaku bila adapter mendukung)";
    this.io.info(`Provider ${name} diperbarui${isActive ? " dan diterapkan" : ""}${tail}.`);
  }

  private async commandModels(arg?: string): Promise<void> {
    let models: ModelInfo[] = [];
    try {
      models = await this.provider.listModels();
    } catch (err) {
      this.io.error(`Gagal memuat model: ${formatErrorMessage(err)}`);
    }
    const knownIds = new Set(models.map((m) => m.id));

    if (!arg) {
      // TUI: buka pemilih melayang; Enter langsung mengganti model.
      if (this.io.pick) {
        // Custom model yang pernah dipakai ditampilkan agar bisa dipilih ulang.
        const recent = (await listRecentCustomModels()).filter((m) => !knownIds.has(m));
        const items: PickItem<string>[] = [
          { label: CUSTOM_MODEL_LABEL, value: "__custom__" },
          ...recent.map((m) => ({ label: m, detail: "custom tersimpan", value: `__recent__${m}` })),
          ...models.map((m) => ({ label: m.id, value: m.id })),
        ];
        if (recent.length > 0) {
          items.push({ label: "Bersihkan riwayat custom", detail: `${recent.length}`, value: "__clear__" });
        }
        const picked = await this.io.pick({
          title: `Model — ${this.providerKey} (${models.length})`,
          items,
          hint: "↑/↓ pilih · Enter pakai · Esc tutup",
        });
        if (picked === null) return;
        if (picked === "__clear__") {
          await clearRecentCustomModels();
          this.io.info("Riwayat custom model dibersihkan.");
          return;
        }
        if (picked === "__custom__") {
          const name = await this.askCustomModelName();
          if (!name) {
            this.io.warn("Nama model kosong; dibatalkan.");
            return;
          }
          await this.applyCustomModel(name);
          return;
        }
        if (picked.startsWith("__recent__")) {
          await this.applyCustomModel(picked.slice("__recent__".length));
          return;
        }
        const chosen = models.find((m) => m.id === picked);
        if (chosen) await this.switchModel({ id: chosen.id, info: chosen });
        return;
      }
      process.stdout.write(`\nModel untuk ${this.providerKey} (${models.length}):\n`);
      process.stdout.write(`    0) ${CUSTOM_MODEL_LABEL}\n`);
      models.forEach((m, i) => process.stdout.write(`  ${String(i + 1).padStart(3)}) ${m.id}\n`));
      process.stdout.write(
        "\n  Ganti dengan /models <nomor>, /models 0 (custom), /models <nama>, atau /models clear (hapus riwayat custom).\n\n",
      );
      return;
    }

    if (arg === "clear") {
      await clearRecentCustomModels();
      this.io.info("Riwayat custom model dibersihkan.");
      return;
    }

    const choice = resolveModelChoice(arg, models);
    if (choice.kind === "custom") {
      const name = await this.askCustomModelName();
      if (!name) {
        this.io.warn("Nama model kosong; dibatalkan.");
        return;
      }
      await this.applyCustomModel(name);
      return;
    }
    if (choice.kind === "model") {
      await this.switchModel({ id: choice.model.id, info: choice.model });
      if (!knownIds.has(choice.model.id)) await rememberCustomModel(choice.model.id);
      return;
    }
    this.io.warn(`Pilihan tidak valid: ${arg}. Gunakan nomor, 0, atau nama model.`);
  }

  /**
   * Minta nama model custom dari pengguna. Di TUI memakai overlay input teks
   * (di dalam modul `/models`); di CLI memakai prompt baris seperti biasa.
   */
  private async askCustomModelName(): Promise<string> {
    if (this.io.inputText) {
      const raw = await this.io.inputText({ title: "Model custom", label: "Nama model" });
      return raw === null ? "" : cleanModelName(raw);
    }
    return cleanModelName(await this.prompter.question("Nama model custom: "));
  }

  /** Terapkan model custom: jadikan aktif sekaligus catat ke riwayat agar tersimpan. */
  private async applyCustomModel(name: string): Promise<void> {
    await this.switchModel({ id: name });
    await rememberCustomModel(name);
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

  /** Item daftar sesi untuk pemilih (TUI) — nilai = id sesi. */
  private sessionItems(sessions: SessionRecord[]): PickItem<string>[] {
    return sessions.map((s) => ({
      label: `${s.updatedAt.slice(0, 16).replace("T", " ")}  ${s.title}`,
      detail: `${s.model || "-"}${s.id === this.record.id ? "  ●" : ""}`,
      value: s.id,
    }));
  }

  private async commandSessions(arg?: string): Promise<void> {
    if (arg === "clear" || arg === "hapus" || arg === "bersihkan") {
      await this.clearSessions();
      return;
    }
    const sessions = await this.store.listForWorkspace(this.workspace.root);
    if (sessions.length === 0) {
      this.io.info("Belum ada sesi untuk workspace ini.");
      return;
    }
    // TUI: langsung buka pemilih melayang; Enter melanjutkan sesi terpilih.
    if (!arg && this.io.pick) {
      const id = await this.io.pick({
        title: "Sesi — Enter untuk melanjutkan",
        items: this.sessionItems(sessions),
        hint: "↑/↓ pilih · Enter resume · Esc tutup",
      });
      if (id !== null) await this.resumeSession(id);
      return;
    }
    process.stdout.write("\nSesi:\n");
    sessions.forEach((s, i) => {
      const active = s.id === this.record.id ? color.green("●") : " ";
      process.stdout.write(
        `  ${active} ${String(i + 1).padStart(2)}) ${s.updatedAt.slice(0, 16).replace("T", " ")}  ${(s.model || "-").padEnd(20)}  ${s.title}\n`,
      );
    });
    process.stdout.write("\n  Gunakan /resume <nomor> untuk melanjutkan sesi.\n");
    process.stdout.write("  /sessions clear (atau /delete all) untuk menghapus semua sesi workspace ini.\n\n");
  }

  /** Cari teks di seluruh sesi (semua workspace), urut terbaru lebih dulu. */
  private async commandSearch(query?: string): Promise<void> {
    const text = (query ?? "").trim();
    if (!text) {
      this.io.warn("Pakai: /search <kata>.");
      return;
    }
    const sessions = await this.store.list();
    const hits = searchSessions(sessions, text);
    if (hits.length === 0) {
      this.io.info(`Tidak ada hasil untuk "${text}".`);
      return;
    }
    let total = 0;
    process.stdout.write(`\nHasil "${text}" (${hits.length} sesi):\n`);
    for (const hit of hits) {
      total += hit.count;
      const active = hit.session.id === this.record.id ? color.green("●") : " ";
      const other =
        hit.session.workspace === this.workspace.root
          ? ""
          : `  [${path.basename(hit.session.workspace) || hit.session.workspace}]`;
      process.stdout.write(
        `  ${active} ${hit.session.updatedAt.slice(0, 16).replace("T", " ")}  ${hit.session.title}${other}\n`,
      );
      for (const match of hit.matches) {
        process.stdout.write(
          `      ${SEARCH_ROLE_LABEL[match.role] ?? match.role}: ${match.snippet}\n`,
        );
      }
      if (hit.count > hit.matches.length) {
        process.stdout.write(`      … ${hit.count - hit.matches.length} pesan lain cocok\n`);
      }
    }
    process.stdout.write(
      `\n  ${total} pesan cocok. Gunakan /resume <id> untuk membuka sesi workspace ini.\n\n`,
    );
  }

  /** Hapus semua sesi workspace ini (termasuk checkpoint-nya) setelah konfirmasi. */
  private async clearSessions(): Promise<void> {
    const sessions = await this.store.listForWorkspace(this.workspace.root);
    if (sessions.length === 0) {
      this.io.info("Belum ada sesi untuk workspace ini.");
      return;
    }
    const answer = (
      await this.prompter.question(`Hapus ${sessions.length} sesi workspace ini? (y/N): `)
    )
      .trim()
      .toLowerCase();
    if (answer !== "y" && answer !== "ya") {
      this.io.info("Dibatalkan.");
      return;
    }
    const removed = await this.store.deleteMany(sessions.map((s) => s.id));
    for (const s of sessions) {
      await fs.rm(path.join(sessionsDir(), s.id), { recursive: true, force: true }).catch(() => undefined);
    }
    this.io.info(`${removed} sesi dihapus.`);
    await this.commandNew();
  }

  /** Lanjutkan sesi berdasarkan nomor (urutan /sessions) atau id. */
  private async commandResume(arg?: string): Promise<void> {
    const sessions = await this.store.listForWorkspace(this.workspace.root);
    if (sessions.length === 0) {
      this.io.info("Belum ada sesi untuk workspace ini.");
      return;
    }
    if (!arg) {
      // TUI: pemilih melayang (sama seperti /sessions). CLI: tampilkan daftar.
      if (this.io.pick) {
        const id = await this.io.pick({
          title: "Sesi — Enter untuk melanjutkan",
          items: this.sessionItems(sessions),
          hint: "↑/↓ pilih · Enter resume · Esc tutup",
        });
        if (id !== null) await this.resumeSession(id);
        return;
      }
      await this.commandSessions();
      return;
    }
    await this.resumeSession(arg);
  }

  /** Aktifkan sesi terpilih (nomor urut atau id) sebagai sesi berjalan. */
  private async resumeSession(selector: string): Promise<void> {
    const sessions = await this.store.listForWorkspace(this.workspace.root);
    const target = selectSession(sessions, selector) ?? (await this.store.load(selector));
    if (!target || target.workspace !== this.workspace.root) {
      this.io.warn(`Sesi tidak ditemukan: ${selector}. Lihat /sessions.`);
      return;
    }
    if (target.id === this.record.id) {
      this.io.info("Sudah berada di sesi ini.");
      return;
    }

    await this.saveRecord();
    await this.activateRecord(target);
    this.io.info(`Melanjutkan sesi: ${target.title} (${target.id})`);
    if (!this.opts.json) {
      const preview = formatResumePreview(target.history, { mode: target.mode });
      if (preview) process.stdout.write(`${preview}\n\n`);
    }
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

  private async commandDiff(): Promise<void> {
    const entries = await this.checkpoints.preview(this.workspace.root);
    if (entries.length === 0) {
      this.io.info("Belum ada perubahan file pada sesi ini.");
      return;
    }
    let added = 0;
    let removed = 0;
    const lines: string[] = [];
    for (const entry of entries) {
      const before = entry.before ?? "";
      const after = entry.after ?? "";
      const stats = diffStats(before, after);
      added += stats.added;
      removed += stats.removed;
      const rendered = renderDiff(before, after, entry.display);
      if (this.io.view) for (const line of rendered.split("\n")) lines.push(line);
      else this.io.diff(rendered);
    }
    if (this.io.view) {
      await this.io.view({
        title: `Diff — ${entries.length} file (+${added} -${removed})`,
        lines,
      });
      return;
    }
    this.io.info(
      `${entries.length} file berubah (+${added} -${removed}). Gunakan /undo untuk membatalkan.`,
    );
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
      const text = renderCrossSession(summary, arg) + "\n";
      const lines = text.split("\n");
      if (this.io.view) {
        await this.io.view({ title: `Penggunaan — ${arg}`, lines });
        return;
      }
      process.stdout.write(text);
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
    const out = renderUsage(this.tracker, {
      ...(this.session.getModelInfo()?.contextWindow
        ? { contextWindow: this.session.getModelInfo()!.contextWindow }
        : {}),
      usedTokens,
      ...(this.opts.maxCost ?? this.config.maxCost
        ? { maxCost: this.opts.maxCost ?? this.config.maxCost! }
        : {}),
    }) + "\n";
    const lines = out.split("\n");
    if (this.io.view) {
      await this.io.view({ title: "Penggunaan — sesi ini", lines });
      return;
    }
    process.stdout.write(out);
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

  private async commandSkills(args: string[] = []): Promise<void> {
    if (args[0] === "install" || args[0] === "pasang") {
      await this.commandSkillInstall(args.slice(1));
      return;
    }
    await this.reloadSkills();
    if (this.skills.length === 0) {
      this.io.info(
        "Belum ada skill. Letakkan folder berisi SKILL.md di ./skills, ./.nex-agent/skills, atau ~/.config/agent/skills.",
      );
      return;
    }
    const lines: string[] = [];
    lines.push(`Skill tersedia (dimuat otomatis saat relevan):`);
    for (const skill of this.skills) {
      const active = this.activeSkills.some((a) => a.name === skill.name) ? color.green("●") : " ";
      lines.push(`  ${active} ${skill.name.padEnd(24)} ${truncate(skill.description, 60)}`);
    }
    lines.push("");
    lines.push("  Paksa aktif: /skill <nama>  ·  lepas semua: /skill off  ·  pasang: /skills install <sumber>");
    if (this.io.view) {
      await this.io.view({ title: "Skills", lines });
      return;
    }
    process.stdout.write("\nSkill tersedia (dimuat otomatis saat relevan):\n");
    for (const skill of this.skills) {
      const active = this.activeSkills.some((a) => a.name === skill.name) ? color.green("●") : " ";
      process.stdout.write(
        `  ${active} ${skill.name.padEnd(24)} ${truncate(skill.description, 60)}\n`,
      );
    }
    process.stdout.write(
      "\n  Paksa aktif: /skill <nama>  ·  lepas semua: /skill off  ·  pasang: /skills install <sumber>\n\n",
    );
  }

  /**
   * Pasang skill eksternal lewat SkillUI tanpa mengetik perintah shell manual:
   * `/skills install <url|repo|folder> [--name <nama>] [--ultra] [--overwrite]`.
   */
  private async commandSkillInstall(tokens: string[]): Promise<void> {
    const { source, name, ultra, overwrite } = parseSkillInstallTokens(tokens);
    if (!source) {
      this.io.warn("Pakai: /skills install <url|repo|folder> [--name <nama>] [--ultra] [--overwrite]");
      return;
    }

    this.io.info(`Memasang skill dari ${source} via SkillUI… (bisa butuh beberapa saat)`);
    const result = await installSkillViaSkillui({
      workspaceRoot: this.workspace.root,
      source,
      name,
      ultra,
      overwrite,
    });
    if (!result.ok) {
      this.io.warn(result.error);
      if (result.output) this.io.info(result.output);
      return;
    }
    await this.reloadSkills();
    this.io.info(`Skill "${result.slug}" terpasang di skills/${result.slug}/ dan siap dipakai.`);
  }

  private async commandSkill(name?: string): Promise<void> {
    if (!name || name === "off") {
      this.activeSkills = [];
      this.session.setSystemPrompt(this.composeSystemPrompt());
      if (!name) {
        await this.commandSkills();
        return;
      }
      this.io.info("Skill yang dipaksa aktif dilepas.");
      return;
    }
    await this.reloadSkills();
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

  /**
   * Nyalakan server web (chat + terminal di browser) tanpa keluar dari sesi
   * chat CLI. Memakai workspace, model, provider, dan mode yang sedang aktif.
   * Perintah `nex-agent web` (alias `serve`) tersedia untuk mode standalone.
   */
  private async commandWeb(arg?: string): Promise<void> {
    if (arg === "stop" || arg === "off") {
      if (!this.webServer) {
        this.io.info("Server web belum berjalan.");
        return;
      }
      await this.webServer.close();
      this.webServer = undefined;
      this.io.info("Server web dihentikan.");
      return;
    }
    if (arg && arg !== "lan") {
      this.io.warn(`Argumen tidak dikenal: ${arg}. Gunakan /web, /web lan, atau /web stop.`);
      return;
    }
    if (this.webServer) {
      this.io.info(`Server web sudah berjalan: ${this.webServer.url}`);
      return;
    }

    // `/web lan` mengekspos ke jaringan (0.0.0.0); selain itu ikuti config.
    const host = arg === "lan" ? "0.0.0.0" : (this.config.webHost ?? "127.0.0.1");
    const port = this.config.webPort ?? 0;
    try {
      this.webServer = await createWebServer({
        host,
        port,
        cwd: this.workspace.root,
        mode: this.session.getMode(),
        model: this.session.getModel(),
        provider: this.providerKey,
        // Sama seperti sesi CLI: allow-all hanya berlaku untuk sesi ini.
        allowAll: this.approvals.allowAll(),
        skills: this.skillsEnabled,
        ...(this.opts.maxSteps !== undefined ? { maxSteps: this.opts.maxSteps } : {}),
        ...(this.opts.maxCost !== undefined ? { maxCost: this.opts.maxCost } : {}),
        ...(this.opts.debug ? { debug: true } : {}),
      });
    } catch (err) {
      if (err instanceof ServerConfigError) {
        this.io.error(`Gagal menjalankan server web: ${err.message}`);
        return;
      }
      this.io.error(`Gagal menjalankan server web: ${formatErrorMessage(err)}`);
      return;
    }

    this.io.info("Server web berjalan (chat + terminal):");
    for (const url of this.webServer.urls) process.stdout.write(`  ${url}\n`);
    process.stdout.write(`  terminal: ${this.webServer.backend}\n`);
    if (!isLoopbackHost(this.webServer.host)) {
      this.io.warn("Server terikat ke jaringan — siapa pun yang punya token bisa menjalankan shell.");
      const target = reachableUrl(this.webServer.urls) ?? this.webServer.url;
      process.stdout.write("\n  Pindai kode QR untuk membuka di perangkat lain:\n\n");
      process.stdout.write(qrLines(target).map((line) => `  ${line}`).join("\n") + "\n");
    } else {
      process.stdout.write("  (hanya loopback — ketik /web lan untuk akses dari HP/LAN + kode QR)\n");
    }
    process.stdout.write("  Buka di browser. Hentikan dengan /web stop.\n");
  }

  /**
   * Perbarui NeX-Agent dari repo git (`/update`). Mula-mula memeriksa ketersediaan,
   * lalu meminta konfirmasi sebelum menarik commit terbaru, memasang dependensi,
   * dan membangun ulang. Karena proses chat ini masih memakai kode lama di memori,
   * pengguna diminta menjalankan `/restart` agar versi baru terpakai.
   */
  private async commandUpdate(flags: string[] = []): Promise<void> {
    const stash = flags.includes("--stash") || flags.includes("-s");
    this.io.info("Memeriksa pembaruan dari repo git...");
    const check = await runUpdate({
      check: true,
      log: (line: string) => process.stdout.write(`  ${line}\n`),
    });
    if (check.status === "error" || check.status === "no-git") {
      this.io.error(describeUpdate(check));
      return;
    }
    if (check.status !== "available") {
      this.io.info(describeUpdate(check));
      return;
    }

    const headline = describeUpdateAvailable(check).replace(
      "Versi Terbaru tersedia",
      color.cyan("Versi Terbaru tersedia"),
    );
    process.stdout.write(`\n${headline}\n`);
    const answer = (await this.prompter.question("Update Sekarang? (y/N): ")).trim().toLowerCase();
    if (answer !== "y" && answer !== "ya") {
      this.io.info("Update dibatalkan.");
      return;
    }

    const outcome = await runUpdate({
      stash,
      log: (line: string) => process.stdout.write(`  ${line}\n`),
    });
    if (outcome.status === "updated") {
      this.io.info(`${color.brightGreen("[SUKSES]")} ${describeUpdateSuccess(outcome)}`);
      if (outcome.stashConflict) {
        this.io.warn(
          "Perubahan lokal bentrok saat dipulihkan; selesaikan konflik lalu commit (git status).",
        );
      }
      await this.offerRestartAfterUpdate();
      return;
    }
    if (outcome.status === "error") {
      this.io.error(describeUpdate(outcome));
      return;
    }
    this.io.info(describeUpdate(outcome));
  }

  /**
   * Tawarkan memuat ulang proses tepat setelah update sukses agar versi baru
   * langsung dipakai tanpa harus mengingat `/restart`. Sesi aktif diteruskan
   * lewat `--resume`, jadi konteks tidak hilang. Hanya untuk sesi interaktif.
   */
  private async offerRestartAfterUpdate(): Promise<void> {
    if (this.opts.json || !process.stdin.isTTY) return;
    const answer = (await this.prompter.question("Muat ulang sekarang untuk menerapkan? (y/N): "))
      .trim()
      .toLowerCase();
    if (answer === "y" || answer === "ya") {
      await this.restartProcess();
      return;
    }
    this.io.info("Diterapkan saat kamu menjalankan /restart berikutnya.");
  }

  /**
   * Jalankan ulang proses CLI (`/restart` atau setelah `/update`) agar `dist/`
   * terbaru dimuat, tetap di sesi yang sama. Sesi disimpan lebih dulu supaya
   * konteks tidak hilang, lalu kontrol diserahkan ke proses baru dengan stdio
   * yang sama; proses ini keluar mengikuti kode keluar proses baru.
   */
  private async restartProcess(): Promise<void> {
    this.io.info("Menjalankan ulang NeX-Agent untuk menerapkan versi terbaru...");
    await this.saveRecord();
    await this.close();
    const args = restartArgs(process.argv.slice(1), this.record.id);
    const child = spawn(process.execPath, args, { stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 0));
    child.on("error", (err) => {
      process.stderr.write(`Gagal menjalankan ulang: ${err.message}\n`);
      process.exit(1);
    });
  }

  private async commandRestart(): Promise<void> {
    await this.restartProcess();
  }

  /**
   * Kelola bot Telegram sebagai **daemon** terpisah. `/telegram` (atau `start`)
   * menyalakan bot di latar belakang (tetap hidup walau sesi chat ini ditutup),
   * `/telegram stop` menghentikannya, `/telegram restart` menjalankan ulang,
   * `/telegram logs` menampilkan log, dan subperintah `token`/`allow`/`deny`/
   * `on`/`off` mengatur konfigurasi.
   */
  private async commandTelegram(args: string[]): Promise<void> {
    const [sub, ...rest] = args;
    const telegram = this.config.telegram ?? {};
    const allowed = telegram.allowedChatIds ?? [];
    const envToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
    const secureToken = await loadTelegramToken();

    if (sub === undefined || sub === "start" || sub === "restart") {
      const settings = resolveTelegramSettings(this.config, process.env, secureToken);
      if (!settings) {
        this.io.warn(
          "Token bot Telegram belum diatur. Jalankan /telegram token <TOKEN> atau set TELEGRAM_BOT_TOKEN.",
        );
        return;
      }
      if (settings.open) {
        this.io.warn("Peringatan: allowlist kosong — bot TERBUKA untuk siapa pun yang menemukannya.");
      }
      const workerArgs = this.telegramWorkerArgs();
      try {
        if (sub === "restart") await restartTelegramDaemon(workerArgs);
        else await startTelegramDaemon(workerArgs);
      } catch (err) {
        if (err instanceof TelegramDaemonError) {
          this.io.warn(err.message);
          return;
        }
        this.io.error(`Gagal menjalankan bot Telegram: ${formatErrorMessage(err)}`);
        return;
      }
      const status = await telegramDaemonStatus();
      this.io.info(
        `Bot Telegram ${sub === "restart" ? "dijalankan ulang" : "aktif"} di latar belakang (pid ${status.pid ?? "?"}).`,
      );
      this.io.info("Bot tetap hidup walau sesi chat ini ditutup. Hentikan dengan /telegram stop.");
      process.stdout.write(`  log: ${telegramLogPath()}\n`);
      if (!settings.open && allowed.length) {
        process.stdout.write(`  allowlist: ${allowed.join(", ")}\n`);
      }
      return;
    }

    if (sub === "stop") {
      const stopped = await stopTelegramDaemon();
      this.io.info(stopped ? "Bot Telegram dihentikan." : "Bot Telegram tidak sedang berjalan.");
      return;
    }

    if (sub === "status") {
      await this.printTelegramStatus(telegram, allowed, envToken, secureToken);
      return;
    }

    if (sub === "logs") {
      const lines = await tailTelegramLog(30);
      if (lines.length === 0) {
        this.io.info(`Belum ada log. (${telegramLogPath()})`);
      } else {
        process.stdout.write(`\nLog Telegram terakhir (${telegramLogPath()}):\n`);
        for (const line of lines) process.stdout.write(`  ${line}\n`);
        process.stdout.write("\n");
      }
      return;
    }

    if (sub === "token") {
      const value = rest.join(" ").trim();
      if (value === "hapus" || value === "clear" || value === "off") {
        await clearTelegramToken();
        this.io.info("Token bot dihapus dari telegram.json.");
        return;
      }
      if (!value) {
        this.io.warn("Pakai: /telegram token <TOKEN> (atau /telegram token hapus)");
        return;
      }
      await saveTelegramToken(value);
      this.io.info(`Token bot disimpan aman (${maskToken(value)}). Jalankan /telegram untuk menyalakan.`);
      return;
    }

    if (sub === "allow") {
      if (rest.length === 0) {
        this.io.info(
          allowed.length ? `Allowlist: ${allowed.join(", ")}` : "Allowlist kosong — bot terbuka untuk siapa pun.",
        );
        return;
      }
      if (rest[0] === "clear" || rest[0] === "off" || rest[0] === "none") {
        this.config = await saveConfig({ telegram: { ...telegram, allowedChatIds: [] } });
        this.io.warn("Allowlist dikosongkan — bot TERBUKA untuk siapa pun yang menemukannya.");
        return;
      }
      const ids = rest.map((id) => id.trim()).filter(Boolean);
      const merged = [...new Set([...allowed, ...ids])];
      this.config = await saveConfig({ telegram: { ...telegram, allowedChatIds: merged } });
      this.io.info(`Allowlist diperbarui: ${merged.join(", ")}`);
      return;
    }

    if (sub === "deny" || sub === "remove") {
      const ids = new Set(rest.map((id) => id.trim()));
      const merged = allowed.filter((id) => !ids.has(String(id)));
      this.config = await saveConfig({ telegram: { ...telegram, allowedChatIds: merged } });
      this.io.info(merged.length ? `Allowlist: ${merged.join(", ")}` : "Allowlist kosong — bot terbuka.");
      return;
    }

    if (sub === "on" || sub === "enable" || sub === "off" || sub === "disable") {
      const on = sub === "on" || sub === "enable";
      this.config = await saveConfig({ telegram: { ...telegram, enabled: on } });
      this.io.info(`Bot Telegram ${on ? "diaktifkan" : "dinonaktifkan"} di config.json.`);
      return;
    }

    this.io.warn(
      `Argumen tidak dikenal: ${sub}. Pakai /telegram [start|stop|restart|status|logs], /telegram token <t>, /telegram allow <id...>.`,
    );
  }

  /** Argumen CLI untuk worker bot agar memakai pengaturan sesi ini. */
  private telegramWorkerArgs(): string[] {
    const args = ["--cwd", this.workspace.root, "--mode", this.session.getMode()];
    const model = this.session.getModel();
    if (model) args.push("--model", model);
    if (this.providerKey) args.push("--provider", this.providerKey);
    if (this.opts.maxSteps !== undefined) args.push("--max-steps", String(this.opts.maxSteps));
    if (this.opts.maxCost !== undefined) args.push("--max-cost", String(this.opts.maxCost));
    if (this.approvals.allowAll()) args.push("--allow-all");
    if (!this.skillsEnabled) args.push("--no-skills");
    if (this.opts.debug) args.push("--debug");
    return args;
  }

  private async printTelegramStatus(
    telegram: AgentConfig["telegram"],
    allowed: Array<string | number>,
    envToken: string | undefined,
    secureToken: string | undefined,
  ): Promise<void> {
    const settings = resolveTelegramSettings(this.config, process.env, secureToken);
    const daemon = await telegramDaemonStatus();
    const tokenDisplay = envToken
      ? `${maskToken(envToken)} (env)`
      : secureToken
        ? `${maskToken(secureToken)} (telegram.json)`
        : telegram?.token
          ? `${maskToken(telegram.token)} (config.json)`
          : "(belum diatur)";
    process.stdout.write("\nBot Telegram:\n");
    process.stdout.write(`  token     : ${tokenDisplay}\n`);
    process.stdout.write(
      `  allowlist : ${allowed.length ? allowed.join(", ") : "(kosong — TERBUKA untuk siapa pun)"}\n`,
    );
    process.stdout.write(`  enabled   : ${telegram?.enabled === false ? "nonaktif" : "aktif"}\n`);
    process.stdout.write(
      `  berjalan  : ${daemon.running ? `ya (pid ${daemon.pid})` : "tidak"}\n`,
    );
    process.stdout.write(
      `  siap      : ${settings ? "ya — /telegram untuk menyalakan" : "belum (token belum ada)"}\n`,
    );
    process.stdout.write(`  log       : ${telegramLogPath()}\n`);
    process.stdout.write(
      "\n  /telegram (nyalakan)  ·  /telegram stop  ·  /telegram restart  ·  /telegram logs\n" +
        "  /telegram token <TOKEN>  ·  /telegram allow <chatId...|clear>  ·  /telegram on|off\n\n",
    );
  }

  private commandTodos(): void {
    const todos = this.session.getTodos();
    if (todos.length === 0) {
      this.io.info("Belum ada daftar tugas. Minta agent merencanakan tugas untuk mengisinya.");
      return;
    }
    const counts = new TodoStore(todos).counts();
    const header = `\n${todoHeader(todos)}  (${counts.inProgress} berjalan, ${counts.pending} menunggu, ${counts.cancelled} dibatalkan)\n`;
    const lines: string[] = [header.replace(/^\n/, "").replace(/\n$/, "")];
    for (const line of todoLines(todos)) lines.push(line);
    if (this.io.view) {
      void this.io.view({ title: "Todos", lines }).catch(() => {
        process.stdout.write(`${header}`);
        for (const line of todoLines(todos)) process.stdout.write(`  ${line}\n`);
        process.stdout.write("\n");
      });
      return;
    }
    process.stdout.write(`${header}`);
    for (const line of todoLines(todos)) process.stdout.write(`  ${line}\n`);
    process.stdout.write("\n");
  }

  private async commandMemory(args: string[]): Promise<void> {
    const dir = configDir();
    const sub = args[0];

    if (sub === "forget" && args[1]) {
      const key = args.slice(1).join(" ");
      const before = await readFacts(dir);
      const existed = findFact(before, key);
      if (!existed) {
        this.io.warn(`Tidak ada memori dengan key "${key}".`);
        return;
      }
      await writeFacts(dir, removeFact(before, existed.key));
      await this.refreshMemory();
      this.io.info(`Dilupakan: ${existed.key}.`);
      return;
    }

    if (sub === "add" && args.length >= 3) {
      const key = args[1]!;
      const value = args.slice(2).join(" ");
      if (looksSecret(key) || looksSecret(value)) {
        this.io.warn("Ditolak: jangan menyimpan kredensial/rahasia di memori.");
        return;
      }
      await writeFacts(dir, upsertFact(await readFacts(dir), key, value));
      await this.refreshMemory();
      this.io.info(`Diingat: ${key} = ${value}.`);
      return;
    }

    if (sub === "clear") {
      const before = await readFacts(dir);
      if (before.length === 0) {
        this.io.info("Memori sudah kosong.");
        return;
      }
      await writeFacts(dir, []);
      await this.refreshMemory();
      this.io.info(`Dihapus ${before.length} fakta memori.`);
      return;
    }

    const facts = await readFacts(dir);
    if (facts.length === 0) {
      this.io.info('Belum ada memori jangka panjang. Contoh: /memory add hobi coding');
      return;
    }
    const lines: string[] = [];
    lines.push(`Memori jangka panjang (${facts.length}):`);
    for (const f of facts) lines.push(`  ${f.key}: ${f.value}`);
    lines.push("");
    lines.push("Hapus dengan: /memory forget <key>  ·  /memory clear");
    if (this.io.view) {
      await this.io.view({ title: "Memory", lines });
      return;
    }
    process.stdout.write(`\nMemori jangka panjang (${facts.length}):\n`);
    for (const f of facts) process.stdout.write(`  ${f.key}: ${f.value}\n`);
    process.stdout.write("\nHapus dengan: /memory forget <key>  ·  /memory clear\n\n");
  }

  private async commandMcp(args: string[]): Promise<void> {
    const [sub, second, third] = args;
    if (sub === undefined) {
      this.printMcp();
      return;
    }
    if (sub === "reload") {
      this.io.info("Memuat ulang konfigurasi MCP…");
      await this.mcp.reload(this.registry);
      this.printMcp();
      return;
    }
    if (sub === "key") {
      await this.commandMcpKey(second, third);
      return;
    }
    if (sub === "add") {
      await this.commandMcpAdd(args.slice(1));
      return;
    }
    if (sub === "remove" || sub === "rm") {
      await this.commandMcpRemove(second);
      return;
    }
    if (sub === "presets") {
      this.commandMcpPresets();
      return;
    }
    this.io.warn(
      `Argumen tidak dikenal: ${sub}. Pakai /mcp, /mcp add <preset|command>, /mcp remove <nama>, /mcp reload, atau /mcp key <nama> [hapus].`,
    );
  }

  private printMcp(): void {
    const fileError = this.mcp.configFileError();
    if (fileError) this.io.warn(`plugins.json bermasalah: ${fileError}`);
    const status = this.mcp.status();
    if (status.length === 0) {
      if (!fileError) {
        this.io.info(
          "Belum ada server MCP. Tambah cepat: /mcp add context7 (atau edit ~/.config/agent/plugins.json — lihat README).",
        );
      }
      return;
    }

    process.stdout.write("\nServer MCP:\n");
    for (const server of status) {
      const marker = server.error ? color.red("✗") : server.connected ? color.green("●") : color.gray("○");
      let detail: string;
      if (!server.enabled) detail = "nonaktif (enabled: false)";
      else if (server.error) detail = server.error;
      else {
        const bits = [`${server.tools} tool`];
        if (server.credential) bits.push(`kredensial: ${server.credential}`);
        detail = bits.join(" · ");
      }
      process.stdout.write(
        `  ${marker} ${server.name.padEnd(20)} ${(server.transport ?? "-").padEnd(6)} ${detail}\n`,
      );
      if (server.registered.length > 0) {
        const shown = server.registered.slice(0, 4).join(", ");
        process.stdout.write(`      ${shown}${server.registered.length > 4 ? ", …" : ""}\n`);
      }
    }
    process.stdout.write(
      "\n  /mcp add <preset|command...> = tambah server · /mcp remove <nama> · /mcp reload · /mcp key <nama>\n\n",
    );
  }

  private async commandMcpAdd(tokens: string[]): Promise<void> {
    if (tokens.length === 0) {
      this.commandMcpPresets();
      return;
    }

    let plan: McpAddPlan;
    let serverName: string;
    try {
      plan = planMcpAdd(tokens);
      serverName = await applyMcpAdd(plan);
    } catch (err) {
      this.io.warn((err as Error).message);
      return;
    }

    const label = plan.kind === "preset" ? `preset: ${plan.presetAlias}` : plan.server.transport;
    this.io.info(`Server MCP "${serverName}" ditambahkan (${label}).`);
    if (plan.presetNote) this.io.info(plan.presetNote);
    await this.mcp.reload(this.registry);
    this.printMcp();
  }

  private async commandMcpRemove(name?: string): Promise<void> {
    if (!name) {
      this.io.warn("Pakai: /mcp remove <nama>.");
      return;
    }

    let removed: boolean;
    try {
      removed = await removeMcpServer(name);
    } catch (err) {
      this.io.warn(formatErrorMessage(err));
      return;
    }
    if (!removed) {
      this.io.info(`Tidak ada server MCP bernama "${name}".`);
      return;
    }

    this.io.info(`Server MCP "${name}" dihapus dari plugins.json.`);
    await this.mcp.reload(this.registry);
    this.printMcp();
  }

  private commandMcpPresets(): void {
    process.stdout.write("\nPreset server MCP (pakai: /mcp add <preset> [nama]):\n");
    for (const preset of listMcpPresets()) {
      process.stdout.write(`  ${preset.name.padEnd(12)} ${preset.description}\n`);
    }
    process.stdout.write(
      "\n  Kustom: /mcp add [--name <nama>] <command> [args...]  ·  /mcp add --url <url> [--name <nama>]\n\n",
    );
  }

  private async commandMcpKey(name?: string, action?: string): Promise<void> {
    if (!name) {
      this.io.warn("Pakai: /mcp key <nama> atau /mcp key <nama> hapus.");
      return;
    }
    if (action === "hapus" || action === "delete" || action === "rm") {
      const deleted = await this.credentials.delete(name);
      this.io.info(deleted ? `Kredensial ${name} dihapus.` : `Tidak ada kredensial bernama ${name}.`);
      return;
    }
    if (action !== undefined) {
      this.io.warn(`Argumen tidak dikenal: ${action}. Pakai /mcp key <nama> atau /mcp key <nama> hapus.`);
      return;
    }

    const raw = await this.prompter.secretQuestion(`API key untuk ${name}: `);
    if (raw === PROMPT_EOF) return;
    const value = raw.trim();
    if (!value) {
      this.io.warn("API key kosong; dibatalkan.");
      return;
    }
    await this.credentials.set(name, { apiKey: value });
    this.io.info(`API key ${name} tersimpan di credentials.json (izin 600; tidak pernah dicetak).`);
  }

  private async close(): Promise<void> {
    process.removeListener("SIGINT", this.onSigint);
    // Catatan: bot Telegram dijalankan sebagai daemon terpisah, jadi sengaja
    // TIDAK dihentikan di sini — ia tetap hidup setelah sesi chat ditutup.
    if (this.webServer) {
      await this.webServer.close();
      this.webServer = undefined;
    }
    if (this.mcp) await this.mcp.stop();
    this.logger.info("session.close", { id: this.record.id });
    if (this.logger instanceof JsonlLogger) this.logger.close();
    this.prompter.close();
  }
}

export { exitCodeFor };
