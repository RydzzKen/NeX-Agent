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
import type { ChatIO, PickRequest, ViewRequest } from "../render.js";
import type { Screen, OverlayContent } from "./screen.js";

export interface TuiIOOptions {
  thinking?: boolean;
  markdown?: boolean;
}

interface KeysOverlay {
  kind: "keys";
  resolve: (value: string | null) => void;
  accept: Map<string, string | null>;
  first: string;
}

interface SecretOverlay {
  kind: "secret";
  resolve: (value: string | null) => void;
}

interface ListOverlay {
  kind: "list";
  resolve: (index: number | null) => void;
}

interface ViewerOverlay {
  kind: "viewer";
  resolve: () => void;
}

type OverlayState = KeysOverlay | SecretOverlay | ListOverlay | ViewerOverlay;

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
    // Status bar menampilkan thinking:on/off — jaga tetap sinkron dengan /thinking.
    this.screen.setThinkingVisible(value);
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

  // ---- pemilih & penampil (modul melayang) ----

  /**
   * Pilih satu item dari daftar lewat overlay melayang: ↑/↓ memindah sorotan,
   * Enter memilih, Esc membatalkan (mengembalikan `null`).
   */
  pick<T>(req: PickRequest<T>): Promise<T | null> {
    if (req.items.length === 0) return Promise.resolve(null);
    const labels = req.items.map((it) =>
      it.detail ? `${it.label}  ${color.dim(it.detail)}` : it.label,
    );
    return new Promise<T | null>((resolve) => {
      this.overlay = {
        kind: "list",
        resolve: (index) => resolve(index === null ? null : req.items[index]!.value),
      };
      const content: OverlayContent = {
        title: req.title,
        body: [],
        keys: [],
        list: {
          items: labels,
          selected: 0,
          offset: 0,
          ...(req.hint ? { hint: req.hint } : {}),
        },
      };
      this.screen.setOverlay(content);
    });
  }

  /**
   * Tampilkan konten panjang di overlay yang bisa digulir (↑/↓, PgUp/PgDn,
   * Home/End). Enter/Esc/q menutup.
   */
  view(req: ViewRequest): Promise<void> {
    return new Promise<void>((resolve) => {
      this.overlay = { kind: "viewer", resolve };
      const content: OverlayContent = {
        title: req.title,
        body: req.lines.length > 0 ? req.lines : ["(tidak ada isi)"],
        keys: [["Esc", "tutup"]],
        scrollTop: 0,
      };
      this.screen.setOverlay(content);
    });
  }

  /**
   * Input teks di dalam overlay (tidak masked). Enter = konfirmasi,
   * Esc = batal (null). Bermanis untuk input singkat seperti nama model custom.
   */
  inputText(req: { title: string; label: string; initial?: string }): Promise<string | null> {
    return this.openOverlay({
      title: req.title,
      body: [],
      keys: [],
      accept: new Map(),
      first: "",
      secret: true,
      masked: false,
      initial: req.initial ?? "",
      label: req.label,
    });
  }

  /** Proses key saat overlay aktif (dipanggil dispatcher). */
  handleOverlayKey(key: Key): void {
    const o = this.overlay;
    if (!o) return;

    if (o.kind === "secret") {
      if (key.name === "return") this.resolveOverlay(this.screen.getOverlayInput());
      else if (key.name === "escape") this.resolveOverlay(null);
      else if (key.name === "backspace") this.screen.popOverlayChar();
      else if (!key.ctrl && !key.meta && isPrintableText(key.sequence)) {
        this.screen.pushOverlayChar(key.sequence);
      }
      return;
    }

    if (o.kind === "list") {
      if (key.name === "up") this.screen.overlaySelect(-1);
      else if (key.name === "down") this.screen.overlaySelect(1);
      else if (key.name === "return") this.resolveList(this.screen.getOverlaySelected());
      else if (key.name === "escape") this.resolveList(null);
      return;
    }

    if (o.kind === "viewer") {
      if (key.name === "up") this.screen.overlayScrollBy(-1);
      else if (key.name === "down") this.screen.overlayScrollBy(1);
      else if (key.name === "pageup") this.screen.overlayScrollBy(-10);
      else if (key.name === "pagedown") this.screen.overlayScrollBy(10);
      else if (key.name === "home") this.screen.overlayScrollBy(-Number.MAX_SAFE_INTEGER);
      else if (key.name === "end") this.screen.overlayScrollBy(Number.MAX_SAFE_INTEGER);
      else if (key.name === "return" || key.name === "escape" || key.name === "q") this.resolveViewer();
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

  private openOverlay(req: {
    title: string;
    body: string[];
    keys: Array<[string, string]>;
    accept: Map<string, string | null>;
    first: string;
    secret?: boolean;
    masked?: boolean;
    initial?: string;
    label?: string;
  }): Promise<string | null> {
    const content: OverlayContent = { title: req.title, body: req.body, keys: req.keys };
    if (req.secret) {
      content.secret = {
        label: req.label ?? req.title,
        ...(req.masked !== undefined ? { masked: req.masked } : {}),
      };
    }
    return new Promise<string | null>((resolve) => {
      this.overlay = req.secret
        ? { kind: "secret", resolve }
        : { kind: "keys", resolve, accept: req.accept, first: req.first };
      this.screen.setOverlay(content);
      // Isi awal input — set setelah setOverlay karena setOverlay me-reset input.
      if (req.initial) this.screen.setOverlayInput(req.initial);
    });
  }

  private clearOverlay(): void {
    this.overlay = undefined;
    this.screen.setOverlay(undefined);
  }

  private resolveOverlay(value: string | null): void {
    const o = this.overlay;
    if (!o || (o.kind !== "keys" && o.kind !== "secret")) return;
    this.clearOverlay();
    o.resolve(value);
  }

  private resolveList(index: number | null): void {
    const o = this.overlay;
    if (!o || o.kind !== "list") return;
    this.clearOverlay();
    o.resolve(index);
  }

  private resolveViewer(): void {
    const o = this.overlay;
    if (!o || o.kind !== "viewer") return;
    this.clearOverlay();
    o.resolve();
  }
}