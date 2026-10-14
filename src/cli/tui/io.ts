import { color } from "../../util/color.js";
import { renderMarkdown } from "../../util/markdown.js";
import { todoHeader, todoLines } from "../../util/todos.js";
import { isPrintableText, truncateTo, type Key } from "../../util/ansi.js";
import type {
  ConfirmDecision,
  ConfirmRequest,
  PathAccessRequest,
  SecretRequest,
  SensitiveAccessRequest,
  StepInfo,
  StepOutcome,
} from "../../core/io.js";
import type { StopReason } from "../../core/types.js";
import type { TodoItem } from "../../core/todos.js";
import type { ChatIO } from "../render.js";
import type { Screen, OverlayContent } from "./screen.js";

export interface TuiIOOptions {
  thinking?: boolean;
  markdown?: boolean;
}

interface OverlayState {
  resolve: (value: string | null) => void;
  accept: Map<string, string | null>;
  first: string;
}

const STEP_SYMBOL: Record<StepOutcome["status"], string> = {
  ok: color.green("✓"),
  error: color.red("✗"),
  denied: color.yellow("⊘"),
};

/**
 * Implementasi `ChatIO` untuk TUI: semua output dirender ke buffer layar
 * (view aktif), interaksi interaktif jadi overlay modal.
 */
export class TuiIO implements ChatIO {
  private markdownOn: boolean;
  private thinkingOn: boolean;
  private textBuffer = "";
  private overlay?: OverlayState;

  constructor(
    private readonly screen: Screen,
    opts: TuiIOOptions = {},
  ) {
    this.markdownOn = opts.markdown ?? true;
    this.thinkingOn = opts.thinking ?? false;
  }

  // ---- teks ----

  text(chunk: string): void {
    if (this.markdownOn) {
      this.textBuffer += chunk;
    } else {
      this.screen.appendStream("text", chunk);
    }
  }

  textEnd(): void {
    const buffered = this.textBuffer;
    this.textBuffer = "";
    if (this.markdownOn && buffered) {
      const rendered = renderMarkdown(buffered);
      this.screen.append("raw", rendered);
    }
    // Tutup baris streaming agar blok berikutnya mulai di baris baru.
    this.screen.endStream();
  }

  thinking(chunk: string): void {
    if (this.thinkingOn) this.screen.appendStream("think", chunk);
  }

  thinkingEnd(): void {
    // Tutup baris thinking agar blok berikutnya tidak menyambung ke baris ini.
    this.screen.endStream();
  }

  setMarkdown(value: boolean): void {
    this.markdownOn = value;
  }

  isMarkdownEnabled(): boolean {
    return this.markdownOn;
  }

  setThinking(value: boolean): void {
    this.thinkingOn = value;
  }

  thinkingEnabled(): boolean {
    return this.thinkingOn;
  }

  // ---- langkah & konten ----

  stepStart(_info: StepInfo): void {
    // hanya ditampilkan saat selesai (paritas dengan TerminalIO).
  }

  stepEnd(info: StepInfo, outcome: StepOutcome): void {
    const icon = info.risk === "mutate" ? "✎" : "⚙";
    const name = color.bold(info.name.padEnd(12));
    const args = color.dim(truncateTo(info.argsSummary, 46));
    const dur = color.dim(`(${outcome.durationMs}ms)`);
    this.screen.append("step", `${icon} ${name} ${args} ${dur} ${STEP_SYMBOL[outcome.status]}`);
  }

  diff(text: string): void {
    this.screen.append("raw", text);
  }

  todos(items: TodoItem[]): void {
    const header = todoHeader(items);
    const lines = todoLines(items);
    this.screen.append("info", `📋 ${header}`);
    for (const line of lines) this.screen.append("raw", line);
  }

  lineBreak(): void {
    this.screen.lineBreak();
  }

  /** Tampilkan pesan pengguna di riwayat (baris input dihapus saat submit). */
  userMessage(text: string): void {
    this.screen.append("user", `› ${text}`);
  }

  info(message: string): void {
    this.screen.append("info", `ℹ ${message}`);
  }

  warn(message: string): void {
    this.screen.append("warn", `⚠ ${message}`);
  }

  error(message: string): void {
    this.screen.append("error", `✗ ${message}`);
  }

  summary(reason: StopReason, message: string): void {
    void reason;
    this.screen.append("warn", `${color.yellow("── berhenti ──")} ${message}`);
  }

  busy(on: boolean): void {
    this.screen.setBusy(on);
  }

  modeChanged(mode: string): void {
    this.screen.setStatus({ mode });
  }

  // ---- sub-workspace (subagent) ----

