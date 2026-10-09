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
import { todoHeader, todoLines } from "../util/todos.js";
import type { PrompterLike } from "./prompt.js";

export interface RenderOptions {
  thinking: boolean;
  json: boolean;
}

const STATUS_SYMBOL: Record<StepOutcome["status"], string> = {
  ok: "✓",
  error: "✗",
  denied: "⊘",
};

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

/** Implementasi AgentIO untuk terminal. */
export class TerminalIO implements AgentIO {
  private thinkingActive = false;
  private textOpen = false;
  private todoLineCount = 0;
  private lastWasTodos = false;

  constructor(
    private readonly prompter: PrompterLike,
    private readonly opts: RenderOptions,
    private readonly write: (s: string) => void = (s) => process.stdout.write(s),
  ) {}

  /** Tandai bahwa output terakhir bukan checklist, agar tidak salah timpa. */
  private unanchor(): void {
    this.lastWasTodos = false;
  }

  private json(event: Record<string, unknown>): void {
    this.write(JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
  }

  text(chunk: string): void {
    if (this.opts.json) {
      this.json({ type: "text", text: chunk });
      return;
    }
    this.unanchor();
    if (this.thinkingActive) {
      this.thinkingActive = false;
      this.write("\n");
    }
    this.textOpen = true;
    this.write(chunk);
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
      this.write(`\n${color.gray("◆ thinking…")}\n`);
    }
    this.write(color.dim(chunk));
  }

  thinkingEnd(): void {
    if (this.opts.json) return;
    if (this.thinkingActive) {
      this.thinkingActive = false;
      this.write("\n");
    }
    if (this.textOpen) {
      this.textOpen = false;
      this.write("\n");
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
    this.write(`${icon} ${name} ${args} ${duration} ${symbolColor}\n`);
  }

  diff(text: string): void {
    if (this.opts.json) {
      this.json({ type: "diff", text });
      return;
    }
    this.unanchor();
    this.write(text + "\n");
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
    this.write(out);
    this.todoLineCount = lines.length;
    this.lastWasTodos = true;
  }

  info(message: string): void {
    if (this.opts.json) return this.json({ type: "info", message });
    this.unanchor();
    this.write(`${color.cyan("ℹ")} ${message}\n`);
  }

  warn(message: string): void {
    if (this.opts.json) return this.json({ type: "warn", message });
    this.unanchor();
    this.write(`${color.yellow("⚠")} ${message}\n`);
  }

  error(message: string): void {
    if (this.opts.json) return this.json({ type: "error", message });
    this.unanchor();
    this.write(`${color.red("✗")} ${message}\n`);
  }

  summary(reason: StopReason, message: string): void {
    if (this.opts.json) return this.json({ type: "summary", reason, message });
    this.unanchor();
    this.write(`\n${color.yellow("── berhenti ──")} ${message}\n`);
  }

  async confirm(req: ConfirmRequest): Promise<ConfirmDecision> {
    if (this.opts.json) return "no";
    if (req.diff) this.write(req.diff + "\n");
    if (req.irreversible) {
      this.write(`${color.yellow("⚠")} Efek samping perintah shell tidak bisa di-undo.\n`);
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
        this.write(req.diff + "\n");
        continue;
      }
      this.write("Jawaban tidak dikenali. Masukkan y, n, a, atau d.\n");
    }
  }

  async requestPathAccess(req: PathAccessRequest): Promise<boolean> {
    if (this.opts.json) return false;
    this.write(
      `${color.yellow("⚠")} Akses ${req.access} di luar workspace: ${req.path}\n`,
    );
    if (req.access === "write") {
      this.write("  Tulis di luar workspace selalu butuh konfirmasi dan tidak bisa disetujui sekaligus.\n");
    }
    const answer = (await this.prompter.question("  Izinkan? [y/N]: ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  }

  async requestSensitiveAccess(req: SensitiveAccessRequest): Promise<boolean> {
    if (this.opts.json) return false;
    this.write(
      `${color.red("⚠ FILE SENSITIF")}  ${req.detail}\n` +
        `  ${color.gray(req.reason)} — konfirmasi ini tidak bisa dilewati allow-all.\n`,
    );
    const answer = (await this.prompter.question("  Izinkan akses rahasia ini? [y/N]: ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
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
