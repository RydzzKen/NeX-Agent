import type {
  AgentIO,
  ConfirmDecision,
  ConfirmRequest,
  PathAccessRequest,
  SensitiveAccessRequest,
  StepInfo,
  StepOutcome,
} from "../core/io.js";
import type { StopReason } from "../core/types.js";
import type { TodoItem } from "../core/todos.js";
import { color } from "../util/color.js";
import { renderMarkdown } from "../util/markdown.js";
import { todoHeader, todoLines } from "../util/todos.js";
import type { PrompterLike } from "./prompt.js";

export interface RenderOptions {
  thinking: boolean;
  json: boolean;
  /** Render markdown pada jawaban model (default true). */
  markdown?: boolean;
  /** Paksa spinner "sedang bekerja" aktif/nonaktif (default: hanya bila TTY). */
  spinner?: boolean;
}

const STATUS_SYMBOL: Record<StepOutcome["status"], string> = {
  ok: "✓",
  error: "✗",
  denied: "⊘",
};

/** Bingkai spinner untuk indikator "sedang bekerja". */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

/** Implementasi AgentIO untuk terminal. */
export class TerminalIO implements AgentIO {
  private thinkingActive = false;
  private textOpen = false;
  private textBuffer = "";
  private todoLineCount = 0;
  private lastWasTodos = false;
  private markdownOn: boolean;
  private readonly spinnerEnabled: boolean;
  private running = false;
  private suspended = false;
  private spinnerOn = false;
  private spinnerFrame = 0;
  private spinnerStarted = 0;
  private spinnerDelay: ReturnType<typeof setTimeout> | undefined;
  private spinnerTick: ReturnType<typeof setInterval> | undefined;
  private lineStart = true;

  constructor(
    private readonly prompter: PrompterLike,
    private readonly opts: RenderOptions,
    private readonly write: (s: string) => void = (s) => process.stdout.write(s),
  ) {
    this.markdownOn = opts.markdown !== false;
    const tty = Boolean(process.stdout.isTTY);
    this.spinnerEnabled = Boolean(opts.json) ? false : (opts.spinner ?? tty);
  }

  /** Pintu tunggal penulisan konten: matikan spinner dulu agar tidak tertimpa. */
  private writeContent(text: string): void {
    if (this.spinnerOn) this.clearSpinner();
    this.write(text);
    this.lineStart = text.endsWith("\n");
    this.armSpinner();
  }

  // ---- spinner "sedang bekerja" ----
  /** Tandai agent mulai/selesai bekerja; spinner tampil di sela output. */
  busy(on: boolean): void {
    if (!this.spinnerEnabled) return;
    if (on) {
      this.running = true;
      this.spinnerStarted = Date.now();
      this.spinnerFrame = 0;
      this.armSpinner();
    } else {
      this.running = false;
      this.disarmSpinner();
      this.clearSpinner();
    }
  }

  private armSpinner(): void {
    if (!this.spinnerEnabled || !this.running || this.suspended) return;
    this.disarmSpinner();
    this.spinnerDelay = setTimeout(() => this.showSpinner(), 300);
    this.spinnerDelay.unref?.();
  }

  private disarmSpinner(): void {
    if (this.spinnerDelay) {
      clearTimeout(this.spinnerDelay);
      this.spinnerDelay = undefined;
    }
  }

