import readline from "node:readline";

/** Nilai yang dikembalikan saat input ditutup (Ctrl+D / EOF). */
export const PROMPT_EOF = "\u0004";

export interface PrompterLike {
  question(query: string): Promise<string>;
  close(): void;
  pause?: () => void;
  resume?: () => void;
}

/** Pembungkus readline tunggal untuk seluruh sesi CLI. */
export class Prompter implements PrompterLike {
  private readonly rl: readline.Interface;
  private closed = false;
  private pending: ((answer: string) => void) | undefined;

  constructor() {
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    this.rl.on("close", () => {
      this.closed = true;
      this.pending?.(PROMPT_EOF);
      this.pending = undefined;
    });
  }

  question(query: string): Promise<string> {
    if (this.closed) return Promise.resolve(PROMPT_EOF);
    return new Promise((resolve) => {
      this.pending = resolve;
      this.rl.question(query, (answer) => {
        this.pending = undefined;
        resolve(answer);
      });
    });
  }

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
    try {
      return await this.question(query);
    } finally {
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
