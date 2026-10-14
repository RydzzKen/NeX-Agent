import { color } from "../../util/color.js";
import { isCtrlTab, isPrintableText, stripAnsi, type Key } from "../../util/ansi.js";
import { PROMPT_EOF, type PrompterLike } from "../prompt.js";
import { completeLine } from "../complete.js";
import type { Screen } from "./screen.js";

/** Nama tombol readline yang relevan untuk input TUI. */
const ENTER = "return";
const TAB = "tab";
const BACKSPACE = "backspace";
const DELETE = "delete";
const LEFT = "left";
const RIGHT = "right";
const HOME = "home";
const END = "end";
const UP = "up";
const DOWN = "down";
const ESC = "escape";

/**
 * Implementasi `PrompterLike` untuk TUI. Tidak memakai readline: input dibaca
 * dari layar (raw mode) lewat `consume(key)`. `pause`/`resume` sengaja
 * no-op — raw mode tetap aktif selama task berjalan (run_shell memakai pipe,
 * jadi tidak ada konflik pembaca TTY).
 */
export class TuiPrompter implements PrompterLike {
  private pending?: { resolve: (value: string) => void; secret: boolean };
  private closed = false;
  private interruptHandler?: () => void;
  /** Pesan yang dikirim saat agent masih bekerja; dijalankan setelah giliran ini. */
  private queue: string[] = [];
  /** Prompt terakhir, dipakai untuk menghidupkan baris input saat menganggur. */
  private lastPrompt = "› ";

  constructor(
    private readonly screen: Screen,
    private readonly commands: string[],
    private readonly cwd: string,
  ) {}

  get hasPending(): boolean {
    return this.pending !== undefined;
  }

  question(query: string): Promise<string> {
    return this.ask(query, false);
  }

  secretQuestion(query: string, _mask?: string): Promise<string> {
    return this.ask(query, true);
  }

  /** Ambil satu pesan yang diantre (dipakai REPL sebelum bertanya lagi). */
  takeQueued(): string | undefined {
    return this.queue.shift();
  }

  pause(): void {
    // no-op: layar tetap mengelola key selama task berjalan.
  }

  resume(): void {
    // no-op.
  }

  onInterrupt(handler: () => void): void {
    this.interruptHandler = handler;
  }

  /** Panggil handler Ctrl+C yang didaftarkan app (jika ada). */
  triggerInterrupt(): void {
    this.interruptHandler?.();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue = [];
    const p = this.pending;
    this.pending = undefined;
    this.screen.clearMenu();
    this.screen.clearInput();
    p?.resolve(PROMPT_EOF);
  }

  private ask(query: string, secret: boolean): Promise<string> {
    const prompt = stripAnsi(query).replace(/\n/g, " ").trim() || "› ";
    if (!secret) this.lastPrompt = `${prompt} `;
    this.screen.clearMenu();
    this.screen.setInput("", 0, secret, `${prompt} `);
    return new Promise<string>((resolve) => {
      this.pending = { resolve, secret };
    });
  }

