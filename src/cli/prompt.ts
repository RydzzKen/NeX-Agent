import readline from "node:readline";
import { completeLine } from "./complete.js";

/** Nilai yang dikembalikan saat input ditutup (Ctrl+D / EOF). */
export const PROMPT_EOF = "\u0004";

export interface PrompterLike {
  question(query: string): Promise<string>;
  close(): void;
  pause(): void;
  resume(): void;
  secretQuestion(query: string, mask?: string): Promise<string>;
  onInterrupt(handler: () => void): void;
  /** Ambil pesan yang diantre (opsional; hanya TUI yang mengantre). */
  takeQueued?(): string | undefined;
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
  private interruptHandler: (() => void) | undefined;
  private interruptBound = false;
  /** Apakah raw mode seharusnya aktif (TTY). Diatur oleh pause/resume. */
  private rawEnabled = true;

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
   * Tanya input rahasia (API key / password) tanpa menampilkan isinya.
   *
   * Readline menulis tiap karakter yang diketik lewat `_writeToOutput`; kita
   * hanya meneruskan prompt dan newline. Bila `mask` diberikan (mis. `"*"`),
   * jumlah karakter ditampilkan sebagai bintang tanpa pernah mengekspos isi —
   * dihitung dari `rl.line` agar backspace/panah tetap konsisten.
   */
  async secretQuestion(query: string, mask?: string): Promise<string> {
    if (this.closed) return PROMPT_EOF;
    const rl = this.rl as unknown as {
      _writeToOutput?: (text: string) => void;
      line?: string;
    };
    const original = rl._writeToOutput;
    if (typeof original !== "function") return this.question(query);
    const bound = original.bind(this.rl);
    let shown = 0;
    rl._writeToOutput = (text: string): void => {
      if (text === query || text === "\n" || text === "\r\n") {
        bound(text);
        return;
      }
      if (!mask) return;
      const target = rl.line?.length ?? shown;
      if (target > shown) {
        bound(mask.repeat(target - shown));
        shown = target;
      } else if (target < shown) {
        bound("\b \b".repeat(shown - target));
        shown = target;
      }
    };
    this.completing = false;
    // Paksa raw mode aktif: bila TTY dalam canonical mode (mis. setelah
    // `pause()` saat tugas berjalan), terminal meng-echo ketikan mentah —
    // membocorkan rahasia sebelum mask kita menimpanya.
    const wasRaw = this.rawEnabled;
    this.setRaw(true);
    try {
      return await this.question(query);
    } finally {
      this.completing = true;
      rl._writeToOutput = original;
      this.setRaw(wasRaw);
    }
  }

  pause(): void {
    if (this.closed) return;
    this.rl.pause();
    // Lepas raw mode agar Ctrl+C menghasilkan SIGINT OS saat readline berhenti
    // membaca (dipakai selama tugas berjalan). Tanpa ini Ctrl+C tidak terdeteksi.
    this.rawEnabled = false;
    this.setRaw(false);
  }

  resume(): void {
    if (this.closed) return;
    this.rl.resume();
    this.rawEnabled = true;
    this.setRaw(true);
  }

  /**
   * Daftarkan handler Ctrl+C. Kehadiran listener `SIGINT` di readline membuat
   * Ctrl+C tidak lagi menutup sesi secara diam-diam; keputusan diserahkan ke
   * pemanggil (mis. hentikan tugas vs keluar).
   */
  onInterrupt(handler: () => void): void {
    this.interruptHandler = handler;
    if (this.interruptBound) return;
    this.interruptBound = true;
    this.rl.on("SIGINT", () => this.interruptHandler?.());
  }

  /** Aktifkan/matikan raw mode TTY dengan aman (abaikan bila bukan TTY). */
  private setRaw(on: boolean): void {
    const input = process.stdin;
    if (input.isTTY && typeof input.setRawMode === "function") {
      try {
        input.setRawMode(on);
      } catch {
        // Terminal tidak mendukung raw mode; abaikan.
      }
    }
  }

  close(): void {
    this.rl.close();
  }
}