  private showSpinner(): void {
    if (!this.spinnerEnabled || !this.running || this.suspended || this.spinnerOn || !this.lineStart) {
      return;
    }
    this.spinnerOn = true;
    this.drawSpinner();
    this.spinnerTick = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      this.drawSpinner();
    }, 90);
    this.spinnerTick.unref?.();
  }

  private drawSpinner(): void {
    const frame = SPINNER_FRAMES[this.spinnerFrame] ?? SPINNER_FRAMES[0]!;
    const seconds = Math.max(0, Math.round((Date.now() - this.spinnerStarted) / 1000));
    const body = `${color.cyan(frame)} ${color.gray("sedang bekerja…")} ${color.gray(seconds + "s")}`;
    // \r + hapus baris: aman karena hanya digambar saat baris masih kosong.
    this.write(`\r\u001b[2K${body}\u001b[?25l`);
  }

  /** Cetak baris baru setelah input agar output/spinner muncul di baris bersih. */
  lineBreak(): void {
    this.writeContent("\n");
  }

  /** Hentikan sementara (mis. saat menunggu jawaban konfirmasi pengguna). */
  private suspendSpinner(): void {
    this.suspended = true;
    this.disarmSpinner();
    this.clearSpinner();
  }

  private resumeSpinner(): void {
    this.suspended = false;
    this.armSpinner();
  }

  private clearSpinner(): void {
    if (this.spinnerTick) {
      clearInterval(this.spinnerTick);
      this.spinnerTick = undefined;
    }
    if (!this.spinnerOn) return;
    this.write("\r\u001b[2K\u001b[?25h");
    this.spinnerOn = false;
    this.lineStart = true;
  }

  /** Tandai bahwa output terakhir bukan checklist, agar tidak salah timpa. */
  private unanchor(): void {
    this.lastWasTodos = false;
  }

  private json(event: Record<string, unknown>): void {
    this.writeContent(JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
  }

  text(chunk: string): void {
    if (this.opts.json) {
      this.json({ type: "text", text: chunk });
      return;
    }
    this.unanchor();
    if (this.thinkingActive) {
      this.thinkingActive = false;
      this.writeContent("\n");
    }
    if (!this.markdownOn) {
      this.textOpen = true;
      this.writeContent(chunk);
      return;
    }
    this.textBuffer += chunk;
  }

  /** Akhir teks satu giliran: render markdown yang terkumpul sekaligus. */
  textEnd(): void {
    if (this.opts.json) return;
    if (!this.markdownOn) {
      if (this.textOpen) {
        this.textOpen = false;
        this.writeContent("\n");
      }
      return;
    }
    if (!this.textBuffer) return;
    const rendered = renderMarkdown(this.textBuffer);
    this.textBuffer = "";
    this.writeContent(rendered.endsWith("\n") ? rendered : `${rendered}\n`);
  }

  /** Aktifkan/nonaktifkan render markdown untuk teks berikutnya. */
  setMarkdown(value: boolean): void {
    this.markdownOn = value;
  }

  isMarkdownEnabled(): boolean {
    return this.markdownOn;
  }

  thinking(chunk: string): void {
    if (!this.opts.thinking) return;
    if (this.opts.json) {
      this.json({ type: "thinking", text: chunk });
      return;
    }
    this.unanchor();
    if (!this.thinkingActive) {
      this.thinkingActive = true;
      this.writeContent(`\n${color.gray("◆ thinking…")}\n`);
    }
    this.writeContent(color.dim(chunk));
  }

  thinkingEnd(): void {
    if (this.opts.json) return;
    if (this.thinkingActive) {
      this.thinkingActive = false;
      this.writeContent("\n");
    }
    if (this.textOpen) {
      this.textOpen = false;
      this.writeContent("\n");
    }
  }

  stepStart(info: StepInfo): void {
    if (this.opts.json) this.json({ type: "step_start", ...info });
  }

  stepEnd(info: StepInfo, outcome: StepOutcome): void {
    if (this.opts.json) {
      this.json({ type: "step_end", ...info, ...outcome });
      return;
    }
    this.unanchor();
    const icon = info.risk === "mutate" ? "✎" : "⚙";
    const symbol = STATUS_SYMBOL[outcome.status];
    const symbolColor =
      outcome.status === "ok" ? color.green(symbol) : outcome.status === "denied" ? color.yellow(symbol) : color.red(symbol);
    const name = color.bold(info.name.padEnd(12));
    const args = color.gray(truncate(info.argsSummary, 46).padEnd(46));
    const duration = color.gray(`(${outcome.durationMs}ms)`);
    this.writeContent(`${icon} ${name} ${args} ${duration} ${symbolColor}\n`);
  }

  diff(text: string): void {
    if (this.opts.json) {
      this.json({ type: "diff", text });
      return;
    }
    this.unanchor();
    this.writeContent(text + "\n");
  }

  todos(items: TodoItem[]): void {
    if (this.opts.json) {
      this.json({ type: "todos", todos: items });
      return;
    }
    const lines = [todoHeader(items), ...todoLines(items)];
    let out = "";
    if (this.lastWasTodos && this.todoLineCount > 0) {
      // Kembali ke awal blok checklist sebelumnya dan hapus, lalu tulis ulang.
      out += `\u001b[${this.todoLineCount}F\u001b[0J`;
    }
    out += lines.join("\n") + "\n";
    this.writeContent(out);
    this.todoLineCount = lines.length;
    this.lastWasTodos = true;
  }

  info(message: string): void {
    if (this.opts.json) return this.json({ type: "info", message });
    this.unanchor();
    this.writeContent(`${color.cyan("ℹ")} ${message}\n`);
  }

  warn(message: string): void {
    if (this.opts.json) return this.json({ type: "warn", message });
    this.unanchor();
    this.writeContent(`${color.yellow("⚠")} ${message}\n`);
  }

  error(message: string): void {
    if (this.opts.json) return this.json({ type: "error", message });
    this.unanchor();
    this.writeContent(`${color.red("✗")} ${message}\n`);
  }

  summary(reason: StopReason, message: string): void {
    if (this.opts.json) return this.json({ type: "summary", reason, message });
    this.unanchor();
    this.writeContent(`\n${color.yellow("── berhenti ──")} ${message}\n`);
  }

  async confirm(req: ConfirmRequest): Promise<ConfirmDecision> {
    if (this.opts.json) return "no";
    this.suspendSpinner();
    try {
      if (req.diff) this.writeContent(req.diff + "\n");
      if (req.irreversible) {
        this.writeContent(`${color.yellow("⚠")} Efek samping perintah shell tidak bisa di-undo.\n`);
      }
      for (;;) {
        const answer = (
          await this.prompter.question(
            `${color.bold(req.title)}  [y] setujui  [n] tolak  [a] setujui semua  [d] diff penuh: `,
          )
        )
          .trim()
          .toLowerCase();
        if (answer === "y" || answer === "yes") return "yes";
        if (answer === "n" || answer === "no" || answer === "") return "no";
        if (answer === "a" || answer === "all") return "all";
        if (answer === "d" && req.diff) {
          this.writeContent(req.diff + "\n");
          continue;
        }
        this.writeContent("Jawaban tidak dikenali. Masukkan y, n, a, atau d.\n");
      }
    } finally {
      this.resumeSpinner();
    }
  }

  async requestPathAccess(req: PathAccessRequest): Promise<boolean> {
    if (this.opts.json) return false;
    this.suspendSpinner();
    try {
      this.writeContent(
        `${color.yellow("⚠")} Akses ${req.access} di luar workspace: ${req.path}\n`,
      );
      if (req.access === "write") {
        this.writeContent("  Tulis di luar workspace selalu butuh konfirmasi dan tidak bisa disetujui sekaligus.\n");
      }
      const answer = (await this.prompter.question("  Izinkan? [y/N]: ")).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    } finally {
      this.resumeSpinner();
    }
  }

  async requestSensitiveAccess(req: SensitiveAccessRequest): Promise<boolean> {
    if (this.opts.json) return false;
    this.suspendSpinner();
    try {
      this.writeContent(
        `${color.red("⚠ FILE SENSITIF")}  ${req.detail}\n` +
          `  ${color.gray(req.reason)} — konfirmasi ini tidak bisa dilewati allow-all.\n`,
      );
      const answer = (await this.prompter.question("  Izinkan akses rahasia ini? [y/N]: ")).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    } finally {
      this.resumeSpinner();
    }
  }

  modeChanged(mode: string): void {
    if (this.opts.json) return this.json({ type: "mode", mode });
    this.info(`Mode: ${mode}`);
  }

  setThinking(value: boolean): void {
    this.opts.thinking = value;
  }

  thinkingEnabled(): boolean {
    return this.opts.thinking;
  }
}