  /**
   * Proses satu key. `true` bila dikonsumsi oleh baris input; `false` berarti
   * dispatcher boleh menangani (Ctrl+C, Ctrl+Tab, Ctrl+X, Ctrl+T, scroll).
   *
   * Baris input tetap hidup walau tidak ada pertanyaan menganggur (mis. saat
   * agent sedang berpikir): pesan yang dikirim lalu **diantre** agar bisa jalan
   * setelah giliran ini selesai — layar tidak lagi beku.
   */
  consume(key: Key): boolean {
    if (this.closed) return false;
    const { name, ctrl, meta, sequence } = key;

    // Kombinasi global dibiarkan ke dispatcher.
    if (ctrl && (name === "c" || name === "x" || name === "t" || name === "l")) return false;
    if (isCtrlTab(key)) return false;

    // Baris input dianggap aktif bila ada pertanyaan, atau user sudah mengetik.
    const engaged = this.pending !== undefined || this.screen.inputActive;

    if (name === ENTER) {
      if (!engaged) return false;
      const selected = this.screen.getMenuSelected();
      if (selected && this.screenMenuOpen()) {
        this.applyCompletion(selected);
        return true;
      }
      if (this.pending) this.submit();
      else this.enqueue();
      return true;
    }

    if (name === TAB && !ctrl && !meta) {
      if (!engaged) return false;
      this.tabComplete();
      return true;
    }

    if ((name === UP || name === DOWN) && !ctrl && !meta) {
      if (this.screenMenuOpen()) {
        this.screen.menuSelect(name === UP ? -1 : 1);
        return true;
      }
      return false; // biarkan dispatcher: scroll view
    }

    if (name === BACKSPACE && !ctrl) {
      if (!engaged) return false;
      this.screen.deleteInput();
      this.refreshMenu();
      return true;
    }

    if (name === DELETE) {
      if (!engaged || this.screen.getInputText().length === 0) return false;
      this.screen.forwardDeleteInput();
      this.refreshMenu();
      return true;
    }

    if (name === LEFT && !ctrl) {
      if (!engaged) return false;
      this.screen.moveCaret(-1);
      return true;
    }
    if (name === RIGHT && !ctrl) {
      if (!engaged) return false;
      this.screen.moveCaret(1);
      return true;
    }
    if (name === HOME) {
      if (!engaged) return false;
      this.screen.caretToStart();
      return true;
    }
    if (name === END) {
      if (!engaged) return false;
      this.screen.caretToEnd();
      return true;
    }
    if (name === ESC) {
      if (!engaged) return false;
      this.screen.clearMenu();
      return true;
    }

    // Ctrl+D: EOF saat kosong (keluar), hapus karakter bila tidak kosong.
    if (ctrl && name === "d") {
      const empty = this.screen.getInputText().length === 0;
      if (empty) {
        if (this.pending) this.submit(PROMPT_EOF);
        return true;
      }
      this.screen.forwardDeleteInput();
      return true;
    }

    // Karakter yang dapat dicetak. readline mengisi `name` untuk huruf/angka
    // (mis. "a" → name "a", "A" → name "a"), jadi JANGAN mengandalkan `name`;
    // pakai `sequence` mentah yang mempertahankan huruf besar/kecil dan simbol.
    if (!ctrl && !meta && isPrintableText(sequence)) {
      if (!engaged) this.activateInput();
      this.screen.insertInput(sequence);
      this.refreshMenu();
      return true;
    }

    return false;
  }

  /** Hidupkan baris input walau belum ada pertanyaan (mis. saat agent sibuk). */
  private activateInput(): void {
    if (this.screen.inputActive) return;
    this.screen.setInput("", 0, false, this.lastPrompt);
  }

  /** Simpan input saat ini sebagai pesan antre untuk giliran berikutnya. */
  private enqueue(): void {
    const text = this.screen.getInputText();
    this.screen.clearMenu();
    if (text.trim() === "") {
      this.screen.clearInput();
      return;
    }
    this.queue.push(text);
    this.screen.clearInput();
    this.screen.appendRaw(`${color.cyan("⏳ antre")} ${color.dim(`(ke-${this.queue.length})`)} ${text}`);
  }

  private screenMenuOpen(): boolean {
    return this.screen.getMenuSelected() !== undefined;
  }

  private submit(value?: string): void {
    const p = this.pending;
    this.pending = undefined;
    const text = this.screen.getInputText();
    this.screen.clearMenu();
    this.screen.clearInput();
    if (p) p.resolve(value ?? text);
  }

  private currentMenu(): { matches: string[]; token: string } {
    const text = this.screen.getInputText();
    const [hits, token] = completeLine(text, this.commands, this.cwd);
    const matches = hits.filter((h) => h !== token);
    return { matches, token };
  }

  private refreshMenu(): void {
    const { matches, token } = this.currentMenu();
    this.screen.setMenu(token, matches);
  }

  private tabComplete(): void {
    // Tab berulang: putar pilihan pada menu yang sudah terbuka.
    if (this.screenMenuOpen()) {
      this.screen.menuSelect(1);
      return;
    }
    const { matches } = this.currentMenu();
    if (matches.length === 1) {
      this.applyCompletion(matches[0]!);
      return;
    }
    this.refreshMenu();
  }

  private applyCompletion(completion: string): void {
    const text = this.screen.getInputText();
    const idx = text.lastIndexOf(" ");
    const prefix = idx >= 0 ? text.slice(0, idx + 1) : "";
    this.screen.setInput(
      prefix + completion,
      (prefix + completion).length,
      false,
      this.screen.getInputPrompt(),
    );
    this.refreshMenu();
  }
}