import readline from "node:readline";

/** Nilai yang dikembalikan saat input ditutup (Ctrl+D / EOF). */
export const PROMPT_EOF = "\u0004";

export interface PrompterLike {
  question(query: string): Promise<string>;
  close(): void;
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

  close(): void {
    this.rl.close();
  }
}
