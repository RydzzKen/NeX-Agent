import readline from "node:readline";
import { completeLine, formatHint } from "./complete.js";

/** Nilai yang dikembalikan saat input ditutup (Ctrl+D / EOF). */
export const PROMPT_EOF = "\u0004";

export interface QuestionOptions {
  /** Tampilkan daftar saran live saat mengetik perintah "/" (butuh TTY). */
  suggest?: boolean;
}

export interface PrompterLike {
  question(query: string, options?: QuestionOptions): Promise<string>;
  close(): void;
  pause?: () => void;
  resume?: () => void;
}

export interface PrompterOptions {
  /** Perintah slash untuk autocomplete token pertama. */
  commands?: string[];
  /** Direktori dasar untuk autocomplete path. */
  cwd?: string;
}

/** Pembungkus readline tunggal untuk seluruh sesi CLI. */
export class Prompter implements PrompterLike {
  private readonly rl: readline.Interface;
  private readonly commands: string[];
  private readonly cwd: string;
  private closed = false;
  private completing = true;
  private pending: ((answer: string) => void) | undefined;
  /** Prompt dasar + daftar saran yang sedang tampil (mode suggest). */
  private basePrompt = "";
  private hint = "";
  private suggesting = false;

  constructor(options: PrompterOptions = {}) {
    this.commands = options.commands ?? [];
    this.cwd = options.cwd ?? process.cwd();
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      completer: (line: string): [string[], string] =>
        this.completing ? completeLine(line, this.commands, this.cwd) : [[], line],
    });
    this.rl.on("close", () => {
      this.closed = true;
      this.pending?.(PROMPT_EOF);
      this.pending = undefined;
    });
  }

  question(query: string, options: QuestionOptions = {}): Promise<string> {
    if (this.closed) return Promise.resolve(PROMPT_EOF);
    const suggest = options.suggest === true && Boolean(process.stdin.isTTY) && this.commands.length > 0;
    return new Promise((resolve) => {
      this.pending = resolve;
      if (suggest) {
        this.basePrompt = query;
        this.hint = "";
        this.suggesting = true;
        process.stdin.on("keypress", this.onKeypress);
      }
      this.rl.question(query, (answer) => {
        if (suggest) {
          this.suggesting = false;
          this.hint = "";
          process.stdin.removeListener("keypress", this.onKeypress);
        }
        this.pending = undefined;
        resolve(answer);
      });
    });
  }

  /**
   * Perbarui daftar saran "dropdown" di atas baris input saat mengetik.
   * Hanya untuk token perintah pertama (diawali `/`, tanpa spasi). Readline
   * yang menggambar ulang prompt multi-baris, jadi tidak ada tulis ANSI manual.
   */
  private readonly onKeypress = (): void => {
    if (!this.suggesting) return;
    const line = this.rl.line ?? "";
    const left = line.replace(/^\s+/, "");
    let hint = "";
    if (left.startsWith("/") && !left.includes(" ")) {
      const [hits] = completeLine(line, this.commands, this.cwd);
      if (hits.length > 1) hint = formatHint(hits);
    }
    if (hint === this.hint) return;
    this.hint = hint;
    this.rl.setPrompt(hint ? `${hint}\n${this.basePrompt}` : this.basePrompt);
    this.rl.prompt(true);
  };

  /**
   * Tanya input rahasia (API key) tanpa menampilkan isinya di layar.
   *
   * Readline menampilkan setiap karakter yang diketik lewat `_writeToOutput`;
   * kita hanya meneruskan prompt dan newline agar kursor tetap berperilaku
   * normal, lalu mengembalikannya setelah selesai.
   */
  async secretQuestion(query: string): Promise<string> {
    if (this.closed) return PROMPT_EOF;
    const rl = this.rl as unknown as { _writeToOutput?: (text: string) => void };
    const original = rl._writeToOutput;
    if (typeof original !== "function") return this.question(query);
    const bound = original.bind(this.rl);
    rl._writeToOutput = (text: string): void => {
      if (text === query || text === "\n" || text === "\r\n") bound(text);
    };
    this.completing = false;
    try {
      return await this.question(query);
    } finally {
      this.completing = true;
      rl._writeToOutput = original;
    }
  }

  pause(): void {
    if (this.closed) return;
    this.rl.pause();
  }

  resume(): void {
    if (this.closed) return;
    this.rl.resume();
  }

  close(): void {
    this.rl.close();
  }
}