  subtaskStart(label: string): void {
    this.screen.appendRaw(`${color.cyan("⟳")} ${label} berjalan…`);
    this.screen.openSubtaskView(label);
  }

  subtaskEnd(): void {
    this.screen.appendRaw(`${color.brightGreen("✓")} subagent selesai.`);
    this.screen.activateMainView();
  }

  // ---- overlay interaktif ----

  async confirm(req: ConfirmRequest): Promise<ConfirmDecision> {
    const body: string[] = [];
    if (req.diff) body.push(...req.diff.split("\n"));
    if (req.irreversible) body.push("⚠ Efek samping perintah shell tidak bisa di-undo.");
    const decision = await this.openOverlay({
      title: req.title,
      body,
      keys: [
        ["y", "setujui"],
        ["n", "tolak"],
        ["a", "setujui semua"],
      ],
      accept: new Map([
        ["y", "yes"],
        ["n", "no"],
        ["a", "all"],
      ]),
      first: "y",
    });
    return (decision === "yes" || decision === "all" ? decision : "no") as ConfirmDecision;
  }

  async requestPathAccess(req: PathAccessRequest): Promise<boolean> {
    const body = [
      `Akses ${req.access} di luar workspace: ${req.path}`,
      ...(req.access === "write"
        ? ["Tulis di luar workspace selalu butuh konfirmasi dan tidak bisa disetujui sekaligus."]
        : []),
    ];
    if (req.reason) body.push(`Alasan: ${req.reason}`);
    const decision = await this.openOverlay({
      title: "Akses di luar workspace",
      body,
      keys: [
        ["y", "izinkan"],
        ["n", "tolak"],
      ],
      accept: new Map([
        ["y", "yes"],
        ["n", "no"],
      ]),
      first: "n",
    });
    return decision === "yes";
  }

  async requestSensitiveAccess(req: SensitiveAccessRequest): Promise<boolean> {
    const decision = await this.openOverlay({
      title: "FILE SENSITIF",
      body: [
        req.detail,
        `${req.reason} — konfirmasi ini tidak bisa dilewati allow-all.`,
      ],
      keys: [
        ["y", "izinkan"],
        ["n", "tolak"],
      ],
      accept: new Map([
        ["y", "yes"],
        ["n", "no"],
      ]),
      first: "n",
    });
    return decision === "yes";
  }

  async requestSecret(req: SecretRequest): Promise<string | null> {
    const label = req.kind === "sudo" ? "Password sudo" : "Password SSH";
    const value = await this.openOverlay({
      title: `${label} (sekali pakai)`,
      body: [req.detail, req.reason],
      keys: [],
      accept: new Map(),
      first: "",
      secret: true,
    });
    return value;
  }

  /** Proses key saat overlay aktif (dipanggil dispatcher). */
  handleOverlayKey(key: Key): void {
    if (!this.overlay) return;
    const o = this.overlay;

    if (this.screen.isOverlaySecret()) {
      if (key.name === "return") this.resolveOverlay(this.screen.getOverlayInput());
      else if (key.name === "escape") this.resolveOverlay(null);
      else if (key.name === "backspace") this.screen.popOverlayChar();
      else if (!key.ctrl && !key.meta && isPrintableText(key.sequence)) {
        this.screen.pushOverlayChar(key.sequence);
      }
      return;
    }

    if (key.name === "return") this.resolveOverlay(o.accept.get(o.first) ?? null);
    else if (key.name === "escape") this.resolveOverlay(null);
    else if (!key.ctrl && !key.meta && isPrintableText(key.sequence) && key.sequence.length === 1) {
      // readline mengisi `name` untuk huruf (mis. "y" → name "y"), jadi cocokkan
      // dari `sequence` — bukan mengandalkan `name === undefined`.
      const value = o.accept.get(key.sequence.toLowerCase());
      if (value !== undefined) this.resolveOverlay(value);
    }
  }

  private async openOverlay(req: {
    title: string;
    body: string[];
    keys: Array<[string, string]>;
    accept: Map<string, string | null>;
    first: string;
    secret?: boolean;
  }): Promise<string | null> {
    const content: OverlayContent = { title: req.title, body: req.body, keys: req.keys };
    if (req.secret) content.secret = { label: req.title };
    return new Promise<string | null>((resolve) => {
      this.overlay = { resolve, accept: req.accept, first: req.first };
      this.screen.setOverlay(content);
    });
  }

  private resolveOverlay(value: string | null): void {
    const o = this.overlay;
    this.overlay = undefined;
    this.screen.setOverlay(undefined);
    o?.resolve(value);
  }
}